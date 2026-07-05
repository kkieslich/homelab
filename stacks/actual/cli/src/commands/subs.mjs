// Subscription detector. Finds payees that look like recurring charges based on
// transaction cadence + amount stability. No keyword lists — purely data-driven.
//
// `detectSubscriptions` is exported for the Prometheus exporter to reuse.

import fs from 'node:fs';
import { parseArgs } from '../lib/args.mjs';
import { SNAPSHOT_PATH } from '../lib/paths.mjs';
import { fetchSnapshot } from './fetch.mjs';

const CADENCES = [
  { name: 'weekly',    gap: 7,   tol: 2,  perYear: 52 },
  { name: 'biweekly',  gap: 14,  tol: 3,  perYear: 26 },
  { name: 'monthly',   gap: 30,  tol: 5,  perYear: 12 },
  { name: 'bimonthly', gap: 60,  tol: 7,  perYear: 6 },
  { name: 'quarterly', gap: 91,  tol: 10, perYear: 4 },
  { name: 'biannual',  gap: 182, tol: 15, perYear: 2 },
  { name: 'yearly',    gap: 365, tol: 20, perYear: 1 },
];

function detectOne(txs) {
  if (txs.length < 3) return null;
  const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const d1 = new Date(sorted[i - 1].date);
    const d2 = new Date(sorted[i].date);
    gaps.push((d2 - d1) / 86_400_000);
  }
  let best = null;
  for (const c of CADENCES) {
    const matching = gaps.filter((g) => Math.abs(g - c.gap) <= c.tol).length;
    const fraction = matching / gaps.length;
    if (fraction >= 0.6 && (!best || matching > best.matching)) {
      best = { cadence: c, matching, fraction };
    }
  }
  if (!best) return null;

  const amounts = sorted.map((t) => t.amount).sort((a, b) => a - b);
  const median = amounts[Math.floor(amounts.length / 2)];
  const min = amounts[0], max = amounts[amounts.length - 1];
  const spread = median > 0 ? (max - min) / median : 1;
  if (spread > 0.5) return null;

  const lastDate = sorted[sorted.length - 1].date;
  const firstDate = sorted[0].date;
  const daysSinceLast = (Date.now() - new Date(lastDate)) / 86_400_000;
  const isActive = daysSinceLast <= best.cadence.gap + best.cadence.tol + 14;

  return {
    cadence: best.cadence.name,
    perYear: best.cadence.perYear,
    median, min, max, spread,
    count: sorted.length,
    firstDate, lastDate,
    daysSinceLast: Math.round(daysSinceLast),
    isActive,
    confidence: best.fraction,
  };
}

// Coarse amount bucket used to split a payee's history into independent
// recurring sub-streams (e.g. a phone contract at €45/mo and an internet
// contract at €28/mo billed by the same Vodafone payee). Bucket size scales
// with magnitude so €2140 rent at ±€100 still lands in one bucket while a
// €28 sub stays distinct from a €45 one.
function amountBucket(cents) {
  const step = Math.max(500, Math.round(cents * 0.10 / 500) * 500); // 10% step, min €5
  return Math.round(cents / step) * step;
}

// Pure function: returns array of {payee, payeeId, ...detection, annualizedCents}.
// Sorted by annualizedCents descending.
export function detectSubscriptions(snapshot, { minAmountCents = 200 } = {}) {
  const payeeName = new Map(snapshot.payees.map((p) => [p.id, p.name]));
  const offBudget = new Set(snapshot.accounts.filter((a) => a.offbudget).map((a) => a.id));
  const incomeCats = new Set(snapshot.categories.filter((c) => c.is_income).map((c) => c.id));

  const byPayee = new Map();
  for (const t of snapshot.transactions) {
    if (!t.date || !t.payee) continue;
    if (offBudget.has(t.account)) continue;
    if (t.transfer_id) continue;
    if (t.amount >= 0) continue;
    if (t.category && incomeCats.has(t.category)) continue;
    const amt = Math.abs(t.amount);
    if (amt < minAmountCents) continue;
    if (!byPayee.has(t.payee)) byPayee.set(t.payee, []);
    byPayee.get(t.payee).push({ date: t.date, amount: amt });
  }

  // Same-day same-payee charges are one billing event (e.g. two electricity
  // contracts on the same Lastschrift day). Sum amounts and dedupe before
  // running cadence detection so gap=0 noise doesn't break it.
  function dedupeSameDay(txs) {
    const byDate = new Map();
    for (const t of txs) {
      const cur = byDate.get(t.date);
      if (cur) cur.amount += t.amount;
      else byDate.set(t.date, { date: t.date, amount: t.amount });
    }
    return Array.from(byDate.values());
  }

  const results = [];
  for (const [payeeId, rawTxs] of byPayee.entries()) {
    const name = payeeName.get(payeeId) ?? '?';

    // Pass 1: per-payee detection on same-day-collapsed stream. Catches the
    // common case (single sub per payee, e.g. rent, gym, donation).
    const collapsed = dedupeSameDay(rawTxs);
    const whole = detectOne(collapsed);

    // Pass 2: per-(payee × amount-bucket) detection. Splits payees that bill
    // multiple distinct amounts on different cadences (Vodafone phone+internet,
    // Stadtwerke two contracts). Run on raw txs so different days stay distinct.
    const buckets = new Map();
    for (const t of rawTxs) {
      const b = amountBucket(t.amount);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(t);
    }
    const bucketDetections = [];
    if (buckets.size > 1) {
      for (const [bucket, btxs] of buckets.entries()) {
        if (btxs.length < 3) continue;
        const d = detectOne(dedupeSameDay(btxs));
        if (!d) continue;
        bucketDetections.push({ bucket, detection: d });
      }
    }

    // Merge: if multiple buckets detected, they win (more specific). Otherwise
    // fall back to the per-payee result. Suffix bucketed names with "(€X)" so
    // the user can see which stream is which.
    const useBuckets = bucketDetections.length >= 2;
    const chosen = useBuckets
      ? bucketDetections.map(({ bucket, detection }) => ({
          payee: `${name} (€${(bucket / 100).toFixed(0)})`,
          payeeId: `${payeeId}:bucket:${bucket}`,
          ...detection,
        }))
      : whole
        ? [{ payee: name, payeeId, ...whole }]
        : [];

    for (const c of chosen) {
      results.push({ ...c, annualizedCents: c.median * c.perYear });
    }
  }
  results.sort((a, b) => b.annualizedCents - a.annualizedCents);
  return results;
}

async function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.error(`No snapshot at ${SNAPSHOT_PATH} — running fetch first...`);
    const s = await fetchSnapshot();
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(s, null, 2));
    return s;
  }
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

export async function run(argv) {
  const args = parseArgs(argv);
  const includeStale = !!args['include-stale'];
  const minAmountCents = parseFloat(args['min-amount'] ?? '2') * 100;
  const csv = !!args.csv;

  const snapshot = await loadSnapshot();
  const all = detectSubscriptions(snapshot, { minAmountCents });
  const results = includeStale ? all : all.filter((r) => r.isActive);

  if (csv) {
    console.log('payee,cadence,median_eur,min_eur,max_eur,annualized_eur,count,first_seen,last_seen,days_since_last,active,confidence');
    for (const r of results) {
      console.log([
        `"${r.payee.replace(/"/g, '""')}"`,
        r.cadence,
        (r.median / 100).toFixed(2),
        (r.min / 100).toFixed(2),
        (r.max / 100).toFixed(2),
        (r.annualizedCents / 100).toFixed(2),
        r.count, r.firstDate, r.lastDate, r.daysSinceLast, r.isActive, r.confidence.toFixed(2),
      ].join(','));
    }
    return;
  }

  const totalAnnual = results.filter((r) => r.isActive).reduce((s, r) => s + r.annualizedCents, 0);
  console.log(`\n=== Detected subscriptions${includeStale ? ' (incl. stale)' : ''} — ${results.length} payees ===\n`);
  console.log(
    'Payee'.padEnd(36) +
    'Cadence'.padEnd(10) +
    'Median'.padStart(10) +
    '€/year'.padStart(10) +
    '  Count' +
    '  Last seen      Status',
  );
  console.log('-'.repeat(100));
  for (const r of results) {
    const status = r.isActive ? '' : `STALE (${r.daysSinceLast}d ago)`;
    const range = r.min === r.max ? '' : ` ±${(((r.max - r.min) / 2) / 100).toFixed(2)}`;
    console.log(
      r.payee.slice(0, 35).padEnd(36) +
      r.cadence.padEnd(10) +
      `€${(r.median / 100).toFixed(2)}${range}`.padStart(10) +
      `€${(r.annualizedCents / 100).toFixed(0)}`.padStart(10) +
      `   ${String(r.count).padStart(3)}` +
      `   ${r.lastDate}     ${status}`,
    );
  }
  console.log('-'.repeat(100));
  console.log(`Active subscription burden: €${(totalAnnual / 100).toFixed(0)} / year  (~€${(totalAnnual / 12 / 100).toFixed(0)} / month)`);
  console.log('\nTip: --include-stale to find ones that stopped (cancelled? or did they?).');
}

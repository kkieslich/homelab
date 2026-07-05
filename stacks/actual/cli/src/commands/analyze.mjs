// Spending analyzer. Smooths out the date-vs-month problem (Feb bill paid in
// March etc.) by averaging across many months — payment-date jitter cancels.
//
// Reads the snapshot from `actual fetch`. Re-runs fetch automatically if the
// snapshot is missing. The exporter imports `analyzeSpending` directly.

import fs from 'node:fs';
import { parseArgs } from '../lib/args.mjs';
import { SNAPSHOT_PATH } from '../lib/paths.mjs';
import { fetchSnapshot } from './fetch.mjs';

// Pure function — used by both the CLI and the Prometheus exporter.
//
// Returns: {
//   monthKeys:  ['2025-06', ...],
//   rows: [{ catId, name, group, total, avg, last3, priorAvg, trendPct, monthly: [...] }],
// }
export function analyzeSpending(snapshot, { months = 12 } = {}) {
  const catById = new Map(snapshot.categories.map((c) => [c.id, c]));
  const groupById = new Map(snapshot.categoryGroups.map((g) => [g.id, g]));
  const groupNameByCatId = new Map(
    snapshot.categories.map((c) => [c.id, groupById.get(c.group_id)?.name ?? '?']),
  );
  const offBudget = new Set(snapshot.accounts.filter((a) => a.offbudget).map((a) => a.id));
  const incomeCats = new Set(snapshot.categories.filter((c) => c.is_income).map((c) => c.id));

  const allDates = snapshot.transactions.map((t) => t.date).filter(Boolean).sort();
  if (allDates.length === 0) return { monthKeys: [], rows: [] };
  const latest = allDates[allDates.length - 1];
  const [ly, lm] = latest.split('-').map(Number);
  const monthKeys = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(ly, lm - 1 - i, 1));
    monthKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const monthSet = new Set(monthKeys);

  const isSpending = (t) => {
    if (!t.date) return false;
    if (!monthSet.has(t.date.slice(0, 7))) return false;
    if (offBudget.has(t.account)) return false;
    if (t.transfer_id) return false;
    if (t.category && incomeCats.has(t.category)) return false;
    if (t.amount >= 0) return false;
    return true;
  };

  const byCat = new Map();
  for (const t of snapshot.transactions) {
    if (!isSpending(t)) continue;
    const catId = t.category ?? '__uncategorized__';
    const ym = t.date.slice(0, 7);
    if (!byCat.has(catId)) byCat.set(catId, new Map());
    const m = byCat.get(catId);
    m.set(ym, (m.get(ym) ?? 0) + Math.abs(t.amount));
  }

  const rows = [];
  for (const [catId, monthMap] of byCat.entries()) {
    const cat = catId === '__uncategorized__' ? { name: '(uncategorized)' } : catById.get(catId);
    if (!cat) continue;
    const group = catId === '__uncategorized__' ? '(none)' : (groupNameByCatId.get(catId) ?? '?');
    const monthly = monthKeys.map((k) => monthMap.get(k) ?? 0);
    const total = monthly.reduce((a, b) => a + b, 0);
    const avg = total / months;
    const last3 = monthly.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const prior = monthly.slice(0, -3);
    const priorAvg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
    const trendPct = priorAvg > 0 ? ((last3 - priorAvg) / priorAvg) * 100 : null;
    rows.push({ catId, name: cat.name, group, total, avg, last3, priorAvg, trendPct, monthly });
  }
  rows.sort((a, b) => b.total - a.total);
  return { monthKeys, rows };
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
  const months = parseInt(args.months ?? '12', 10);
  const top = parseInt(args.top ?? '12', 10);
  const csv = !!args.csv;
  const drill = (args.drilldown ?? '').toString().split(',').map((s) => s.trim()).filter(Boolean);

  const snapshot = await loadSnapshot();
  const { monthKeys, rows } = analyzeSpending(snapshot, { months });

  if (csv) {
    const header = ['group', 'category', 'total_eur', 'avg_per_month_eur', 'last3mo_avg_eur', 'prior_avg_eur', 'trend_pct', ...monthKeys];
    console.log(header.join(','));
    for (const r of rows) {
      const cells = [
        r.group, r.name,
        (r.total / 100).toFixed(2),
        (r.avg / 100).toFixed(2),
        (r.last3 / 100).toFixed(2),
        (r.priorAvg / 100).toFixed(2),
        r.trendPct === null ? '' : r.trendPct.toFixed(1),
        ...r.monthly.map((v) => (v / 100).toFixed(2)),
      ];
      console.log(cells.map((c) => /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(','));
    }
    return;
  }

  const total = rows.reduce((a, r) => a + r.total, 0);
  const avg = total / months;
  console.log(`\n=== Spending by category, last ${months} months (${monthKeys[0]} ... ${monthKeys.at(-1)}) ===\n`);
  const cName = 28, cGrp = 18, cNum = 11;
  console.log(
    'Category'.padEnd(cName) + 'Group'.padEnd(cGrp) +
    '12mo total'.padStart(cNum) + '€/month'.padStart(cNum) +
    'last 3mo'.padStart(cNum) + 'prior'.padStart(cNum) +
    '   trend  flag',
  );
  console.log('-'.repeat(cName + cGrp + cNum * 4 + 14));
  for (const r of rows) {
    const flag = (() => {
      if (r.trendPct === null) return '';
      if (r.last3 < 1000) return '';
      if (r.trendPct > 50 && r.last3 > r.priorAvg + 2000) return '⚠ up';
      if (r.trendPct > 25) return '↑';
      if (r.trendPct < -25) return '↓';
      return '';
    })();
    const trendStr = r.trendPct === null ? '   —  ' : `${r.trendPct > 0 ? '+' : ''}${r.trendPct.toFixed(0).padStart(4)}%`;
    console.log(
      r.name.slice(0, cName - 1).padEnd(cName) +
      r.group.slice(0, cGrp - 1).padEnd(cGrp) +
      `€${(r.total / 100).toFixed(0)}`.padStart(cNum) +
      `€${(r.avg / 100).toFixed(0)}`.padStart(cNum) +
      `€${(r.last3 / 100).toFixed(0)}`.padStart(cNum) +
      `€${(r.priorAvg / 100).toFixed(0)}`.padStart(cNum) +
      `   ${trendStr}  ${flag}`,
    );
  }
  console.log('-'.repeat(cName + cGrp + cNum * 4 + 14));
  console.log('TOTAL'.padEnd(cName + cGrp) + `€${(total / 100).toFixed(0)}`.padStart(cNum) + `€${(avg / 100).toFixed(0)}`.padStart(cNum));

  console.log(`\n=== Per-month spend, top ${top} categories ===\n`);
  const monthHeader = monthKeys.map((k) => k.slice(2)).map((k) => k.padStart(7)).join('');
  console.log('Category'.padEnd(cName) + monthHeader);
  console.log('-'.repeat(cName + monthHeader.length));
  for (const r of rows.slice(0, top)) {
    const cells = r.monthly.map((v) => v === 0 ? '     -' : `€${(v / 100).toFixed(0)}`).map((c) => c.padStart(7)).join('');
    console.log(r.name.slice(0, cName - 1).padEnd(cName) + cells);
  }

  if (drill.length) {
    for (const name of drill) {
      const r = rows.find((x) => x.name.toLowerCase().includes(name.toLowerCase()));
      if (!r) { console.log(`\n[drilldown] no category matches "${name}"`); continue; }
      const txs = snapshot.transactions
        .filter((t) => t.category === r.catId && t.amount < 0 && monthKeys.includes(t.date?.slice(0, 7)))
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
        .slice(0, 15);
      console.log(`\n=== Drilldown: ${r.name} (top 15 transactions in window) ===`);
      for (const t of txs) {
        const payee = snapshot.payees.find((p) => p.id === t.payee)?.name ?? '?';
        console.log(`  ${t.date}  €${(Math.abs(t.amount) / 100).toFixed(2).padStart(8)}  ${payee.slice(0, 40).padEnd(40)}  ${(t.notes ?? '').slice(0, 50)}`);
      }
    }
  }
}

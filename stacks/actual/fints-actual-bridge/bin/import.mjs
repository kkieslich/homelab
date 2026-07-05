#!/usr/bin/env node
// Reads a fints-fetch JSON payload (single-bank or multi-bank `--all` shape)
// and imports it into a self-hosted Actual Budget server via @actual-app/api.
//
// Mapping IBAN -> Actual account UUID lives in banks.toml under
// [[banks.<key>.accounts]] entries. Accounts not listed there are skipped.
//
// Usage:
//   fints-fetch --bank umwelt | node bin/import.mjs --bank umwelt
//   fints-fetch --all          | node bin/import.mjs --all
//   node bin/import.mjs --bank umwelt --in /tmp/ub.json
//   node bin/import.mjs --all  --in /tmp/all.json --dry-run
//
// Idempotent: every transaction's `imported_id` (the bank's AcctSvcrRef) is
// passed to Actual as `imported_id`, and Actual's CRDT-based import dedupes on it.

import process from 'node:process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as toml from 'smol-toml';
import * as actual from '@actual-app/api';

// Auto-load .env from CWD (Python's python-dotenv does this for fints-fetch;
// match that for the Node side so users only maintain one .env file).
// process.loadEnvFile is built-in since Node 21.7. Silent-no-op when .env is missing.
try {
  process.loadEnvFile('.env');
} catch (err) {
  if (err?.code !== 'ENOENT') throw err;
}

const args = parseArgs({
  options: {
    bank: { type: 'string' },
    all: { type: 'boolean', default: false },
    in: { type: 'string' },
    config: { type: 'string', default: 'banks.toml' },
    'data-dir': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'seed-balance': { type: 'boolean', default: false },
  },
}).values;

if (!args.bank && !args.all) {
  console.error('Usage: actual-import (--bank <name> | --all) [--in <path>] [--dry-run]');
  process.exit(2);
}
if (args.bank && args.all) {
  console.error('--bank and --all are mutually exclusive');
  process.exit(2);
}

const cfgText = await fs.readFile(args.config, 'utf8').catch((err) => {
  console.error(`Cannot read ${args.config}: ${err.message}`);
  process.exit(1);
});
const cfg = toml.parse(cfgText);

const actualCfg = cfg.actual;
if (!actualCfg) {
  console.error('Missing [actual] section in banks.toml');
  process.exit(1);
}
const password = process.env[actualCfg.password_env];
if (!password) {
  console.error(`Missing env var ${actualCfg.password_env} for the Actual server password`);
  process.exit(1);
}
const budgetPassword = actualCfg.budget_password_env ? process.env[actualCfg.budget_password_env] : undefined;

// Returns { byIban: Map, byAccountNumber: Map } so depot accounts (which
// commonly have no IBAN — Baader is one) can be matched by accountnumber.
function loadBankMapping(bankKey) {
  const bank = cfg.banks?.[bankKey];
  if (!bank) {
    console.error(`Bank '${bankKey}' not found in ${args.config}`);
    return null;
  }
  const byIban = new Map();
  const byAccountNumber = new Map();
  for (const acc of bank.accounts ?? []) {
    if (!acc.actual_account_id) continue;
    if (acc.actual_account_id.startsWith('REPLACE')) continue;
    if (acc.iban) byIban.set(acc.iban, acc);
    if (acc.accountnumber) byAccountNumber.set(String(acc.accountnumber), acc);
  }
  if (byIban.size + byAccountNumber.size === 0) {
    console.error(`[${bankKey}] no accounts configured (or all still set to REPLACE-...). Skipping.`);
    return null;
  }
  return { byIban, byAccountNumber };
}

function lookupAccount(mapping, accountBlob) {
  if (accountBlob.iban && mapping.byIban.has(accountBlob.iban)) {
    return mapping.byIban.get(accountBlob.iban);
  }
  if (accountBlob.account_number && mapping.byAccountNumber.has(String(accountBlob.account_number))) {
    return mapping.byAccountNumber.get(String(accountBlob.account_number));
  }
  return null;
}

const inputJson = args.in
  ? await fs.readFile(args.in, 'utf8')
  : await new Promise((resolve, reject) => {
      let chunks = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => (chunks += c));
      process.stdin.on('end', () => resolve(chunks));
      process.stdin.on('error', reject);
    });

const payload = JSON.parse(inputJson);

// Normalize: support both `{banks: [...]}` (multi) and legacy `{bank, accounts}` (single).
const bankPayloads = payload.banks ?? (payload.bank ? [{ bank: payload.bank, accounts: payload.accounts ?? [] }] : []);
if (bankPayloads.length === 0) {
  console.error('Empty payload (no banks)');
  process.exit(1);
}

// If --bank was passed, restrict to that one. Otherwise process every payload.
const filtered = args.bank
  ? bankPayloads.filter((p) => p.bank?.key === args.bank)
  : bankPayloads;
if (args.bank && filtered.length === 0) {
  console.error(`Payload contains no entry for bank '${args.bank}'. Available: ${bankPayloads.map((p) => p.bank?.key).join(', ')}`);
  process.exit(1);
}

const txByActualId = new Map(); // actual_account_id -> Actual transaction records
const actualIdToBank = new Map(); // actual_account_id -> bank key (for status report)
// Depot accounts are handled differently — instead of importTransactions we
// emit a single balance-adjustment transaction per account so the Actual balance
// equals the sum of holdings' current market value. Holdings detail is exported
// separately to <bridge>/holdings.json for the SQLite db-sync to pick up.
const depotJobs = [];   // [{ bank, accountBlob, acc }]
const allHoldings = []; // raw holding rows for holdings.json
for (const bp of filtered) {
  const bankKey = bp.bank?.key;
  if (!bankKey) {
    console.error('[skip] payload entry missing bank.key');
    continue;
  }
  const mapping = loadBankMapping(bankKey);
  if (!mapping) continue;
  for (const accountBlob of bp.accounts ?? []) {
    const acc = lookupAccount(mapping, accountBlob);
    if (!acc) {
      console.error(`[${bankKey}] [skip] account iban=${accountBlob.iban || '-'} accountnumber=${accountBlob.account_number || '-'} not in banks.toml mapping`);
      continue;
    }
    actualIdToBank.set(acc.actual_account_id, bankKey);

    if (accountBlob.type === 'depot') {
      depotJobs.push({ bankKey, accountBlob, acc });
      for (const h of accountBlob.holdings ?? []) {
        allHoldings.push({
          bank: bankKey,
          depot_iban: accountBlob.iban,
          depot_actual_account_id: acc.actual_account_id,
          depot_display_name: acc.display_name ?? accountBlob.iban,
          ...h,
        });
      }
      const total = (accountBlob.holdings ?? []).reduce((s, h) => s + (h.total_value_cents || 0), 0);
      console.error(`[${bankKey}] [depot] ${accountBlob.iban} (${acc.display_name ?? '?'}) → ${(accountBlob.holdings ?? []).length} holdings, total €${(total / 100).toFixed(2)}`);
      continue;
    }

    const records = (accountBlob.transactions ?? []).map((t) => ({
      date: t.date,
      amount: t.amount_cents,
      payee_name: t.payee_name ?? undefined,
      imported_payee: t.payee_name ?? undefined,
      notes: t.notes ?? undefined,
      imported_id: t.imported_id,
      cleared: t.status === 'BOOK',
    })).filter((r) => r.date && Number.isFinite(r.amount));

    // Optional opening-balance seed: emit a synthetic transaction equal to OPBD
    // dated one day before the OPBD date. Stable imported_id => idempotent across runs.
    if (args['seed-balance']) {
      const opbd = (accountBlob.balances ?? []).find((b) => b.type === 'OPBD');
      if (opbd && opbd.date && Number.isFinite(opbd.amount_cents)) {
        const seedDate = new Date(opbd.date + 'T00:00:00Z');
        seedDate.setUTCDate(seedDate.getUTCDate() - 1);
        const iso = seedDate.toISOString().slice(0, 10);
        records.unshift({
          date: iso,
          amount: opbd.amount_cents,
          payee_name: 'Opening Balance',
          imported_payee: 'Opening Balance',
          notes: `Seeded from camt.052 OPBD ${opbd.date} ${(opbd.amount_cents / 100).toFixed(2)} ${opbd.currency}`,
          imported_id: `fints-bridge-opening-balance-${acc.actual_account_id}`,
          cleared: true,
        });
        console.error(`[${bankKey}] [seed] ${accountBlob.iban} opening-balance ${(opbd.amount_cents / 100).toFixed(2)} ${opbd.currency} dated ${iso}`);
      }
    }

    console.error(`[${bankKey}] [map] ${accountBlob.iban} (${acc.display_name ?? '?'}) → actual=${acc.actual_account_id}: ${records.length} records`);
    txByActualId.set(acc.actual_account_id, (txByActualId.get(acc.actual_account_id) ?? []).concat(records));
  }
}

if (args.dry_run || args['dry-run']) {
  console.log(JSON.stringify(Object.fromEntries(txByActualId), null, 2));
  process.exit(0);
}

const dataDir = args['data-dir'] ?? join(tmpdir(), 'fints-actual-bridge');
await fs.mkdir(dataDir, { recursive: true });

// ACTUAL_SERVER_URL env wins over banks.toml so the daemon container can use
// the internal docker DNS name (http://actual_server:5006) instead of the
// public Caddy URL — bypasses TLS / hairpin-NAT issues when running in-cluster.
const serverUrl = process.env.ACTUAL_SERVER_URL || actualCfg.server_url;
console.error(`[actual] init server=${serverUrl} dataDir=${dataDir}`);
await actual.init({ dataDir, serverURL: serverUrl, password });
try {
  console.error(`[actual] downloadBudget syncId=${actualCfg.sync_id}`);
  await actual.downloadBudget(actualCfg.sync_id, budgetPassword ? { password: budgetPassword } : undefined);

  let totalAdded = 0;
  let totalUpdated = 0;
  const perBank = new Map();  // bank key -> { added, updated }
  for (const [actualId, records] of txByActualId.entries()) {
    if (records.length === 0) continue;
    console.error(`[actual] importTransactions account=${actualId} count=${records.length}`);
    const result = await actual.importTransactions(actualId, records);
    const added = result?.added?.length ?? 0;
    const updated = result?.updated?.length ?? 0;
    totalAdded += added;
    totalUpdated += updated;
    const bankKey = actualIdToBank.get(actualId);
    if (bankKey) {
      const bucket = perBank.get(bankKey) ?? { added: 0, updated: 0 };
      bucket.added += added;
      bucket.updated += updated;
      perBank.set(bankKey, bucket);
    }
    console.error(`[actual]   added=${added} updated=${updated}`);
  }
  console.error(`[actual] DONE  total added=${totalAdded}  total updated=${totalUpdated}`);

  // Depot revaluation: for each depot account, write a single "Holdings
  // revaluation" tx so the Actual balance equals SUM(holdings.total_value).
  // Strategy: delete any prior revaluation tx (any date), recompute the delta
  // from scratch, then write the fresh adjustment. This is robust to re-runs
  // and to interleaving with stock-buy transfers — without it, the bridge
  // would over- or under-state the depot if transfers landed between fetches.
  const REVALUATION_PREFIX = 'fints-bridge-depot-revaluation-';
  for (const job of depotJobs) {
    const target = (job.accountBlob.holdings ?? []).reduce((s, h) => s + (h.total_value_cents || 0), 0);
    const today = new Date().toISOString().slice(0, 10);

    // Compute the depot balance EXCLUDING any prior revaluation txs (since we'll
    // delete them and replace with a fresh one). Computing manually instead of
    // calling getAccountBalance() avoids a cache issue: getAccountBalance still
    // includes deleted-but-not-synced txs, which would break the delta math.
    const existingTxs = await actual.getTransactions(job.acc.actual_account_id, '1900-01-01', '2100-01-01');
    const priorRevals = existingTxs.filter((t) => (t.imported_id ?? '').startsWith(REVALUATION_PREFIX));
    const nonRevalSum = existingTxs
      .filter((t) => !(t.imported_id ?? '').startsWith(REVALUATION_PREFIX))
      .reduce((s, t) => s + t.amount, 0);
    for (const t of priorRevals) await actual.deleteTransaction(t.id);
    if (priorRevals.length) console.error(`[depot-reval] ${job.bankKey} ${job.acc.display_name}: cleared ${priorRevals.length} prior revaluation tx(s)`);

    const current = nonRevalSum;
    const delta = target - current;
    if (delta === 0) {
      console.error(`[depot-reval] ${job.bankKey} ${job.acc.display_name}: balance already €${(target / 100).toFixed(2)}, no adjustment`);
      continue;
    }
    const result = await actual.importTransactions(job.acc.actual_account_id, [{
      date: today,
      amount: delta,
      payee_name: 'Holdings revaluation',
      imported_payee: 'Holdings revaluation',
      notes: `Auto-adjustment so depot balance equals SUM(holdings.total_value) = €${(target / 100).toFixed(2)}`,
      imported_id: `fints-bridge-depot-revaluation-${job.acc.actual_account_id}-${today}`,
      cleared: true,
    }]);
    const added = result?.added?.length ?? 0;
    const updated = result?.updated?.length ?? 0;
    console.error(`[depot-reval] ${job.bankKey} ${job.acc.display_name}: ${current/100}€ → ${target/100}€ (delta ${delta/100}€)  added=${added} updated=${updated}`);
    // Make sure this bank shows a fresh last_run even if it had no cash txs.
    const bucket = perBank.get(job.bankKey) ?? { added: 0, updated: 0 };
    bucket.added += added;
    bucket.updated += updated;
    perBank.set(job.bankKey, bucket);
  }

  // State files (status + holdings) live under STATE_DIR — defaults to the
  // bridge directory itself, but the daemon container sets it to /state so
  // the files land on the volume db-sync also mounts.
  const stateDir = process.env.STATE_DIR
    ? process.env.STATE_DIR
    : new URL('..', import.meta.url).pathname;

  // Holdings snapshot for db-sync to import into SQLite (current + history).
  if (!args['dry-run'] && allHoldings.length > 0) {
    const holdingsPath = join(stateDir, 'holdings.json');
    const holdingsPayload = {
      fetched_at: new Date().toISOString(),
      holdings: allHoldings,
    };
    await fs.writeFile(holdingsPath, JSON.stringify(holdingsPayload, null, 2) + '\n');
    console.error(`[holdings] wrote ${holdingsPath} (${allHoldings.length} positions)`);
  }

  // Status marker: read by actual_db_sync for the pipeline_status table. We
  // merge into existing entries so a single-bank import doesn't drop the other
  // bank's last-run record.
  if (!args['dry-run']) {
    const statusPath = join(stateDir, 'fints-status.json');
    let status = { last_runs: {} };
    try {
      const existing = await fs.readFile(statusPath, 'utf8');
      status = { last_runs: {}, ...JSON.parse(existing) };
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const ts = new Date().toISOString();
    for (const [bankKey, bucket] of perBank.entries()) {
      status.last_runs[bankKey] = { ts, ...bucket };
    }
    await fs.writeFile(statusPath, JSON.stringify(status, null, 2) + '\n');
    console.error(`[status] wrote ${statusPath}`);
  }
} finally {
  await actual.shutdown();
}

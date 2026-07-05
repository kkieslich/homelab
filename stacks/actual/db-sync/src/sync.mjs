// Pull a fresh snapshot from Actual and write it into a SQLite read-replica.
// Re-uses cli/src/commands/{fetch,subs}.mjs for snapshot construction and
// subscription detection so business logic isn't duplicated.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from '@actual-app/api';
import Database from 'better-sqlite3';
import { detectSubscriptions } from '../../cli/src/commands/subs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8');

export async function buildSnapshot() {
  const accounts = await api.getAccounts();
  const categoryGroups = await api.getCategoryGroups();
  const categories = await api.getCategories();
  const payees = await api.getPayees();
  const transactions = [];
  for (const acct of accounts) {
    const txs = await api.getTransactions(acct.id, '1900-01-01', '2100-01-01');
    for (const t of txs) transactions.push({ ...t, account_name: acct.name });
  }
  const balances = {};
  for (const acct of accounts) {
    balances[acct.id] = await api.getAccountBalance(acct.id);
  }
  return { accounts, categoryGroups, categories, payees, transactions, balances };
}

async function readJsonIfExists(p) {
  if (!p) return null;
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

// Replace the contents of every table in a single transaction. SQLite WAL mode
// keeps Grafana queries non-blocking against the previous snapshot.
export async function syncToSqlite(dbPath, fintsStatusPath, holdingsPath, budgetPath) {
  const snapshot = await buildSnapshot();
  const fintsStatus = await readJsonIfExists(fintsStatusPath);
  const holdingsBlob = await readJsonIfExists(holdingsPath);
  const budgetBlob = await readJsonIfExists(budgetPath);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // DELETE journal (not WAL) so readers like Grafana don't need to create
  // -shm/-wal sidecar files in the volume directory, which they can't because
  // the dir is owned by root from this container. Tradeoff: Grafana queries
  // briefly block during our transaction (~2-3s every 5 min). Acceptable.
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA_SQL);

  const groupNameById = new Map(snapshot.categoryGroups.map((g) => [g.id, g.name]));
  const catById = new Map(snapshot.categories.map((c) => [c.id, c]));
  const payeeNameById = new Map(snapshot.payees.map((p) => [p.id, p.name]));

  const insertAccount = db.prepare(
    'INSERT INTO accounts (id, name, offbudget, closed, balance_cents) VALUES (?, ?, ?, ?, ?)',
  );
  const insertCategory = db.prepare(
    'INSERT INTO categories (id, name, group_name, is_income) VALUES (?, ?, ?, ?)',
  );
  const insertPayee = db.prepare(
    'INSERT INTO payees (id, name, transfer_account_id) VALUES (?, ?, ?)',
  );
  const insertTx = db.prepare(`
    INSERT INTO transactions (
      id, date, account_id, account_name, account_offbudget,
      amount_cents, payee_id, payee_name,
      category_id, category_name, category_group_name, category_is_income,
      notes, cleared, reconciled, transfer_id, is_transfer, imported_id,
      year, month, ymd_unix
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSub = db.prepare(`
    INSERT INTO subscriptions (
      payee_id, payee_name, cadence, per_year,
      median_cents, min_cents, max_cents, annualized_cents,
      count, first_seen, last_seen, days_since_last, is_active, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPipeline = db.prepare(
    'INSERT INTO pipeline_status (source, last_run_iso, added, updated) VALUES (?, ?, ?, ?)',
  );
  const insertHolding = db.prepare(`
    INSERT INTO holdings (
      depot_account_id, depot_account_name, isin, name, pieces,
      market_value_cents, total_value_cents, currency,
      valuation_date, acquisition_price_cents
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertHoldingHistory = db.prepare(`
    INSERT OR IGNORE INTO holdings_history (
      snapshot_iso, snapshot_unix, depot_account_id, isin, name, pieces, total_value_cents
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBudget = db.prepare(
    'INSERT INTO budgets (category_name, monthly_cents) VALUES (?, ?)',
  );
  const accountNameById = new Map(snapshot.accounts.map((a) => [a.id, a.name]));

  const txn = db.transaction(() => {
    // holdings_history is intentionally NOT deleted — it's append-only.
    db.exec('DELETE FROM accounts; DELETE FROM categories; DELETE FROM payees; DELETE FROM transactions; DELETE FROM subscriptions; DELETE FROM pipeline_status; DELETE FROM holdings; DELETE FROM budgets;');

    const offBudget = new Set(snapshot.accounts.filter((a) => a.offbudget).map((a) => a.id));

    for (const a of snapshot.accounts) {
      insertAccount.run(a.id, a.name, a.offbudget ? 1 : 0, a.closed ? 1 : 0, snapshot.balances[a.id] ?? 0);
    }
    for (const c of snapshot.categories) {
      insertCategory.run(c.id, c.name, groupNameById.get(c.group_id) ?? null, c.is_income ? 1 : 0);
    }
    for (const p of snapshot.payees) {
      insertPayee.run(p.id, p.name, p.transfer_acct ?? null);
    }
    for (const t of snapshot.transactions) {
      const cat = t.category ? catById.get(t.category) : null;
      const ymd = (t.date ?? '1970-01-01').slice(0, 10);
      const [y, m, d] = ymd.split('-').map(Number);
      const ymdUnix = Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 1000);
      insertTx.run(
        t.id,
        ymd,
        t.account,
        t.account_name ?? '',
        offBudget.has(t.account) ? 1 : 0,
        t.amount,
        t.payee ?? null,
        t.payee ? (payeeNameById.get(t.payee) ?? null) : null,
        t.category ?? null,
        cat?.name ?? null,
        cat ? (groupNameById.get(cat.group_id) ?? null) : null,
        cat?.is_income ? 1 : 0,
        t.notes ?? null,
        t.cleared ? 1 : 0,
        t.reconciled ? 1 : 0,
        t.transfer_id ?? null,
        t.transfer_id ? 1 : 0,
        t.imported_id ?? null,
        y || 1970,
        ymd.slice(0, 7),
        ymdUnix,
      );
    }

    // Subscriptions table — uses the same cli detector.
    const subs = detectSubscriptions(snapshot);
    for (const s of subs) {
      insertSub.run(
        s.payeeId, s.payee, s.cadence, s.perYear,
        s.median, s.min, s.max, s.annualizedCents,
        s.count, s.firstDate, s.lastDate, s.daysSinceLast,
        s.isActive ? 1 : 0, s.confidence,
      );
    }

    // Pipeline status: one row per bank from fints-status.json + a 'sync' row
    // updated by us so dashboards know when this container last ran. Age is
    // computed live in dashboard queries, never stored.
    const now = new Date();
    if (fintsStatus?.last_runs) {
      for (const [bank, run] of Object.entries(fintsStatus.last_runs)) {
        if (!run?.ts) continue;
        insertPipeline.run(bank, run.ts, run.added ?? null, run.updated ?? null);
      }
    }
    insertPipeline.run('sync', now.toISOString(), null, null);

    // Holdings: drop+re-insert current snapshot, append to history.
    if (holdingsBlob?.holdings?.length) {
      const snapIso = holdingsBlob.fetched_at ?? now.toISOString();
      const snapUnix = Math.floor(new Date(snapIso).getTime() / 1000);
      for (const h of holdingsBlob.holdings) {
        const acctName = accountNameById.get(h.depot_actual_account_id) ?? h.depot_display_name ?? '?';
        insertHolding.run(
          h.depot_actual_account_id, acctName,
          h.isin, h.name, h.pieces ?? 0,
          h.market_value_cents ?? 0, h.total_value_cents ?? 0,
          h.currency ?? 'EUR',
          h.valuation_date ?? null,
          h.acquisition_price_cents ?? null,
        );
        insertHoldingHistory.run(
          snapIso, snapUnix,
          h.depot_actual_account_id, h.isin, h.name,
          h.pieces ?? 0, h.total_value_cents ?? 0,
        );
      }
    }

    // Budget targets from cli/config/budget.json. Drop+insert each cycle so
    // edits to the JSON propagate immediately on next sync.
    if (budgetBlob?.monthly_budgets) {
      for (const [name, eur] of Object.entries(budgetBlob.monthly_budgets)) {
        if (typeof eur !== 'number') continue;
        insertBudget.run(name, Math.round(eur * 100));
      }
    }
  });
  txn();

  const counts = {
    accounts: db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,
    transactions: db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n,
    subscriptions: db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n,
    holdings: db.prepare('SELECT COUNT(*) AS n FROM holdings').get().n,
    holdings_history: db.prepare('SELECT COUNT(*) AS n FROM holdings_history').get().n,
    budgets: db.prepare('SELECT COUNT(*) AS n FROM budgets').get().n,
  };
  db.close();
  // Make sure Grafana (UID 472) can read regardless of who wrote the file.
  fs.chmodSync(dbPath, 0o644);
  return counts;
}

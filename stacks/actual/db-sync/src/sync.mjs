// Pull a fresh snapshot from Actual and write it into a SQLite read-replica.
// Re-uses cli/src/commands/{fetch,subs}.mjs for snapshot construction and
// subscription detection so business logic isn't duplicated.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as api from '@actual-app/api';
import Database from 'better-sqlite3';
import { detectSubscriptions } from '../../cli/src/commands/subs.mjs';
import { deriveCategoryRole, validateCategoryGroups } from './semantics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8');

export function capturedDay(value, timeZone = process.env.ACTUAL_TIMEZONE ?? 'Europe/Berlin') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function buildSnapshot() {
  const accounts = await api.getAccounts();
  const metadataResult = await api.aqlQuery(api.q('accounts').select(['id', 'last_reconciled']));
  const metadata = new Map((metadataResult?.data ?? []).map((account) => [account.id, account]));
  for (const account of accounts) account.last_reconciled = metadata.get(account.id)?.last_reconciled ?? null;
  const categoryGroups = await api.getCategoryGroups();
  const categories = await api.getCategories();
  const payees = await api.getPayees();
  const transactions = [];
  for (const acct of accounts) {
    const txs = await api.getTransactions(acct.id, '1900-01-01', '2100-01-01');
    for (const t of txs) transactions.push({ ...t, account_name: acct.name });
  }
  const balances = {};
  const balanceAsOf = {};
  const timeZone = process.env.ACTUAL_TIMEZONE ?? 'Europe/Berlin';
  const cutoffDay = capturedDay(new Date(), timeZone);
  const cutoff = new Date(`${cutoffDay}T12:00:00Z`);
  for (const acct of accounts) {
    balances[acct.id] = await api.getAccountBalance(acct.id, cutoff);
    balanceAsOf[acct.id] = cutoffDay;
  }
  const budgetMonths = [];
  for (const month of await api.getBudgetMonths()) budgetMonths.push(await api.getBudgetMonth(month));
  const schedules = await api.getSchedules();
  return {
    accounts, categoryGroups, categories, payees, transactions, balances, balanceAsOf, budgetMonths, schedules,
    schedulesFetchedAt: new Date().toISOString(),
  };
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

async function readManifests(directory) {
  if (!directory) return [];
  let names;
  try { names = await fsp.readdir(directory); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const manifests = [];
  for (const name of names.filter((name) => name.endsWith('.json')).sort()) {
    const value = await readJsonIfExists(path.join(directory, name));
    if (value?.schema_version === 1 && value.run_id && value.source && value.finished_at) manifests.push(value);
  }
  return manifests;
}

async function readExpectedSources(registryPath, supplied) {
  const entries = supplied ?? await readJsonIfExists(registryPath);
  if (!Array.isArray(entries)) throw new Error('Expected-source registry is missing or invalid');
  const sources = new Map();
  for (const entry of entries) {
    if (!entry?.source || (!supplied && !entry.enabled)) continue;
    const accountId = entry.actual_account_id ?? entry.account_id;
    if (!accountId) throw new Error('Expected-source account id is missing');
    const cadence = entry.expected_cadence_seconds;
    if (sources.has(accountId)) throw new Error(`Duplicate expected account: ${accountId}`);
    sources.set(accountId, { source: entry.source, expected_cadence_seconds: cadence ?? null });
  }
  return [...sources].map(([account_id, value]) => ({ account_id, ...value }));
}

function ensureSchemaMigrations(db) {
  const columns = db.prepare("SELECT name FROM pragma_table_info('transactions')").pluck().all();
  if (columns.length > 0 && !columns.includes('category_role')) db.exec('ALTER TABLE transactions ADD COLUMN category_role TEXT');
  const quality = db.prepare("SELECT name FROM pragma_table_info('data_quality')").pluck().all();
  if (quality.length > 0 && !quality.includes('severity')) {
    db.exec("ALTER TABLE data_quality ADD COLUMN severity TEXT NOT NULL DEFAULT 'warning'");
  }
  if (quality.length > 0 && !quality.includes('producer')) {
    db.exec("ALTER TABLE data_quality ADD COLUMN producer TEXT NOT NULL DEFAULT 'manual'");
  }
  const expected = db.prepare("SELECT name FROM pragma_table_info('expected_sources')").pluck().all();
  if (expected.length > 0 && !expected.includes('account_id')) db.exec('DROP TABLE expected_sources');
}

function scheduleRole(name) {
  const match = /^\[(Fixed|Essential|Discretionary|Sinking fund|Savings|Income)\]\s+/iu.exec(String(name ?? ''));
  if (!match) return null;
  return match[1].toLocaleLowerCase('und').replaceAll(' ', '_');
}

function validIsoDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ''))) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function validSourceInstant(value, now) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() <= now.getTime() + 5 * 60 * 1000;
}

function normalizedPayee(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
}

function duplicateCandidates(transactions, payeeNameById, checkedAt) {
  const groups = new Map();
  for (const transaction of transactions) {
    if (transaction.transfer_id || transaction.amount >= 0) continue;
    if (/^fints-bridge-(opening-balance|depot-revaluation)-/u.test(transaction.imported_id ?? '')) continue;
    const key = [transaction.account, transaction.date, transaction.amount,
      normalizedPayee(payeeNameById.get(transaction.payee))].join('\u0000');
    const group = groups.get(key) ?? [];
    group.push(transaction.id);
    groups.set(key, group);
  }
  return [...groups.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({
    check_id: `duplicate_candidate:${createHash('sha256').update(`${key}\u0000${ids.slice().sort().join('\u0000')}`).digest('hex').slice(0, 24)}`,
    checked_at: checkedAt,
    kind: 'duplicate_candidate',
    account_id: key.split('\u0000')[0],
    detail: JSON.stringify({ transaction_ids: ids.slice().sort(), classification: 'fuzzy_review_only' }),
  }));
}

// Replace the contents of every table in a single transaction. SQLite WAL mode
// keeps Grafana queries non-blocking against the previous snapshot.
export async function syncToSqlite(dbPath, fintsStatusPath, holdingsPath, manifestDir, registryPath, options = {}) {
  const snapshot = options.snapshot ?? await buildSnapshot();
  // Semantic validation deliberately happens before opening or modifying the
  // replica, so a bad Actual category setup leaves the prior file readable.
  validateCategoryGroups(snapshot.categoryGroups);
  const fintsStatus = await readJsonIfExists(fintsStatusPath);
  const holdingsBlob = await readJsonIfExists(holdingsPath);
  // During the transition, the fourth argument may still be the retired
  // budget.json path. Manifests share the FinTS state volume.
  const effectiveManifestDir = manifestDir?.endsWith('.json')
    ? path.join(path.dirname(fintsStatusPath), 'import-runs')
    : manifestDir;
  const manifests = await readManifests(effectiveManifestDir);
  const expectedSources = await readExpectedSources(registryPath, options.expectedSources);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // DELETE journal (not WAL) so readers like Grafana don't need to create
  // -shm/-wal sidecar files in the volume directory, which they can't because
  // the dir is owned by root from this container. Tradeoff: Grafana queries
  // briefly block during our transaction (~2-3s every 5 min). Acceptable.
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = NORMAL');
  let counts;
  try {
    db.exec('BEGIN IMMEDIATE');
    ensureSchemaMigrations(db);
    db.exec(SCHEMA_SQL);

  const groupNameById = new Map(snapshot.categoryGroups.map((g) => [g.id, g.name]));
  const groupById = new Map(snapshot.categoryGroups.map((g) => [g.id, g]));
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
      category_id, category_name, category_group_name, category_role, category_is_income,
      notes, cleared, reconciled, transfer_id, is_transfer, imported_id,
      year, month, ymd_unix
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  const insertCurrentBudget = db.prepare(`INSERT INTO current_budgets
    (month,category_id,category_name,category_role,budgeted_cents,spent_cents,balance_cents,carried_cents)
    VALUES (?,?,?,?,?,?,?,?)`);
  const insertExpectedSource = db.prepare(
    'INSERT INTO expected_sources (account_id,source,expected_cadence_seconds) VALUES (?,?,?)',
  );
  const insertRun = db.prepare(`INSERT OR REPLACE INTO pipeline_runs
    (run_id,source,started_at,finished_at,requested_from,requested_to,importer_version,
     fetched,valid,added,updated,quarantined,outcome,error_code,expected_cadence_seconds,resolved)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertRunAccount = db.prepare(`INSERT OR REPLACE INTO pipeline_run_accounts
    (run_id,account_id,source,requested_from,requested_to,outcome,
     fetched,valid,added,updated,quarantined) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insertAccountProjection = db.prepare(`INSERT INTO account_projection
    (account_id,balance_as_of,last_reconciled,checked_at) VALUES (?,?,?,?)`);
  const insertBudgetProjection = db.prepare(`INSERT INTO budget_projection
    (fetched_at,complete,current_month,max_age_seconds,detail) VALUES (?,?,?,?,?)`);
  const accountNameById = new Map(snapshot.accounts.map((a) => [a.id, a.name]));
  const insertSchedule = db.prepare(`INSERT INTO current_schedules
    (id,name,role,due_date,amount_cents,completed,fetched_at) VALUES (?,?,?,?,?,?,?)`);
  const insertScheduleProjection = db.prepare(`INSERT INTO schedule_projection
    (fetched_at,complete,detail,max_age_seconds) VALUES (?,?,?,?)`);
  const insertQuality = db.prepare(`INSERT INTO data_quality
    (check_id,checked_at,kind,source,account_id,detail,value_cents,resolved,severity,producer)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const priorQualityResolutions = new Map(db.prepare(
    "SELECT check_id,resolved FROM data_quality WHERE producer='db-sync'",
  ).all().map((row) => [row.check_id, row.resolved]));

  {
    // holdings_history is intentionally NOT deleted — it's append-only.
    db.exec("DELETE FROM accounts; DELETE FROM account_projection; DELETE FROM categories; DELETE FROM payees; DELETE FROM transactions; DELETE FROM subscriptions; DELETE FROM pipeline_status; DELETE FROM holdings; DELETE FROM budgets; DELETE FROM current_budgets; DELETE FROM budget_projection; DELETE FROM expected_sources; DELETE FROM current_schedules; DELETE FROM schedule_projection; DELETE FROM data_quality WHERE producer='db-sync';");

    for (const source of expectedSources) {
      insertExpectedSource.run(source.account_id, source.source, source.expected_cadence_seconds);
    }

    const offBudget = new Set(snapshot.accounts.filter((a) => a.offbudget).map((a) => a.id));

    for (const a of snapshot.accounts) {
      insertAccount.run(a.id, a.name, a.offbudget ? 1 : 0, a.closed ? 1 : 0, snapshot.balances[a.id] ?? 0);
      if (validIsoDay(snapshot.balanceAsOf?.[a.id])) {
        insertAccountProjection.run(a.id, snapshot.balanceAsOf[a.id],
          validIsoDay(a.last_reconciled) ? a.last_reconciled : null, (options.now ?? new Date()).toISOString());
      }
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
        cat && !groupById.get(cat.group_id)?.hidden
          ? deriveCategoryRole(groupNameById.get(cat.group_id))
          : null,
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

    const projectionNow = options.now ?? new Date();
    const capturedAt = projectionNow.toISOString();
    const schedulesFetchedAt = snapshot.schedulesFetchedAt ?? capturedAt;
    const schedules = snapshot.schedules;
    if (!Array.isArray(schedules) || !validSourceInstant(schedulesFetchedAt, projectionNow)) {
      insertScheduleProjection.run(schedulesFetchedAt, 0,
        !Array.isArray(schedules) ? 'schedules_missing' : 'source_timestamp_invalid', 900);
    } else {
      const errors = new Set();
      for (const schedule of schedules) {
        if (typeof schedule.completed !== 'boolean') {
          errors.add('completed_type');
          continue;
        }
        if (schedule.completed) continue;
        const role = scheduleRole(schedule.name);
        const signValid = role === 'income' ? schedule.amount > 0 : schedule.amount < 0;
        if (!schedule.id || !schedule.name) errors.add('identity');
        if (!role) errors.add('role');
        if (!validIsoDay(schedule.next_date)) errors.add('next_date');
        if (schedule.amountOp !== 'is') errors.add('amount_op');
        if (!Number.isInteger(schedule.amount)) errors.add('amount');
        if (Number.isInteger(schedule.amount) && role && !signValid) errors.add('amount_sign');
        const valid = schedule.id && schedule.name && role && validIsoDay(schedule.next_date)
          && schedule.amountOp === 'is' && Number.isInteger(schedule.amount) && signValid;
        if (!valid) continue;
        insertSchedule.run(schedule.id, schedule.name ?? 'Unnamed schedule', role, schedule.next_date ?? null,
          schedule.amount, 0, schedulesFetchedAt);
      }
      insertScheduleProjection.run(schedulesFetchedAt, errors.size === 0 ? 1 : 0,
        errors.size === 0 ? 'authoritative_actual_api' : `invalid_active_schedule:${[...errors].sort().join(',')}`, 900);
    }

    for (const candidate of duplicateCandidates(snapshot.transactions, payeeNameById, capturedAt)) {
      insertQuality.run(candidate.check_id, candidate.checked_at, candidate.kind, 'actual-api',
        candidate.account_id, candidate.detail, null, priorQualityResolutions.get(candidate.check_id) ?? 0,
        'warning', 'db-sync');
    }
    const reconciliationCutoff = new Date(`${capturedDay(projectionNow)}T12:00:00Z`);
    reconciliationCutoff.setUTCDate(reconciliationCutoff.getUTCDate() - 35);
    const reconciliationDay = reconciliationCutoff.toISOString().slice(0, 10);
    const capturedDayValue = capturedDay(projectionNow);
    for (const account of snapshot.accounts.filter((account) => !account.closed)) {
      const reconciled = validIsoDay(account.last_reconciled) ? account.last_reconciled : null;
      if (!reconciled) {
        insertQuality.run(`reconciliation_missing:${account.id}`, capturedAt, 'reconciliation_missing',
          'actual-api', account.id, 'No authoritative Actual reconciliation date', null, 0, 'error', 'db-sync');
      } else if (reconciled > capturedDayValue) {
        insertQuality.run(`reconciliation_future:${account.id}:${reconciled}`, capturedAt, 'reconciliation_future',
          'actual-api', account.id, JSON.stringify({ last_reconciled: reconciled, captured_day: capturedDayValue }),
          null, 0, 'error', 'db-sync');
      } else if (reconciled < reconciliationDay) {
        insertQuality.run(`reconciliation_stale:${account.id}:${reconciled}`, capturedAt, 'reconciliation_stale',
          'actual-api', account.id, JSON.stringify({ last_reconciled: reconciled, max_age_days: 35 }),
          null, 0, 'error', 'db-sync');
      }
    }
    for (const monthData of snapshot.budgetMonths ?? []) {
      for (const group of monthData.categoryGroups ?? []) {
        if (group.is_income || group.hidden) continue;
        const role = deriveCategoryRole(group.name);
        for (const category of group.categories ?? []) {
          insertCurrentBudget.run(
            monthData.month, category.id, category.name, role,
            category.budgeted ?? 0, category.spent ?? 0, category.balance ?? 0,
            typeof category.carryover === 'number'
              ? category.carryover
              : category.carryover ? (category.balance ?? 0) - (category.budgeted ?? 0) - (category.spent ?? 0) : 0,
          );
        }
      }
    }
    const currentMonth = capturedDay(projectionNow).slice(0, 7);
    const currentRows = db.prepare('SELECT COUNT(*) FROM current_budgets WHERE month=?').pluck().get(currentMonth);
    insertBudgetProjection.run(capturedAt, currentRows > 0 ? 1 : 0,
      currentRows > 0 ? currentMonth : null, 900, currentRows > 0 ? 'authoritative_actual_api' : 'current_month_missing');
    for (const manifest of manifests) {
      const totals = (manifest.accounts ?? []).reduce((sum, account) => {
        for (const key of ['fetched', 'valid', 'added', 'updated', 'quarantined']) sum[key] += Number(account[key]) || 0;
        return sum;
      }, { fetched: 0, valid: 0, added: 0, updated: 0, quarantined: 0 });
      insertRun.run(
        manifest.run_id, manifest.source, manifest.started_at ?? null, manifest.finished_at,
        manifest.requested_range?.from ?? null, manifest.requested_range?.to ?? null,
        manifest.importer_version ?? null, totals.fetched, totals.valid, totals.added, totals.updated,
        totals.quarantined, manifest.outcome, manifest.error_code ?? null,
        expectedSources.find((source) => source.source === manifest.source)?.expected_cadence_seconds ?? null,
        totals.quarantined === 0 ? 1 : 0,
      );
      for (const account of manifest.accounts ?? []) {
        const expected = expectedSources.find((source) => source.account_id === account.actual_account_id);
        const source = manifest.source === 'unknown' || manifest.source === 'multiple'
          ? expected?.source : manifest.source;
        if (!source) continue;
        insertRunAccount.run(manifest.run_id, account.actual_account_id, source,
          manifest.requested_range?.from ?? null, manifest.requested_range?.to ?? null,
          manifest.outcome, account.fetched ?? null, account.valid ?? null, account.added ?? null,
          account.updated ?? null, account.quarantined ?? 0);
      }
    }
  }

  counts = {
    accounts: db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,
    transactions: db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n,
    subscriptions: db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n,
    holdings: db.prepare('SELECT COUNT(*) AS n FROM holdings').get().n,
    holdings_history: db.prepare('SELECT COUNT(*) AS n FROM holdings_history').get().n,
    budgets: db.prepare('SELECT COUNT(*) AS n FROM current_budgets').get().n,
  };
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
  // Make sure Grafana (UID 472) can read regardless of who wrote the file.
  try {
    fs.chmodSync(dbPath, 0o644);
  } catch (error) {
    console.error(`[sync] warning: could not normalize SQLite permissions (${error?.code ?? 'unknown'})`);
  }
  return counts;
}

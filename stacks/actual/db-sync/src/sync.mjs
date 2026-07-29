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
import { readRunManifests } from '../../fints-actual-bridge/src/importer/manifest.mjs';
import { duplicateCandidateKey, isIsoDay, isSyntheticImportedId } from '../../fints-actual-bridge/src/importer/text.mjs';
import { deriveCategoryRole, validateCategoryGroups } from './semantics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8');

export function capturedDay(value, timeZone = process.env.ACTUAL_TIMEZONE ?? 'Europe/Berlin') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Only the live month and the month being closed are consumed downstream
// (current_budgets readers filter to the current month; month-close reads
// an explicitly-passed month that must already be closed). Closed history
// beyond that is preserved in budget_snapshots at month-close, so there is
// no need to keep re-fetching every budget month since Actual's inception.
export function wantedBudgetMonths(now = new Date()) {
  const currentMonth = capturedDay(now).slice(0, 7);
  const previousStart = new Date(`${currentMonth}-01T00:00:00Z`);
  previousStart.setUTCMonth(previousStart.getUTCMonth() - 1);
  return [currentMonth, previousStart.toISOString().slice(0, 7)];
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
  const wantedMonths = new Set(wantedBudgetMonths());
  for (const month of (await api.getBudgetMonths()).filter((m) => wantedMonths.has(m))) {
    budgetMonths.push(await api.getBudgetMonth(month));
  }
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
  const runAccounts = db.prepare("SELECT name FROM pragma_table_info('pipeline_run_accounts')").pluck().all();
  if (runAccounts.length > 0 && !runAccounts.includes('pending_excluded')) {
    db.exec('ALTER TABLE pipeline_run_accounts ADD COLUMN pending_excluded INTEGER NOT NULL DEFAULT 0');
  }
  if (runAccounts.length > 0 && !runAccounts.includes('bank_balance_cents')) {
    db.exec('ALTER TABLE pipeline_run_accounts ADD COLUMN bank_balance_cents INTEGER');
  }
  if (runAccounts.length > 0 && !runAccounts.includes('bank_balance_as_of')) {
    db.exec('ALTER TABLE pipeline_run_accounts ADD COLUMN bank_balance_as_of TEXT');
  }
  const annotations = db.prepare("SELECT name FROM pragma_table_info('review_queue_annotations')").pluck().all();
  // SQLite cannot add CHECK constraints with ALTER TABLE. Existing replicas get
  // the reviewer column safely; all writes still pass strict CLI validation.
  // Fresh replicas receive the schema-level timestamp/reviewer CHECKs.
  if (annotations.length > 0 && !annotations.includes('reviewer')) {
    db.exec("ALTER TABLE review_queue_annotations ADD COLUMN reviewer TEXT NOT NULL DEFAULT 'legacy'");
  }
}

function scheduleRole(name) {
  const match = /^\[(Fixed|Essential|Discretionary|Sinking fund|Savings|Income)\]\s+/iu.exec(String(name ?? ''));
  if (!match) return null;
  return match[1].toLocaleLowerCase('und').replaceAll(' ', '_');
}

const validIsoDay = isIsoDay;

export function reconciledDay(value, timeZone = process.env.ACTUAL_TIMEZONE ?? 'Europe/Berlin') {
  const raw = String(value ?? '').trim();
  if (validIsoDay(raw)) return raw;
  // The Actual UI reconcile flow stores Date.now().toString() — an
  // epoch-milliseconds string, not a calendar day.
  if (/^\d{12,14}$/u.test(raw)) {
    const parsed = new Date(Number(raw));
    if (Number.isFinite(parsed.getTime())) return capturedDay(parsed, timeZone);
  }
  return null;
}

// Manifests are transport written by another process; re-validate the bank
// balance here rather than trusting it, so a malformed value is dropped
// instead of being projected as authoritative reconciliation evidence.
function manifestBankBalance(value) {
  if (!value || typeof value !== 'object') return null;
  if (!Number.isInteger(value.amount_cents) || !validIsoDay(value.as_of)) return null;
  return { amount_cents: value.amount_cents, as_of: String(value.as_of) };
}

function validSourceInstant(value, now) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() <= now.getTime() + 5 * 60 * 1000;
}

function duplicateCandidates(transactions, payeeNameById, checkedAt) {
  const groups = new Map();
  for (const transaction of transactions) {
    if (transaction.transfer_id || transaction.amount >= 0) continue;
    if (isSyntheticImportedId(transaction.imported_id)) continue;
    const key = duplicateCandidateKey({
      accountId: transaction.account, date: transaction.date,
      amountCents: transaction.amount, payeeIdentity: payeeNameById.get(transaction.payee),
    });
    const group = groups.get(key) ?? [];
    group.push(transaction.id);
    groups.set(key, group);
  }
  return [...groups.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => {
    const identity = { ...JSON.parse(key), transaction_ids: ids.slice().sort(), classification: 'fuzzy_review_only' };
    const detail = JSON.stringify(identity);
    return {
    check_id: `duplicate_candidate:${createHash('sha256').update(detail).digest('hex').slice(0, 24)}`,
    checked_at: checkedAt,
    kind: 'duplicate_candidate',
    account_id: identity.account_id,
    detail,
  }; });
}

// Replace the contents of every table in one transaction. DELETE journaling
// keeps the published file compatible with Grafana's read-only mount.
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
  const expectedSources = await readExpectedSources(registryPath, options.expectedSources);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // DELETE journal (not WAL) so readers like Grafana don't need to create
  // -shm/-wal sidecar files in the volume directory, which they can't because
  // the dir is owned by root from this container. Tradeoff: Grafana queries
  // briefly block during our transaction (~2-3s every 5 min). Acceptable.
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = NORMAL');
  // Manifest IO happens before the write transaction so filesystem reads and
  // JSON parsing never extend the DELETE-journal write lock that briefly
  // blocks Grafana readers. Already-ingested runs are durable in pipeline_runs
  // (the table is never dropped below): manifests written as <run_id>.json are
  // skipped by filename without being opened; a file whose name doesn't match
  // its run_id is still parsed once, then dropped by the post-parse run_id
  // check. On a fresh replica the table doesn't exist yet, so guard the reads
  // and treat every manifest as new.
  const hasPipelineRuns = db.prepare(
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='pipeline_runs'",
  ).pluck().get() > 0;
  const knownRunIds = new Set(
    hasPipelineRuns ? db.prepare('SELECT run_id FROM pipeline_runs').pluck().all() : [],
  );
  const priorRunResolutions = new Map(hasPipelineRuns ? db.prepare(
    'SELECT run_id,resolved FROM pipeline_runs WHERE resolved=1',
  ).all().map((row) => [row.run_id, row.resolved]) : []);
  const manifests = effectiveManifestDir
    ? await readRunManifests(effectiveManifestDir, { skipRunIds: knownRunIds })
    : [];
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
     fetched,valid,added,updated,quarantined,pending_excluded,
     bank_balance_cents,bank_balance_as_of) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
        const failed = [];
        if (!schedule.id || !schedule.name) failed.push('identity');
        if (!role) failed.push('role');
        if (!validIsoDay(schedule.next_date)) failed.push('next_date');
        if (schedule.amountOp !== 'is') failed.push('amount_op');
        if (!Number.isInteger(schedule.amount)) failed.push('amount');
        if (Number.isInteger(schedule.amount) && role
          && !(role === 'income' ? schedule.amount > 0 : schedule.amount < 0)) failed.push('amount_sign');
        if (failed.length) {
          for (const f of failed) errors.add(f);
          continue;
        }
        insertSchedule.run(schedule.id, schedule.name, role, schedule.next_date, schedule.amount, 0, schedulesFetchedAt);
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
        priorRunResolutions.get(manifest.run_id) === 1 ? 1 : (totals.quarantined === 0 ? 1 : 0),
      );
      for (const account of manifest.accounts ?? []) {
        const expected = expectedSources.find((source) => source.account_id === account.actual_account_id);
        const source = manifest.source === 'unknown' || manifest.source === 'multiple'
          ? expected?.source : manifest.source;
        if (!source) continue;
        const bankBalance = manifestBankBalance(account.bank_balance);
        insertRunAccount.run(manifest.run_id, account.actual_account_id, source,
          manifest.requested_range?.from ?? null, manifest.requested_range?.to ?? null,
          account.outcome ?? manifest.outcome, account.fetched ?? null, account.valid ?? null, account.added ?? null,
          account.updated ?? null, account.quarantined ?? 0, account.pending_excluded ?? 0,
          bankBalance?.amount_cents ?? null, bankBalance?.as_of ?? null);
      }
    }

    // Bank-reported balances are authoritative reconciliation evidence and are
    // therefore evaluated AFTER the run projection above, so the run that just
    // landed is already visible in pipeline_run_accounts.
    //
    // Units/sign: the bridge writes bank_balance_cents straight from the
    // camt.052/MT940 CLBD balance, signed with DBIT negative — the same
    // convention as transactions.amount_cents (which is Actual's `amount`, in
    // cents, negative for money out). Actual's own account balance is by
    // definition the sum of its transaction amounts, so Actual's balance on a
    // given day is SUM(amount_cents) WHERE date <= that day, directly
    // comparable to the bank figure with no scaling or negation.
    //
    // 'empty' counts as a successful attempt here exactly as it does in
    // finance_trust's coverage definition: a run that fetched no new
    // transactions still reports a valid closing balance.
    //
    // Two different dates matter here and must not be confused. `as_of` is the
    // ledger cutoff the bank's figure refers to — HKSAL dates its closing
    // balance at the account's LAST BOOKING, so a dormant account reports an
    // old as_of while the amount is perfectly current. `finished_at` is when we
    // asked. Freshness is therefore judged on finished_at (the bank confirmed
    // this today), while as_of only selects which ledger cutoff to compare
    // against. Judging freshness on as_of would make any account that simply
    // has not moved in 35 days permanently unverifiable.
    const latestBankBalance = new Map(db.prepare(`
      SELECT account_id, bank_balance_cents, bank_balance_as_of, finished_at FROM (
        SELECT a.account_id, a.bank_balance_cents, a.bank_balance_as_of, p.finished_at,
          ROW_NUMBER() OVER (PARTITION BY a.account_id
            ORDER BY p.finished_at DESC, a.bank_balance_as_of DESC, a.run_id DESC) rank
        FROM pipeline_run_accounts a JOIN pipeline_runs p ON p.run_id = a.run_id
        WHERE a.outcome IN ('success','empty')
          AND a.bank_balance_cents IS NOT NULL AND a.bank_balance_as_of IS NOT NULL
      ) WHERE rank = 1
    `).all().map((row) => [row.account_id, row]));
    const actualBalanceThrough = db.prepare(
      'SELECT COALESCE(SUM(amount_cents),0) FROM transactions WHERE account_id=? AND date<=?',
    ).pluck();
    // Accounts the bank itself has vouched for; consumed by the reconciliation_*
    // emission loop below in place of a human UI reconcile.
    const bankVerified = new Set();
    for (const account of snapshot.accounts.filter((account) => !account.closed)) {
      const evidence = latestBankBalance.get(account.id);
      // A balance dated in the future is corrupt, not evidence.
      if (!evidence || evidence.bank_balance_as_of > capturedDayValue) continue;
      const actualBalanceCents = actualBalanceThrough.get(account.id, evidence.bank_balance_as_of);
      const differenceCents = actualBalanceCents - evidence.bank_balance_cents;
      const observedDay = String(evidence.finished_at ?? '').slice(0, 10);
      const detail = JSON.stringify({
        bank_balance_cents: evidence.bank_balance_cents, actual_balance_cents: actualBalanceCents,
        as_of: evidence.bank_balance_as_of, observed_at: evidence.finished_at ?? null,
        basis: 'value_cents = actual_balance_cents - bank_balance_cents',
      });
      if (differenceCents === 0) {
        // Only a confirmation obtained inside the same 35-day window used for
        // UI reconciliation staleness may stand in for a UI reconcile. This is
        // the date we ASKED, not the date the bank last booked something.
        if (!validIsoDay(observedDay) || observedDay < reconciliationDay) continue;
        bankVerified.add(account.id);
        insertQuality.run(`reconciliation_bank_verified:${account.id}:${evidence.bank_balance_as_of}`,
          capturedAt, 'reconciliation_bank_verified', 'fints-bridge', account.id, detail, 0, 1, 'info', 'db-sync');
        continue;
      }
      // check_id carries the exact discrepancy: an operator resolving "€5 short
      // as of the 20th" must not silently absorb a different (or grown) gap on
      // the 21st. A gap is operator-resolvable — pending-vs-booked timing and
      // deliberate manual adjustments are legitimate explanations — but only
      // for the one discrepancy that was actually inspected.
      const checkId = `reconciliation_gap:${account.id}:${evidence.bank_balance_as_of}:${differenceCents}`;
      insertQuality.run(checkId, capturedAt, 'reconciliation_gap', 'fints-bridge', account.id, detail,
        differenceCents, priorQualityResolutions.get(checkId) ?? 0, 'error', 'db-sync');
    }

    for (const account of snapshot.accounts.filter((account) => !account.closed)) {
      const reconciled = reconciledDay(account.last_reconciled);
      if (reconciled && reconciled > capturedDayValue) {
        // A future last_reconciled is a corrupt value; bank evidence cannot
        // vouch for it, so this always fires.
        insertQuality.run(`reconciliation_future:${account.id}:${reconciled}`, capturedAt, 'reconciliation_future',
          'actual-api', account.id, JSON.stringify({ last_reconciled: reconciled, captured_day: capturedDayValue }),
          null, 0, 'error', 'db-sync');
      } else if (bankVerified.has(account.id)) {
        continue;
      } else if (!reconciled) {
        insertQuality.run(`reconciliation_missing:${account.id}`, capturedAt, 'reconciliation_missing',
          'actual-api', account.id, 'No authoritative Actual reconciliation date', null, 0, 'error', 'db-sync');
      } else if (reconciled < reconciliationDay) {
        insertQuality.run(`reconciliation_stale:${account.id}:${reconciled}`, capturedAt, 'reconciliation_stale',
          'actual-api', account.id, JSON.stringify({ last_reconciled: reconciled, max_age_days: 35 }),
          null, 0, 'error', 'db-sync');
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

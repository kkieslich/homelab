import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { deriveCategoryRole } from '../src/semantics.mjs';
import { capturedDay, syncToSqlite } from '../src/sync.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(HERE, '../src/schema.sql'), 'utf8');

const roles = {
  'Fixed obligations': 'fixed',
  'Flexible essentials': 'essential',
  Discretionary: 'discretionary',
  'Sinking funds': 'sinking_fund',
  'Savings and investing': 'savings',
  Income: 'income',
};

test('maps the six canonical Actual category groups and rejects unknown groups', () => {
  for (const [name, role] of Object.entries(roles)) assert.equal(deriveCategoryRole(name), role);
  assert.throws(() => deriveCategoryRole('Historic miscellany'), /unknown active category group/i);
});

test('balance cutoff day follows the configured Actual timezone', () => {
  const instant = new Date('2026-07-18T22:30:00Z');
  assert.equal(capturedDay(instant, 'Europe/Berlin'), '2026-07-19');
  assert.equal(capturedDay(instant, 'UTC'), '2026-07-18');
});

function projection() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO schedule_projection (fetched_at,complete,detail) VALUES (datetime('now'),1,'fixture')`).run();
  db.prepare(`INSERT INTO budget_projection (fetched_at,complete,current_month,detail)
    VALUES (datetime('now'),1,strftime('%Y-%m','now'),'fixture')`).run();
  const account = db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?)');
  account.run('checking', 'Checking', 0, 0, 100000);
  account.run('card', 'Card', 0, 0, -2000);
  account.run('depot', 'Depot', 1, 0, 50000);
  const payee = db.prepare('INSERT INTO payees VALUES (?, ?, ?)');
  payee.run('p-depot', 'Transfer: Depot', 'depot');
  payee.run('p-card', 'Transfer: Card', 'card');
  const insert = db.prepare(`INSERT INTO transactions
    (id,date,account_id,account_name,account_offbudget,amount_cents,payee_id,payee_name,
     category_id,category_name,category_group_name,category_role,category_is_income,notes,
     cleared,reconciled,transfer_id,is_transfer,imported_id,year,month,ymd_unix)
    VALUES (@id,'2026-07-01',@account,@account_name,@offbudget,@amount,@payee,@payee_name,
     @category,@category_name,@group_name,@role,@income,NULL,1,1,@transfer,@is_transfer,@imported_id,
     2026,'2026-07',1782864000)`);
  const tx = (id, amount, overrides = {}) => insert.run({
    id, amount, account: 'checking', account_name: 'Checking', offbudget: 0,
    payee: null, payee_name: id, category: 'cat', category_name: id,
    group_name: 'Flexible essentials', role: 'essential', income: 0,
    transfer: null, is_transfer: 0, imported_id: `bank:${id}`, ...overrides,
  });
  tx('salary', 300000, { group_name: 'Income', role: 'income', income: 1 });
  tx('grocery', -10000);
  tx('refund', 2000);
  tx('opening', 90000, { category: null, category_name: null, group_name: null, role: null, imported_id: 'fints-bridge-opening-balance-checking' });
  tx('save-out', -50000, { payee: 'p-depot', transfer: 'save-in', is_transfer: 1, category: null, category_name: null, group_name: null, role: null });
  tx('save-in', 50000, { account: 'depot', account_name: 'Depot', offbudget: 1, transfer: 'save-out', is_transfer: 1, category: null, category_name: null, group_name: null, role: null });
  tx('card-pay', -20000, { payee: 'p-card', transfer: 'card-in', is_transfer: 1, category: null, category_name: null, group_name: null, role: null });
  tx('card-in', 20000, { account: 'card', account_name: 'Card', transfer: 'card-pay', is_transfer: 1, category: null, category_name: null, group_name: null, role: null });
  tx('revalue', 7000, { account: 'depot', account_name: 'Depot', offbudget: 1, category: null, category_name: null, group_name: null, role: null, imported_id: 'fints-bridge-depot-revaluation-depot-2026-07-01' });
  return db;
}

test('canonical views isolate consumption, ordinary income, and investment contributions', () => {
  const db = projection();
  assert.equal(db.prepare('SELECT SUM(amount_cents) n FROM consumption').get().n, -8000);
  assert.equal(db.prepare('SELECT SUM(amount_cents) n FROM ordinary_income').get().n, 300000);
  assert.equal(db.prepare('SELECT SUM(amount_cents) n FROM savings_contributions').get().n, 50000);
  db.close();
});

test('finance trust exposes machine-readable reasons for every trust gate', () => {
  const db = projection();
  db.prepare(`INSERT INTO expected_sources VALUES ('checking','bank-a',3600),('card','bank-b',3600)`).run();
  db.prepare(`INSERT INTO pipeline_runs
    (run_id,source,finished_at,expected_cadence_seconds,outcome,quarantined,resolved)
    VALUES ('stale','bank-a','2020-01-01T00:00:00Z',3600,'success',0,1),
           ('q','bank-b',datetime('now'),3600,'quarantined',2,0)`).run();
  db.prepare(`INSERT INTO pipeline_run_accounts
    (run_id,account_id,source,requested_from,requested_to,outcome,quarantined) VALUES
    ('stale','checking','bank-a','2020-01-01','2020-01-01','success',0),
    ('q','card','bank-b',date('now'),date('now'),'quarantined',2)`).run();
  db.prepare(`INSERT INTO data_quality
    (check_id,checked_at,kind,account_id,value_cents,resolved)
    VALUES ('gap',datetime('now'),'reconciliation_gap','checking',100,0)`).run();
  const clone = db.prepare(`INSERT INTO transactions
    SELECT ?,date,account_id,account_name,account_offbudget,amount_cents,payee_id,payee_name,
      NULL,NULL,NULL,NULL,0,notes,cleared,reconciled,NULL,0,?,year,month,ymd_unix
    FROM transactions WHERE id='grocery'`);
  for (let i = 0; i < 11; i++) clone.run(`review-${i}`, `bank:review-${i}`);
  const row = db.prepare('SELECT trusted, reasons FROM finance_trust').get();
  assert.equal(row.trusted, 0);
  const reasons = JSON.parse(row.reasons);
  assert.ok(reasons.includes('stale_account_coverage:checking'));
  assert.ok(reasons.includes('reconciliation_gap'));
  assert.ok(reasons.includes('unresolved_quarantine'));
  assert.ok(reasons.includes('review_queue_exceeded'));
  db.close();
});

test('late projection failure leaves previous schema, rows, and views unchanged', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'actual-semantics-'));
  const dbPath = path.join(dir, 'actual.sqlite');
  const existing = new Database(dbPath);
  existing.exec(`CREATE TABLE sentinel(value TEXT);
    INSERT INTO sentinel VALUES ('previous');
    CREATE VIEW sentinel_view AS SELECT upper(value) AS value FROM sentinel;`);
  const beforeSchema = existing.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'sentinel%' ORDER BY name").all();
  existing.close();
  const snapshot = {
    accounts: [
      { id: 'duplicate', name: 'One', offbudget: false, closed: false },
      { id: 'duplicate', name: 'Two', offbudget: false, closed: false },
    ],
    categories: [], payees: [], transactions: [], balances: { duplicate: 1 }, budgetMonths: [],
    categoryGroups: [],
  };
  await assert.rejects(
    syncToSqlite(dbPath, null, null, null, null, { snapshot, expectedSources: [] }),
    /unique constraint failed/i,
  );
  const retained = new Database(dbPath, { readonly: true });
  assert.equal(retained.prepare('SELECT value FROM sentinel').pluck().get(), 'previous');
  assert.equal(retained.prepare('SELECT value FROM sentinel_view').pluck().get(), 'PREVIOUS');
  assert.deepEqual(retained.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'sentinel%' ORDER BY name").all(), beforeSchema);
  assert.equal(retained.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name='accounts'").pluck().get(), 0);
  retained.close();
});

test('transactional refresh migrates legacy source-level expected_sources to account scope', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'actual-migration-'));
  const dbPath = path.join(dir, 'actual.sqlite');
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE expected_sources (source TEXT PRIMARY KEY, expected_cadence_seconds INTEGER);
    INSERT INTO expected_sources VALUES ('legacy-source',86400);`);
  legacy.close();
  await syncToSqlite(dbPath, null, null, null, null, {
    expectedSources: [{ account_id: 'checking', source: 'bank', expected_cadence_seconds: 86400 }],
    now: new Date('2026-07-18T10:00:00Z'),
    snapshot: {
      accounts: [{ id: 'checking', name: 'Checking', offbudget: false, closed: false, last_reconciled: '2026-07-18' }],
      categoryGroups: [], categories: [], payees: [], transactions: [], balances: { checking: 0 },
      balanceAsOf: { checking: '2026-07-18' }, budgetMonths: [], schedules: [],
      schedulesFetchedAt: '2026-07-18T10:00:00Z',
    },
  });
  const db = new Database(dbPath, { readonly: true });
  assert.deepEqual(db.prepare('SELECT * FROM expected_sources').get(),
    { account_id: 'checking', source: 'bank', expected_cadence_seconds: 86400 });
  db.close();
});

test('routine sync replaces current budget state without touching immutable month-close snapshots', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'actual-projection-'));
  const manifests = path.join(dir, 'runs');
  fs.mkdirSync(manifests);
  fs.writeFileSync(path.join(manifests, 'run.json'), JSON.stringify({
    schema_version: 1, run_id: 'run-1', source: 'fints-bank', importer_version: '2',
    started_at: '2026-07-18T09:00:00Z', finished_at: '2026-07-18T09:01:00Z',
    requested_range: { from: '2026-07-01', to: '2026-07-18' }, outcome: 'success', error_code: null,
    accounts: [{ actual_account_id: 'checking', fetched: 2, valid: 2, added: 1, updated: 1, quarantined: 0 }],
  }));
  const registryPath = path.join(dir, 'accounts.json');
  fs.writeFileSync(registryPath, JSON.stringify([
    {
      actual_account_id: 'checking', source: 'fints-bank', enabled: true,
      expected_cadence_seconds: 86400,
    },
    { actual_account_id: 'legacy', source: 'manual-actual', enabled: false },
  ]));
  const snapshot = {
    accounts: [{ id: 'checking', name: 'Checking', offbudget: false, closed: false }],
    categoryGroups: [{ id: 'essential', name: 'Flexible essentials', hidden: false }],
    categories: [{ id: 'groceries', name: 'Groceries', group_id: 'essential', is_income: false }],
    payees: [], transactions: [], balances: { checking: 12345 },
    budgetMonths: [{ month: '2026-07', categoryGroups: [{
      id: 'essential', name: 'Flexible essentials', hidden: false, is_income: false,
      categories: [{ id: 'groceries', name: 'Groceries', budgeted: 40000, spent: -12300, balance: 28200, carryover: true }],
    }] }],
  };
  const dbPath = path.join(dir, 'actual.sqlite');
  const seed = new Database(dbPath);
  seed.exec(SCHEMA);
  seed.prepare(`INSERT INTO budget_snapshots VALUES
    ('2026-06','2026-06-30T23:59:00Z','old','Old','fixed',1,2,3,4)`).run();
  seed.prepare(`INSERT INTO net_worth_snapshots VALUES
    ('2026-06','2026-06-30T23:59:00Z','old',999)`).run();
  seed.close();
  const chmodSync = fs.chmodSync;
  fs.chmodSync = () => { throw new Error('synthetic permission failure'); };
  let counts;
  try {
    counts = await syncToSqlite(dbPath, null, null, manifests, registryPath, {
      snapshot, now: new Date('2026-07-31T23:59:00Z'),
    });
  } finally {
    fs.chmodSync = chmodSync;
  }
  assert.equal(counts.budgets, 1);
  const db = new Database(dbPath, { readonly: true });
  assert.deepEqual(db.prepare('SELECT budgeted_cents,spent_cents,balance_cents,carried_cents FROM current_budgets').get(),
    { budgeted_cents: 40000, spent_cents: -12300, balance_cents: 28200, carried_cents: 500 });
  assert.deepEqual(db.prepare('SELECT fetched,valid,added,updated,quarantined FROM pipeline_runs').get(),
    { fetched: 2, valid: 2, added: 1, updated: 1, quarantined: 0 });
  assert.deepEqual(db.prepare(`SELECT account_id,source,requested_to,outcome,valid FROM pipeline_run_accounts`).get(),
    { account_id: 'checking', source: 'fints-bank', requested_to: '2026-07-18', outcome: 'success', valid: 2 });
  assert.deepEqual(db.prepare('SELECT * FROM expected_sources').get(),
    { account_id: 'checking', source: 'fints-bank', expected_cadence_seconds: 86400 });
  assert.equal(db.prepare("SELECT COUNT(*) FROM expected_sources WHERE source='manual-actual'").pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM budget_snapshots').pluck().get(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM net_worth_snapshots').pluck().get(), 1);
  db.close();
});

test('finance trust rejects expected sources with no run or no cadence', () => {
  const db = projection();
  db.prepare('INSERT INTO expected_sources VALUES (?, ?, ?)').run('checking', 'weekly-manual', 604800);
  db.prepare('INSERT OR REPLACE INTO expected_sources VALUES (?, ?, ?)').run('card', 'missing-cadence', null);
  db.prepare(`INSERT INTO pipeline_runs
    (run_id,source,finished_at,outcome) VALUES ('present','missing-cadence',datetime('now'),'success')`).run();
  const trust = db.prepare('SELECT trusted,reasons FROM finance_trust').get();
  assert.equal(trust.trusted, 0);
  const reasons = JSON.parse(trust.reasons);
  assert.ok(reasons.some(reason => reason.startsWith('missing_account_')));
  assert.ok(reasons.includes('missing_source_cadence'));
  db.close();
});

test('finance trust distinguishes latest attempts from latest successful coverage', () => {
  const db = projection();
  db.prepare(`INSERT INTO expected_sources (account_id,source,expected_cadence_seconds) VALUES ('checking','bank',86400)`).run();
  db.prepare(`INSERT INTO pipeline_runs
    (run_id,source,finished_at,requested_from,requested_to,outcome)
    VALUES ('ok','bank',datetime('now','-1 hour'),'2026-07-01','2026-07-18','success'),
           ('failed','bank',datetime('now'),'2026-07-01','2026-07-18','failed')`).run();
  db.prepare(`INSERT INTO pipeline_run_accounts
    (run_id,account_id,source,requested_from,requested_to,outcome) VALUES
    ('ok','checking','bank','2026-07-01',date('now'),'success'),
    ('failed','checking','bank','2026-07-01',date('now'),'failed')`).run();
  let trust = db.prepare('SELECT trusted,reasons FROM finance_trust').get();
  assert.equal(trust.trusted, 0);
  assert.ok(JSON.parse(trust.reasons).includes('latest_account_attempt_failed:checking'));
  db.prepare("DELETE FROM pipeline_runs WHERE run_id='failed'").run();
  db.prepare("DELETE FROM pipeline_run_accounts WHERE run_id='failed'").run();
  db.prepare(`INSERT INTO pipeline_runs
    (run_id,source,finished_at,requested_from,requested_to,outcome)
    VALUES ('dry','bank',datetime('now'),'2026-07-01','2026-07-18','dry_run')`).run();
  db.prepare(`INSERT INTO pipeline_run_accounts
    (run_id,account_id,source,requested_from,requested_to,outcome)
    VALUES ('dry','checking','bank','2026-07-01',date('now'),'dry_run')`).run();
  trust = db.prepare('SELECT trusted,reasons FROM finance_trust').get();
  assert.ok(JSON.parse(trust.reasons).includes('latest_account_attempt_dry_run:checking'));
  db.close();
});

test('finance trust rejects only-failed, empty, and stale-success source histories', () => {
  const db = projection();
  db.prepare(`INSERT INTO expected_sources (account_id,source,expected_cadence_seconds) VALUES
    ('checking','failed',86400),('card','empty',86400),('depot','stale',60)`).run();
  db.prepare(`INSERT INTO pipeline_runs (run_id,source,finished_at,outcome) VALUES
    ('f','failed',datetime('now'),'failed'),('e','empty',datetime('now'),'empty'),
    ('s','stale',datetime('now','-1 day'),'success')`).run();
  db.prepare(`INSERT INTO pipeline_run_accounts
    (run_id,account_id,source,requested_to,outcome) VALUES
    ('f','checking','failed',date('now'),'failed'),
    ('e','card','empty',date('now'),'empty'),
    ('s','depot','stale','2020-01-01','success')`).run();
  const reasons = JSON.parse(db.prepare('SELECT reasons FROM finance_trust').pluck().get());
  assert.ok(reasons.some(reason => reason.startsWith('missing_account_coverage:')));
  assert.ok(reasons.includes('latest_account_attempt_empty:card'));
  db.close();
});

test('trust requires current successful covered range for every expected account', () => {
  const db = projection();
  db.prepare(`INSERT INTO expected_sources (account_id,source,expected_cadence_seconds) VALUES
    ('checking','shared',86400),('card','shared',86400)`).run();
  db.prepare(`INSERT INTO pipeline_runs (run_id,source,finished_at,requested_from,requested_to,outcome)
    VALUES ('run','shared',datetime('now'),'2020-01-01','2020-01-31','success')`).run();
  db.prepare(`INSERT INTO pipeline_run_accounts
    (run_id,account_id,source,requested_from,requested_to,outcome,valid)
    VALUES ('run','checking','shared','2020-01-01','2020-01-31','success',2)`).run();
  let reasons = JSON.parse(db.prepare('SELECT reasons FROM finance_trust').pluck().get());
  assert.ok(reasons.includes('stale_account_coverage:checking'));
  assert.ok(reasons.includes('missing_account_coverage:card'));
  db.prepare(`INSERT INTO pipeline_runs (run_id,source,finished_at,requested_from,requested_to,outcome)
    VALUES ('unknown','unknown',datetime('now'),NULL,NULL,'failed')`).run();
  reasons = JSON.parse(db.prepare('SELECT reasons FROM finance_trust').pluck().get());
  assert.ok(!reasons.some(reason => reason.includes('unknown')));
  db.close();
});

test('trust requires both current coverage day and fresh successful completion', () => {
  const db = projection();
  db.prepare(`INSERT INTO expected_sources VALUES ('checking','bank',7200)`).run();
  db.prepare(`INSERT INTO pipeline_runs (run_id,source,finished_at,outcome) VALUES
    ('old-finish','bank',datetime('now','-23 hours'),'success')`).run();
  db.prepare(`INSERT INTO pipeline_run_accounts
    (run_id,account_id,source,requested_from,requested_to,outcome)
    VALUES ('old-finish','checking','bank',date('now'),date('now'),'success')`).run();
  let reasons = JSON.parse(db.prepare('SELECT reasons FROM finance_trust').pluck().get());
  assert.ok(reasons.includes('stale_account_success:checking'));
  db.prepare('DELETE FROM pipeline_run_accounts').run();
  db.prepare('DELETE FROM pipeline_runs').run();
  db.prepare(`INSERT INTO pipeline_runs (run_id,source,finished_at,outcome) VALUES
    ('future','bank',datetime('now'),'success')`).run();
  db.prepare(`INSERT INTO pipeline_run_accounts
    (run_id,account_id,source,requested_from,requested_to,outcome)
    VALUES ('future','checking','bank',date('now'),date('now','+1 day'),'success')`).run();
  reasons = JSON.parse(db.prepare('SELECT reasons FROM finance_trust').pluck().get());
  assert.ok(reasons.includes('invalid_account_coverage:checking'));
  db.close();
});

test('future attempt and success timestamps are invalid and excluded from ranking', () => {
  const db = projection();
  db.prepare(`INSERT INTO expected_sources VALUES ('checking','bank',7200)`).run();
  db.prepare(`INSERT INTO pipeline_runs (run_id,source,finished_at,outcome) VALUES
    ('valid','bank',datetime('now','-1 hour'),'success'),
    ('future','bank',datetime('now','+1 hour'),'failed')`).run();
  db.prepare(`INSERT INTO pipeline_run_accounts
    (run_id,account_id,source,requested_from,requested_to,outcome) VALUES
    ('valid','checking','bank',date('now'),date('now'),'success'),
    ('future','checking','bank',date('now'),date('now'),'failed')`).run();
  const reasons = JSON.parse(db.prepare('SELECT reasons FROM finance_trust').pluck().get());
  assert.ok(reasons.includes('invalid_future_timestamp:checking'));
  assert.ok(!reasons.includes('latest_account_attempt_failed:checking'));
  db.close();
});

test('budget projection missing stale or wrong month blocks trust and makes safe-to-spend unavailable', () => {
  const db = projection();
  db.prepare(`INSERT INTO current_budgets VALUES (strftime('%Y-%m','now'), 'fun','Fun','discretionary',0,0,10000,0)`).run();
  for (const [fetchedAt, complete, month, expected] of [
    [null, null, null, 'missing_budget_projection'],
    ["datetime('now','-1 hour')", 1, "strftime('%Y-%m','now')", 'stale_budget_projection'],
    ["datetime('now')", 1, "strftime('%Y-%m','now','-1 month')", 'wrong_budget_month'],
  ]) {
    db.prepare('DELETE FROM budget_projection').run();
    if (fetchedAt) db.exec(`INSERT INTO budget_projection (fetched_at,complete,current_month,max_age_seconds)
      VALUES (${fetchedAt},${complete},${month},900)`);
    const reasons = JSON.parse(db.prepare('SELECT reasons FROM finance_trust').pluck().get());
    assert.ok(reasons.includes(expected));
    assert.equal(db.prepare('SELECT month_cents FROM safe_to_spend').pluck().get(), null);
  }
  db.prepare('DELETE FROM current_budgets').run();
  db.prepare('DELETE FROM budget_projection').run();
  db.exec(`INSERT INTO budget_projection (fetched_at,complete,current_month,max_age_seconds)
    VALUES (datetime('now'),1,strftime('%Y-%m','now'),900)`);
  assert.ok(JSON.parse(db.prepare('SELECT reasons FROM finance_trust').pluck().get()).includes('missing_current_budget_rows'));
  assert.equal(db.prepare('SELECT month_cents FROM safe_to_spend').pluck().get(), null);
  db.close();
});

test('schedule projection rejects malformed dates timestamps types operations and signs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'actual-schedules-'));
  const base = {
    accounts: [{ id: 'checking', name: 'Checking', offbudget: false, closed: false, last_reconciled: '2026-07-01' }],
    categoryGroups: [], categories: [], payees: [], transactions: [], balances: { checking: 0 },
    balanceAsOf: { checking: '2026-07-18' }, budgetMonths: [], schedulesFetchedAt: '2026-07-18T10:00:00Z',
  };
  const invalid = [
    { next_date: '2026-02-30', amountOp: 'is', amount: -100, completed: false },
    { next_date: 'bad', amountOp: 'is', amount: -100, completed: false },
    { next_date: '2026-07-20', amountOp: 'isapprox', amount: -100, completed: false },
    { next_date: '2026-07-20', amountOp: 'isbetween', amount: { num1: -90, num2: -110 }, completed: false },
    { next_date: '2026-07-20', amountOp: 'is', amount: 100, completed: false },
    { next_date: '2026-07-20', amountOp: 'is', amount: -100, completed: 'false' },
  ];
  for (const [index, fields] of invalid.entries()) {
    const dbPath = path.join(dir, `${index}.sqlite`);
    await syncToSqlite(dbPath, null, null, null, null, { expectedSources: [], now: new Date('2026-07-18T10:00:00Z'),
      snapshot: { ...base, schedules: [{ id: 's', name: '[Discretionary] Test', ...fields }] } });
    const db = new Database(dbPath, { readonly: true });
    assert.equal(db.prepare('SELECT complete FROM schedule_projection').pluck().get(), 0);
    db.close();
  }
  for (const [index, schedulesFetchedAt] of ['not-an-instant', '2026-07-19T10:00:00Z'].entries()) {
    const dbPath = path.join(dir, `timestamp-${index}.sqlite`);
    await syncToSqlite(dbPath, null, null, null, null, { expectedSources: [], now: new Date('2026-07-18T10:00:00Z'),
      snapshot: { ...base, schedulesFetchedAt, schedules: [{
        id: 's', name: '[Discretionary] Test', next_date: '2026-07-20',
        amountOp: 'is', amount: -100, completed: false,
      }] } });
    const db = new Database(dbPath, { readonly: true });
    assert.equal(db.prepare('SELECT complete FROM schedule_projection').pluck().get(), 0);
    db.close();
  }
});

test('completed historical schedules need only a valid boolean completion state', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'actual-completed-schedule-'));
  const snapshot = {
    accounts: [], categoryGroups: [], categories: [], payees: [], transactions: [], balances: {}, balanceAsOf: {}, budgetMonths: [],
    schedulesFetchedAt: '2026-07-18T10:00:00Z',
    schedules: [{ id: 'done', name: 'Historical schedule', next_date: null, amountOp: 'isbetween', amount: null, completed: true }],
  };
  const dbPath = path.join(dir, 'ok.sqlite');
  await syncToSqlite(dbPath, null, null, null, null, { snapshot, expectedSources: [], now: new Date('2026-07-18T10:00:00Z') });
  let db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare('SELECT complete FROM schedule_projection').pluck().get(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM current_schedules').pluck().get(), 0);
  db.close();
  snapshot.schedules[0].completed = 'true';
  const badPath = path.join(dir, 'bad.sqlite');
  await syncToSqlite(badPath, null, null, null, null, { snapshot, expectedSources: [], now: new Date('2026-07-18T10:00:00Z') });
  db = new Database(badPath, { readonly: true });
  assert.equal(db.prepare('SELECT complete FROM schedule_projection').pluck().get(), 0);
  assert.match(db.prepare('SELECT detail FROM schedule_projection').pluck().get(), /completed_type/);
  db.close();
});

test('reconciliation evidence is per account and clears only after authoritative reconciliation advances', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'actual-reconcile-'));
  const dbPath = path.join(dir, 'actual.sqlite');
  const snapshot = {
    accounts: [
      { id: 'missing', name: 'Missing', offbudget: false, closed: false, last_reconciled: null },
      { id: 'stale', name: 'Stale', offbudget: true, closed: false, last_reconciled: '2026-01-01' },
      { id: 'closed', name: 'Closed', offbudget: false, closed: true, last_reconciled: null },
    ], categoryGroups: [], categories: [], payees: [], transactions: [],
    balances: { missing: 0, stale: 0, closed: 0 }, balanceAsOf: { missing: '2026-07-18', stale: '2026-07-18', closed: '2026-07-18' },
    budgetMonths: [], schedules: [], schedulesFetchedAt: '2026-07-18T10:00:00Z',
  };
  await syncToSqlite(dbPath, null, null, null, null, { snapshot, expectedSources: [], now: new Date('2026-07-18T10:00:00Z') });
  let db = new Database(dbPath, { readonly: true });
  assert.deepEqual(db.prepare("SELECT account_id,kind,resolved FROM data_quality WHERE kind LIKE 'reconciliation_%' ORDER BY account_id").all(), [
    { account_id: 'missing', kind: 'reconciliation_missing', resolved: 0 },
    { account_id: 'stale', kind: 'reconciliation_stale', resolved: 0 },
  ]);
  db.close();
  snapshot.accounts[0].last_reconciled = '2026-07-18';
  snapshot.accounts[1].last_reconciled = '2026-07-18';
  await syncToSqlite(dbPath, null, null, null, null, { snapshot, expectedSources: [], now: new Date('2026-07-18T11:00:00Z') });
  db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare("SELECT COUNT(*) FROM data_quality WHERE kind LIKE 'reconciliation_%'").pluck().get(), 0);
  db.close();
});

test('future reconciliation dates are rejected as reconciliation-required evidence', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'actual-future-reconcile-'));
  const dbPath = path.join(dir, 'actual.sqlite');
  const snapshot = {
    accounts: [{ id: 'checking', name: 'Checking', offbudget: false, closed: false, last_reconciled: '2026-07-19' }],
    categoryGroups: [], categories: [], payees: [], transactions: [], balances: { checking: 0 }, balanceAsOf: { checking: '2026-07-18' },
    budgetMonths: [], schedules: [], schedulesFetchedAt: '2026-07-18T10:00:00Z',
  };
  await syncToSqlite(dbPath, null, null, null, null, { snapshot, expectedSources: [], now: new Date('2026-07-18T10:00:00Z') });
  const db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare("SELECT kind FROM data_quality WHERE account_id='checking'").pluck().get(), 'reconciliation_future');
  assert.ok(JSON.parse(db.prepare('SELECT reasons FROM finance_trust').pluck().get()).includes('reconciliation_required'));
  db.close();
});

test('sync persists authoritative schedules and deterministic duplicate candidates', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'actual-quality-'));
  const dbPath = path.join(dir, 'actual.sqlite');
  const baseTx = { date: '2026-07-18', account: 'checking', amount: -1200, category: 'fun', cleared: true };
  const snapshot = {
    accounts: [{ id: 'checking', name: 'Checking', offbudget: false, closed: false }],
    categoryGroups: [{ id: 'd', name: 'Discretionary', hidden: false }],
    categories: [{ id: 'fun', name: 'Fun', group_id: 'd', is_income: false }],
    payees: [{ id: 'shop', name: 'Shop' }], balances: { checking: -2400 }, budgetMonths: [],
    schedules: [{ id: 's1', name: '[Discretionary] Cinema', next_date: '2026-07-25', amountOp: 'is', amount: -3000, completed: false }],
    schedulesFetchedAt: '2026-07-18T10:00:00Z',
    transactions: [
      { ...baseTx, id: 'a', payee: 'shop', imported_id: 'bank:a' },
      { ...baseTx, id: 'b', payee: 'shop', imported_id: 'bank:b' },
    ],
  };
  await syncToSqlite(dbPath, null, null, null, null, { snapshot, expectedSources: [], now: new Date('2026-07-18T10:00:00Z') });
  let db = new Database(dbPath);
  assert.deepEqual(db.prepare('SELECT role,due_date,amount_cents,completed FROM current_schedules').get(),
    { role: 'discretionary', due_date: '2026-07-25', amount_cents: -3000, completed: 0 });
  const candidate = db.prepare("SELECT * FROM data_quality WHERE kind='duplicate_candidate'").get();
  assert.ok(candidate.check_id.startsWith('duplicate_candidate:'));
  assert.equal(candidate.resolved, 0);
  assert.ok(JSON.parse(db.prepare('SELECT reasons FROM finance_trust').pluck().get()).includes('unresolved_duplicate_candidate'));
  db.prepare("UPDATE data_quality SET resolved=1 WHERE kind='duplicate_candidate'").run();
  db.close();
  await syncToSqlite(dbPath, null, null, null, null, { snapshot, expectedSources: [], now: new Date('2026-07-18T10:30:00Z') });
  db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare("SELECT resolved FROM data_quality WHERE kind='duplicate_candidate'").pluck().get(), 1);
  db.close();
  snapshot.transactions[1] = { ...snapshot.transactions[1], id: 'replacement', imported_id: 'bank:replacement' };
  await syncToSqlite(dbPath, null, null, null, null, { snapshot, expectedSources: [], now: new Date('2026-07-18T10:45:00Z') });
  db = new Database(dbPath);
  assert.equal(db.prepare("SELECT resolved FROM data_quality WHERE kind='duplicate_candidate'").pluck().get(), 0);
  db.prepare("UPDATE data_quality SET resolved=1 WHERE kind='duplicate_candidate'").run();
  db.close();
  snapshot.transactions.push({ ...snapshot.transactions[0], id: 'growth', imported_id: 'bank:growth' });
  await syncToSqlite(dbPath, null, null, null, null, { snapshot, expectedSources: [], now: new Date('2026-07-18T10:50:00Z') });
  db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare("SELECT resolved FROM data_quality WHERE kind='duplicate_candidate'").pluck().get(), 0);
  db.close();
  snapshot.transactions.pop();
  snapshot.transactions.pop();
  snapshot.balances.checking = -1200;
  await syncToSqlite(dbPath, null, null, null, null, { snapshot, expectedSources: [], now: new Date('2026-07-18T11:00:00Z') });
  db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare("SELECT COUNT(*) FROM data_quality WHERE kind='duplicate_candidate'").pluck().get(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM data_quality WHERE kind='reconciliation_missing'").pluck().get(), 1);
  db.close();
  snapshot.schedules[0].amount = { num1: -2500, num2: -3500 };
  await syncToSqlite(dbPath, null, null, null, null, { snapshot, expectedSources: [], now: new Date('2026-07-18T12:00:00Z') });
  db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare('SELECT complete FROM schedule_projection').pluck().get(), 0);
  db.close();
});

test('unclassified or missing schedule projection fails finance trust closed', () => {
  const db = projection();
  db.prepare('DELETE FROM schedule_projection').run();
  assert.ok(JSON.parse(db.prepare('SELECT reasons FROM finance_trust').pluck().get()).includes('missing_schedule_projection'));
  db.prepare(`INSERT INTO schedule_projection (fetched_at,complete,detail) VALUES (datetime('now'),0,'unclassified_schedule')`).run();
  const reasons = JSON.parse(db.prepare('SELECT reasons FROM finance_trust').pluck().get());
  assert.ok(reasons.includes('schedule_projection_incomplete'));
  db.prepare('DELETE FROM schedule_projection').run();
  db.prepare(`INSERT INTO schedule_projection (fetched_at,complete,detail,max_age_seconds)
    VALUES (datetime('now','-1 hour'),1,'classified',900)`).run();
  assert.ok(JSON.parse(db.prepare('SELECT reasons FROM finance_trust').pluck().get()).includes('stale_schedule_projection'));
  db.close();
});

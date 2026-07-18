import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { deriveCategoryRole } from '../src/semantics.mjs';
import { syncToSqlite } from '../src/sync.mjs';

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

function projection() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
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
  db.prepare(`INSERT INTO pipeline_runs
    (run_id,source,finished_at,expected_cadence_seconds,outcome,quarantined,resolved)
    VALUES ('stale','bank-a','2020-01-01T00:00:00Z',3600,'success',0,1),
           ('q','bank-b',datetime('now'),3600,'quarantined',2,0)`).run();
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
  assert.ok(reasons.includes('stale_source'));
  assert.ok(reasons.includes('reconciliation_gap'));
  assert.ok(reasons.includes('unresolved_quarantine'));
  assert.ok(reasons.includes('review_queue_exceeded'));
  db.close();
});

test('unknown active category role leaves the previous readable SQLite snapshot intact', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'actual-semantics-'));
  const dbPath = path.join(dir, 'actual.sqlite');
  const existing = new Database(dbPath);
  existing.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'previous\')');
  existing.close();
  const snapshot = {
    accounts: [], categories: [], payees: [], transactions: [], balances: {}, budgetMonths: [],
    categoryGroups: [{ id: 'unknown', name: 'Unknown active', hidden: false }],
  };
  await assert.rejects(
    syncToSqlite(dbPath, null, null, null, { snapshot }),
    /unknown active category group/i,
  );
  const retained = new Database(dbPath, { readonly: true });
  assert.equal(retained.prepare('SELECT value FROM sentinel').pluck().get(), 'previous');
  retained.close();
});

test('sync stores Actual budget-month fields and sanitized import manifests transactionally', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'actual-projection-'));
  const manifests = path.join(dir, 'runs');
  fs.mkdirSync(manifests);
  fs.writeFileSync(path.join(manifests, 'run.json'), JSON.stringify({
    schema_version: 1, run_id: 'run-1', source: 'fints-bank', importer_version: '2',
    started_at: '2026-07-18T09:00:00Z', finished_at: '2026-07-18T09:01:00Z',
    requested_range: { from: '2026-07-01', to: '2026-07-18' }, outcome: 'success', error_code: null,
    accounts: [{ actual_account_id: 'checking', fetched: 2, valid: 2, added: 1, updated: 1, quarantined: 0 }],
  }));
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
  await syncToSqlite(dbPath, null, null, manifests, {
    snapshot, now: new Date('2026-07-31T23:59:00Z'), expectedCadenceSeconds: { 'fints-bank': 86400 },
  });
  const db = new Database(dbPath, { readonly: true });
  assert.deepEqual(db.prepare('SELECT budgeted_cents,spent_cents,balance_cents,carried_cents FROM budget_snapshots').get(),
    { budgeted_cents: 40000, spent_cents: -12300, balance_cents: 28200, carried_cents: 500 });
  assert.deepEqual(db.prepare('SELECT fetched,valid,added,updated,quarantined FROM pipeline_runs').get(),
    { fetched: 2, valid: 2, added: 1, updated: 1, quarantined: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) FROM net_worth_snapshots').pluck().get(), 1);
  db.close();
});

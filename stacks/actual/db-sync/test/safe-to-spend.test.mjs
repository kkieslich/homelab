import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(HERE, '../src/schema.sql'), 'utf8');

// Ports the JS calculateSafeToSpend test cases (deleted alongside the JS twin
// in cli/src/commands/month-close.mjs) against the shipped `safe_to_spend`
// SQL view, which is what captureMonthClose actually snapshots. The view
// reads SQL 'now', so every fixture row below uses clock-relative
// expressions (datetime('now'), date('now'), strftime('%Y-%m','now')) rather
// than fixed dates.

function baseProjections(db, { budgetFetchedAt = "datetime('now')", budgetMaxAge = 900 } = {}) {
  db.exec(`INSERT INTO schedule_projection (fetched_at,complete,detail) VALUES (datetime('now'),1,'fixture')`);
  db.exec(`INSERT INTO budget_projection (fetched_at,complete,current_month,max_age_seconds,detail)
    VALUES (${budgetFetchedAt},1,strftime('%Y-%m','now'),${budgetMaxAge},'fixture')`);
}

function readyDb(options) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  baseProjections(db, options);
  return db;
}

test('case 1: discretionary headroom minus essential underfunding minus unpaid discretionary schedule due this month', () => {
  const db = readyDb();
  db.prepare(`INSERT INTO current_budgets VALUES (strftime('%Y-%m','now'),'disc','Fun','discretionary',0,0,30000,0)`).run();
  db.prepare(`INSERT INTO current_budgets VALUES (strftime('%Y-%m','now'),'ess','Rent','essential',0,0,-5000,0)`).run();
  db.prepare(`INSERT INTO current_schedules (id,name,role,due_date,amount_cents,completed,fetched_at)
    VALUES ('sched','Cinema','discretionary',date('now'),-4000,0,datetime('now'))`).run();
  const row = db.prepare('SELECT * FROM safe_to_spend').get();
  assert.equal(row.month_cents, 21000);
  assert.ok(row.remaining_days >= 1, `remaining_days should be >= 1, got ${row.remaining_days}`);
  assert.equal(row.per_day_cents, Math.floor(Math.max(row.month_cents, 0) / Math.max(row.remaining_days, 1)));
  db.close();
});

test('case 2: a negative sinking-fund balance does not count as underfunding', () => {
  const db = readyDb();
  db.prepare(`INSERT INTO current_budgets VALUES (strftime('%Y-%m','now'),'disc','Fun','discretionary',0,0,10000,0)`).run();
  db.prepare(`INSERT INTO current_budgets VALUES (strftime('%Y-%m','now'),'fund','Car repair','sinking_fund',0,0,-9999,0)`).run();
  const row = db.prepare('SELECT * FROM safe_to_spend').get();
  assert.equal(row.month_cents, 10000);
  db.close();
});

test('case 3: income schedules, completed schedules, and positive-amount schedules are ignored', () => {
  const db = readyDb();
  db.prepare(`INSERT INTO current_budgets VALUES (strftime('%Y-%m','now'),'disc','Fun','discretionary',0,0,5000,0)`).run();
  db.prepare(`INSERT INTO current_schedules (id,name,role,due_date,amount_cents,completed,fetched_at) VALUES
    ('income-sched','Paycheck','income',date('now'),-3000,0,datetime('now')),
    ('completed-sched','Paid rent','discretionary',date('now'),-3000,1,datetime('now')),
    ('inflow-sched','Refund','discretionary',date('now'),3000,0,datetime('now'))`).run();
  const row = db.prepare('SELECT * FROM safe_to_spend').get();
  assert.equal(row.month_cents, 5000);
  db.close();
});

test('case 4: a stale budget_projection makes month_cents NULL, never a trusted zero', () => {
  const db = readyDb({ budgetFetchedAt: "datetime('now','-3600 seconds')", budgetMaxAge: 900 });
  db.prepare(`INSERT INTO current_budgets VALUES (strftime('%Y-%m','now'),'disc','Fun','discretionary',0,0,10000,0)`).run();
  const row = db.prepare('SELECT * FROM safe_to_spend').get();
  assert.equal(row.month_cents, null);
  db.close();
});

test('case 5: current_budgets rows that exist only for a different month leave month_cents NULL', () => {
  const db = readyDb();
  db.prepare(`INSERT INTO current_budgets VALUES (strftime('%Y-%m','now','-1 month'),'disc','Fun','discretionary',0,0,10000,0)`).run();
  const row = db.prepare('SELECT * FROM safe_to_spend').get();
  assert.equal(row.month_cents, null);
  db.close();
});

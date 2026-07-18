import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { calculateSafeToSpend, captureMonthClose } from '../src/commands/month-close.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(HERE, '../../db-sync/src/schema.sql'), 'utf8');

test('calculates safe to spend including today and unpaid schedules through month end', () => {
  assert.deepEqual(calculateSafeToSpend({
    categories: [
      { role: 'discretionary', available: 30000 },
      { role: 'flexible_essential', available: -5000 },
    ],
    schedules: [{ role: 'discretionary', amount: -4000, due: '2026-07-25', paid: false }],
    today: '2026-07-18',
  }), { month_cents: 21000, remaining_days: 14, per_day_cents: 1500 });
});

test('handles negative availability, paid schedules, month end, and leap years', () => {
  assert.deepEqual(calculateSafeToSpend({
    categories: [{ role: 'flexible_essential', available: -100 }], schedules: [], today: '2024-02-29',
  }), { month_cents: -100, remaining_days: 1, per_day_cents: 0 });
  assert.deepEqual(calculateSafeToSpend({
    categories: [{ role: 'discretionary', available: 1000 }],
    schedules: [{ role: 'discretionary', amount: -900, due: '2024-02-29', paid: true }],
    today: '2024-02-28',
  }), { month_cents: 1000, remaining_days: 2, per_day_cents: 500 });
});

async function fixture({ review = false, annotate = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'month-close-'));
  const dbPath = path.join(dir, 'actual.sqlite');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('checking', 'Checking', 0, 0, 12345);
  db.prepare('INSERT INTO current_budgets VALUES (?,?,?,?,?,?,?,?)')
    .run('2026-06', 'food', 'Food', 'discretionary', 20000, -5000, 15000, 1000);
  if (review) {
    db.prepare(`INSERT INTO transactions
      (id,date,account_id,account_name,account_offbudget,amount_cents,category_is_income,cleared,
       reconciled,is_transfer,imported_id,year,month,ymd_unix)
      VALUES ('review','2026-06-20','checking','Checking',0,-1000,0,1,0,0,'bank:review',2026,'2026-06',1781913600)`).run();
    if (annotate) db.prepare(`INSERT INTO review_queue_annotations
      (transaction_id,month,decision,annotated_at,note) VALUES (?,?,?,?,?)`)
      .run('review', '2026-06', 'accepted_for_close', '2026-07-01T08:00:00Z', 'Known merchant; review later');
  }
  db.close();
  return dbPath;
}

test('month close defaults to dry-run and apply writes both snapshots idempotently', async () => {
  const dbPath = await fixture();
  const options = { dbPath, month: '2026-06', capturedAt: '2026-07-01T09:00:00Z', now: new Date('2026-07-01T09:00:00Z') };
  const dry = captureMonthClose(options);
  assert.equal(dry.applied, false);
  let db = new Database(dbPath);
  assert.equal(db.prepare('SELECT count(*) FROM budget_snapshots').pluck().get(), 0);
  db.close();
  assert.equal(captureMonthClose({ ...options, apply: true }).applied, true);
  assert.equal(captureMonthClose({ ...options, apply: true }).inserted, 0);
  db = new Database(dbPath);
  assert.equal(db.prepare('SELECT count(*) FROM budget_snapshots').pluck().get(), 1);
  assert.equal(db.prepare('SELECT count(*) FROM net_worth_snapshots').pluck().get(), 1);
  db.close();
});

test('apply refuses an open month and unannotated review items but accepts explicit annotations', async () => {
  const open = await fixture();
  assert.throws(() => captureMonthClose({
    dbPath: open, month: '2026-07', apply: true, now: new Date('2026-07-18T00:00:00Z'),
  }), /not closed/i);
  const review = await fixture({ review: true });
  assert.throws(() => captureMonthClose({
    dbPath: review, month: '2026-06', apply: true, now: new Date('2026-07-01T09:00:00Z'),
  }), /review queue/i);
  const annotated = await fixture({ review: true, annotate: true });
  assert.equal(captureMonthClose({
    dbPath: annotated, month: '2026-06', apply: true, now: new Date('2026-07-01T09:00:00Z'),
  }).applied, true);
});

test('apply refuses non-review finance trust failures', async () => {
  const dbPath = await fixture();
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO data_quality
    (check_id,checked_at,kind,account_id,value_cents,resolved)
    VALUES ('gap','2026-07-01T08:00:00Z','reconciliation_gap','checking',100,0)`).run();
  db.close();
  assert.throws(() => captureMonthClose({
    dbPath, month: '2026-06', apply: true, now: new Date('2026-07-01T09:00:00Z'),
  }), /reconciliation_gap/);
});

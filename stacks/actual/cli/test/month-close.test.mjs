import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { captureMonthClose } from '../src/commands/month-close.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(HERE, '../../db-sync/src/schema.sql'), 'utf8');

async function fixture({ review = false, annotate = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'month-close-'));
  const dbPath = path.join(dir, 'actual.sqlite');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO schedule_projection (fetched_at,complete,detail) VALUES (datetime('now'),1,'fixture')`).run();
  db.prepare(`INSERT INTO budget_projection (fetched_at,complete,current_month,detail)
    VALUES (datetime('now'),1,strftime('%Y-%m','now'),'fixture')`).run();
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('checking', 'Checking', 0, 0, 12345);
  db.prepare(`INSERT INTO account_projection VALUES ('checking','2026-07-01',NULL,'2026-07-01T00:00:00Z')`).run();
  db.prepare('INSERT INTO current_budgets VALUES (?,?,?,?,?,?,?,?)')
    .run('2026-06', 'food', 'Food', 'discretionary', 20000, -5000, 15000, 1000);
  db.prepare(`INSERT OR IGNORE INTO current_budgets VALUES
    (strftime('%Y-%m','now'),'current-fixture','Current fixture','discretionary',0,0,0,0)`).run();
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

test('month close rejects empty, malformed, and non-UTC capture timestamps', async () => {
  const dbPath = await fixture();
  for (const capturedAt of ['', 'not-a-date', '2026-07-01T09:00:00+02:00']) {
    assert.throws(() => captureMonthClose({ dbPath, month: '2026-06', capturedAt,
      now: new Date('2026-07-01T09:00:00Z') }), /captured-at.*UTC/i);
  }
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

test('month close scopes review items and annotations to the requested month', async () => {
  const dbPath = await fixture({ review: true, annotate: true });
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO transactions
    (id,date,account_id,account_name,account_offbudget,amount_cents,category_is_income,cleared,
     reconciled,is_transfer,imported_id,year,month,ymd_unix)
    VALUES ('later','2026-07-02','checking','Checking',0,-1000,0,1,0,0,'bank:later',2026,'2026-07',1782950400)`).run();
  db.prepare(`INSERT INTO review_queue_annotations
    (transaction_id,month,decision,annotated_at,note) VALUES
    ('later','2026-06','accepted_for_close','2026-07-02T00:00:00Z','wrong month')`).run();
  db.close();
  assert.equal(captureMonthClose({ dbPath, month: '2026-06', apply: true,
    now: new Date('2026-07-03T00:00:00Z') }).applied, true);
});

test('month close computes every account balance at requested month-end', async () => {
  const dbPath = await fixture();
  const db = new Database(dbPath);
  db.prepare('UPDATE accounts SET balance_cents=13345 WHERE id=?').run('checking');
  db.prepare(`INSERT INTO accounts VALUES ('closed','Closed savings',1,1,5000)`).run();
  db.prepare(`INSERT INTO accounts VALUES ('savings','Savings',1,0,9000)`).run();
  db.prepare(`INSERT INTO transactions
    (id,date,account_id,account_name,account_offbudget,amount_cents,category_is_income,cleared,reconciled,is_transfer,imported_id,year,month,ymd_unix)
    VALUES ('later','2026-07-02','checking','Checking',0,2000,0,1,0,0,'bank:later',2026,'2026-07',1782950400),
           ('closed-old','2026-06-10','closed','Closed savings',1,7000,0,1,1,0,'bank:old',2026,'2026-06',1781049600),
           ('closed-later','2026-07-01','closed','Closed savings',1,-2000,0,1,1,0,'bank:closed-later',2026,'2026-07',1782864000),
           ('transfer-out','2026-07-02','checking','Checking',0,-1000,0,1,1,1,'bank:transfer-out',2026,'2026-07',1782950400),
           ('transfer-in','2026-07-02','savings','Savings',1,1000,0,1,1,1,'bank:transfer-in',2026,'2026-07',1782950400)`).run();
  db.prepare(`INSERT INTO transactions
    (id,date,account_id,account_name,account_offbudget,amount_cents,category_is_income,cleared,reconciled,is_transfer,imported_id,year,month,ymd_unix)
    VALUES ('future','2026-08-01','checking','Checking',0,999999,0,0,0,0,'bank:future',2026,'2026-08',1785542400)`).run();
  db.prepare(`INSERT OR REPLACE INTO account_projection (account_id,balance_as_of,last_reconciled,checked_at)
    SELECT id,'2026-07-18',NULL,'2026-07-18T10:00:00Z' FROM accounts`).run();
  db.close();
  captureMonthClose({ dbPath, month: '2026-06', capturedAt: '2026-07-03T00:00:00Z', apply: true,
    now: new Date('2026-07-03T00:00:00Z') });
  const result = new Database(dbPath, { readonly: true });
  assert.deepEqual(result.prepare('SELECT account_id,balance_cents FROM net_worth_snapshots ORDER BY account_id').all(), [
    { account_id: 'checking', balance_cents: 12345 },
    { account_id: 'closed', balance_cents: 7000 },
    { account_id: 'savings', balance_cents: 8000 },
  ]);
  result.close();
});

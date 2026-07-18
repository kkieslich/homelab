import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { financeHealth } from '../src/commands/finance-health.mjs';
import { resolveDuplicate } from '../src/commands/duplicate-resolution.mjs';
import { annotateReviewQueue } from '../src/commands/review-annotation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(HERE, '../../db-sync/src/schema.sql'), 'utf8');

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'finance-ops-'));
  const dbPath = path.join(dir, 'actual.sqlite');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('a', 'Checking', 0, 0, 0);
  db.prepare("INSERT INTO account_projection VALUES ('a','2026-07-18','2026-07-18','2026-07-18T10:00:00Z')").run();
  db.prepare("INSERT INTO expected_sources VALUES ('a','bank',86400)").run();
  db.prepare("INSERT INTO pipeline_runs (run_id,source,finished_at,requested_from,requested_to,quarantined,outcome,resolved) VALUES ('r','bank','2026-07-18T10:00:00Z','2026-07-01','2026-07-18',0,'success',1)").run();
  db.prepare("INSERT INTO pipeline_run_accounts (run_id,account_id,source,requested_from,requested_to,outcome,quarantined) VALUES ('r','a','bank','2026-07-01','2026-07-18','success',0)").run();
  db.prepare("INSERT INTO schedule_projection VALUES ('2026-07-18T10:00:00Z',1,'ok',999999999)").run();
  db.prepare("INSERT INTO budget_projection VALUES ('2026-07-18T10:00:00Z',1,strftime('%Y-%m','now'),999999999,'ok')").run();
  db.prepare("INSERT INTO current_budgets VALUES (strftime('%Y-%m','now'),'c','C','discretionary',0,0,0,0)").run();
  db.prepare("INSERT INTO data_quality (check_id,checked_at,kind,account_id,detail,resolved,producer) VALUES ('duplicate_candidate:key','2026-07-18T10:00:00Z','duplicate_candidate','a','{\"transaction_ids\":[\"t1\",\"t2\"]}',0,'db-sync')").run();
  db.prepare(`INSERT INTO transactions (id,date,account_id,account_name,account_offbudget,amount_cents,category_is_income,cleared,reconciled,is_transfer,imported_id,year,month,ymd_unix)
    VALUES ('review','2026-06-20','a','Checking',0,-100,0,1,0,0,'x',2026,'2026-06',1)`).run();
  db.close();
  return dbPath;
}

test('finance health reports account-grain attempts, coverage, gates, and trust reasons read-only', async () => {
  const dbPath = await fixture();
  const before = fs.statSync(dbPath).mtimeMs;
  const report = financeHealth({ dbPath, now: new Date('2026-07-18T12:00:00Z') });
  assert.equal(report.accounts[0].account_id, 'a');
  assert.equal(report.accounts[0].latest_attempt.outcome, 'success');
  assert.equal(report.accounts[0].latest_valid_success.requested_to, '2026-07-18');
  assert.equal(report.accounts[0].status, 'current');
  assert.ok(report.finance_trust.reasons.includes('unresolved_duplicate_candidate'));
  assert.equal(report.gates.duplicate_candidates, 1);
  assert.equal(report.gates.review_queue, 1);
  assert.equal(fs.statSync(dbPath).mtimeMs, before);
});

test('duplicate resolution is dry-run by default, transactional, idempotent, and rejects stale evidence', async () => {
  const dbPath = await fixture();
  const input = { dbPath, candidateKey: 'duplicate_candidate:key', resolution: 'intentional_repeat',
    note: 'Two separate purchases', reviewer: 'kolja', resolvedAt: '2026-07-18T12:00:00Z' };
  assert.equal(resolveDuplicate(input).applied, false);
  let db = new Database(dbPath); assert.equal(db.prepare("SELECT resolved FROM data_quality WHERE check_id=?").pluck().get(input.candidateKey), 0); db.close();
  assert.equal(resolveDuplicate({ ...input, apply: true }).applied, true);
  assert.equal(resolveDuplicate({ ...input, apply: true }).idempotent, true);
  db = new Database(dbPath); assert.equal(db.prepare('SELECT COUNT(*) FROM duplicate_resolution_audit').pluck().get(), 1);
  db.prepare("UPDATE data_quality SET detail='{\"transaction_ids\":[\"changed\"]}',resolved=0 WHERE check_id=?").run(input.candidateKey); db.close();
  assert.throws(() => resolveDuplicate({ ...input, apply: true }), /changed|stale/i);
  assert.throws(() => resolveDuplicate({ ...input, candidateKey: 'missing', apply: true }), /current unresolved/i);
});

test('typed review annotations default dry-run and validate decision, note, reviewer and UTC timestamp', async () => {
  const dbPath = await fixture();
  const input = { dbPath, transactionId: 'review', month: '2026-06', decision: 'accepted_for_close',
    note: 'Known exception', reviewer: 'kolja', annotatedAt: '2026-07-18T12:00:00Z' };
  assert.equal(annotateReviewQueue(input).applied, false);
  assert.equal(annotateReviewQueue({ ...input, apply: true }).applied, true);
  assert.equal(annotateReviewQueue({ ...input, apply: true }).idempotent, true);
  for (const bad of [{ note: ' ' }, { reviewer: '' }, { annotatedAt: 'bad' }, { decision: 'skip' }]) {
    assert.throws(() => annotateReviewQueue({ ...input, ...bad, apply: true }), /invalid|required|UTC/i);
  }
});

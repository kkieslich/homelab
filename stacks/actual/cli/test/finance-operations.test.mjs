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

function relativeDay(offsetDays, base) {
  const day = new Date(base);
  day.setUTCDate(day.getUTCDate() + offsetDays);
  return day.toISOString().slice(0, 10);
}

async function fixture() {
  const now = new Date();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  const reviewDate = relativeDay(-32, now);
  const reviewMonth = reviewDate.slice(0, 7);
  const dir = await mkdtemp(path.join(tmpdir(), 'finance-ops-'));
  const dbPath = path.join(dir, 'actual.sqlite');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('a', 'Checking', 0, 0, 0);
  db.prepare('INSERT INTO account_projection VALUES (?,?,?,?)').run('a', today, today, nowIso);
  db.prepare("INSERT INTO expected_sources VALUES ('a','bank',86400)").run();
  db.prepare(`INSERT INTO pipeline_runs (run_id,source,finished_at,requested_from,requested_to,quarantined,outcome,resolved)
    VALUES ('r','bank',?,?,?,0,'success',1)`).run(nowIso, relativeDay(-17, now), today);
  db.prepare(`INSERT INTO pipeline_run_accounts (run_id,account_id,source,requested_from,requested_to,outcome,quarantined)
    VALUES ('r','a','bank',?,?,'success',0)`).run(relativeDay(-17, now), today);
  db.prepare('INSERT INTO schedule_projection VALUES (?,1,?,999999999)').run(nowIso, 'ok');
  db.prepare("INSERT INTO budget_projection VALUES (?,1,strftime('%Y-%m','now'),999999999,'ok')").run(nowIso);
  db.prepare("INSERT INTO current_budgets VALUES (strftime('%Y-%m','now'),'c','C','discretionary',0,0,0,0)").run();
  db.prepare(`INSERT INTO data_quality (check_id,checked_at,kind,account_id,detail,resolved,producer)
    VALUES ('duplicate_candidate:key',?,'duplicate_candidate','a',?,0,'db-sync')`).run(nowIso,
    JSON.stringify({ account_id: 'a', date: today, amount_cents: -100, normalized_payee: 'shop',
      transaction_ids: ['t1', 't2'], classification: 'fuzzy_review_only' }));
  db.prepare(`INSERT INTO transactions (id,date,account_id,account_name,account_offbudget,amount_cents,category_is_income,cleared,reconciled,is_transfer,imported_id,year,month,ymd_unix)
    VALUES ('review',?,'a','Checking',0,-100,0,1,0,0,'x',?,?,1)`)
    .run(reviewDate, Number(reviewDate.slice(0, 4)), reviewMonth);
  db.close();
  return { dbPath, now, today, reviewMonth, reviewDate };
}

test('finance health reports account-grain attempts, coverage, and trust reasons read-only', async () => {
  const { dbPath, now, today } = await fixture();
  const before = fs.statSync(dbPath).mtimeMs;
  const report = financeHealth({ dbPath, now });
  assert.equal(report.accounts[0].account_id, 'a');
  assert.equal(report.accounts[0].latest_attempt.outcome, 'success');
  assert.equal(report.accounts[0].latest_valid_success.requested_to, today);
  assert.equal(report.accounts[0].status, 'current');
  assert.ok(report.finance_trust.reasons.includes('unresolved_duplicate_candidate'));
  assert.equal(report.evidence.duplicate_candidates, 1);
  assert.equal(report.evidence.review_queue, 1);
  assert.equal(fs.statSync(dbPath).mtimeMs, before);
});

test('a fresh validated empty latest attempt is current coverage, not an error status', async () => {
  const { dbPath, now, today } = await fixture();
  const laterIso = new Date(now.getTime() + 1000).toISOString();
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO pipeline_runs (run_id,source,finished_at,requested_from,requested_to,quarantined,outcome,resolved)
    VALUES ('quiet','bank',?,?,?,0,'partial_empty',1)`).run(laterIso, relativeDay(-17, now), today);
  db.prepare(`INSERT INTO pipeline_run_accounts (run_id,account_id,source,requested_from,requested_to,outcome,quarantined)
    VALUES ('quiet','a','bank',?,?,'empty',0)`).run(relativeDay(-17, now), today);
  db.close();
  const report = financeHealth({ dbPath, now });
  assert.equal(report.accounts[0].latest_attempt.run_id, 'quiet');
  assert.equal(report.accounts[0].latest_attempt.outcome, 'empty');
  assert.equal(report.accounts[0].latest_valid_success.run_id, 'quiet');
  assert.equal(report.accounts[0].latest_valid_success.outcome, 'empty');
  assert.equal(report.accounts[0].latest_valid_success.requested_to, today);
  assert.equal(report.accounts[0].status, 'current');
});

test('duplicate resolution is dry-run by default, transactional, idempotent, and rejects stale evidence', async () => {
  const { dbPath } = await fixture();
  const input = { dbPath, candidateKey: 'duplicate_candidate:key', resolution: 'intentional_repeat',
    note: 'Two separate purchases', reviewer: 'kolja', resolvedAt: '2026-07-18T12:00:00Z' };
  assert.equal(resolveDuplicate(input).applied, false);
  let db = new Database(dbPath); assert.equal(db.prepare("SELECT resolved FROM data_quality WHERE check_id=?").pluck().get(input.candidateKey), 0); db.close();
  assert.equal(resolveDuplicate({ ...input, apply: true }).applied, true);
  assert.equal(resolveDuplicate({ ...input, apply: true }).idempotent, true);
  db = new Database(dbPath); assert.equal(db.prepare('SELECT COUNT(*) FROM duplicate_resolution_audit').pluck().get(), 1);
  db.close();
  for (const conflict of [{ resolution: 'not_a_duplicate' }, { note: 'different' }, { reviewer: 'other' },
    { resolvedAt: '2026-07-18T12:00:01Z' }]) {
    assert.throws(() => resolveDuplicate({ ...input, ...conflict, apply: true }), /conflicts/i);
  }
  db = new Database(dbPath);
  db.prepare("DELETE FROM data_quality WHERE check_id=?").run(input.candidateKey);
  const audit = JSON.parse(db.prepare('SELECT candidate_detail FROM duplicate_resolution_audit').pluck().get());
  db.close();
  assert.equal(audit.account_id, 'a'); assert.equal(audit.amount_cents, -100); assert.deepEqual(audit.transaction_ids, ['t1', 't2']);
  assert.throws(() => resolveDuplicate({ ...input, apply: true }), /current unresolved|stale/i);
  assert.throws(() => resolveDuplicate({ ...input, candidateKey: 'missing', apply: true }), /current unresolved/i);
});

test('typed review annotations default dry-run and validate decision, note, reviewer and UTC timestamp', async () => {
  const { dbPath, reviewMonth } = await fixture();
  const input = { dbPath, transactionId: 'review', month: reviewMonth, decision: 'accepted_for_close',
    note: 'Known exception', reviewer: 'kolja', annotatedAt: '2026-07-18T12:00:00Z' };
  assert.equal(annotateReviewQueue(input).applied, false);
  assert.equal(annotateReviewQueue({ ...input, apply: true }).applied, true);
  assert.equal(annotateReviewQueue({ ...input, apply: true }).idempotent, true);
  for (const conflict of [{ note: 'different' }, { reviewer: 'other' }, { annotatedAt: '2026-07-18T12:00:01Z' }]) {
    assert.throws(() => annotateReviewQueue({ ...input, ...conflict, apply: true }), /conflicts/i);
  }
  for (const bad of [{ note: ' ' }, { reviewer: '' }, { annotatedAt: 'bad' }, { decision: 'skip' }]) {
    assert.throws(() => annotateReviewQueue({ ...input, ...bad, apply: true }), /invalid|required|UTC/i);
  }
});

test('finance health gate summary is exactly the canonical trust view', async () => {
  const { dbPath, now } = await fixture();
  const db = new Database(dbPath);
  db.prepare("DELETE FROM data_quality WHERE kind='duplicate_candidate'").run();
  db.prepare("INSERT INTO accounts VALUES ('closed','Closed',0,1,0)").run();
  db.prepare("INSERT INTO account_projection VALUES ('closed','2026-07-18','2026-07-18','2026-07-18T10:00:00Z')").run();
  db.prepare("INSERT INTO data_quality (check_id,checked_at,kind,account_id,value_cents,resolved) VALUES ('closed-gap',datetime('now'),'reconciliation_gap','closed',100,0),('zero-gap',datetime('now'),'reconciliation_gap','a',0,0)").run();
  db.prepare("INSERT INTO pipeline_runs (run_id,source,finished_at,quarantined,outcome,resolved) VALUES ('other','unexpected',datetime('now'),2,'failed',0)").run();
  db.close();
  const report = financeHealth({ dbPath, now });
  assert.equal(report.finance_trust.trusted, true);
  assert.equal(report.evidence.reconciliation.length, 0);
  assert.equal(report.evidence.quarantine.length, 0);
  const write = new Database(dbPath);
  write.prepare("UPDATE pipeline_runs SET quarantined=1,resolved=0 WHERE run_id='r'").run();
  write.prepare("UPDATE pipeline_run_accounts SET quarantined=1 WHERE run_id='r'").run();
  write.close();
  const blocked = financeHealth({ dbPath, now });
  assert.ok(blocked.finance_trust.reasons.includes('unresolved_quarantine'));
  assert.equal(blocked.evidence.quarantine.length, 1);
});

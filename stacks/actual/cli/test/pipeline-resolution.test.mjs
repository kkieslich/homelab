import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { resolvePipelineRun } from '../src/commands/pipeline-resolution.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(HERE, '../../db-sync/src/schema.sql'), 'utf8');

async function fixture() {
  const now = new Date();
  const nowIso = now.toISOString();
  const dir = await mkdtemp(path.join(tmpdir(), 'pipeline-resolution-'));
  const dbPath = path.join(dir, 'actual.sqlite');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO pipeline_runs (run_id,source,finished_at,quarantined,outcome,resolved)
    VALUES ('r','bank',?,1,'success',0)`).run(nowIso);
  db.close();
  return { dbPath, now, nowIso };
}

test('pipeline resolution is dry-run by default, transactional, idempotent, and rejects an unknown run', async () => {
  const { dbPath, nowIso } = await fixture();
  const input = { dbPath, runId: 'r', note: 'Investigated: one benign weak reference', reviewer: 'kolja', resolvedAt: nowIso };

  const preview = resolvePipelineRun(input);
  assert.equal(preview.applied, false);
  assert.equal(preview.quarantined, 1);
  let db = new Database(dbPath);
  assert.equal(db.prepare('SELECT resolved FROM pipeline_runs WHERE run_id=?').pluck().get('r'), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM pipeline_resolution_audit').pluck().get(), 0);
  db.close();

  const applied = resolvePipelineRun({ ...input, apply: true });
  assert.equal(applied.applied, true);
  db = new Database(dbPath);
  assert.equal(db.prepare('SELECT resolved FROM pipeline_runs WHERE run_id=?').pluck().get('r'), 1);
  assert.deepEqual(
    db.prepare('SELECT run_id,resolved_at,reviewer,note FROM pipeline_resolution_audit').get(),
    { run_id: 'r', resolved_at: nowIso, reviewer: 'kolja', note: 'Investigated: one benign weak reference' },
  );
  db.close();

  const again = resolvePipelineRun({ ...input, apply: true });
  assert.equal(again.applied, false);
  assert.equal(again.idempotent, true);
  db = new Database(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) FROM pipeline_resolution_audit').pluck().get(), 1);
  db.close();

  assert.throws(() => resolvePipelineRun({ ...input, runId: 'missing', apply: true }), /No pipeline run/i);
});

test('pipeline resolution requires an existing snapshot file and stores trimmed audit text', async () => {
  const { dbPath, nowIso } = await fixture();
  const input = { dbPath, runId: 'r', note: 'note', reviewer: 'kolja', resolvedAt: nowIso };

  const missingPath = path.join(path.dirname(dbPath), 'does-not-exist.sqlite');
  assert.throws(() => resolvePipelineRun({ ...input, dbPath: missingPath, apply: true }));
  assert.equal(fs.existsSync(missingPath), false);

  const applied = resolvePipelineRun({ ...input, note: '  padded note  ', reviewer: '  kolja  ', apply: true });
  assert.equal(applied.applied, true);
  const db = new Database(dbPath);
  assert.deepEqual(
    db.prepare('SELECT reviewer,note FROM pipeline_resolution_audit').get(),
    { reviewer: 'kolja', note: 'padded note' },
  );
  db.close();
});

test('pipeline resolution requires a snapshot path, run id, note, reviewer, and UTC resolved-at', async () => {
  const { dbPath, nowIso } = await fixture();
  const input = { dbPath, runId: 'r', note: 'note', reviewer: 'kolja', resolvedAt: nowIso };
  assert.throws(() => resolvePipelineRun({ ...input, dbPath: undefined }), /snapshot/i);
  assert.throws(() => resolvePipelineRun({ ...input, runId: ' ' }), /run-id/i);
  assert.throws(() => resolvePipelineRun({ ...input, note: '' }), /note/i);
  assert.throws(() => resolvePipelineRun({ ...input, reviewer: '  ' }), /reviewer/i);
  assert.throws(() => resolvePipelineRun({ ...input, resolvedAt: 'not-a-utc-instant' }), /UTC/i);
});

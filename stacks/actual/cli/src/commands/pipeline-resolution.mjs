import Database from 'better-sqlite3';
import { parseArgs } from '../lib/args.mjs';
import { requireUtcInstant } from '../lib/validation.mjs';

export function resolvePipelineRun({ dbPath, runId, note, reviewer, resolvedAt, apply = false }) {
  if (!dbPath) throw new Error('A snapshot SQLite path is required');
  if (!String(runId ?? '').trim()) throw new Error('run-id is required');
  if (!String(note ?? '').trim()) throw new Error('note is required');
  if (!String(reviewer ?? '').trim()) throw new Error('reviewer is required');
  requireUtcInstant(resolvedAt, 'resolved-at');
  const db = new Database(dbPath, { readonly: !apply });
  try {
    const run = db.prepare('SELECT run_id, quarantined, resolved FROM pipeline_runs WHERE run_id=?').get(runId);
    if (!run) throw new Error(`No pipeline run: ${runId}`);
    if (run.resolved === 1) return { run_id: runId, applied: false, idempotent: true };
    if (!apply) return { run_id: runId, quarantined: run.quarantined, applied: false };
    const write = db.transaction(() => {
      db.prepare('UPDATE pipeline_runs SET resolved=1 WHERE run_id=?').run(runId);
      db.prepare('INSERT INTO pipeline_resolution_audit (run_id,resolved_at,reviewer,note) VALUES (?,?,?,?)')
        .run(runId, resolvedAt, reviewer, note);
    });
    write();
    return { run_id: runId, applied: true };
  } finally { db.close(); }
}

export async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: actual pipeline-resolution --snapshot=<db> --run-id=<id> --note=<t> --reviewer=<n> --resolved-at=<UTC ISO> [--apply]');
    return;
  }
  console.log(JSON.stringify(resolvePipelineRun({
    dbPath: args.snapshot, runId: args['run-id'], note: args.note,
    reviewer: args.reviewer, resolvedAt: args['resolved-at'], apply: args.apply === true,
  }), null, 2));
}

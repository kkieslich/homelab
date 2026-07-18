import Database from 'better-sqlite3';
import { parseArgs } from '../lib/args.mjs';
import { requireText, requireUtcInstant } from '../lib/validation.mjs';

export function annotateReviewQueue({ dbPath, transactionId, month, decision, note, reviewer, annotatedAt, apply = false }) {
  requireText(transactionId, 'transaction id');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month ?? '')) throw new Error('Invalid month');
  if (decision !== 'accepted_for_close') throw new Error('Invalid decision');
  requireText(note, 'note'); requireText(reviewer, 'reviewer'); requireUtcInstant(annotatedAt, 'annotated-at');
  const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
  try {
    const item = db.prepare('SELECT id FROM review_queue WHERE id=? AND month=?').get(transactionId, month);
    if (!item) throw new Error('Transaction is not in the current month-scoped review queue');
    const existing = db.prepare('SELECT * FROM review_queue_annotations WHERE transaction_id=? AND month=?').get(transactionId, month);
    if (existing) {
      if (existing.decision !== decision || existing.note !== note.trim() || existing.reviewer !== reviewer.trim()
        || existing.annotated_at !== annotatedAt) throw new Error('Requested annotation conflicts with immutable stored evidence');
      return { transaction_id: transactionId, month, applied: apply, idempotent: true };
    }
    if (!apply) return { transaction_id: transactionId, month, decision, reviewer: reviewer.trim(), applied: false };
    db.prepare(`INSERT INTO review_queue_annotations
      (transaction_id,month,decision,annotated_at,note,reviewer) VALUES (?,?,?,?,?,?)`)
      .run(transactionId, month, decision, annotatedAt, note.trim(), reviewer.trim());
    return { transaction_id: transactionId, month, applied: true };
  } finally { db.close(); }
}

export async function run(argv) {
  const a = parseArgs(argv);
  if (a.help) { console.log('Usage: actual review-annotation --snapshot=PATH --transaction-id=ID --month=YYYY-MM --decision=accepted_for_close --note=TEXT --reviewer=NAME --annotated-at=UTC_ISO [--apply]'); return; }
  console.log(JSON.stringify(annotateReviewQueue({ dbPath: a.snapshot, transactionId: a['transaction-id'], month: a.month,
    decision: a.decision, note: a.note, reviewer: a.reviewer, annotatedAt: a['annotated-at'], apply: a.apply === true }), null, 2));
}

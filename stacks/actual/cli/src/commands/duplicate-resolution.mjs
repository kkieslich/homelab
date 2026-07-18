import Database from 'better-sqlite3';
import { parseArgs } from '../lib/args.mjs';
import { requireText, requireUtcInstant } from '../lib/validation.mjs';

const RESOLUTIONS = new Set(['intentional_repeat', 'confirmed_duplicate_merged', 'not_a_duplicate']);
export function resolveDuplicate({ dbPath, candidateKey, resolution, note, reviewer, resolvedAt, apply = false }) {
  requireText(candidateKey, 'candidate key');
  if (!RESOLUTIONS.has(resolution)) throw new Error('Invalid resolution');
  requireText(note, 'note'); requireText(reviewer, 'reviewer'); requireUtcInstant(resolvedAt, 'resolved-at');
  const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
  try {
    const candidate = db.prepare("SELECT * FROM data_quality WHERE check_id=? AND kind='duplicate_candidate'").get(candidateKey);
    if (!candidate || (!candidate.resolved && candidate.producer !== 'db-sync')) throw new Error('Candidate is not a current unresolved duplicate candidate');
    const audit = db.prepare('SELECT * FROM duplicate_resolution_audit WHERE candidate_key=?').get(candidateKey);
    if (audit) {
      if (audit.candidate_detail !== candidate.detail) throw new Error('Candidate evidence changed; resolution key is stale');
      return { candidate_key: candidateKey, applied: apply, idempotent: true };
    }
    if (candidate.resolved) throw new Error('Candidate is not a current unresolved duplicate candidate');
    const result = { candidate_key: candidateKey, resolution, candidate_detail: candidate.detail, applied: false };
    if (!apply) return result;
    db.transaction(() => {
      const changed = db.prepare("UPDATE data_quality SET resolved=1 WHERE check_id=? AND kind='duplicate_candidate' AND resolved=0 AND detail=?")
        .run(candidateKey, candidate.detail).changes;
      if (changed !== 1) throw new Error('Candidate evidence changed; resolution key is stale');
      db.prepare(`INSERT INTO duplicate_resolution_audit
        (candidate_key,candidate_detail,resolution,note,reviewer,resolved_at) VALUES (?,?,?,?,?,?)`)
        .run(candidateKey, candidate.detail, resolution, note.trim(), reviewer.trim(), resolvedAt);
    })();
    return { ...result, applied: true };
  } finally { db.close(); }
}

export async function run(argv) {
  const a = parseArgs(argv);
  if (a.help) { console.log('Usage: actual duplicate-resolution --snapshot=PATH --candidate-key=KEY --resolution=intentional_repeat|confirmed_duplicate_merged|not_a_duplicate --note=TEXT --reviewer=NAME --resolved-at=UTC_ISO [--apply]'); return; }
  console.log(JSON.stringify(resolveDuplicate({ dbPath: a.snapshot, candidateKey: a['candidate-key'], resolution: a.resolution,
    note: a.note, reviewer: a.reviewer, resolvedAt: a['resolved-at'], apply: a.apply === true }), null, 2));
}

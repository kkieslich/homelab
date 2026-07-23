import Database from 'better-sqlite3';
import { parseArgs } from '../lib/args.mjs';

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value ?? '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function financeHealth({ dbPath, now = new Date() }) {
  if (!dbPath) throw new Error('A snapshot SQLite path is required');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const expected = db.prepare('SELECT * FROM expected_sources ORDER BY source,account_id').all();
    const attempt = db.prepare(`SELECT a.*,p.finished_at FROM pipeline_run_accounts a JOIN pipeline_runs p USING(run_id)
      WHERE a.account_id=? AND a.source=? AND strftime('%s',p.finished_at) IS NOT NULL
      ORDER BY p.finished_at DESC,a.run_id DESC LIMIT 1`);
    const success = db.prepare(`SELECT a.*,p.finished_at FROM pipeline_run_accounts a JOIN pipeline_runs p USING(run_id)
      WHERE a.account_id=? AND a.source=? AND a.outcome IN ('success','empty') AND strftime('%s',p.finished_at) IS NOT NULL
        AND CAST(strftime('%s',p.finished_at) AS INTEGER)<=?+300
      ORDER BY a.requested_to DESC,p.finished_at DESC,a.run_id DESC LIMIT 1`);
    let pendingExcluded = 0;
    const accounts = expected.map((row) => {
      const latestAttempt = attempt.get(row.account_id, row.source) ?? null;
      pendingExcluded += Number(latestAttempt?.pending_excluded) || 0;
      const latestSuccess = success.get(row.account_id, row.source, nowSeconds) ?? null;
      const finishedSeconds = latestSuccess ? Math.floor(new Date(latestSuccess.finished_at).getTime() / 1000) : null;
      const future = latestAttempt && new Date(latestAttempt.finished_at).getTime() > now.getTime() + 300000;
      const coverageValid = latestSuccess && validDay(latestSuccess.requested_from)
        && validDay(latestSuccess.requested_to)
        && latestSuccess.requested_from <= latestSuccess.requested_to
        && latestSuccess.requested_to <= now.toISOString().slice(0, 10);
      let status = 'current';
      if (future) status = 'invalid_future_timestamp';
      else if (!row.expected_cadence_seconds || row.expected_cadence_seconds <= 0) status = 'missing_cadence';
      else if (!latestAttempt) status = 'missing_attempt';
      else if (latestAttempt.outcome !== 'success' && latestAttempt.outcome !== 'empty') status = `latest_attempt_${latestAttempt.outcome}`;
      else if (!latestSuccess) status = 'missing_valid_success';
      else if (!coverageValid) status = 'invalid_coverage';
      else if (Math.floor((Date.parse(now.toISOString().slice(0, 10)) - Date.parse(latestSuccess.requested_to)) / 1000)
        > row.expected_cadence_seconds) status = 'stale_coverage';
      else if (nowSeconds - finishedSeconds > row.expected_cadence_seconds) status = 'stale_success';
      return { account_id: row.account_id, source: row.source, expected_cadence_seconds: row.expected_cadence_seconds,
        latest_attempt: latestAttempt, latest_valid_success: latestSuccess,
        finish_age_seconds: finishedSeconds === null ? null : nowSeconds - finishedSeconds, status };
    });
    const trust = db.prepare('SELECT trusted,reasons FROM finance_trust').get() ?? { trusted: 0, reasons: '[]' };
    const financeTrust = { trusted: Boolean(trust.trusted), reasons: JSON.parse(trust.reasons) };
    return {
      evaluated_at: now.toISOString(),
      finance_trust: financeTrust,
      accounts,
      gates: financeTrust,
      evidence: {
        review_queue: db.prepare('SELECT COUNT(*) FROM review_queue').pluck().get(),
        duplicate_candidates: db.prepare("SELECT COUNT(*) FROM data_quality WHERE kind='duplicate_candidate' AND resolved=0").pluck().get(),
        reconciliation: db.prepare(`SELECT q.* FROM data_quality q JOIN accounts a ON a.id=q.account_id AND a.closed=0
          WHERE q.resolved=0 AND ((q.kind='reconciliation_gap' AND COALESCE(q.value_cents,0)<>0)
            OR q.kind IN ('reconciliation_missing','reconciliation_stale','reconciliation_future')) ORDER BY q.check_id`).all(),
        quarantine: db.prepare(`SELECT p.run_id,a.account_id,a.source,a.quarantined FROM pipeline_run_accounts a
          JOIN pipeline_runs p ON p.run_id=a.run_id JOIN expected_sources e ON e.account_id=a.account_id AND e.source=a.source
          WHERE a.quarantined>0 AND p.resolved=0 ORDER BY p.run_id,a.account_id`).all(),
        // Pending (non-BOOK) weak-reference transactions are deliberately excluded
        // from import, not withheld — informational only, summed over each
        // expected account's latest pipeline run (same latest-attempt row used above).
        pending_excluded: pendingExcluded,
        budget_projection: db.prepare('SELECT * FROM budget_projection ORDER BY fetched_at DESC LIMIT 1').get() ?? null,
        schedule_projection: db.prepare('SELECT * FROM schedule_projection ORDER BY fetched_at DESC LIMIT 1').get() ?? null,
      },
    };
  } finally { db.close(); }
}

export async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log('Usage: actual finance-health --snapshot=/path/to/actual.sqlite --json'); return; }
  console.log(JSON.stringify(financeHealth({ dbPath: args.snapshot }), null, 2));
}

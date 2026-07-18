import Database from 'better-sqlite3';
import { parseArgs } from '../lib/args.mjs';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid date: ${value}`);
  const date = new Date(`${value}T00:00:00Z`);
  if (date.toISOString().slice(0, 10) !== value) throw new Error(`Invalid date: ${value}`);
  return date;
}

export function calculateSafeToSpend({ categories, schedules, today }) {
  const day = parseDay(today);
  const nextMonth = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1));
  const remainingDays = Math.round((nextMonth - day) / 86400000);
  const discretionary = categories
    .filter(category => category.role === 'discretionary' && category.available > 0)
    .reduce((sum, category) => sum + category.available, 0);
  const underfunded = categories
    .filter(category => ['essential', 'flexible_essential'].includes(category.role) && category.available < 0)
    .reduce((sum, category) => sum + Math.abs(category.available), 0);
  const scheduled = schedules
    .filter(schedule => schedule.role === 'discretionary' && !schedule.paid
      && /^\d{4}-\d{2}-\d{2}$/.test(schedule.due ?? '')
      && schedule.due < nextMonth.toISOString().slice(0, 10))
    .reduce((sum, schedule) => sum + Math.abs(Math.min(schedule.amount, 0)), 0);
  const monthCents = discretionary - underfunded - scheduled;
  return {
    month_cents: monthCents,
    remaining_days: remainingDays,
    per_day_cents: Math.floor(Math.max(monthCents, 0) / remainingDays),
  };
}

function validateMonth(month) {
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month: ${month}`);
}

function isClosed(month, now) {
  return month < now.toISOString().slice(0, 7);
}

export function captureMonthClose({ dbPath, month, apply = false, capturedAt, now = new Date() }) {
  validateMonth(month);
  if (!dbPath) throw new Error('A snapshot SQLite path is required');
  if (!isClosed(month, now)) throw new Error(`Month ${month} is not closed`);
  const capture = capturedAt ?? now.toISOString();
  const db = new Database(dbPath, { readonly: !apply });
  try {
    const trust = db.prepare('SELECT trusted,reasons FROM finance_trust').get();
    const review = db.prepare(`SELECT q.id FROM review_queue q
      LEFT JOIN review_queue_annotations a
        ON a.transaction_id=q.id AND a.month=? AND a.decision='accepted_for_close'
      WHERE q.month=? AND a.transaction_id IS NULL`).all(month, month);
    const reasons = JSON.parse(trust?.reasons ?? '[]');
    // finance_trust historically includes review_queue_exceeded. A complete set
    // of typed annotations resolves only that reason; no other trust failure.
    const nonReviewReasons = reasons.filter(reason => reason !== 'review_queue_exceeded');
    if (!trust?.trusted && (nonReviewReasons.length || review.length)) {
      throw new Error(`Finance projection is not trusted: ${reasons.join(', ')}`);
    }
    if (review.length) throw new Error(`Review queue has ${review.length} unannotated transaction(s)`);
    const budgets = db.prepare('SELECT * FROM current_budgets WHERE month=? ORDER BY category_id').all(month);
    if (!budgets.length) throw new Error(`No current budget data for ${month}`);
    const monthEndExclusive = new Date(`${month}-01T00:00:00Z`);
    monthEndExclusive.setUTCMonth(monthEndExclusive.getUTCMonth() + 1);
    const boundary = monthEndExclusive.toISOString().slice(0, 10);
    const missingProjection = db.prepare(`SELECT a.id FROM accounts a
      LEFT JOIN account_projection p ON p.account_id=a.id
      WHERE p.account_id IS NULL OR p.balance_as_of<?`).all(boundary);
    if (missingProjection.length) throw new Error(`Account balance cutoff is incomplete for ${month}`);
    const accounts = db.prepare(`SELECT a.id,
      a.balance_cents-COALESCE(SUM(CASE WHEN t.date>=? AND t.date<=p.balance_as_of THEN t.amount_cents ELSE 0 END),0) balance_cents
      FROM accounts a JOIN account_projection p ON p.account_id=a.id LEFT JOIN transactions t ON t.account_id=a.id
      GROUP BY a.id,a.balance_cents,p.balance_as_of ORDER BY a.id`).all(monthEndExclusive.toISOString().slice(0, 10));
    const safeToSpend = db.prepare('SELECT * FROM safe_to_spend').get();
    const result = {
      month, captured_at: capture, budget_rows: budgets.length, net_worth_rows: accounts.length,
      applied: false, safe_to_spend: safeToSpend,
      net_worth_basis: 'Actual account balance explicitly cut off at account_projection.balance_as_of minus projected transactions from the next-month boundary through that cutoff; future transactions after cutoff excluded; includes open/closed and on/off-budget accounts',
    };
    if (!apply) return result;
    const write = db.transaction(() => {
      const budgetInsert = db.prepare(`INSERT OR IGNORE INTO budget_snapshots
        (month,captured_at,category_id,category_name,category_role,budgeted_cents,spent_cents,balance_cents,carried_cents)
        VALUES (@month,@captured_at,@category_id,@category_name,@category_role,@budgeted_cents,@spent_cents,@balance_cents,@carried_cents)`);
      const worthInsert = db.prepare(`INSERT OR IGNORE INTO net_worth_snapshots
        (month,captured_at,account_id,balance_cents) VALUES (?,?,?,?)`);
      let inserted = 0;
      for (const budget of budgets) inserted += budgetInsert.run({ ...budget, captured_at: capture }).changes;
      for (const account of accounts) inserted += worthInsert.run(month, capture, account.id, account.balance_cents).changes;
      return inserted;
    });
    return { ...result, applied: true, inserted: write() };
  } finally {
    db.close();
  }
}

export async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: actual month-close --month=YYYY-MM --snapshot=/path/to/actual.sqlite [--captured-at=ISO] [--apply]');
    return;
  }
  const result = captureMonthClose({
    dbPath: args.snapshot,
    month: args.month,
    apply: args.apply === true,
    capturedAt: args['captured-at'],
  });
  console.log(JSON.stringify(result, null, 2));
}

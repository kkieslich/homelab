# Task 9 report: canonical financial semantics and quality models

## Status

Implemented and verified without live deployment or data writes.

## Red/green record

1. RED: `npm test` failed with `ERR_MODULE_NOT_FOUND` for the intentionally absent `src/semantics.mjs`.
2. GREEN: the role mapping and canonical projection views passed against synthetic in-memory SQLite data.
3. RED: the snapshot-retention fixture reached Actual and failed with `No budget file is open`, proving the sync had no injectable snapshot boundary.
4. GREEN: snapshot injection plus pre-write role validation retained the prior SQLite file; the complete suite passes.

## Implementation

- Added exact category-group role mapping and active-group validation.
- Added canonical consumption, ordinary-income, savings-contribution, review-queue, and finance-trust views.
- Added pipeline-run, data-quality, budget-snapshot, and net-worth-snapshot tables.
- Verified installed `@actual-app/api` 26.5.0 declarations and implementation before using `getBudgetMonths()` and `getBudgetMonth(month)`.
- Replaced JSON budget loading with Actual budget-month values (`budgeted`, `spent`, `balance`, and derived carried amount).
- Ingested only the allow-listed fields from sanitized importer manifests.
- Kept semantic validation before opening SQLite and all snapshot replacement writes in one transaction.
- Added a compatibility migration for replicas created before `transactions.category_role` existed.

## Verification

- `cd stacks/actual/db-sync && npm test`: 5 passed, 0 failed.
- `node --check src/sync.mjs`: passed.
- `node --check src/semantics.mjs`: passed.
- `git diff --check`: passed.

## Self-review notes

- Transfers to ordinary on-budget accounts, including card settlement, are excluded from both consumption and savings; only an on-budget outflow whose Actual transfer payee targets an off-budget account is a savings contribution.
- Refunds assigned to an expense role offset consumption; opening balances and depot revaluations are excluded explicitly.
- Actual exposes carryover as a flag. The carried amount is therefore derived as `balance - budgeted - spent` when the flag is set.
- Expected cadence is stored per manifest source when supplied by runtime configuration. A source without an expected cadence cannot be judged stale; deployment configuration must provide these values.
- Reconciliation gaps are consumed from `data_quality`; generating them requires an authoritative external closing balance and remains outside this task's available Actual snapshot data.

## Review remediation

All three review findings were addressed test-first.

### Red/green record

1. RED: a late duplicate-account failure left schema objects created before the data transaction. GREEN: `BEGIN IMMEDIATE` now encloses compatibility migrations, schema/view creation, and all data changes; rollback preserves the former tables, rows, and views byte-for-byte at the SQL-schema level, and `db.close()` runs in `finally`.
2. RED: routine sync appended both immutable snapshot tables. GREEN: routine Actual budget-month values now replace `current_budgets`; `budget_snapshots` and `net_worth_snapshots` are untouched for Task 10's explicit month-close capture.
3. RED: `finance_trust` knew only about sources with manifests and `expected_sources` was absent. GREEN: enabled sources and exact cadences are deduplicated from the mounted non-secret account registry. Missing run, missing/invalid cadence, and stale run are independently fail-closed reasons.

### Configuration

- `fints-fnz`: 7,200 seconds, allowing one missed hourly daemon cycle before becoming stale.
- `fints-umwelt`: 604,800 seconds because authentication makes this a weekly manual import.
- `manual-actual`: 604,800 seconds for weekly manual review/import activity.

### Fresh verification

- `npm --prefix db-sync test`: 6 passed, 0 failed.
- `node --check db-sync/src/sync.mjs`: passed.
- `node --check db-sync/src/index.mjs`: passed.
- `git diff --check`: passed.
- `docker compose config --quiet`: passed.
- Full neighboring regression suites: Actual CLI 9/9, FinTS bridge 28/28, db-sync 6/6.

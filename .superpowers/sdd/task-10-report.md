# Task 10 report

## Outcome

Implemented a pure `calculateSafeToSpend` function and the guarded
`actual month-close` command. The command reads the Task 9 projection, defaults
to dry-run, and writes budget and net-worth rows in one transaction only with
`--apply`.

Review exceptions now have a machine-readable representation in
`review_queue_annotations`: the decision is constrained to
`accepted_for_close`, the annotation is scoped to a transaction and close
month, and a non-empty audit note and timestamp are required.

## RED

Added `test/month-close.test.mjs` before production code. The first targeted
run failed with `ERR_MODULE_NOT_FOUND` for `src/commands/month-close.mjs`, the
expected failure because the requested feature did not exist.

One subsequent edge-case assertion exposed the specified distinction between
positive discretionary availability and essential underfunding. The fixture
was corrected to exercise an underfunded essential category; implementation
was not changed to accommodate an invalid expectation.

## GREEN

- Safe-to-spend sums only positive discretionary balances, subtracts essential
  deficits and unpaid discretionary schedules in the current month, includes
  today in remaining days, and clamps only the per-day numerator.
- Month close validates month format and refuses an open/current month.
- It requires the Task 9 `finance_trust` gate and refuses every non-review
  trust reason.
- Every review-queue row must have a typed annotation for the close month.
  The legacy `review_queue_exceeded` finance-trust reason is treated as
  resolved only when all rows have those annotations; no other reason can be
  overridden.
- The requested month must exist in `current_budgets`.
- Budget and open-account net-worth rows use `INSERT OR IGNORE` inside one
  SQLite transaction, so an identical `month,captured_at` rerun is idempotent.
- `--captured-at=ISO` is available for reproducible/idempotent automation;
  otherwise the command uses the current instant.

## Verification

- `cd stacks/actual/cli && npm test`: 14 passed, 0 failed.
- `cd stacks/actual/db-sync && npm test`: 6 passed, 0 failed.

## Concerns

- The Task 9 `finance_trust` view mixes review-queue size into general trust.
  Task 10 preserves compatibility and permits only a fully annotated queue to
  resolve that one reason. A future schema revision could separate pipeline
  trust and review readiness into distinct views.
- Net-worth snapshots use the projection's current open-account balances. The
  command therefore intentionally refuses the current month but operators
  should run it promptly after close; the projection has no historical daily
  account-balance field from which to reconstruct an older month end.
- No live databases were opened, written, or deployed.

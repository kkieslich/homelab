# Monthly finance close

Run after the final bank imports for a closed month and before funding the new
month. Actual is authoritative; the projection and Grafana validate it.

> A repository-ready close is not a completed live close. Account
> reconciliation, native-rule/category coverage, cent-level metric comparison,
> and snapshot capture require recorded production evidence.

## 1. Establish finance trust

1. Complete the [weekly review](weekly-review.md).
2. Run **Actual - Audit imports** and **Actual - Finance health**.
3. Confirm every expected source is current, no run is quarantined, no confirmed
   duplicate remains, and every active account reconciles exactly.
4. Confirm transfers, brokerage cash legs, and credit-card settlements use
   transfer payees and are budget-neutral.
5. Clear the review queue. A genuinely understood exception may receive a typed
   `accepted_for_close` annotation for this month; a free-form note is not an
   acceptance decision.

Stop for stale/missing imports, quarantine, reconciliation gaps, invalid
category roles, or material unexplained transactions. `finance_trust=false`
suppresses headline analytics intentionally.

## 2. Review the closed month in Actual

Review funded, consumed, and available amounts in the six authoritative groups:

1. `Fixed obligations`
2. `Flexible essentials`
3. `Discretionary`
4. `Sinking funds`
5. `Savings and investing`
6. `Income`

Every active category belongs to exactly one group; transfers have no expense
role. Use **Actual — Monthly** for month-over-month category/payee drivers and
snapshot history, **Actual — Investments & Pipeline** for contributions and
holdings, and **Actual — Home** for trust and safe-to-spend context.

For a fixed closed month, compare Actual with the canonical projection at exact
cent precision for ordinary income, consumption, transfer-neutral totals,
category totals, savings/investment contributions, and month-end net worth.
Document any discrepancy and stop; never patch the replica to make it agree.

## 3. Maintain schedules and sinking funds

In Actual:

1. Match completed schedules and resolve overdue ones.
2. Maintain salary, rent, utilities, insurance, subscriptions, savings, and
   investment-contribution schedules.
3. Update variable estimates only for durable changes.
4. Review annual bills, travel, repairs, gifts, and major-purchase sinking funds;
   adjust targets using the remaining amount and due date.
5. Confirm sinking-fund balances roll forward.

Routine finance policy belongs in Actual. Do not edit repository budget or
categorization JSON; those files are migration input only until live acceptance
authorizes retirement.

## 4. Fund the new month

Assign expected income in this order:

1. Fixed obligations.
2. Required sinking-fund contributions.
3. Savings and investment targets.
4. Flexible essentials.
5. Discretionary envelopes.

Do not treat unassigned cash as spendable. Verify scheduled obligations are
funded and trace the planning headline to Actual:

```text
safe to spend this month =
  positive discretionary envelope availability
  - essential envelope underfunding
  - unpaid discretionary schedules due this month
```

The daily value is the non-negative result divided by remaining calendar days,
including today.

## 5. Preview and capture immutable snapshots

The CLI is dry-run by default. Run it against the production projection path
from an approved operator shell and inspect the reported row counts:

```sh
node /app/cli/bin/actual.mjs month-close \
  --month=YYYY-MM --snapshot=/db/actual.sqlite
```

Only after all preceding gates pass, repeat once with `--apply` (and optionally
a valid `--captured-at` timestamp). The transaction is atomic and the same
snapshot identity is idempotent:

```sh
node /app/cli/bin/actual.mjs month-close \
  --month=YYYY-MM --snapshot=/db/actual.sqlite --apply
```

Record the capture timestamp and finance-trust evidence. Later budget edits must
not rewrite the historical snapshot.

## 6. Acceptance

The close is complete only when:

- the ledger and all active accounts reconcile;
- the review queue is empty or each exception has a typed close annotation;
- schedules and sinking funds are current and the next month is funded;
- Actual and the projection agree at cent level for the fixed month;
- safe-to-spend components are explainable from Actual; and
- immutable budget and net-worth snapshots were captured and visible in the
  three dashboards.

If any gate fails, do not apply a snapshot. Preserve evidence, correct the
ledger in Actual, refresh the projection, and repeat the dry run. For suspected
corruption or an unsafe migration, use [restore.md](restore.md).

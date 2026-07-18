# Monthly finance close

Run this after the final bank imports for the month and before funding the new
month. Actual is the source of truth; Grafana is a read-only analytical check.

## 1. Establish a trustworthy ledger

1. Complete the [weekly review](weekly-review.md), including current imports,
   an empty or fully explained review queue, and reconciliation of every active
   on-budget account.
2. Confirm investment contributions and current portfolio value are present.
   Do not try to reproduce cost basis, realized gains, or tax reporting in
   Actual.
3. Confirm owned-account movements, brokerage cash legs, and credit-card
   settlements use transfer payees and are budget-neutral.
4. Resolve duplicate candidates. Preserve legitimate same-day, same-amount
   transactions.

Stop the close if an account does not reconcile, an import is stale, or a
material transaction remains unexplained. Do not publish precise Grafana
conclusions from an untrusted ledger.

## 2. Review the completed month

In Actual, compare funded amounts, spending, and available balances for the six
authoritative groups:

1. `Fixed obligations`
2. `Flexible essentials`
3. `Discretionary`
4. `Sinking funds`
5. `Savings and investing`
6. `Income`

Every active category must belong to exactly one of these groups. Transfers
must not be represented by budget categories. Check category and merchant
drivers for material month-over-month changes, then review savings rate and net
worth movement in Grafana against the reconciled Actual ledger.

## 3. Maintain schedules and sinking funds

1. Match all completed scheduled transactions and resolve overdue schedules.
2. Create or update schedules for salary, rent, utilities, insurance,
   subscriptions, regular savings, and investment contributions.
3. Use approximate amounts for variable bills and update them when a durable
   change becomes known.
4. Review annual bills, travel, repairs, gifts, and major-purchase sinking
   funds. Adjust their targets based on the remaining amount and due date.
5. Preview the next month and confirm sinking-fund balances roll forward.

## 4. Fund the new month

Assign expected income in this order:

1. Fixed obligations.
2. Required sinking-fund contributions.
3. Savings and investment targets.
4. Flexible essentials.
5. Discretionary envelopes.

Do not treat unassigned bank cash as spendable. Verify that Actual's funded
envelopes cover the scheduled obligations due during the month. The planning
headline is:

```text
safe to spend this month =
  available discretionary envelopes
  - overdue or underfunded essential envelopes
  - discretionary scheduled outflows still due this month
```

Divide the non-negative result by the remaining calendar days, including
today, for the daily figure. Every component must be traceable to Actual.

## 5. Record and verify the close

After the analytical snapshot refreshes, reconcile its monthly income,
consumption, transfers, envelope availability, and safe-to-spend components to
Actual. Record any known caveat with the month-end snapshot so later budget
changes do not rewrite the historical interpretation.

The close is complete when the ledger reconciles, schedules are current,
sinking funds roll forward, the next month is funded in priority order, and
Grafana agrees with Actual. Do not edit `cli/config/budget.json`; retain it only
as migration input until every legacy target exists in funded Actual envelopes
and the final reconciliation authorizes deletion.

# Actual-First Personal Finance Architecture

**Date:** 2026-07-18  
**Status:** Approved design  
**Audience:** Homelab operator and future implementers

## 1. Outcome

Build a dependable personal-finance workflow in which Actual Budget is the primary interface and source of truth for transactions, payees, rules, transfers, schedules, and envelope balances. Grafana remains a read-only analytical tool for longer-term trends, diagnostics, and investment summaries.

The system must answer four routine questions:

1. Where did money go this month?
2. How much is safe to spend for the rest of the month?
3. Are savings and irregular-expense reserves on track?
4. Is the underlying transaction data complete and trustworthy?

The target operating cadence is a five-to-ten-minute weekly transaction review and a more complete monthly budget review.

## 2. Current-State Findings

The repository and live deployment on `192.168.1.20` were inspected read-only on 2026-07-18.

### 2.1 Live data quality

The live analytical replica contained:

- 1,496 transactions across seven accounts.
- 253 transactions categorized as `Needs Review`.
- 48 transactions with no category.
- 165 `Needs Review` transactions with no payee.
- One repeated imported ID (`STARTUMS`) used by nine Baader transactions.
- 23 same-account/date/amount/notes duplicate groups containing 58 rows.

The review backlog is concentrated in recent data: all 152 June transactions had been assigned `Needs Review`, while July contained both `Needs Review` and still-uncategorized records. This aligns with the July simplification of `categorization.json`, which retained only salary, positive-inflow, and bank-fee rules and assigned everything else to the fallback.

Several Triodos duplicates have two different ID schemes for the same bank record: a bank-reference-like ID and a date/index ID such as `2026-06-30.0`. This proves that more than one import identity scheme has targeted the same account. Exact-ID deduplication cannot reconcile records whose IDs change across import paths.

Credit-card transactions frequently have no payee even though the merchant is present in notes, for example `REWE ... EUR ... Umsatz vom ...`. This prevents reliable payee rules, category learning, and schedule/subscription matching.

### 2.2 Conflicting sources of truth

The current system divides financial semantics between:

- Actual's categories and rules.
- `cli/config/categorization.json` and the custom categorizer.
- `cli/config/budget.json` and Actual's native budget.
- A custom subscription detector and Actual schedules.
- Repeated panel-specific SQL definitions in Grafana.

This division makes corrections fragile. A user action in Actual does not necessarily improve the external categorizer, and a repository budget edit does not express Actual's real funded envelope balances.

### 2.3 Grafana drift

Grafana's underlying SQLite projection is technically healthy and refreshes every five minutes, but the displayed metrics inherit poor transaction semantics. In particular, `Needs Review` is treated as a normal expense category, transfers are only excluded when correctly linked, and the budget comparison uses static JSON targets rather than actual funded category balances. Precise-looking panels therefore cannot be trusted until ingestion and categorization are corrected.

## 3. Design Principles

1. **One writer per account.** Each Actual account has exactly one authoritative bank-import path.
2. **Actual owns financial meaning.** Payees, categories, transfers, schedules, and funded envelopes live in Actual.
3. **The bridge owns transport normalization.** It may normalize bank protocol data and merchant text, but it does not decide spending categories.
4. **Raw evidence remains available.** The bank description is preserved as `imported_payee` even when a clean payee candidate is supplied.
5. **Ambiguity stays visible.** Unknown transactions remain uncategorized instead of being hidden in a fallback expense category.
6. **Analytics are downstream.** Grafana reads a validated projection and never changes financial truth.
7. **Automation fails closed.** Empty, partial, conflicting, or implausible import results write nothing.
8. **Every headline reconciles.** Safe-to-spend, monthly spending, and savings metrics must be traceable to Actual data.

## 4. Target Architecture

```text
Bank and broker sources
          |
          v
FinTS/source adapters
  fetch + protocol parsing
          |
          v
Canonical normalization and validation
  stable IDs + merchant candidates + quarantine
          |
          v
Actual Budget
  payees + native rules + transfers + schedules + envelopes
          |
          v
Validated read-only analytical projection
  facts + dimensions + snapshots + quality checks
          |
          v
Grafana
  overview + monthly analysis + investments/pipeline
```

Actual's `importTransactions` is the correct write boundary because it runs rules, creates transfers when a transfer payee is selected, and reconciles imports. Exact `imported_id` reuse prevents repeat insertion; when it is absent, Actual falls back to less reliable similarity matching. The importer will explicitly set `reimportDeleted: false` so intentionally removed records do not return. See the [Actual API reference](https://actualbudget.org/docs/api/reference/).

## 5. Ingestion and Transaction Integrity

### 5.1 Source ownership registry

Maintain a versioned, non-secret registry with one row per Actual account:

- Actual account ID and display name.
- Source adapter and bank account identifier.
- Account role: on-budget cash, credit card, investment, or liability.
- Canonical source namespace.
- Expected fetch cadence.
- Whether interactive authentication is required.

Startup validation rejects duplicate Actual account targets. This prevents built-in sync, legacy importers, and the FinTS bridge from silently writing to the same ledger.

### 5.2 Canonical transaction contract

Every adapter produces the same record shape:

- `source` and `source_account`.
- Stable `source_transaction_id`.
- Namespaced `imported_id` of `<source>:<source-account>:<source-transaction-id>`.
- Booking date and, when available, value date.
- Amount in integer cents and currency.
- Raw bank description.
- Clean payee candidate.
- Notes and structured reference metadata.
- Booked or pending status.
- Importer version.

IDs must not depend on fetch position or requested date window. If a bank supplies no reliable identifier, the adapter creates a documented deterministic fingerprint from stable transaction fields and stores collision-disambiguating bank data. A generic date/index ID is forbidden.

### 5.3 Merchant normalization

For credit-card records whose payee field is empty, adapter-specific parsing extracts the merchant from the raw statement description. The output is conservative:

- Remove known currency, country, exchange-rate, fee, and booking-date suffixes.
- Preserve meaningful merchant text and location only when needed for disambiguation.
- Treat opaque numeric terminal descriptions as unknown rather than inventing a payee.
- Always retain the untouched description in `imported_payee` or equivalent raw evidence.

Actual rules can then match `imported payee`, normalize multiple raw variants into one canonical payee, and assign categories. Actual explicitly distinguishes immutable imported text from the editable payee for this purpose. See [Actual rules](https://actualbudget.org/docs/budgeting/rules/) and [payee management](https://actualbudget.org/docs/transactions/payees/).

### 5.4 Batch validation

Before calling Actual, validate:

- Required account mapping exists.
- Canonical IDs are present and unique within the batch.
- Dates, currencies, and integer amounts are valid.
- A successful response is not unexpectedly empty.
- Counts and covered dates are plausible relative to recent successful runs.
- The account is not claimed by another enabled importer.
- Exact records already present use the same canonical ID.
- Fuzzy candidates with account, amount, nearby date, and normalized description are reported.

Exact reimports are automatic no-ops. Fuzzy duplicate candidates are quarantined or surfaced for review; the recurring pipeline never deletes transactions heuristically.

### 5.5 Run manifests and privacy

Each run stores a compact manifest:

- Run ID, source, accounts, and importer version.
- Requested and returned date ranges.
- Fetched, valid, imported, updated, skipped, and quarantined counts.
- Validation outcome and sanitized error summary.
- Start/end timestamps.

Raw bank payloads remain short-lived and access-restricted. Long-lived operational records retain counts, hashes, IDs, and sanitized errors rather than full sensitive descriptions.

## 6. Actual Rules and Review Workflow

### 6.1 Rule layers

Native Actual rules run in this order:

1. Normalize raw imported descriptions into canonical payees.
2. Convert movements between owned accounts into Actual transfers.
3. Assign a default category to stable payees.
4. Apply narrow exceptions based on account, raw text, notes, or amount.
5. Leave unmatched transactions uncategorized.

Transfer payees are native Actual payees linked to accounts and should be used instead of assigning an `Internal Transfer` expense category. Actual documents this model in [payee management](https://actualbudget.org/docs/transactions/payees/).

`Needs Review` is retired as a financial category. A saved filter or equivalent view defines the review queue as on-budget, non-transfer transactions that meet at least one condition:

- Category is empty.
- Payee is empty or explicitly unknown.
- Import validation flagged a duplicate candidate.
- Transaction exceeds an unusual-amount threshold.

### 6.2 Rule bootstrap

Historical corrected records seed rule candidates:

- Group raw imported descriptions by canonical payee.
- Measure category consistency per canonical payee.
- Propose payee and category rules only at high confidence.
- Require manual approval for broad regular expressions, large-value payees, and variable-purpose aggregators.
- Keep Amazon, PayPal, Klarna, cash withdrawals, and person-to-person payments reviewable when the same payee legitimately spans categories.

The existing custom categorizer is retired only after useful mappings have been converted and verified. It must not run concurrently with native rules after cutover.

### 6.3 Weekly workflow

The weekly workflow is:

1. Run imports that require interactive authentication.
2. Confirm pipeline success and absence of quarantined batches.
3. Open the Actual review queue.
4. Correct payee first and category second.
5. Accept or refine the resulting future rule.
6. Confirm transfers and large unusual transactions.
7. Reconcile each active account to its bank balance.

Normal completion should take five to ten minutes and leave no unexplained reconciliation difference.

### 6.4 Schedules

Use Actual schedules for known salary, rent, utilities, subscriptions, insurance, regular savings, and investment contributions. Schedules provide upcoming cash-flow visibility and can link to imported transactions; rules can attach categories and notes. See [Actual schedules](https://actualbudget.org/docs/schedules/).

The custom recurring-charge detector may remain as a read-only audit that highlights repeated payees without a matching schedule. It is not the authoritative subscription list.

## 7. Budget and Safe-to-Spend Model

### 7.1 Category roles

Actual's native envelope budget replaces `cli/config/budget.json`. Each expense category receives one analytical role:

- Fixed obligation.
- Flexible essential.
- Discretionary.
- Sinking fund.
- Savings or investing.
- Income or reimbursement.

Transfers have no expense role and remain budget-neutral.

The role is encoded by Actual category groups, using one group per role (for example `Fixed obligations` and `Discretionary`). The analytical projection derives the role from the Actual group and rejects unknown active groups. This avoids introducing another hand-maintained category-role file outside Actual.

### 7.2 Monthly funding order

Expected income is assigned in this order:

1. Fixed obligations.
2. Required sinking-fund contributions.
3. Savings and investment target.
4. Flexible essentials.
5. Discretionary envelopes.

Sinking-fund balances roll forward for annual and irregular costs. Reimbursements return to the original expense category when practical so they offset consumption instead of inflating ordinary income.

### 7.3 Safe to spend

The primary monthly planning metric is:

```text
safe_to_spend_month =
  sum(available balances in discretionary categories)
  - max(0, essential envelope underfunding)
  - discretionary scheduled outflows still due this month
```

The daily companion metric is:

```text
safe_to_spend_per_day =
  max(0, safe_to_spend_month) / remaining calendar days including today
```

Both values must expose their components. They are planning metrics, not bank balances. Money assigned to obligations, sinking funds, or savings never appears spendable merely because it is liquid.

### 7.4 Monthly review

At month end:

1. Complete imports and reconcile every account.
2. Clear or explicitly annotate the review queue.
3. Compare consumption with funded envelopes.
4. Fund the next month in the defined priority order.
5. Adjust sinking-fund targets when expected annual costs change.
6. Review savings rate and net-worth movement.
7. Persist a month-end budget and net-worth snapshot.

Month-end snapshots prevent later budget edits from rewriting the historical interpretation of what was funded and available at the time.

## 8. Analytical Projection

The projection is rebuilt read-only from Actual plus bank/depot run metadata. It contains explicit models rather than panel-specific interpretations.

### 8.1 Core models

- `fact_transactions`: normalized transaction ledger with import identity and review state.
- `fact_monthly_category`: monthly income, consumption, refunds, and transfer-neutral totals.
- `fact_budget_snapshot`: month-end budgeted, spent, available, and carried balances.
- `fact_net_worth_snapshot`: month-end liquid assets, investments, and liabilities.
- `dim_category`: Actual category plus analytical role.
- `dim_account`: Actual account plus cash, credit, investment, liability, on-budget, and closed semantics.
- `pipeline_runs`: run counts, coverage, versions, and outcomes.
- `data_quality`: duplicate candidates, missing payees, uncategorized records, stale sources, and reconciliation differences.

Existing current-holdings and holdings-history data can remain, but Actual only needs to represent contributions and current account value. Tax lots, realized gains, and investment-performance accounting are out of scope and belong in a dedicated portfolio tool if later required.

### 8.2 Canonical financial definitions

**Consumption:** Negative on-budget transactions excluding transfers, savings/investment movements, liabilities, and non-consumption adjustments. Refunds reduce their attributed consumption category.

**Ordinary income:** Positive on-budget transactions categorized as income, excluding transfers, starting balances, refunds, and asset revaluations.

**Savings:** Explicit contributions to savings/investment destinations plus positive retained cash according to the chosen monthly definition. Dashboards must label which form they display.

**Savings rate:** `(ordinary income - consumption) / ordinary income`, with transfers excluded and no value shown when ordinary income is zero.

**Net worth:** Reconciled asset balances minus reconciled liability balances. Depot market value is used once; it must not also be counted through a second revaluation representation.

## 9. Grafana Information Architecture

Grafana is reduced to three dashboards.

### 9.1 Finance overview

- Net worth and liquid balance.
- Safe to spend this month and per remaining day.
- Current savings rate.
- Current-month consumption versus funded envelopes.
- Review-queue size and value.
- Source freshness and reconciliation warnings.

### 9.2 Monthly analysis

- Income, consumption, savings, and investments by month.
- Fixed, essential, discretionary, and sinking-fund views.
- Category and merchant drivers of month-over-month change.
- Rolling averages and annualized irregular costs.
- Largest unusual transactions with links or identifiers for review.

### 9.3 Investments and pipeline health

- Contributions and current portfolio value.
- Holdings allocation when source data supports it.
- Import freshness and covered-through dates.
- Imported, updated, skipped, and quarantined counts.
- Duplicate candidates and reconciliation gaps.

Every panel includes a metric definition and latest-complete-data timestamp. When reconciliation gaps, stale imports, or the review backlog breach thresholds, the overview displays a visible `data not trustworthy` state instead of silently presenting headline metrics.

## 10. Error Handling and Recovery

- An incomplete or unexpectedly empty bank response imports nothing.
- Authentication failures preserve the previous successful state and mark the source stale.
- Validation failure quarantines the entire affected account batch unless records can be proven independent.
- Actual API errors record the run as failed and do not mark its covered-through date as advanced.
- SQLite projection refresh happens transactionally and retains the prior readable snapshot on failure.
- Historical duplicate cleanup is a one-time, reviewed migration. Recurring jobs never perform heuristic deletions.
- Budget and analytical backups are taken before cleanup and structural migration.
- The restore procedure is tested before destructive duplicate merging begins.

Actual supports manual merging of equal-amount duplicate transactions while preserving useful fields from the dropped record; use this supported behavior for reviewed cleanup. See [merging duplicate transactions](https://actualbudget.org/docs/transactions/merging/).

## 11. Migration Plan

1. Export and back up the Actual budget, server data, bridge state, and analytical SQLite database.
2. Inventory accounts and record their one authoritative importer.
3. Disable overlapping writers before another production import.
4. Add the canonical transaction contract, merchant parsers, and namespaced IDs behind a dry-run mode.
5. Run historical fixture and live dry-run comparisons without writing. Where an existing authoritative importer already used stable bank IDs, preserve that identity or maintain a one-time legacy-ID lookup during cutover; a namespace migration must not reinsert existing history.
6. Identify and manually approve historical duplicate groups.
7. Merge approved duplicates and reconcile every account.
8. Generate and review native Actual rule candidates from corrected history.
9. Remove `Needs Review` as a semantic category and clear its backlog in bounded batches.
10. Configure schedules and rebuild category roles and envelopes in Actual.
11. Extend the analytical projection and reconcile it to fixed Actual exports.
12. Replace Grafana dashboards after data-quality gates pass.
13. Remove the external categorizer and JSON budget from routine operation.
14. Document the weekly, monthly, failure-recovery, and rule-maintenance workflows.

## 12. Verification Strategy

### 12.1 Importer fixtures

Fixture tests must prove:

- Reimporting an identical batch adds zero records.
- Changing the requested date window does not change transaction IDs.
- Merchant extraction preserves raw imported text.
- Same-day, same-amount legitimate purchases remain distinct.
- A repeated or unstable bank reference is detected before import.
- Empty, partial, and malformed responses fail closed.
- No two enabled sources target the same Actual account.

### 12.2 Financial semantics

Tests and reconciliation queries must prove:

- Transfer pairs affect neither income nor consumption.
- Credit-card settlement is a transfer, not spending.
- Refunds reduce the intended expense category.
- Starting balances and revaluations do not count as income.
- Uncategorized transactions remain visible in quality metrics.
- Budget balances and safe-to-spend components agree with Actual.
- Investment value is counted once in net worth.

### 12.3 Dashboard QA

For fixed closed months, compare Grafana totals with reviewed Actual exports for:

- Ordinary income.
- Consumption.
- Transfers.
- Savings/investing contributions.
- Category spending.
- Month-end account and net-worth balances.

Verify that stale sources, incomplete reconciliation, or an excessive review queue visibly invalidate headline metrics.

## 13. Acceptance Criteria

- Reimporting an unchanged source window creates no duplicate transactions.
- At least 95% of ordinary transactions receive a usable payee automatically.
- At least 90% of ordinary transactions receive a correct automatic category after the initial learning period.
- The weekly review queue normally remains below ten transactions.
- Every active on-budget account reconciles to its bank balance.
- Safe-to-spend is traceable to funded discretionary envelopes, essential underfunding, and remaining schedules.
- Grafana and Actual agree on reviewed monthly income, consumption, and transfers.
- The dashboard identifies stale or untrustworthy data rather than presenting it as current.
- Routine operation requires no edits to repository categorization or budget JSON.

## 14. Explicit Non-Goals

- Automatic category decisions inside bank adapters.
- A warehouse as the authoritative transaction ledger.
- Fully zero-touch categorization of ambiguous merchants.
- Tax-lot, realized-gain, or investment-performance accounting.
- Automatic heuristic deletion of suspected duplicates.
- Replacing Actual's budgeting interface with Grafana.

## 15. Key Decisions

- Actual is the primary daily interface; Grafana is secondary analytics.
- Use both envelope budgeting and a derived safe-to-spend headline.
- Accept a five-to-ten-minute weekly review.
- Keep investment scope to contributions and current value.
- Prefer the Actual-native architecture over config-as-code or warehouse-first alternatives.

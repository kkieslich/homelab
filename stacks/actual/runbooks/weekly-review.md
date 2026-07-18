# Weekly finance review

Target time after initial migration: five to ten minutes. Actual is the only
place to change finance data. Grafana and SQLite are read-only checks.

> The native-rule/category migration and coverage acceptance are live operator
> gates. Until they pass, use this workflow to migrate and verify; do not claim
> that normal queue targets have already been achieved.

## 1. Import one bank at a time

1. Confirm no Actual Komodo procedure or importer is already running.
2. Run **Actual - Sync UmweltBank now** and wait for completion.
3. Inspect the latest privacy-safe run manifest with the exact read-only command
   in [the README](../README.md#inspect-the-latest-bank-manifest), using
   `manifest_source=fints-umwelt` and `manifest_outcome=any`. Compare its account
   counts with the last
   successful manifest for the same requested window plus known new bank
   postings. Stop for failure, quarantine, unexpected zero data, an account
   appearing/disappearing, or an unexplained count change.
4. Confirm the Baader daemon is healthy. If its session expired, run
   **Actual - Sync Baader now** once and wait for `Enter TAN:`.
5. Enter the smsTAN through SSH:

   ```sh
   ssh -t kolja@192.168.1.20
   sudo docker attach fints_daemon_baader
   ```

   Type the TAN and press Enter. Detach with Ctrl-p, Ctrl-q. Never press Ctrl-c.
   Then inspect `sudo docker logs --tail 100 fints_daemon_baader` and run the
   manifest command with `manifest_source=fints-fnz`.
6. Run **Actual - Audit imports** and **Actual - Finance health**. Both are
   read-only.

Never overlap imports or fall back to the retired categorizer, date/index
importer, or an unreviewed CSV import. Never expose authentication or raw bank
data in logs or notes.

## 2. Work the Actual review queue

### Intentional same-day repeats

The duplicate signal is deliberately fuzzy: two legitimate purchases can share
account, date, amount, and payee. Compare the exact transaction IDs, bank
reference, notes, and receipt in Actual. Do not merge when the evidence shows
two purchases. Resolve only the currently displayed candidate key, first as a
dry run and then with `--apply`:

```sh
ssh -t kolja@192.168.1.20
sudo docker exec actual_db_sync node /app/cli/bin/actual.mjs duplicate-resolution \
  --snapshot=/db/actual.sqlite --candidate-key=duplicate_candidate:KEY \
  --resolution=intentional_repeat --note="two separate receipts" \
  --reviewer=YOUR_NAME --resolved-at=YYYY-MM-DDTHH:MM:SSZ
```

The supported resolutions are `intentional_repeat`,
`confirmed_duplicate_merged`, and `not_a_duplicate`. After verifying the dry
run, repeat with `--apply`. The write is transactional and audited. It refuses
a stale key or changed evidence; refresh and review again instead of editing
SQLite directly. An unchanged candidate remains resolved across db-sync. A
repeat is idempotent only when resolution, normalized note, reviewer, and UTC
timestamp exactly match the immutable audit; any conflict fails closed.

Open the saved filter for on-budget, non-transfer transactions with a missing
category/payee, duplicate candidate, or unusual amount.

1. Correct the payee first and category second.
2. Approve/refine a native rule only when the imported description has a stable
   meaning. Keep broad aggregators and person-to-person payments reviewable.
3. Leave an unknown transaction uncategorized; do not hide it in `Needs Review`.
4. Confirm owned-account movements use Actual transfer payees and no spending
   category.
5. Match salary, bills, subscriptions, savings, and investment contributions to
   Actual schedules. Investigate overdue schedules.
6. Return refunds to the original expense category where practical.
7. Inspect large or unusual transactions against bank evidence.

Routine changes to payees, rules, categories, schedules, targets, and envelope
funding happen here in Actual, not in `categorization.json`, `budget.json`, or
other repository JSON. Category-group JSON is validation/bootstrap only.

## 3. Reconcile and check spending

Reconcile every active on-budget account to the bank's cleared balance. Stop if
any difference is unexplained. Check essential envelope underfunding and unpaid
schedules, then verify safe to spend:

```text
positive discretionary envelope availability
- essential envelope underfunding
- unpaid discretionary schedules due through month-end (including overdue)
```

Every component must trace to Actual. Move money between envelopes in Actual if
needed; never modify SQLite to change the result.

Use the `[Discretionary] ` prefix for active schedules that reduce this metric,
and `[Fixed] `, `[Essential] `, `[Sinking fund] `, `[Savings] `, or `[Income] `
for the other active schedules. An unclassified active schedule, failed schedule fetch, or schedule projection
older than 15 minutes suppresses the headline rather than overstating it.
Approximate/range schedule amounts, malformed dates/types, wrong signs, and
future-skewed source timestamps invalidate the entire schedule projection.
Likewise, missing/stale/wrong-month budget evidence makes safe-to-spend
unavailable rather than zero.

Use **Actual — Home** for the trust-first overview, **Actual — Monthly** for
drivers and category/payee detail, and **Actual — Investments & Pipeline** for
holdings and import diagnostics. Suppressed headlines mean `finance_trust` is
false; resolve its reasons rather than bypassing the gate.

## 4. Completion and recovery

The weekly review is complete when imports are current, quarantines and
confirmed duplicates are zero, remaining queue items are understood, schedules
are current, and active accounts reconcile exactly. The steady-state queue
target is below 10 only after the live rule migration meets its coverage gate.
Actual's authoritative reconciliation date must be present and no older than 35
days for every open account; update it by reconciling in Actual, never by editing
the replica.

If an import fails, preserve its manifest, stop other writers, run the two
read-only procedures, and diagnose the source before retrying. If it wrote data,
verify bank evidence and merge only confirmed duplicates in Actual. Prove an
identical fetch window has `added=0`, only understood pending/cleared updates,
and `quarantined=0` before resuming. Use [restore.md](restore.md) for
backup/restore; never delete a production volume in place.

An empty batch is recorded as `empty` (or `partial_empty`) and never advances
source freshness. The guard compares a source/account/window only with durable
prior non-dry successful manifests. A drop from a prior non-empty success is
`EMPTY_BATCH_REGRESSION`; a first genuinely empty window is explicit but still
leaves finance trust closed until non-empty successful coverage exists.
Coverage is evaluated independently for every enabled Actual account using the
successful manifest's `requested_to` date and configured cadence. A fresh
process that fetched an old window, or a shared-source run missing one account,
does not satisfy trust.
The successful process finish time must also be within cadence; a recent-looking
coverage date from an old run is not current. Reversed, malformed, or future
coverage ranges are rejected before import writes.
Requested-range “today” uses `FINANCE_TIMEZONE` (`Europe/Berlin` by default),
while manifest instants remain UTC. A run timestamp over five minutes in the
future is invalid evidence and must be corrected at the producing host clock.

Use [month-close.md](month-close.md) for closed-month reconciliation, funding,
sinking funds, and immutable snapshots.

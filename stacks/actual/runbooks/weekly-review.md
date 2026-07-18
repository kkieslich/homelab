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
   `MANIFEST_SOURCE=fints-umwelt`. Compare its account counts with the last
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
   manifest command with `MANIFEST_SOURCE=fints-fnz`.
6. Run **Actual - Audit imports** and **Actual - Finance health**. Both are
   read-only.

Never overlap imports or fall back to the retired categorizer, date/index
importer, or an unreviewed CSV import. Never expose authentication or raw bank
data in logs or notes.

## 2. Work the Actual review queue

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
- unpaid discretionary schedules due this month
```

Every component must trace to Actual. Move money between envelopes in Actual if
needed; never modify SQLite to change the result.

Use **Actual — Home** for the trust-first overview, **Actual — Monthly** for
drivers and category/payee detail, and **Actual — Investments & Pipeline** for
holdings and import diagnostics. Suppressed headlines mean `finance_trust` is
false; resolve its reasons rather than bypassing the gate.

## 4. Completion and recovery

The weekly review is complete when imports are current, quarantines and
confirmed duplicates are zero, remaining queue items are understood, schedules
are current, and active accounts reconcile exactly. The steady-state queue
target is below 10 only after the live rule migration meets its coverage gate.

If an import fails, preserve its manifest, stop other writers, run the two
read-only procedures, and diagnose the source before retrying. If it wrote data,
verify bank evidence and merge only confirmed duplicates in Actual. Prove an
identical fetch window has `added=0`, only understood pending/cleared updates,
and `quarantined=0` before resuming. Use [restore.md](restore.md) for
backup/restore; never delete a production volume in place.

Use [month-close.md](month-close.md) for closed-month reconciliation, funding,
sinking funds, and immutable snapshots.

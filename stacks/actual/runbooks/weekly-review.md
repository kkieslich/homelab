# Weekly finance review

## Refresh bank data

Run only one Actual Komodo procedure at a time. Komodo serializes stack
operations, so wait until no other Actual procedure is active before starting
or restarting Baader.

Run **Actual - Sync UmweltBank now** when its interactive SCA is available.
Baader normally fetches and imports hourly through `fints_daemon_baader`. If its
session expired, run **Actual - Sync Baader now**, then enter the SMS TAN:

```sh
ssh -t kolja@192.168.1.20
sudo docker attach fints_daemon_baader
```

Wait for `Enter TAN:`, type the SMS TAN, and press Enter. Detach without
stopping the daemon by pressing Ctrl-p and then Ctrl-q. Never press Ctrl-c in
the attached terminal.

Inspect the daemon after detaching:

```sh
sudo docker logs --tail 100 fints_daemon_baader
```

Never paste a TAN, PIN, bank login, IBAN, or raw banking payload into logs,
issues, chat, or repository files.

## Review in Actual

Complete this review in Actual, which is authoritative for payees, categories,
transfers, schedules, and funded envelopes:

1. Confirm both import sources have a successful, current run. Stop if a batch
   is quarantined or unexpectedly empty; do not compensate with a manual CSV
   import.
2. Open the saved review filter for uncategorized, missing-payee, duplicate-
   candidate, and unusual-value transactions.
3. Correct the payee first, then the category. Add or refine a native Actual
   rule only when the same imported description has a stable meaning.
4. Leave Amazon, PayPal, Klarna, cash withdrawals, and person-to-person
   payments reviewable when their purpose varies.
5. Confirm movements between owned accounts use transfer payees. Never assign
   them to an expense category such as `Internal Transfer`.
6. Match expected salary, bills, subscriptions, savings, and investment
   contributions to their Actual schedules. Investigate overdue schedules.
7. Inspect unusual large transactions and confirm refunds return to the
   original spending category where practical.
8. Reconcile each active on-budget account to the bank's cleared balance.

The review is complete only when every remaining queue item is understood and
every active on-budget account reconciles. Do not hide unresolved items in a
`Needs Review` category. Grafana's read model refreshes automatically within
five minutes, but Grafana is not a correction interface.

## Budget check

Check for overspent or underfunded essential envelopes and upcoming scheduled
outflows. Move available money in Actual if necessary; do not edit
`cli/config/budget.json`. Until the native-envelope migration has been
reconciled, that file is retained only as legacy migration input.

Use [month-close.md](month-close.md) for envelope funding, sinking-fund review,
and the full monthly reconciliation.

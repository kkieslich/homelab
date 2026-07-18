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

Open the saved review filter, correct the payee before the category, confirm
transfers, inspect unusual large transactions, and reconcile each on-budget
account. Grafana's read model refreshes automatically within five minutes.

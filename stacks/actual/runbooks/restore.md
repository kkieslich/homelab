# Actual backup and restore

Use this runbook before any ledger cleanup. Run it on `livingroom-server` as a
user with Docker access and passwordless `sudo`. Never put decrypted `.env` or
`banks.toml` files in the backup directory.

## Resolve the production targets

Confirm the mounts before archiving. The expected sources are the three paths
below; stop if Docker reports different paths.

```sh
docker inspect actual_server --format '{{json .Mounts}}'
docker inspect actual_db_sync --format '{{json .Mounts}}'
sudo du -sh \
  /persist/docker/volumes/actual_server-data/_data \
  /persist/docker/volumes/actual_fints-state/_data \
  /persist/docker/volumes/actual_db/_data
```

The `/persist/appdata/actual/*` directories are not production backups unless
the mount inspection explicitly identifies them.

## Export the budget

In Actual, use **Settings → Export data → Actual budget file** and save the
export in the password manager's encrypted document storage. This is the
supported, portable export and is independent of the server-volume archive.
Alternatively, an API client may call `downloadBudget` into an encrypted local
data directory. Do not commit either export.

## Create the server backup

Importer jobs are one-shot profile services. Verify that none is running; do
not stop `actual_server` or `actual_db_sync` for this procedure.

```sh
docker ps --format '{{.Names}}' | grep '^fints_sync_' || true

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir=/persist/backups/actual/$stamp
sudo install -d -m 0700 "$backup_dir"

sudo tar --xattrs --acls \
  -C /persist/docker/volumes/actual_server-data \
  -czf "$backup_dir/actual_server-data.tar.gz" _data
sudo tar --xattrs --acls \
  -C /persist/docker/volumes/actual_fints-state \
  -czf "$backup_dir/actual_fints-state.tar.gz" _data
sudo tar --xattrs --acls \
  -C /persist/docker/volumes/actual_db \
  -czf "$backup_dir/actual_db.tar.gz" _data

sudo sh -c "cd '$backup_dir' && sha256sum *.tar.gz > SHA256SUMS"
sudo sh -c "cd '$backup_dir' && sha256sum -c SHA256SUMS"
```

Record the explicit directory and checksums in the change log before cleanup.

## Restore drill on a non-production port

The drill restores a copy, never the production volume. The restored server
must be writable because Actual runs database migrations at startup.

```sh
backup_dir=/persist/backups/actual/YYYYMMDDTHHMMSSZ
drill_dir="$backup_dir/restore-drill"
sudo install -d -m 0700 "$drill_dir"
sudo tar -xzf "$backup_dir/actual_server-data.tar.gz" -C "$drill_dir"
sudo chown -R 1000:1000 "$drill_dir/_data"

docker run -d --name actual_restore_drill \
  --network proxy_net \
  -p 127.0.0.1:15006:5006 \
  -v "$drill_dir/_data:/data" \
  actualbudget/actual-server:latest
curl --retry 30 --retry-delay 1 --retry-connrefused -fsS \
  http://127.0.0.1:15006/ >/dev/null
```

Point a temporary Actual API client at
`http://actual_restore_drill:5006`, download the configured sync ID into a new
temporary client directory, and verify account and transaction counts. The
2026-07-18 pre-cleanup baseline is seven accounts and 1,496 transactions.
Remove only the explicitly named drill container and directory afterward:

```sh
docker rm -f actual_restore_drill
sudo rm -rf "$drill_dir"
```

## Production restore

Only restore during an announced outage. First stop the three Actual services,
move each current `_data` directory to a timestamped rollback location, verify
the archive checksums, then extract each archive into its matching parent.
Preserve ownership and ACLs. Start `actual_server` first, verify login and the
budget, then start `actual_db_sync`; leave importer jobs stopped until account
counts, balances, and the duplicate audit agree with the recorded baseline.

Do not restore by deleting a production volume in place, and do not use this
procedure to merge duplicate transactions.

## Duplicate cleanup gate

Use Actual's transaction merge action in the UI. Compare account, amount, raw
description, bank reference, and dates for every candidate. Never merge merely
because date, amount, and payee match. In particular, preserve the repeated BHW
repayments and repeated card charges unless distinct bank references prove that
two rows represent the same bank record.

After merging, refresh `actual_db_sync` and record:

```sh
docker restart actual_db_sync
docker exec actual_db_sync node -e '
const Database = require("better-sqlite3");
const db = new Database("/db/actual.sqlite", { readonly: true });
console.log(db.prepare("select count(*) as transactions from transactions").get());
console.table(db.prepare("select name, balance_cents from accounts order by name").all());
console.log(db.prepare("select count(*) as uncategorized from transactions where category_id is null and is_transfer = 0").get());
'
```

Run `actual audit-imports --json` and reconcile every on-budget account against
its bank statement. Cleanup is incomplete until confirmed duplicate groups and
bank/ledger balance differences are both zero.

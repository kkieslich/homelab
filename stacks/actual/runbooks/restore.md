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

Stop only the explicitly named importer containers if they exist, then abort
unless both are inactive. The Baader daemon will require a fresh SMS TAN after
it is started again. Do not stop
`actual_server` or `actual_db_sync` for this procedure.

```sh
for importer in fints_sync_umwelt fints_daemon_baader; do
  if docker container inspect "$importer" >/dev/null 2>&1; then
    docker stop --time 30 "$importer"
  fi
done
for importer in fints_sync_umwelt fints_daemon_baader; do
  if docker ps --quiet --filter "name=^/${importer}$" | grep -q .; then
    echo "ABORT: importer is still running: $importer" >&2
    exit 1
  fi
done

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

Use the API client already installed in `actual_db_sync` to verify the restored
server. The command inherits the production credentials without printing them,
but overrides the server and uses a fresh client directory. It must report
seven accounts and 1,496 transactions for the 2026-07-18 pre-cleanup backup.

```sh
docker exec actual_db_sync mkdir -p /tmp/actual-restore-verify
docker exec \
  -e ACTUAL_SERVER_URL=http://actual_restore_drill:5006 \
  -e ACTUAL_DATA_DIR=/tmp/actual-restore-verify \
  actual_db_sync node --input-type=module -e '
import * as api from "@actual-app/api";
await api.init({
  dataDir: process.env.ACTUAL_DATA_DIR,
  serverURL: process.env.ACTUAL_SERVER_URL,
  password: process.env.ACTUAL_PASSWORD,
});
await api.downloadBudget(process.env.ACTUAL_BUDGET_ID);
const accounts = await api.getAccounts();
let transactions = 0;
for (const account of accounts) {
  transactions += (await api.getTransactions(
    account.id, "1900-01-01", "2100-01-01"
  )).length;
}
console.log(JSON.stringify({ accounts: accounts.length, transactions }));
await api.shutdown();
'
```

Remove only the explicitly named drill container and the validated drill
directory afterward:

```sh
docker rm -f actual_restore_drill
case "$drill_dir" in
  /persist/backups/actual/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z/restore-drill)
    sudo rm -rf -- "$drill_dir"
    ;;
  *) echo "ABORT: invalid drill path: $drill_dir" >&2; exit 1 ;;
esac
```

## Production restore

Only restore during an announced outage. Run from the deployed Compose
directory. Replace the timestamp once; the validation refuses any other path.

```sh
cd /var/lib/komodo-periphery/stacks/actual/stacks/actual
backup_dir=/persist/backups/actual/YYYYMMDDTHHMMSSZ
case "$backup_dir" in
  /persist/backups/actual/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) echo "ABORT: invalid backup path: $backup_dir" >&2; exit 1 ;;
esac
sudo test -f "$backup_dir/SHA256SUMS"
sudo sh -c "cd '$backup_dir' && sha256sum -c SHA256SUMS"

for importer in fints_sync_umwelt fints_daemon_baader; do
  if docker container inspect "$importer" >/dev/null 2>&1; then
    docker stop --time 30 "$importer"
  fi
done
docker compose stop actual_db_sync actual_server

restore_stamp=$(date -u +%Y%m%dT%H%M%SZ)
rollback_dir=/persist/backups/actual/rollback-$restore_stamp
sudo install -d -m 0700 "$rollback_dir"
sudo mv /persist/docker/volumes/actual_server-data/_data \
  "$rollback_dir/actual_server-data._data"
sudo mv /persist/docker/volumes/actual_fints-state/_data \
  "$rollback_dir/actual_fints-state._data"
sudo mv /persist/docker/volumes/actual_db/_data \
  "$rollback_dir/actual_db._data"

sudo tar --xattrs --acls -xzf "$backup_dir/actual_server-data.tar.gz" \
  -C /persist/docker/volumes/actual_server-data
sudo tar --xattrs --acls -xzf "$backup_dir/actual_fints-state.tar.gz" \
  -C /persist/docker/volumes/actual_fints-state
sudo tar --xattrs --acls -xzf "$backup_dir/actual_db.tar.gz" \
  -C /persist/docker/volumes/actual_db
sudo chown -R 1000:1000 /persist/docker/volumes/actual_server-data/_data

docker compose up -d actual_server
curl --retry 30 --retry-delay 1 --retry-connrefused -fsS \
  http://127.0.0.1:5006/ >/dev/null
docker compose up -d actual_db_sync
```

Verify login, budget counts, balances, and the duplicate audit before running
either importer. If verification fails, roll back using the exact directory
printed above:

```sh
cd /var/lib/komodo-periphery/stacks/actual/stacks/actual
rollback_dir=/persist/backups/actual/rollback-YYYYMMDDTHHMMSSZ
case "$rollback_dir" in
  /persist/backups/actual/rollback-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) echo "ABORT: invalid rollback path: $rollback_dir" >&2; exit 1 ;;
esac
sudo test -d "$rollback_dir/actual_server-data._data"
sudo test -d "$rollback_dir/actual_fints-state._data"
sudo test -d "$rollback_dir/actual_db._data"
docker compose stop actual_db_sync actual_server
failed_stamp=$(date -u +%Y%m%dT%H%M%SZ)
failed_dir=/persist/backups/actual/failed-restore-$failed_stamp
sudo install -d -m 0700 "$failed_dir"
sudo mv /persist/docker/volumes/actual_server-data/_data \
  "$failed_dir/actual_server-data._data"
sudo mv /persist/docker/volumes/actual_fints-state/_data \
  "$failed_dir/actual_fints-state._data"
sudo mv /persist/docker/volumes/actual_db/_data \
  "$failed_dir/actual_db._data"
sudo mv "$rollback_dir/actual_server-data._data" \
  /persist/docker/volumes/actual_server-data/_data
sudo mv "$rollback_dir/actual_fints-state._data" \
  /persist/docker/volumes/actual_fints-state/_data
sudo mv "$rollback_dir/actual_db._data" \
  /persist/docker/volumes/actual_db/_data
docker compose up -d actual_server
curl --retry 30 --retry-delay 1 --retry-connrefused -fsS \
  http://127.0.0.1:5006/ >/dev/null
docker compose up -d actual_db_sync
```

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

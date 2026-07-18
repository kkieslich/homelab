# Actual-first personal finance

Actual Budget is the primary interface and source of truth for transactions,
payees, native rules, transfers, schedules, categories, and funded envelopes.
The SQLite projection and Grafana are read-only consumers. They must never be
used to correct the ledger or define routine finance policy.

> Cutover status (2026-07-18): the repository implementation is prepared, but
> the live Actual category/rule migration, coverage acceptance, complete account
> reconciliation, production deployment, and idempotence proof are separate
> operator gates. Follow the runbooks and do not interpret this document as
> evidence that those live gates have passed.

## Architecture and ownership

```text
UmweltBank one-shot ─┐
                     ├─ canonical validation ─> Actual Budget
Baader daemon ───────┘   + guarded manifests      │
                                                  ├─ payees/rules/transfers
                                                  ├─ schedules/categories
                                                  └─ funded envelopes
                                                         │ read-only
                                                         v
                                              actual_db_sync (SQLite)
                                                         │
                                                         v
                                               three Grafana dashboards
```

| Service | Purpose |
|---|---|
| `actual_server` | Actual web application at `https://actual.home.kki.berlin`. |
| `fints_sync_umwelt` | Profile-gated, guarded UmweltBank one-shot import. |
| `fints_daemon_baader` | Persistent hourly Baader import; keeps the smsTAN-authenticated FinTS dialog alive. |
| `actual_db_sync` | Rebuilds the read-only SQLite projection every five minutes. |

[`cli/config/accounts.json`](cli/config/accounts.json) is the non-secret writer
registry. Exactly one enabled importer may own each Actual account. It records
the source namespace, source account, role, cadence, and interactive-auth
requirement; it contains no credentials or IBANs. `manual-actual` means that no
automated importer may target that historical account. Credentials and bank
mapping remain only in the SOPS-encrypted bank configuration.

The importer creates stable namespaced IDs, rejects invalid/empty/conflicting
batches, calls Actual with `reimportDeleted: false`, and writes privacy-safe run
manifests under the FinTS state volume. Fuzzy duplicate candidates are reported,
never automatically deleted or merged.

## Operator entry points

Komodo provides one guarded path per interactive bank:

- **Actual - Sync UmweltBank now** runs the one-shot guarded service. Wait for
  it to finish and inspect its manifest before starting another Actual job.
- **Actual - Sync Baader now** restarts the persistent daemon when its session
  has expired. It is not a second Baader importer.
- **Actual - Audit imports** runs the live API audit read-only.
- **Actual - Finance health** reads finance trust, review-queue size, and source
  freshness from SQLite read-only.

Do not overlap bank procedures. Do not compensate for a failed guarded import
with CSV import, the retired date/index importer, or the external categorizer.
The database projection refreshes on its normal cadence; a bank procedure does
not need to restart it.

### Inspect the latest bank manifest

The `actual_db_sync` container mounts FinTS state read-only at `/fints`. Run the
following after SSHing to the server. Set `MANIFEST_SOURCE` to exactly
`fints-umwelt` or `fints-fnz`; the script selects the latest matching manifest
by `finished_at` and prints only the manifest's privacy-safe contract fields:

```sh
sudo docker exec -e MANIFEST_SOURCE=fints-umwelt actual_db_sync \
  node --input-type=module -e '
import { readFile, readdir } from "node:fs/promises";
const dir = "/fints/import-runs";
const manifests = [];
for (const name of await readdir(dir)) {
  if (!name.endsWith(".json")) continue;
  const value = JSON.parse(await readFile(`${dir}/${name}`, "utf8"));
  if (value.source === process.env.MANIFEST_SOURCE) manifests.push(value);
}
manifests.sort((a, b) => String(a.finished_at).localeCompare(String(b.finished_at)));
const value = manifests.at(-1);
if (!value) throw new Error(`No manifest for ${process.env.MANIFEST_SOURCE}`);
console.log(JSON.stringify({
  schema_version: value.schema_version,
  run_id: value.run_id,
  source: value.source,
  importer_version: value.importer_version,
  started_at: value.started_at,
  finished_at: value.finished_at,
  requested_range: value.requested_range,
  outcome: value.outcome,
  error_code: value.error_code,
  accounts: (value.accounts ?? []).map(account => ({
    actual_account_id: account.actual_account_id,
    fetched: account.fetched,
    valid: account.valid,
    added: account.added,
    updated: account.updated,
    quarantined: account.quarantined,
  })),
}, null, 2));
'
```

For Baader, change only the first line to
`MANIFEST_SOURCE=fints-fnz`. UUID filenames do not contain the bank name, so do
not select manifests with `ls | tail`; filter the parsed `source` as above.

Before a run, obtain the expectation from the last successful manifest for the
same source and requested date window plus the bank's known new postings. Treat
its per-account `fetched` and `valid` counts as the baseline, not an automatic
approval: investigate unexpected decreases, large increases, or an account
appearing/disappearing. After a repeated identical window, every account must
have `added=0`; `updated` is allowed only for an understood pending/cleared
transition, and `quarantined` must be zero. The manifest intentionally contains
no raw transactions, payees, credentials, IBANs, or source account identifiers.

### Entering a Baader SMS TAN

After restarting the daemon, wait for `Enter TAN:` in its logs, then attach:

```sh
ssh -t kolja@192.168.1.20
sudo docker attach fints_daemon_baader
```

Type the SMS TAN and press Enter. Detach without stopping the daemon by pressing
Ctrl-p and then Ctrl-q. Never press Ctrl-c. Verify the session after detaching:

```sh
sudo docker logs --tail 100 fints_daemon_baader
```

Never put a TAN, PIN, bank login, IBAN, decrypted config, or raw bank payload in
Git, Komodo logs, tickets, or chat.

## Actual-native finance workflow

Routine finance changes happen in Actual, not repository JSON. In Actual:

1. Correct the payee first, then the category.
2. Approve narrow native rules for stable imported descriptions.
3. Use transfer payees for movements between owned accounts.
4. Maintain schedules for salary, obligations, subscriptions, savings, and
   investment contributions.
5. Fund and move money between native envelopes.

Variable-purpose Amazon, PayPal, Klarna, cash, and person-to-person payments
remain reviewable. Unknown transactions stay uncategorized; `Needs Review` is
not a financial category. The saved review queue is the operating inbox.

The six expected category groups are `Fixed obligations`, `Flexible
essentials`, `Discretionary`, `Sinking funds`, `Savings and investing`, and
`Income`. [`cli/config/category-groups.json`](cli/config/category-groups.json)
validates those names and may bootstrap migration; it is not an ongoing category
assignment system. `categorization.json`, `budget.json`, and `actual categorize`
are retained only as migration artifacts until the live acceptance gate permits
their removal. They must not run concurrently with native rules.

## Safe to spend and finance trust

Safe to spend is a planning metric, not a bank balance:

```text
positive discretionary envelope availability
- essential envelope underfunding
- unpaid discretionary schedules due this month
```

The daily value divides the non-negative result by the remaining calendar days,
including today. Every component must trace to Actual. Money assigned to fixed
obligations, sinking funds, or savings is never spendable merely because it is
liquid.

`finance_trust` is the analytical publication gate. Stale/missing source runs,
quarantine, unresolved duplicate candidates, non-zero reconciliation gaps,
excess review backlog, or invalid semantic mappings make the projection
untrusted. Headline Grafana values intentionally suppress themselves when trust
is false. Fix the underlying ledger/pipeline issue; never edit the replica to
force trust.

## Grafana

Grafana exposes exactly three downstream views:

- **Actual — Home**: trust first, latest close net worth/liquidity, safe to
  spend, savings rate, review queue, funded versus consumed, and freshness.
- **Actual — Monthly**: closed-month income, consumption, savings, role trends,
  drivers, categories, payees, and immutable snapshot history.
- **Actual — Investments & Pipeline**: contributions, holdings, portfolio
  history, latest runs, quarantine, duplicate candidates, and reconciliation
  gaps.

All use canonical SQLite models. Grafana is for exploration and diagnosis, not
categorization, reconciliation, scheduling, or budgeting.

## Recurring operations

- Follow [weekly-review.md](runbooks/weekly-review.md) after imports.
- Follow [month-close.md](runbooks/month-close.md) after the final import for a
  closed month.
- Follow [restore.md](runbooks/restore.md) before cleanup and for verified
  backup/restore instructions.

The month-close CLI is dry-run by default:

```sh
ssh -t kolja@192.168.1.20
sudo docker exec actual_db_sync node /app/cli/bin/actual.mjs month-close \
  --month=YYYY-MM --snapshot=/db/actual.sqlite
```

The first command only validates and previews. Only after all gates pass, add
`--apply`; this intentionally writes immutable budget and net-worth snapshot
rows to the analytical SQLite database, but does not modify Actual. Review
annotations must use the typed `accepted_for_close` decision; a generic note is
not a substitute.

## Failure recovery

1. Stop if a manifest reports failure, quarantine, unexpected zero data, or
   counts inconsistent with the prior successful same-source/window baseline
   and known new postings. Do not run another writer.
2. Preserve the manifest and inspect sanitized service logs. Never copy raw
   banking data into an incident record.
3. Run **Actual - Audit imports** and **Actual - Finance health**.
4. For expired Baader authentication, restart only the daemon and attach for
   the SMS TAN. For UmweltBank, rerun its single one-shot procedure only after
   the failed run is understood.
5. If transactions were already written, compare the ledger and bank evidence;
   merge only confirmed duplicates in Actual. Same-day/date/amount similarity
   alone is insufficient.
6. Reconcile all affected accounts and prove the same fetch window adds zero
   transactions before restoring normal operation.
7. For corruption or an unsafe migration, use the verified backup and restore
   runbook. Never delete production volumes in place.

## Cutover acceptance gate

Before declaring the live workflow complete, record evidence that:

- the backup path/checksums and restore drill are valid;
- each bank imports alone with no quarantine and a repeated identical window
  yields `added=0`;
- the duplicate audit has no new confirmed groups;
- every active account reconciles exactly;
- one fixed closed month agrees between Actual and SQLite/Grafana at cent level;
- usable-payee coverage is at least 95%, reviewed category accuracy at least
  90%, and the review queue is normally below 10;
- safe-to-spend components trace to envelopes and unpaid schedules; and
- `finance_trust` is true or every false reason is explicitly understood.

Until this evidence exists, the repository is cutover-ready, not cut over.

## Local verification

```sh
(cd fints-actual-bridge && npm test)
(cd cli && npm test)
(cd db-sync && npm test)
(cd ../monitoring && docker compose config --quiet)
docker compose config --quiet
jq empty ../monitoring/grafana/provisioning/dashboards/actual-*.json
```

The `db-sync` test suite prepares every provisioned dashboard query against a
fixture SQLite database, so its passing result is the query-validation gate.

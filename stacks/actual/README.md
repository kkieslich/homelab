# Actual Budget stack

Self-hosted [Actual Budget](https://actualbudget.org/) running on the home server, with manual FinTS imports for UmweltBank and Baader, rule-based categorization, versioned budget targets, and a SQLite read-replica that feeds the Grafana finance dashboards.

## Architecture

```
UmweltBank / Baader
        │
        ▼
fints-actual-bridge
manual Komodo procedures
        │
        ▼
actual_server
container · :5006
        │
        ├── cli/config/categorization.json
        ├── cli/config/budget.json
        │
        ▼
actual_db_sync
every 5 min → SQLite (/db/actual.sqlite)
        │
        ▼
grafana (frser-sqlite-datasource)
```

The dashboards run real SQL against a year of historical data — not against a metrics-scraping window. Add a new SQL panel and it works against the full transaction history immediately.

## Services (docker-compose.yml)

| Container | Port | What it does |
|---|---|---|
| `actual_server` | 5006 | The Actual Budget server itself. Accessed at https://actual.home.kki.berlin via Caddy. |
| `fints_sync_umwelt` | — | Manual one-shot service for UmweltBank. Run through Komodo procedure **Actual - Sync UmweltBank now**. |
| `fints_sync_baader` | — | Manual one-shot service for Baader / finanzen.net zero. Run through Komodo procedure **Actual - Sync Baader now**. |
| `actual_db_sync` | — | Pulls a fresh snapshot from `actual_server` every 5 min and writes it to `/db/actual.sqlite` on the shared `/persist/appdata/actual/db` bind mount. |

Grafana lives in [`stacks/monitoring/`](../../stacks/monitoring/) and reads the same `/persist/appdata/actual/db` directory.

## Subdirectories

| Path | What it is |
|---|---|
| [`cli/`](cli/) | Local Node CLI (`actual fetch / analyze / subs / categorize`) for ad-hoc analysis and rule-based categorization. Not a container — runs from your dev machine. |
| [`cli/config/`](cli/config/) | Versioned categorization rules and monthly budget targets. |
| [`db-sync/`](db-sync/) | The SQLite read-replica writer. Reuses `cli/`'s subscription detector. |
| [`fints-actual-bridge/`](fints-actual-bridge/) | Python+Node bridge that fetches credit-card transactions via FinTS (which exposes them, unlike PSD2) and imports them into Actual. Runs manually due to interactive SCA. See its own README for protocol notes. |
| [`runbooks/restore.md`](runbooks/restore.md) | Verified backup, restore-drill, and guarded duplicate-cleanup procedure. |
| `/persist/docker/volumes/actual_server-data/_data` | Production named-volume data for `actual_server`. |
| `/persist/docker/volumes/actual_fints-state/_data` | Production FinTS runtime state, fetch output, status, and holdings files. |
| `/persist/docker/volumes/actual_db/_data` | Production SQLite read replica shared with Grafana. |
| `banks.toml.enc` | SOPS-encrypted bank/account mapping, decrypted by Komodo pre-deploy. |

## SQLite read-replica schema

`actual_db_sync` re-creates these tables on every refresh (5-min cadence) and writes them into `/persist/appdata/actual/db` at `/db/actual.sqlite`:

| Table | What's in it |
|---|---|
| `accounts` | id, name, offbudget, closed, balance_cents (snapshot at sync time) |
| `categories` | id, name, group_name, is_income |
| `payees` | id, name, transfer_account_id |
| `transactions` | full denormalised row including category_name, group_name, payee_name, account_name. Plus `month` (`'YYYY-MM'`), `year`, `ymd_unix` for cheap GROUP BY. |
| `subscriptions` | output of the cli detector — payee, cadence, median, annualized, is_active, days_since_last |
| `pipeline_status` | one row per import source: `umwelt`, `fnz` (from `fints-status.json`), and `sync` (this container's own heartbeat) |
| `holdings` | current depot positions from `holdings.json` — ISIN, name, pieces, market_value, total_value, valuation_date |
| `holdings_history` | append-only — one row per holding per snapshot for portfolio-value-over-time charts |
| `budgets` | monthly targets from `cli/config/budget.json` |

Because every refresh is a `DELETE + re-INSERT` inside a transaction with WAL journaling, Grafana queries are non-blocking and never see partial state.

## First-time setup

```sh
# 1. External network (shared with Caddy reverse proxy)
docker network create proxy_net

# 2. Submodules
git submodule update --init

# 3. Secrets — copy from password manager into stacks/actual/.env
cat > .env <<'EOF'
ACTUAL_PASSWORD=<your password>
ACTUAL_BUDGET_ID=<sync ID from Actual UI: Settings → Show advanced settings → Sync ID>
EOF

# 4. Bring up the stack — this creates the /persist/appdata/actual/db bind mount
cd stacks/actual
docker compose up -d

# 5. Bring up monitoring (reads the Actual SQLite replica, installs SQLite plugin)
cd ../../stacks/monitoring
docker compose up -d

# 6. (Optional) Local CLI for ad-hoc analysis
cd ../../stacks/actual/cli && npm install
./bin/actual.mjs help

# 7. (Optional) FinTS bridge — see fints-actual-bridge/README.md for full setup
cd ../fints-actual-bridge
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
cp banks.toml.example banks.toml  # edit to add your IBAN→Actual UUID mapping
npm install                       # for bin/import.mjs
```

## Grafana dashboards

Open Grafana → **Dashboards** → search "Actual":

- **Actual — Overview**: liquid balance, 30/90/365d spend, sub burden, uncategorized count, net-worth time series, monthly spending bar.
- **Actual — Spending**: bar chart of top categories (window dropdown 30/90/365), full-history monthly time series for top 8 categories, biggest transactions in the window.
- **Actual — Subscriptions**: active subs table with €/year, stale subs table, total burden.
- **Actual — Pipeline Health**: per-bank import freshness (red after 48h), DB sync container heartbeat, recently imported transactions.

All four use the SQLite datasource (`uid: actual`) and run live SQL — copy any panel and modify the SQL to slice differently.

## Daily / weekly workflows

### Import ownership

[`cli/config/accounts.json`](cli/config/accounts.json) is the authoritative
writer registry. Every account has exactly one enabled owner. The FinTS bridge
owns UmweltBank and the active Baader accounts; `manual-actual` owns the
historical Triodos and FNZ Depot accounts and means no automated importer may
target them. The old date/index importer is not present in the deployed Komodo
Compose stack and must not be reintroduced. Imports fail closed when their
account does not match this registry.

Before changing an owner or cleaning transactions, follow the
[backup and restore runbook](runbooks/restore.md). Duplicate candidates are
reviewed and merged through Actual; same-day matches are never deleted
heuristically.

### "I want to import the latest bank transactions"

Run the Komodo procedure for the bank you want to sync:

- **Actual - Sync UmweltBank now**
- **Actual - Sync Baader now**

This also writes `fints-status.json` so the Pipeline Health dashboard knows when each bank last synced. Then categorize:

```sh
cd ../cli && npx actual categorize --apply
```

The dashboards reflect the new data within 5 minutes (next `actual_db_sync` cycle), or restart the container to refresh immediately.

### "I want to see if I'm overspending"

Open Grafana → **Actual — Overview**. Big numbers across the top, monthly spending chart in the middle.

For drilldowns: **Actual — Spending** dashboard, switch the window dropdown. The "Biggest individual transactions" table at the bottom is what you skim to find unusual items.

CLI alternative:
```sh
cd cli && npx actual analyze
npx actual analyze --drilldown="Bills,Subscriptions"
```

### "I want to import my finanzen.net zero (Baader) data"

finanzen.net zero is a tied agent of Baader Bank AG. Both the cash account (Verrechnungskonto) and the securities account (Depot) sit at Baader and are accessible via Baader's FinTS endpoint at `https://fints.baaderbank.de/`.

One-time setup:
1. In Actual, create a new on-budget account for the Verrechnungskonto, copy its UUID.
2. The off-budget `finanzen-zero Depot` account already exists (we created it during the broker reorganisation).
3. Edit `fints-actual-bridge/banks.toml`, add the `[banks.fnz]` block from `banks.toml.example` with both IBANs and the two Actual UUIDs. The depot account needs `type = "depot"`.
4. Add `BANKS_FNZ_LOGIN` (your Baader Online-Banking name, **not** your finanzen.net zero web login) and `BANKS_FNZ_PIN` to `stacks/actual/.env`.
5. If the first connection fails with a Product-ID error, register a free FinTS Product-ID at <https://www.hbci-zka.de/register/prod_register.htm> and add `FINTS_PRODUCT_ID=...` to `.env`.

Then fetch and import the Baader data through Komodo procedure **Actual - Sync Baader now**.

CLI fallback:
```sh
cd fints-actual-bridge
source .venv/bin/activate
fints-fetch --bank fnz --days 30 --out /tmp/fnz.json
node bin/import.mjs --bank fnz --in /tmp/fnz.json
```

What gets imported:
- **Cash transactions** on the Verrechnungskonto (deposits, dividends, fees, the cash legs of buys/sells) — same as your other banks.
- **Holdings snapshot** for the Depot (ISIN, shares, market value, valuation date) — written to `holdings.json`. The bridge also emits a single "Holdings revaluation" transaction on the off-budget Depot account so its Actual balance equals the sum of `total_value` across positions. The transaction is keyed by date so re-runs replace the same adjustment instead of stacking.
- Per-trade detail (price/share, fees) is **not** captured — that lives only in the PDF Wertpapierabrechnungen. If you need cost-basis tracking for tax, use Portfolio Performance's Baader PDF importer alongside.

Baader imports are intentionally one-shot. If Baader rejects a FinTS request, the fetch fails closed and the importer will not revalue the depot from an empty holdings response.

The new **Actual — Investments** Grafana dashboard reads from the SQLite `holdings` and `holdings_history` tables — current portfolio value, allocation pie, per-position time series, total cost basis vs. market value, and unrealised P/L on positions where Baader returns the acquisition price.

### "I want to find a forgotten subscription"

Open **Actual — Subscriptions**. The "Stale" table is your hit list — subscriptions detected as previously active but recently silent.

CLI:
```sh
cd cli && npx actual subs --include-stale
```

### "Something looks miscategorized"

Edit `cli/config/categorization.json` to add or fix a rule. Then:

```sh
cd cli && npx actual categorize                                # dry run
npx actual categorize --apply                                  # commit
npx actual categorize --apply --recat-categories="WrongCat"    # force re-evaluate
```

The matcher walks rules top-to-bottom and uses the first match — order matters.

### "Is my pipeline healthy?"

Open **Actual — Pipeline Health**. The per-bank import status table goes yellow at 24h and red at 48h. If a bank is red, run the import workflow above.

## CLI reference

`cd cli && ./bin/actual.mjs <command>`. The CLI loads `../.env` automatically.

| Command | What it does |
|---|---|
| `actual fetch` | Snapshot the entire budget (accounts, categories, payees, txs) to `$TMPDIR/actual-cli/transactions.json`. |
| `actual analyze [--months=12] [--top=12] [--drilldown=A,B] [--csv]` | Spending breakdown over rolling window with trend flags. |
| `actual subs [--include-stale] [--min-amount=2] [--csv]` | Recurring-charge detector by cadence + amount stability. |
| `actual categorize [--apply] [--recat-fallback] [--recat-categories=A,B]` | Apply rules from `cli/config/categorization.json`. Dry run by default. |

## Where things live

```
stacks/actual/
├── README.md                # this file
├── docker-compose.yml       # actual server, manual FinTS jobs, SQLite mirror
├── .env                     # secrets (gitignored)
├── actual-data/             # bind mount (gitignored)
├── fints-actual-bridge/     # FinTS import pipeline
│   ├── src/fints_bridge/    # python: fints-fetch, fints-spike CLIs
│   ├── bin/import.mjs       # node: read fetch JSON → @actual-app/api
│   ├── banks.toml           # bank config (gitignored)
│   ├── .env                 # FinTS credentials (gitignored)
│   ├── fints-status.json    # written by import.mjs (gitignored)
│   └── holdings.json        # depot snapshot — written by import.mjs (gitignored)
├── cli/                     # local Node CLI
│   ├── bin/actual.mjs       # subcommand dispatcher
│   ├── src/commands/        # fetch, analyze, subs, categorize
│   ├── src/lib/             # shared env loader, Actual client wrapper, paths
│   └── config/              # categorization.json + budget.json
└── db-sync/                 # SQLite read-replica writer container
    ├── Dockerfile           # build context is stacks/actual/, copies cli + db-sync
    ├── package.json
    └── src/                 # index.mjs (loop), sync.mjs (Actual→SQLite), schema.sql

stacks/monitoring/
├── docker-compose.yml                                # grafana reads the Actual SQLite replica
└── grafana/provisioning/
    ├── datasources/datasources.yml                   # adds frser-sqlite-datasource pointing at /actual-db
    └── dashboards/actual-{overview,spending,subscriptions,pipeline}.json
```

## Troubleshooting

- **Dashboards empty / "no data"** — check that `actual_db_sync` is running and has done at least one refresh: `docker compose logs actual_db_sync | tail -20` should show `[sync] ok in Xs — N txs ...`. If the container is up but failing, the most common cause is a wrong `ACTUAL_PASSWORD` or unreachable `ACTUAL_SERVER_URL`.
- **Grafana shows "Datasource actual not found"** — the SQLite plugin install hasn't completed. Watch `docker compose logs grafana | grep -i sqlite`. The first `up -d` after adding the plugin pulls it from the Grafana plugin registry; subsequent restarts use the cached install.
- **Grafana shows "no such file actual.sqlite"** — `/persist/appdata/actual/db` isn't shared correctly. Verify with `ls -la /persist/appdata/actual/db` (should be a single volume seen by both stacks) and `docker exec grafana ls -la /actual-db/` (should show `actual.sqlite`).
- **Pipeline dashboard says fetch is stale** — run the FinTS import workflow above. The dashboard turns yellow at 24h, red at 48h.
- **Categorize dry-run shows huge change count** — likely a recent edit to `categorization.json` re-shuffled rule precedence. Spend-impacting rules (Brokerage, Internal Transfer) should appear before broader rules.
- **`actual subs` finds nothing** — your credit-card data window may be too short. Detection requires ≥3 occurrences of the same payee. Re-run after a few months of imports.

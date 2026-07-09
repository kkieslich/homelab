# Actual Budget stack

Self-hosted [Actual Budget](https://actualbudget.org/) running on the home server, with two bank-import paths, an LLM auto-categorizer, a local CLI for ad-hoc analysis, and a SQLite read-replica that feeds four Grafana dashboards.

## Architecture

```
Banks (PSD2/XS2A)         Banks (FinTS, credit cards)
        │                            │
        ▼                            ▼
  bank_sync (enable-actual)    fints-actual-bridge
   container · :3009            python+node, manual SCA
        │                            │
        └─────────────┬──────────────┘
                      ▼
                actual_server  ◄────  actual_ai (LLM categorizer, every 4h)
                container · :5006     container
                      │
       ┌──────────────┴──────────────┐
       ▼                             ▼
  cli (manual)                actual_db_sync
  npx actual {fetch,         every 5 min →
  analyze,subs,                       │
  categorize}                         ▼
                            SQLite (bind mount /persist/appdata/actual/db)
                                      │ read-only mount
                                      ▼
                                   grafana
                            (frser-sqlite-datasource)
```

The dashboards run real SQL against a year of historical data — not against a metrics-scraping window. Add a new SQL panel and it works against the full transaction history immediately.

## Services (docker-compose.yml)

| Container | Port | What it does |
|---|---|---|
| `actual_server` | 5006 | The Actual Budget server itself. Accessed at https://actual.home.kki.berlin via Caddy. |
| `bank_sync` | 3009 | [enable-actual](enable-actual/) — PSD2 import for **checking accounts** of most European banks. Web UI at https://bank-sync.home.kki.berlin. |
| `actual_ai` | — | [actual-ai](actual-ai/) — runs Anthropic Claude every 4h to auto-categorize new transactions. |
| `actual_db_sync` | — | Pulls a fresh snapshot from `actual_server` every 5 min and writes it to `/db/actual.sqlite` on the shared `/persist/appdata/actual/db` bind mount. |

Grafana lives in [`stacks/monitoring/`](../../stacks/monitoring/) and reads the same `/persist/appdata/actual/db` directory.

## Subdirectories

| Path | What it is |
|---|---|
| [`cli/`](cli/) | Local Node CLI (`actual fetch / analyze / subs / categorize`) for ad-hoc analysis and rule-based categorization. Not a container — runs from your dev machine. |
| [`db-sync/`](db-sync/) | The SQLite read-replica writer. Reuses `cli/`'s subscription detector. |
| [`fints-actual-bridge/`](fints-actual-bridge/) | Python+Node bridge that fetches credit-card transactions via FinTS (which exposes them, unlike PSD2) and imports them into Actual. Runs manually due to interactive SCA. See its own README for protocol notes. |
| [`enable-actual/`](enable-actual/) | Submodule. The `bank_sync` service. PSD2 sync for checking accounts. |
| [`actual-ai/`](actual-ai/) | Submodule. The `actual_ai` service. LLM-based transaction categorizer. |
| `/persist/appdata/actual/server-data` | Bind mount for `actual_server`. |
| `/persist/appdata/actual/sync-data` | Bind mount for `bank_sync`. |
| `/persist/appdata/actual/fints-state` | FinTS runtime state, fetch output, status, and holdings files. |
| `/persist/config/actual/banks.toml` | Restored or sops-rendered bank/account mapping. |

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
ANTHROPIC_API_KEY=<for actual_ai>
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

### "I want to import the latest credit card transactions"

```sh
cd fints-actual-bridge
source .venv/bin/activate
fints-fetch --all --days 30 --out /tmp/all.json   # SCA approval on phone
node bin/import.mjs --all --in /tmp/all.json       # idempotent — safe to re-run
```

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

Then fetch and import the Baader data:
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

SCA cadence is ~90 days (photoTAN/pushTAN device approval), same decoupled flow as your other banks.

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
├── docker-compose.yml       # 4 services + /persist/appdata/actual/db bind mount
├── .env                     # secrets (gitignored)
├── enable-actual/           # submodule (bank_sync)
├── actual-ai/               # submodule (actual_ai)
├── sync-data/               # bind mount (gitignored)
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
│   └── config/categorization.json
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

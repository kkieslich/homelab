# fints-actual-bridge

Pulls bank-account and credit-card transactions from German FinTS banks (PIN/TAN, decoupled-TAN apps like SecureGo plus) and imports them into a self-hosted [Actual Budget](https://actualbudget.com/) instance. Supports **multiple banks** via per-profile config — currently set up for UmweltBank and Baader/finanzen.net zero.

## Why this exists

Credit-card transactions are **not reachable through PSD2/XS2A** with any consumer-priced aggregator (Enable Banking, GoCardless/Nordigen, Lunch Flow). None of them request the Berlin Group `cardAccounts` consent scope, so the card is invisible at the API level.

The card *is* reachable via the older FinTS protocol — verified for UmweltBank via MoneyMoney's protocol log: both checking AND credit-card show up in the FinTS UPD; the card supports `HKCAZ` (camt.052 XML) but not `HKKAZ` (legacy MT940).

> ⚠️ Status: fetcher works; Actual import sidecar still TODO.

## Layout

```
.
├── pyproject.toml             # python-fints + python-dotenv + lxml
├── banks.toml.example         # connection profiles per bank
├── .env.example               # per-bank credentials
├── .gitignore                 # banks.toml + .env are gitignored
├── src/fints_bridge/
│   ├── config.py              # bank profile loader (banks.toml + env)
│   ├── spike.py               # connection diagnostic
│   ├── fetch.py               # production fetcher → JSON
│   └── camt052.py             # minimal camt.052.001.x parser
├── package.json               # @actual-app/api + smol-toml (Node sidecar deps)
└── bin/
    └── import.mjs             # Node sidecar — reads fetch JSON → Actual via @actual-app/api
```

The directory is intentionally self-contained so it can be promoted to its own git submodule / standalone repo later without rework.

## Setup (one-time)

```sh
cd stacks/actual/fints-actual-bridge
python3 -m venv .venv
. .venv/bin/activate
pip install -e .

cp banks.toml.example banks.toml   # edit if you add/remove banks
cp .env.example .env
$EDITOR .env                        # fill in BANKS_*_LOGIN and BANKS_*_PIN
```

## Step 1 — verify a bank with `fints-spike`

Quick diagnostic for a single bank: opens the dialog, prompts SCA approval (one push to your TAN app), then dumps `get_information()` JSON + the SEPA accounts list + a 30-day sample of camt.052 docs per account. Use this whenever you add a new bank profile.

```sh
fints-spike --bank umwelt
```

Look in the JSON output for the `accounts` list. Both checking AND credit-card accounts should show up; the card has its own IBAN.

## Step 2 — fetch real transactions with `fints-fetch`

Pulls a window of camt.052 transactions, parsed and normalized into JSON suitable for the Actual importer:

```sh
# Last 60 days, only the credit-card account, write to file
fints-fetch --bank umwelt --days 60 --iban DE59760350008001107152 --out /tmp/ub-card.json

# Last 30 days, all configured UmweltBank accounts, JSON to stdout
fints-fetch --bank umwelt
```

Each transaction in the output:
```jsonc
{
  "imported_id": "REF12345",          // raw bank reference; not assumed globally unique
  "date": "2026-05-01",
  "value_date": "2026-05-02",
  "amount_cents": -1234,              // signed: DBIT (money out) = negative
  "currency": "EUR",
  "status": "BOOK",                   // or PDNG
  "payee_name": "Test Merchant GmbH",
  "notes": "Coffee at airport",
  "end_to_end_id": "E2E-AAA",
  "account_servicer_ref": "REF12345"
}
```

Re-runs are idempotent. A strong bank reference is namespaced by source and
account and remains the primary identity across pending-to-booked metadata
changes. Known weak placeholders such as `STARTUMS`, plus fetcher-generated
`syn_…` fallback IDs, are not trusted as unique:
pending weak-reference rows are excluded from import until booked, then
qualified using booked-stable date, amount, currency, payee, and purpose
fields. Distinct booked transactions remain distinct while a repeated fetch
produces the same IDs.

## Step 3 — import into Actual via the Node sidecar

`@actual-app/api` is the only supported way to write transactions into a self-hosted Actual server (the sync uses a CRDT over WebSocket — no plain REST endpoint). So the import lives in a small Node script.

One-time setup:

```sh
npm install                     # installs @actual-app/api + smol-toml
```

Then in `banks.toml`, fill in the `[actual]` section and at least one `[[banks.<key>.accounts]]` block per IBAN you want to import. The Actual account UUID lives in the URL bar when you open the account inside Actual: `/accounts/<uuid>`.

Add the Actual server password to `.env`:
```
ACTUAL_PASSWORD=...
```

Pipe the fetcher straight into the importer (one full sync):

```sh
# Single bank
fints-fetch --bank umwelt --days 30 | node bin/import.mjs --bank umwelt

# Every configured bank in one go (one SCA push per bank, sequential)
fints-fetch --all --days 30 | node bin/import.mjs --all

# Or stage to a file for inspection first:
fints-fetch --all --days 30 --out /tmp/all.json
node bin/import.mjs --all --in /tmp/all.json --dry-run   # prints the per-account mapped records, no server call
node bin/import.mjs --all --in /tmp/all.json             # actually imports
```

JSON shape with `--all` (or `--bank`) is always:
```jsonc
{
  "fetched_at": "2026-05-04T...",
  "banks": [
    { "bank": { "key": "umwelt", ... }, "window": {...}, "accounts": [ ... ] },
    { "bank": { "key": "fnz", ... }, "window": {...}, "accounts": [ ... ] }
  ]
}
```
The importer accepts both this multi-bank shape and the legacy single-bank shape.

The importer:
- Loads `banks.toml`, finds the IBAN→Actual-account-UUID mapping for the requested bank.
- Skips any IBAN not listed (or still set to `REPLACE-...`).
- Maps each fetched transaction into Actual's `importTransactions` shape (cents already signed, `imported_id` for dedup, `cleared = (status === 'BOOK')`).
- Holds pending transactions carrying known weak/reused placeholder references
  out of Actual until the bank reports them booked, rather than inventing a
  lifecycle identity. Pending weak-reference transactions (typical for card
  pre-bookings) are excluded from import until they book — they are reported
  per-run as `pending_excluded` and do not gate trust.
- Before its first canonical write, reads the account history and migrates an
  exact, unique legacy-ID/content match in place. Ambiguous legacy matches are
  quarantined and abort the whole run before any write; deleted transactions
  remain protected by `reimportDeleted: false`.
- Keeps one stable depot-revaluation transaction per depot. Existing valuation
  rows are atomically updated in place; the recurring importer never deletes a
  valid valuation before creating a replacement.
- Calls `actual.init()` → `downloadBudget(syncId)` → `importTransactions(accountId, [...])` → `shutdown()`.
- Prints per-account `added=N updated=M` so you see the diff per run.

`--dry-run` prints the mapped JSON without touching the Actual server. Useful when adding a new account to the mapping.

## Findings + protocol notes (proven 2026-05-03)

- UmweltBank FinTS endpoint: `https://fints2.atruvia.de/cgi-bin/hbciservlet`, BLZ `76035000`.
- Both checking + credit-card show up in the FinTS UPD for UmweltBank (Atruvia's standard behavior).
- Credit-card UPD allows `HKSAL` (balance) and `HKCAZ` (camt.052) but **not** `HKKAZ` (legacy MT940). So we use `client.get_transactions_xml()`, not `get_transactions()`.
- TAN method: security_function `946` "SecureGo plus (Direktfreigabe)" — `tech_id='DECOUPLED'`. Detect with `tech_id == 'DECOUPLED'`.
- python-fints quirks:
  - `set_tan_mechanism()` MUST be called BEFORE `with client:` — fails inside a standing dialog with "Cannot change TAN mechanism with a standing dialog".
  - When the bank returns `9340/9342/etc.` after a real format error (e.g. `9050 - Die Nachricht enthält Fehler`), python-fints over-classifies it as PIN-wrong and locally blocks the password. **The block is client-side only — your bank account is NOT locked at the bank.** Just restart the process.
  - `mode=FinTSClientMode.INTERACTIVE` does not auto-handle decoupled SCA initiation — must check `client.init_tan_response` after entering `with` and call `send_tan(response, '')` after user approves in the app.
- After one successful SCA, follow-up reads in the same dialog return `3076 - Starke Kundenauthentifizierung nicht notwendig` (no fresh SCA needed). One push per `fints-fetch` invocation.

## Realistic SCA cadence

PSD2's 90-day SCA-free window applies to XS2A, **not** FinTS. Atruvia enforces roughly **daily SCA on FinTS sessions**. Plan: schedule a daily cron, send a [ntfy](https://ntfy.sh) push to your phone right before, you tap once per day. Truly headless consent-less automation isn't possible under the German FinTS regime.

## Future steps

- ✅ ~~Push into Actual via `@actual-app/api`~~ → `bin/import.mjs`.
- ✅ ~~Account → Actual-account-id mapping in `banks.toml`~~.
- Dockerize: single image with both Python 3.11+ and Node 20+ runtimes, mounted under `stacks/actual/`. Cron entrypoint runs `fints-fetch --bank ... | node bin/import.mjs --bank ...` per bank.
- ntfy push to phone right before the cron fires so SCA can be approved within the 5-min decoupled-TAN window.

## Security

- `.env` and `banks.toml` are gitignored. Never commit credentials.
- The PIN lives only in env / process memory. python-fints sends it to the bank's TLS endpoint directly; this bridge never logs it.
- The decoupled-TAN push is the SCA gate — even a leaked PIN can't fetch transactions without your phone.

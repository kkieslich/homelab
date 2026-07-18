# Actual-First Finance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Actual Budget the reliable source of truth for imported transactions, categorization, envelopes, and safe-to-spend while retaining Grafana for reconciled analysis.

**Architecture:** FinTS adapters produce canonical, validated transaction records and one importer owns each Actual account. Actual's native import reconciliation, payee rules, transfer payees, schedules, and envelope budget own finance semantics; a read-only SQLite projection exposes reconciled facts, snapshots, and quality gates to three Grafana dashboards.

**Tech Stack:** Python 3.11+, Node.js 22, `node:test`, `@actual-app/api`, `better-sqlite3`, Docker Compose, SQLite, Grafana provisioning JSON, FinTS/camt.052.

## Global Constraints

- Work in an isolated git worktree created with `superpowers:using-git-worktrees` before implementation.
- Treat the production Actual budget and bank payloads as sensitive; tests use synthetic fixtures only.
- Do not write to the live server until Tasks 1–5 pass locally and the Task 6 backup gate is confirmed.
- Exactly one enabled importer may target an Actual account.
- Use `actual.importTransactions(accountId, records, { reimportDeleted: false })` for ordinary imports.
- Canonical imported IDs must not depend on fetch position or fetch-window length.
- Unknown transactions remain uncategorized; do not assign a `Needs Review` category.
- Recurring jobs never delete or merge suspected duplicates automatically.
- Actual owns payees, categories, transfers, schedules, and funded envelopes.
- Grafana and SQLite are read-only downstream consumers of Actual.
- Preserve unrelated user changes in the worktree and make one focused commit per task.

## File Structure

### Create

- `stacks/actual/fints-actual-bridge/src/importer/canonical.mjs` — canonical ID and transaction construction.
- `stacks/actual/fints-actual-bridge/src/importer/merchant.mjs` — conservative card merchant parsing.
- `stacks/actual/fints-actual-bridge/src/importer/registry.mjs` — source/account ownership validation.
- `stacks/actual/fints-actual-bridge/src/importer/validate.mjs` — batch validation and duplicate candidates.
- `stacks/actual/fints-actual-bridge/src/importer/manifest.mjs` — privacy-safe run manifests.
- `stacks/actual/fints-actual-bridge/test/fixtures/*.json` — synthetic bank/account fixtures.
- `stacks/actual/fints-actual-bridge/test/*.test.mjs` — importer unit and integration tests.
- `stacks/actual/cli/src/commands/audit-imports.mjs` — read-only duplicate and ownership audit.
- `stacks/actual/cli/src/commands/rule-candidates.mjs` — read-only native-rule candidate report.
- `stacks/actual/cli/src/commands/month-close.mjs` — reconciled month-end snapshot writer.
- `stacks/actual/cli/test/*.test.mjs` — CLI pure-logic tests.
- `stacks/actual/db-sync/src/semantics.mjs` — category-role and financial-semantic derivation.
- `stacks/actual/db-sync/test/*.test.mjs` — projection tests against in-memory SQLite.
- `stacks/actual/cli/config/accounts.json` — non-secret source ownership registry.
- `stacks/actual/cli/config/category-groups.json` — expected Actual group names and roles used only for validation/bootstrap.
- `stacks/actual/runbooks/weekly-review.md` — weekly operating procedure.
- `stacks/actual/runbooks/month-close.md` — month-close procedure.
- `stacks/actual/runbooks/restore.md` — backup and restore drill.

### Modify

- `stacks/actual/fints-actual-bridge/bin/import.mjs` — orchestrate canonical validation and import.
- `stacks/actual/fints-actual-bridge/package.json` — add test and audit scripts.
- `stacks/actual/fints-actual-bridge/Dockerfile` — include importer modules and tests where required.
- `stacks/actual/cli/bin/actual.mjs` — register new read-only/migration commands.
- `stacks/actual/cli/package.json` — add test script.
- `stacks/actual/db-sync/src/schema.sql` — normalized facts, snapshots, runs, and quality views.
- `stacks/actual/db-sync/src/sync.mjs` — populate new projection models.
- `stacks/actual/db-sync/package.json` — add test script.
- `stacks/actual/docker-compose.yml` — mount registry/manifests and run guarded importer.
- `syncs/procedures.toml` — replace procedures with guarded import/review operations.
- `stacks/monitoring/grafana/provisioning/dashboards/actual-*.json` — consolidate to three dashboards.
- `stacks/actual/README.md` — document source of truth, setup, and runbooks.

### Retire after cutover

- `stacks/actual/cli/src/commands/categorize.mjs`.
- `stacks/actual/cli/config/categorization.json`.
- `stacks/actual/cli/config/budget.json`.
- Superseded Grafana dashboard JSON files.

---

## Phase A — Import Integrity

### Task 1: Add the importer test harness and synthetic fixtures

**Files:**
- Modify: `stacks/actual/fints-actual-bridge/package.json`
- Create: `stacks/actual/fints-actual-bridge/test/fixtures/card-transactions.json`
- Create: `stacks/actual/fints-actual-bridge/test/fixtures/giro-transactions.json`
- Create: `stacks/actual/fints-actual-bridge/test/smoke.test.mjs`

**Interfaces:**
- Consumes: Existing FinTS fetch JSON shape `{ bank, accounts[] }`.
- Produces: `npm test` running `node --test test/*.test.mjs` and reusable synthetic fixtures.

- [ ] **Step 1: Add the failing smoke test**

```js
// test/smoke.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('card fixture contains no real banking data', async () => {
  const text = await readFile(new URL('./fixtures/card-transactions.json', import.meta.url), 'utf8');
  const fixture = JSON.parse(text);
  assert.equal(fixture.bank.key, 'fixture-bank');
  assert.equal(fixture.accounts[0].iban, 'DE00000000000000000000');
  assert.ok(fixture.accounts[0].transactions.length >= 3);
});
```

- [ ] **Step 2: Run the test and confirm the missing fixture failure**

Run: `cd stacks/actual/fints-actual-bridge && node --test test/smoke.test.mjs`  
Expected: FAIL with `ENOENT` for `card-transactions.json`.

- [ ] **Step 3: Add sanitized fixtures and the package script**

Use merchants `REWE TESTMARKT`, `PAYPAL *EXAMPLE`, and an opaque `22207136`; use amounts `-2690`, `-2300`, and `-2000`; use stable references `CARD-001` through `CARD-003`. Add a giro fixture with two distinct same-day `-1000` transactions and references `GIRO-001` and `GIRO-002`.

```json
"scripts": {
  "import": "node bin/import.mjs",
  "test": "node --test test/*.test.mjs"
}
```

- [ ] **Step 4: Run the harness**

Run: `cd stacks/actual/fints-actual-bridge && npm test`  
Expected: PASS, one test.

- [ ] **Step 5: Commit**

```bash
git add stacks/actual/fints-actual-bridge/package.json stacks/actual/fints-actual-bridge/test
git commit -m "test(actual): add synthetic importer fixtures"
```

### Task 2: Canonicalize IDs and extract card merchants

**Files:**
- Create: `stacks/actual/fints-actual-bridge/src/importer/canonical.mjs`
- Create: `stacks/actual/fints-actual-bridge/src/importer/merchant.mjs`
- Create: `stacks/actual/fints-actual-bridge/test/canonical.test.mjs`
- Create: `stacks/actual/fints-actual-bridge/test/merchant.test.mjs`

**Interfaces:**
- Produces: `canonicalImportedId({ source, sourceAccount, sourceTransactionId }): string`.
- Produces: `extractCardMerchant(raw: string): string | null`.
- Produces: `toActualTransaction({ source, sourceAccount, transaction }): ActualTransaction`.

- [ ] **Step 1: Write failing canonical-ID tests**

```js
test('canonical ID is stable and namespaced', () => {
  assert.equal(canonicalImportedId({ source: 'fints-umwelt', sourceAccount: 'card-1', sourceTransactionId: 'CARD-001' }), 'fints-umwelt:card-1:CARD-001');
});
test('missing bank identity is rejected', () => {
  assert.throws(() => canonicalImportedId({ source: 'fints-umwelt', sourceAccount: 'card-1', sourceTransactionId: '' }), /sourceTransactionId/);
});
```

- [ ] **Step 2: Write failing merchant tests**

```js
assert.equal(extractCardMerchant('REWE TESTMARKT DEU Berlin EUR 26,90 Umsatz vom 08.07.2026 MC Hauptkarte'), 'REWE TESTMARKT');
assert.equal(extractCardMerchant('HIGHWAY TOLL JPN FUKUOKA JPY 1.070,00 KURS: 185,44 1,50% AUSLANDSUMS. 0,09Umsatz vom 16.06.2026'), 'HIGHWAY TOLL');
assert.equal(extractCardMerchant('22207136 DEU BERLIN EUR 20,00 Umsatz vom 13.07.2026 MC Hauptkarte'), null);
```

- [ ] **Step 3: Run and confirm missing-module failures**

Run: `cd stacks/actual/fints-actual-bridge && npm test`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for both modules.

- [ ] **Step 4: Implement the minimal pure functions**

```js
export function canonicalImportedId({ source, sourceAccount, sourceTransactionId }) {
  for (const [name, value] of Object.entries({ source, sourceAccount, sourceTransactionId })) {
    if (!String(value ?? '').trim()) throw new Error(`${name} is required`);
  }
  return [source, sourceAccount, sourceTransactionId].map((v) => encodeURIComponent(String(v).trim())).join(':');
}

export function toActualTransaction({ source, sourceAccount, transaction }) {
  const raw = transaction.notes ?? transaction.payee_name ?? '';
  const candidate = transaction.payee_name?.trim() || extractCardMerchant(raw);
  return {
    date: transaction.date,
    amount: transaction.amount_cents,
    payee_name: candidate || undefined,
    imported_payee: raw || undefined,
    notes: raw || undefined,
    imported_id: canonicalImportedId({ source, sourceAccount, sourceTransactionId: transaction.imported_id }),
    cleared: transaction.status === 'BOOK',
  };
}
```

Implement `extractCardMerchant` as a sequence of anchored suffix removals; return `null` when the candidate is empty, numeric-only, or fewer than three letters.

- [ ] **Step 5: Run tests and commit**

Run: `cd stacks/actual/fints-actual-bridge && npm test`  
Expected: PASS, all canonical and merchant cases.

```bash
git add stacks/actual/fints-actual-bridge/src/importer stacks/actual/fints-actual-bridge/test
git commit -m "feat(actual): canonicalize imported transactions"
```

### Task 3: Enforce one importer per account and validate batches

**Files:**
- Create: `stacks/actual/cli/config/accounts.json`
- Create: `stacks/actual/fints-actual-bridge/src/importer/registry.mjs`
- Create: `stacks/actual/fints-actual-bridge/src/importer/validate.mjs`
- Create: `stacks/actual/fints-actual-bridge/test/registry.test.mjs`
- Create: `stacks/actual/fints-actual-bridge/test/validate.test.mjs`

**Interfaces:**
- Produces: `validateOwnership(entries): Map<string, OwnershipEntry>`.
- Produces: `validateBatch(records, { previousCount }): { records, duplicateCandidates, warnings }`.

- [ ] **Step 1: Test duplicate ownership and exact-ID rejection**

```js
assert.throws(() => validateOwnership([
  { actual_account_id: 'a1', source: 'fints-a', enabled: true },
  { actual_account_id: 'a1', source: 'fints-b', enabled: true },
]), /multiple enabled importers.*a1/i);

assert.throws(() => validateBatch([
  { imported_id: 's:a:1', date: '2026-07-01', amount: -100 },
  { imported_id: 's:a:1', date: '2026-07-01', amount: -100 },
], { previousCount: 2 }), /duplicate imported_id/);
```

- [ ] **Step 2: Test distinct same-day purchases remain valid**

```js
const result = validateBatch([
  { imported_id: 's:a:1', date: '2026-07-01', amount: -1000, imported_payee: 'SHOP' },
  { imported_id: 's:a:2', date: '2026-07-01', amount: -1000, imported_payee: 'SHOP' },
], { previousCount: 2 });
assert.equal(result.records.length, 2);
assert.equal(result.duplicateCandidates.length, 1);
```

- [ ] **Step 3: Implement strict validation**

Reject missing IDs, invalid ISO dates, non-integer amounts, duplicate exact IDs, and an empty batch when `previousCount > 0`. Report but do not remove fuzzy candidates keyed by `date|amount|normalized imported_payee`.

- [ ] **Step 4: Add the real non-secret account registry**

Inventory the seven live accounts read-only. For every entry set `actual_account_id`, `display_name`, `source`, `source_account`, `role`, `enabled`, and `interactive_auth`. Do not put IBANs or credentials in this file; retain those only in SOPS-encrypted `banks.toml.enc`.

- [ ] **Step 5: Verify and commit**

Run: `cd stacks/actual/fints-actual-bridge && npm test`  
Expected: PASS including ownership and validation tests.

```bash
git add stacks/actual/cli/config/accounts.json stacks/actual/fints-actual-bridge/src/importer stacks/actual/fints-actual-bridge/test
git commit -m "feat(actual): guard importer account ownership"
```

### Task 4: Record safe manifests and integrate guarded importing

**Files:**
- Create: `stacks/actual/fints-actual-bridge/src/importer/manifest.mjs`
- Create: `stacks/actual/fints-actual-bridge/test/import-flow.test.mjs`
- Modify: `stacks/actual/fints-actual-bridge/bin/import.mjs`
- Modify: `stacks/actual/fints-actual-bridge/Dockerfile`
- Modify: `stacks/actual/docker-compose.yml`

**Interfaces:**
- Produces: `writeRunManifest(path, manifest): Promise<void>` using atomic rename.
- `import.mjs` accepts `--registry`, `--manifest-dir`, and existing `--dry-run`.

- [ ] **Step 1: Test the import orchestration with a fake Actual API**

Assert that an identical validated batch calls:

```js
fakeActual.importTransactions('actual-account-1', expectedRecords, { reimportDeleted: false });
```

Assert that validation failure makes zero API calls and writes a failed manifest without raw notes or payees.

- [ ] **Step 2: Extract orchestration from top-level CLI execution**

Export `runImport({ payload, config, registry, actualApi, manifestDir, dryRun, now })`. Keep argument parsing and Actual initialization in `bin/import.mjs`; inject dependencies in tests.

- [ ] **Step 3: Implement privacy-safe manifests**

```js
const manifest = {
  schema_version: 1,
  run_id: crypto.randomUUID(),
  source,
  importer_version,
  started_at,
  finished_at,
  requested_range,
  accounts: [{ actual_account_id, fetched, valid, added, updated, quarantined }],
  outcome,
  error_code,
};
```

Never serialize raw transactions, notes, payees, IBANs, PINs, or API errors containing request payloads.

- [ ] **Step 4: Wire Compose mounts and arguments**

Mount `./cli/config/accounts.json:/app/accounts.json:ro` and the existing `fints-state` volume for `/state/import-runs`. Pass `--registry /app/accounts.json --manifest-dir /state/import-runs` to both manual import services.

- [ ] **Step 5: Verify idempotence with the fake API and build image**

Run: `cd stacks/actual/fints-actual-bridge && npm test`  
Expected: PASS, including zero calls on failure and exact options on success.

Run: `docker compose -f stacks/actual/docker-compose.yml build fints_sync_umwelt fints_sync_baader`  
Expected: both images build successfully.

- [ ] **Step 6: Commit**

```bash
git add stacks/actual/fints-actual-bridge stacks/actual/docker-compose.yml
git commit -m "feat(actual): fail closed on invalid import batches"
```

### Task 5: Add a read-only import and duplicate audit

**Files:**
- Create: `stacks/actual/cli/src/commands/audit-imports.mjs`
- Create: `stacks/actual/cli/test/audit-imports.test.mjs`
- Modify: `stacks/actual/cli/bin/actual.mjs`
- Modify: `stacks/actual/cli/package.json`

**Interfaces:**
- Produces command: `actual audit-imports [--json] [--since=YYYY-MM-DD]`.
- Produces pure function: `auditTransactions(snapshot, registry): AuditReport`.

- [ ] **Step 1: Test audit classification**

Create synthetic transactions proving the report separates `duplicate_imported_ids`, `fuzzy_candidates`, `legacy_id_schemes`, `missing_payees`, and `uncategorized`; assert that it never mutates the input.

- [ ] **Step 2: Implement the pure audit and CLI renderer**

The JSON report must include transaction IDs, account IDs, dates, amounts, and imported IDs, but omit notes. Human output shows group counts and exact Actual transaction IDs needed for reviewed merging.

- [ ] **Step 3: Register scripts and verify**

Add `"test": "node --test test/*.test.mjs"` to the CLI package and register `audit-imports` in `bin/actual.mjs` help/dispatch.

Run: `cd stacks/actual/cli && npm test`  
Expected: PASS.

- [ ] **Step 4: Run read-only against production**

Run from the workstation with existing credentials: `cd stacks/actual/cli && ./bin/actual.mjs audit-imports --json > "$TMPDIR/actual-import-audit.json"`  
Expected: report counts reconcile with the known baseline (one nine-row repeated-ID group and approximately 23 fuzzy groups); no server records change.

- [ ] **Step 5: Commit**

```bash
git add stacks/actual/cli
git commit -m "feat(actual): audit import identity and duplicates"
```

## Phase B — Reviewed Actual Migration

### Task 6: Back up, resolve writer ownership, and clean confirmed duplicates

**Files:**
- Create: `stacks/actual/runbooks/restore.md`
- Modify: `stacks/actual/README.md`
- Modify: `stacks/actual/cli/config/accounts.json`

**Interfaces:**
- Consumes: Task 5 audit JSON.
- Produces: Timestamped verified backup, finalized ownership registry, and reconciled duplicate-free baseline.

- [ ] **Step 1: Document exact backup and restore commands**

Record commands that stop only importer jobs, export an Actual budget through the supported UI/API, and archive `/persist/docker/volumes/actual_server-data/_data`, `/persist/docker/volumes/actual_fints-state/_data`, and `/persist/docker/volumes/actual_db/_data` to an explicit dated directory. Include checksum generation and a restore drill into a temporary Actual container on a non-production port.

- [ ] **Step 2: Execute and verify the backup gate**

Do not proceed until the archive exists, checksums pass, and the temporary restored budget opens with the expected seven accounts and approximately 1,496 pre-cleanup transactions.

- [ ] **Step 3: Disable every overlapping writer**

Use the audit plus deployment inventory to identify the path that created date/index IDs. Disable it in Komodo/Actual configuration before importing again. Update `accounts.json` so each account has one enabled owner.

- [ ] **Step 4: Review duplicates in Actual**

For each Task 5 candidate, compare account, amount, raw description, bank reference, and dates. Merge only confirmed duplicates with Actual's supported merge operation. Treat legitimate repeated card charges and the BHW same-amount repayments as distinct unless bank references prove duplication.

- [ ] **Step 5: Reconcile all accounts and capture baseline**

Record ledger count, per-account balance, uncategorized count, and duplicate audit result. Expected: zero confirmed unresolved duplicate groups and zero account/bank balance differences.

- [ ] **Step 6: Commit runbook/config only**

```bash
git add stacks/actual/runbooks/restore.md stacks/actual/README.md stacks/actual/cli/config/accounts.json
git commit -m "docs(actual): add verified finance restore procedure"
```

### Task 7: Generate native Actual rule candidates and retire fallback categorization

**Files:**
- Create: `stacks/actual/cli/src/commands/rule-candidates.mjs`
- Create: `stacks/actual/cli/test/rule-candidates.test.mjs`
- Modify: `stacks/actual/cli/bin/actual.mjs`
- Delete after approval: `stacks/actual/cli/src/commands/categorize.mjs`
- Delete after approval: `stacks/actual/cli/config/categorization.json`

**Interfaces:**
- Produces command: `actual rule-candidates --min-count=3 --min-confidence=0.9 --json`.
- Produces report only; the operator creates/approves native rules in Actual.

- [ ] **Step 1: Test conservative candidate scoring**

Assert that a payee seen ten times in one category scores `1.0`, a 9/10 split scores `0.9`, and aggregators named PayPal, Amazon, Klarna, cash/ATM, or person-to-person are marked `manual_only` regardless of score.

- [ ] **Step 2: Implement candidate generation**

Group reviewed on-budget, non-transfer history by canonical payee; return count, dominant category, confidence, raw imported-payee variants, and risk flags. Do not emit rule mutations.

- [ ] **Step 3: Review and create Actual rules in layers**

In Actual, create imported-payee normalization rules first, transfer-payee rules second, stable category defaults third, and narrow exceptions last. Apply actions to the historical `Needs Review` backlog in bounded selections and inspect results after every rule.

- [ ] **Step 4: Remove the fallback category from active use**

When its transaction count reaches zero, hide or delete `Needs Review` in Actual. Remove the external categorizer command/config and its documentation only after a dry import proves native rules categorize known fixtures.

- [ ] **Step 5: Verify acceptance thresholds and commit**

Run the read-only audit. Expected: usable payee coverage at least 95%, automatic correct category coverage at least 90% on a held-out reviewed sample, and no active transaction categorized `Needs Review`.

```bash
git add -A stacks/actual/cli
git commit -m "refactor(actual): move categorization into native rules"
```

### Task 8: Move envelopes, schedules, and category roles into Actual

**Files:**
- Create: `stacks/actual/cli/config/category-groups.json`
- Create: `stacks/actual/runbooks/weekly-review.md`
- Create: `stacks/actual/runbooks/month-close.md`
- Delete after reconciliation: `stacks/actual/cli/config/budget.json`
- Modify: `stacks/actual/README.md`

**Interfaces:**
- Produces Actual groups named `Fixed obligations`, `Flexible essentials`, `Discretionary`, `Sinking funds`, `Savings and investing`, and `Income`.
- Produces authoritative Actual schedules and funded envelopes.

- [ ] **Step 1: Export the current Actual category and budget baseline**

Save a temporary, untracked export. Map every active category to exactly one target group and record current monthly targets as migration input.

- [ ] **Step 2: Reorganize groups without changing transaction categories**

Move existing categories into the six target groups. Convert `Internal Transfer`, brokerage cash movements, and credit-card settlements into transfer payees before removing them from expense budgeting.

- [ ] **Step 3: Configure schedules**

Create schedules for salary, rent, utilities, insurance, subscriptions, regular savings, and investment contributions. Link historical matches and use approximate amounts for variable bills where appropriate.

- [ ] **Step 4: Fund envelopes in priority order**

Fund fixed obligations, sinking funds, savings/investing, flexible essentials, then discretionary categories. Confirm sinking-fund rollover behavior in the next-month preview.

- [ ] **Step 5: Reconcile and retire JSON budget**

Compare the sum of intended targets with funded Actual envelopes. Delete `budget.json` only when Actual contains every active target and the README/runbooks no longer instruct edits to JSON.

- [ ] **Step 6: Commit documentation and validation config**

```bash
git add -A stacks/actual/cli/config stacks/actual/runbooks stacks/actual/README.md
git commit -m "refactor(actual): make native envelopes authoritative"
```

## Phase C — Trusted Projection and Grafana

### Task 9: Add canonical financial semantics and quality models

**Files:**
- Create: `stacks/actual/db-sync/src/semantics.mjs`
- Create: `stacks/actual/db-sync/test/semantics.test.mjs`
- Modify: `stacks/actual/db-sync/src/schema.sql`
- Modify: `stacks/actual/db-sync/src/sync.mjs`
- Modify: `stacks/actual/db-sync/package.json`

**Interfaces:**
- Produces: `deriveCategoryRole(groupName): string`.
- Produces SQLite views `consumption`, `ordinary_income`, `savings_contributions`, `review_queue`, and `finance_trust`.
- Produces tables `pipeline_runs`, `data_quality`, `budget_snapshots`, and `net_worth_snapshots`.

- [ ] **Step 1: Write in-memory projection tests**

Seed synthetic salary, grocery, refund, transfer pair, credit-card settlement, starting balance, investment contribution, and revaluation transactions. Assert:

```sql
SELECT SUM(amount_cents) FROM consumption;          -- grocery plus its refund only
SELECT SUM(amount_cents) FROM ordinary_income;      -- salary only
SELECT SUM(amount_cents) FROM savings_contributions; -- investment contribution only
```

Assert transfers, starting balances, and revaluations appear in none of the first two views.

- [ ] **Step 2: Add role validation**

`deriveCategoryRole` maps the exact six Actual group names and throws for an unknown active group. Sync failure retains the previous SQLite snapshot.

- [ ] **Step 3: Extend schema and transactional population**

Keep immutable month-end snapshots append-only with `(month, captured_at)` keys. Replace static budget-table loading with Actual budget-month API data; store category budgeted, spent, balance, and carried values. Ingest sanitized Task 4 manifests into `pipeline_runs`.

- [ ] **Step 4: Define finance trust**

`finance_trust` returns `trusted = 0` if any source exceeds its expected cadence, any active account has a reconciliation gap, any quarantined batch is unresolved, or review-queue count exceeds 10. Include machine-readable reasons.

- [ ] **Step 5: Verify and commit**

Run: `cd stacks/actual/db-sync && npm test`  
Expected: PASS for all semantic and failure-retention fixtures.

```bash
git add stacks/actual/db-sync
git commit -m "feat(actual): add trusted finance projection"
```

### Task 10: Capture month-end snapshots and calculate safe to spend

**Files:**
- Create: `stacks/actual/cli/src/commands/month-close.mjs`
- Create: `stacks/actual/cli/test/month-close.test.mjs`
- Modify: `stacks/actual/cli/bin/actual.mjs`
- Modify: `stacks/actual/db-sync/src/schema.sql`

**Interfaces:**
- Produces: `calculateSafeToSpend({ categories, schedules, today })`.
- Produces command: `actual month-close --month=YYYY-MM --snapshot=/path/to/actual.sqlite [--apply]`.

- [ ] **Step 1: Test safe-to-spend arithmetic**

```js
assert.deepEqual(calculateSafeToSpend({
  categories: [
    { role: 'discretionary', available: 30000 },
    { role: 'flexible_essential', available: -5000 },
  ],
  schedules: [{ role: 'discretionary', amount: -4000, due: '2026-07-25', paid: false }],
  today: '2026-07-18',
}), { month_cents: 21000, remaining_days: 14, per_day_cents: 1500 });
```

- [ ] **Step 2: Implement the pure calculation**

Sum positive discretionary availability, subtract absolute essential underfunding and unpaid discretionary schedules due through month-end, clamp the daily numerator at zero, and include today in remaining calendar days.

- [ ] **Step 3: Implement guarded snapshot writing**

Default is dry-run. `--apply` refuses unless finance trust is true, review queue is empty or explicitly annotated, and the requested month is closed. Insert budget and net-worth snapshots in one SQLite transaction; rerunning the same `month,captured_at` is idempotent.

- [ ] **Step 4: Verify and commit**

Run: `cd stacks/actual/cli && npm test`  
Expected: PASS for positive, negative, month-end, leap-year, paid-schedule, and underfunded-essential cases.

```bash
git add stacks/actual/cli stacks/actual/db-sync/src/schema.sql
git commit -m "feat(actual): snapshot month close and safe spending"
```

### Task 11: Consolidate Grafana to three trustworthy dashboards

**Files:**
- Modify: `stacks/monitoring/grafana/provisioning/dashboards/actual-home.json`
- Create: `stacks/monitoring/grafana/provisioning/dashboards/actual-monthly.json`
- Create: `stacks/monitoring/grafana/provisioning/dashboards/actual-investments-pipeline.json`
- Delete: superseded `actual-cashflow.json`, `actual-spending.json`, `actual-recurring.json`, `actual-investments.json`, `actual-pipeline.json`

**Interfaces:**
- Consumes only Task 9–10 canonical views/tables.
- Produces dashboard UIDs `actual-home`, `actual-monthly`, and `actual-investments-pipeline`.

- [ ] **Step 1: Add a dashboard query validator**

Create a temporary validation script that extracts every `rawQueryText`, substitutes fixed variable values, prepares it against a fixture SQLite database, and fails on missing tables/columns. Keep it as `stacks/actual/db-sync/test/dashboard-queries.test.mjs` if it remains maintainable.

- [ ] **Step 2: Rebuild the overview**

Lead with finance-trust status. Show net worth, liquid balance, safe-to-spend month/day, savings rate, funded-versus-consumed envelopes, review queue, and freshness. Every financial panel filters to a latest complete snapshot or canonical view and includes a definition plus freshness timestamp.

- [ ] **Step 3: Build monthly analysis**

Show monthly ordinary income, consumption, savings, role mix, month-over-month category/merchant drivers, rolling averages, annualized irregular costs, and unusual transactions. Do not query raw `transactions` for headline metrics.

- [ ] **Step 4: Combine investments and pipeline**

Show contributions, portfolio value, allocation, source coverage/freshness, run counts, quarantines, duplicate candidates, and reconciliation gaps. Do not show tax lots or investment-return claims.

- [ ] **Step 5: Validate JSON, SQL, and rendering**

Run: `jq empty stacks/monitoring/grafana/provisioning/dashboards/actual-*.json`  
Expected: exit 0.

Run: `cd stacks/actual/db-sync && npm test`  
Expected: all dashboard queries prepare successfully.

Deploy to a non-production Grafana or provision a temporary container, then visually verify titles, units, thresholds, empty states, timestamps, and the untrusted-data banner.

- [ ] **Step 6: Commit**

```bash
git add -A stacks/monitoring/grafana/provisioning/dashboards stacks/actual/db-sync/test
git commit -m "feat(grafana): focus finance dashboards on trusted metrics"
```

## Phase D — Cutover and Acceptance

### Task 12: Cut over procedures, verify production, and finish documentation

**Files:**
- Modify: `syncs/procedures.toml`
- Modify: `stacks/actual/README.md`
- Modify: `stacks/actual/runbooks/weekly-review.md`
- Modify: `stacks/actual/runbooks/month-close.md`

**Interfaces:**
- Produces final operator workflows and production acceptance evidence.

- [ ] **Step 1: Update Komodo procedures**

Keep one guarded import procedure per interactive bank. Add read-only `Actual - Audit imports` and `Actual - Finance health` procedures. Remove any procedure that calls the retired categorizer or overlapping importer.

- [ ] **Step 2: Run local verification**

```bash
cd stacks/actual/fints-actual-bridge && npm test
cd ../cli && npm test
cd ../db-sync && npm test
cd ../../monitoring && docker compose config --quiet
cd ../actual && docker compose config --quiet
jq empty ../monitoring/grafana/provisioning/dashboards/actual-*.json
```

Expected: every command exits 0.

- [ ] **Step 3: Deploy with rollback assets present**

Confirm the Task 6 backup path and checksums again. Deploy the Actual stack, run one bank at a time, inspect its manifest, and stop if added counts exceed the dry-run expectation or any quarantine appears.

- [ ] **Step 4: Prove production idempotence**

Re-run the same fetch window. Expected: `added=0`; updates are limited to documented cleared/pending changes; duplicate audit finds no new confirmed groups.

- [ ] **Step 5: Reconcile and validate metrics**

Reconcile every active on-budget account. For one fixed closed month, compare Actual and SQLite/Grafana ordinary income, consumption, transfers, category totals, investment contributions, and month-end net worth. Expected: exact cent-level agreement.

- [ ] **Step 6: Validate operating acceptance**

Measure usable-payee coverage (at least 95%), correct-category coverage on reviewed sample (at least 90%), review queue (normally below 10), and finance-trust state. Confirm safe-to-spend components trace to Actual envelopes and unpaid schedules.

- [ ] **Step 7: Complete README and commit**

Document architecture, source registry, weekly review, month close, failure recovery, rule maintenance, backup/restore, and the three dashboards. State explicitly that routine changes happen in Actual, not repository budget/categorization JSON.

```bash
git add syncs/procedures.toml stacks/actual/README.md stacks/actual/runbooks
git commit -m "docs(actual): complete Actual-first finance cutover"
```

## Final Verification Gate

- [ ] `git status --short` contains no unexpected files.
- [ ] All three Node test suites pass from clean installs.
- [ ] Both Compose configurations validate.
- [ ] All provisioned dashboard JSON parses and queries validate.
- [ ] Reimporting the same window adds zero transactions.
- [ ] Duplicate audit reports no new confirmed duplicates.
- [ ] All active accounts reconcile exactly.
- [ ] A fixed closed month reconciles Actual to Grafana at cent precision.
- [ ] Safe-to-spend is explainable from envelopes, underfunding, and schedules.
- [ ] Restore drill is documented and previously verified.
- [ ] Weekly and month-close runbooks can be followed without repository finance-data edits.


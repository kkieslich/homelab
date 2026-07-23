# Finance Trust Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every confirmed defect from the 2026-07-22 full review of the Actual-first finance cutover (10 confirmed correctness bugs, 2 operational hazards, 9 structural consolidations, 1 dashboard regression) so `finance_trust = true` is actually reachable and stays truthful.

**Architecture:** No architecture change — this hardens the existing design (FinTS importer → Actual → read-only SQLite projection → Grafana, gated by `finance_trust`). The theme of the fixes: trust evidence must be *per-account*, *resolvable*, and *derived from one shared definition* of identity (normalization, ISO dates, duplicate keys, synthetic markers) instead of five drifting copies.

**Tech Stack:** Node.js 22 + `node:test`, `@actual-app/api`, `better-sqlite3`, Python 3.11 (fints_bridge), Docker Compose, SQLite, Grafana provisioning JSON, Komodo procedures (TOML).

## Review provenance (why these tasks exist)

Full review 2026-07-22 of range `96aec53..origin/main` (41 commits). 7 finder angles + adversarial verification; every finding below was CONFIRMED against the code (file:line evidence) unless marked otherwise. The Appendix maps **every** review finding to a task or an explicit deferral so nothing is lost.

## Global Constraints

- Execute in the worktree `.worktrees/actual-first-finance` (branch `feat/actual-first-finance`, tracks `origin/main`). The repo-root `main` checkout is STALE (96aec53) — never edit finance code there. Run `git -C .worktrees/actual-first-finance pull --ff-only origin main`-equivalent (`git pull --ff-only origin main` inside the worktree after `git merge --ff-only origin/main` if needed) before starting.
- Komodo auto-deploys `origin/main` to the live server (`kolja@192.168.1.20`). Pushing = deploying. Push only after the full local verification gate (end of plan) passes.
- Komodo redeploys pull git but do NOT rebuild locally-built images. After pushing importer/db-sync/daemon changes: on the server run `docker compose build <svc> && docker compose up -d --no-deps <svc>` in `/var/lib/komodo-periphery/stacks/actual/stacks/actual`.
- Restarting `fints_daemon_baader` may require a new SMS TAN only if the bank invalidated the session; the daemon persists dialog state in `/state`. Never `docker attach` without `--sig-proxy=false` unless entering a TAN; never Ctrl-C the daemon.
- Exactly one enabled importer may target an Actual account. Canonical imported IDs must not depend on fetch position or fetch-window length (identical-twin disambiguation in Task 7 is multiset-stable and therefore allowed).
- Recurring jobs never delete or merge suspected duplicates automatically. Unknown transactions remain uncategorized.
- Tests use synthetic fixtures only; never real bank data, IBANs, PINs, or TANs in code, tests, or manifests.
- Never use hard-coded calendar dates in test fixtures that feed freshness/staleness logic — compute relative to `new Date()` (that bug is Task 1).
- One focused commit per task, message format `type(actual): summary` matching existing history.

## File Structure

### Create
- `stacks/actual/fints-actual-bridge/src/importer/text.mjs` — the ONE normalization + ISO-day + duplicate-key module (Tasks 13, 17).
- `stacks/actual/cli/src/commands/pipeline-resolution.mjs` — operator path to resolve a quarantined pipeline run (Task 5).
- `stacks/actual/db-sync/test/reconciled-day.test.mjs` — epoch-ms reconciliation parsing (Task 3).
- `stacks/actual/db-sync/test/safe-to-spend.test.mjs` — SQL view becomes the tested implementation (Task 16).
- `stacks/actual/cli/test/pipeline-resolution.test.mjs` — Task 5.

### Modify
- `stacks/actual/fints-actual-bridge/bin/import.mjs` — Tasks 4, 5, 6, 7, 8, 9, 13, 14, 15, 19.
- `stacks/actual/fints-actual-bridge/src/importer/canonical.mjs` — Tasks 13, 20.
- `stacks/actual/fints-actual-bridge/src/importer/validate.mjs` — Tasks 13, 15, 17.
- `stacks/actual/fints-actual-bridge/src/importer/manifest.mjs` — Task 14 (shared reader + retention).
- `stacks/actual/fints-actual-bridge/src/fints_bridge/daemon.py` — Task 12.
- `stacks/actual/fints-actual-bridge/src/fints_bridge/fetch.py`, `camt052.py` — Task 20.
- `stacks/actual/db-sync/src/sync.mjs` — Tasks 3, 4, 5, 6, 13, 14, 17, 18, 19.
- `stacks/actual/db-sync/src/schema.sql` — Tasks 4, 5, 6, 16 (comment).
- `stacks/actual/db-sync/Dockerfile` — Task 13 (COPY shared module).
- `stacks/actual/cli/src/commands/{finance-health,month-close,audit-imports,duplicate-resolution}.mjs` — Tasks 4, 10, 13, 15, 16.
- `stacks/actual/cli/bin/actual.mjs` — Task 5 (register command).
- `stacks/actual/cli/test/finance-operations.test.mjs` — Task 1 (deterministic fixture).
- `stacks/actual/cli/package.json` + `package-lock.json` — Task 2 (commit existing bump).
- `stacks/actual/docker-compose.yml` — Task 11.
- `syncs/procedures.toml` — Task 12 (description text).
- `stacks/monitoring/grafana/provisioning/dashboards/actual-monthly.json` — Task 21.
- `stacks/actual/README.md` — touched by Tasks 5, 6, 11, 12, 18 (doc lines given inline).
- Importer/cli/db-sync tests as listed per task.

---

## Phase A — Green baseline

### Task 1: Make the finance-operations test fixture time-independent

**Finding (CONFIRMED, currently failing):** `cli/test/finance-operations.test.mjs` pins all evidence to 2026-07-18; the test at line 98 calls `financeHealth({ dbPath })` without `now`, and the `finance_trust` SQL view uses `'now'` internally. From 2026-07-20 the suite fails (`trusted` false !== true). The fixture must use dates relative to the real clock, because the SQL view cannot be injected with a fake clock.

**Files:**
- Modify: `stacks/actual/cli/test/finance-operations.test.mjs`

**Interfaces:**
- Produces: `fixture()` returning `{ dbPath, now, today, reviewMonth, reviewDate }` used by all four tests in the file.

- [ ] **Step 1: Reproduce the current failure**

Run: `cd stacks/actual/cli && node --test test/finance-operations.test.mjs`
Expected: FAIL — `finance health gate summary is exactly the canonical trust view`, `false !== true` at line 100.

- [ ] **Step 2: Rewrite the fixture with relative dates**

Replace the `fixture()` function (lines 16–34) with:

```js
function relativeDay(offsetDays, base) {
  const day = new Date(base);
  day.setUTCDate(day.getUTCDate() + offsetDays);
  return day.toISOString().slice(0, 10);
}

async function fixture() {
  const now = new Date();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  const reviewDate = relativeDay(-32, now);
  const reviewMonth = reviewDate.slice(0, 7);
  const dir = await mkdtemp(path.join(tmpdir(), 'finance-ops-'));
  const dbPath = path.join(dir, 'actual.sqlite');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('a', 'Checking', 0, 0, 0);
  db.prepare('INSERT INTO account_projection VALUES (?,?,?,?)').run('a', today, today, nowIso);
  db.prepare("INSERT INTO expected_sources VALUES ('a','bank',86400)").run();
  db.prepare(`INSERT INTO pipeline_runs (run_id,source,finished_at,requested_from,requested_to,quarantined,outcome,resolved)
    VALUES ('r','bank',?,?,?,0,'success',1)`).run(nowIso, relativeDay(-17, now), today);
  db.prepare(`INSERT INTO pipeline_run_accounts (run_id,account_id,source,requested_from,requested_to,outcome,quarantined)
    VALUES ('r','a','bank',?,?,'success',0)`).run(relativeDay(-17, now), today);
  db.prepare('INSERT INTO schedule_projection VALUES (?,1,?,999999999)').run(nowIso, 'ok');
  db.prepare("INSERT INTO budget_projection VALUES (?,1,strftime('%Y-%m','now'),999999999,'ok')").run(nowIso);
  db.prepare("INSERT INTO current_budgets VALUES (strftime('%Y-%m','now'),'c','C','discretionary',0,0,0,0)").run();
  db.prepare(`INSERT INTO data_quality (check_id,checked_at,kind,account_id,detail,resolved,producer)
    VALUES ('duplicate_candidate:key',?,'duplicate_candidate','a',?,0,'db-sync')`).run(nowIso,
    JSON.stringify({ account_id: 'a', date: today, amount_cents: -100, normalized_payee: 'shop',
      transaction_ids: ['t1', 't2'], classification: 'fuzzy_review_only' }));
  db.prepare(`INSERT INTO transactions (id,date,account_id,account_name,account_offbudget,amount_cents,category_is_income,cleared,reconciled,is_transfer,imported_id,year,month,ymd_unix)
    VALUES ('review',?,'a','Checking',0,-100,0,1,0,0,'x',?,?,1)`)
    .run(reviewDate, Number(reviewDate.slice(0, 4)), reviewMonth);
  db.close();
  return { dbPath, now, today, reviewMonth, reviewDate };
}
```

- [ ] **Step 3: Update all four tests to consume the new return shape**

Mechanical changes, keeping every assertion's meaning:
- Test 1 (line 36): `const { dbPath, now, today } = await fixture();` then `financeHealth({ dbPath, now })`; replace the assertion `latest_valid_success.requested_to === '2026-07-18'` with `=== today`.
- Test 2 (duplicate resolution, line 51): `const { dbPath } = await fixture();` — the fixed `resolvedAt: '2026-07-18T12:00:00Z'` stays (only shape validation applies to it).
- Test 3 (annotations, line 74): `const { dbPath, reviewMonth } = await fixture();` and use `month: reviewMonth` in the input object.
- Test 4 (line 89): `const { dbPath, now } = await fixture();` and both `financeHealth({ dbPath, now })` calls pass `now`.

- [ ] **Step 4: Run the suite and verify green**

Run: `cd stacks/actual/cli && npm test`
Expected: PASS, 21 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add stacks/actual/cli/test/finance-operations.test.mjs
git commit -m "test(actual): make finance-operations fixture time-independent"
```

### Task 2: Commit the @actual-app/api bump

**Finding (PLAUSIBLE):** `cli/package.json` `^26.5.0 → ^26.7.0` (+ lockfile 26.5.2 → 26.7.0) sits uncommitted in the worktree. The committed lockfile may not open budgets migrated by the current `actualbudget/actual-server:latest`. A fresh clone would break. (This bump was made 2026-07-21 during live reconciliation; local API version must be >= server budget migrations.)

- [ ] **Step 1: Verify the diff is only the version bump**

Run: `git diff stacks/actual/cli/package.json stacks/actual/cli/package-lock.json | grep '^[+-]' | grep -v '^[+-][+-]'`
Expected: only `@actual-app/api` version/integrity lines.

- [ ] **Step 2: Verify the CLI still passes tests with the bumped dependency**

Run: `cd stacks/actual/cli && npm ci && npm test`
Expected: PASS (Task 1 already merged).

- [ ] **Step 3: Commit**

```bash
git add stacks/actual/cli/package.json stacks/actual/cli/package-lock.json
git commit -m "build(actual): track @actual-app/api 26.7 lockfile"
```

---

## Phase B — Trust-gate correctness (why finance_trust can never go green today)

### Task 3: Accept Actual's epoch-milliseconds `last_reconciled`

**Finding (CONFIRMED, highest severity):** `sync.mjs:409` validates `account.last_reconciled` with `validIsoDay` (`YYYY-MM-DD`), but Actual's UI reconcile flow stores `Date.now().toString()` (epoch-ms string; verified in bundled loot-core: plain TEXT column, raw AQL passthrough, upstream displays via `parseInt`). Every open account therefore emits `reconciliation_missing` (severity error) forever → `reconciliation_required` gates trust permanently. **Reconciling in the Actual UI — the documented remaining operator gate — can never clear it.**

**Files:**
- Modify: `stacks/actual/db-sync/src/sync.mjs` (add exported `reconciledDay`, use at line 409)
- Test: `stacks/actual/db-sync/test/reconciled-day.test.mjs`

**Interfaces:**
- Produces: `reconciledDay(value, timeZone?): string | null` exported from `sync.mjs` — accepts `YYYY-MM-DD` or a 12–14-digit epoch-ms string, returns the calendar day in `ACTUAL_TIMEZONE` (default `Europe/Berlin`), else `null`.

- [ ] **Step 1: Write the failing test**

```js
// stacks/actual/db-sync/test/reconciled-day.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconciledDay } from '../src/sync.mjs';

test('epoch-ms string maps to the Berlin calendar day', () => {
  // 2026-07-21T23:30:00Z is already July 22 in Europe/Berlin (CEST, UTC+2).
  assert.equal(reconciledDay(String(Date.UTC(2026, 6, 21, 23, 30)), 'Europe/Berlin'), '2026-07-22');
  assert.equal(reconciledDay(String(Date.UTC(2026, 0, 15, 12, 0)), 'Europe/Berlin'), '2026-01-15');
});

test('ISO day passes through unchanged', () => {
  assert.equal(reconciledDay('2026-07-18', 'Europe/Berlin'), '2026-07-18');
});

test('garbage, empty, and short numerics return null', () => {
  assert.equal(reconciledDay('not-a-date', 'Europe/Berlin'), null);
  assert.equal(reconciledDay('', 'Europe/Berlin'), null);
  assert.equal(reconciledDay(null, 'Europe/Berlin'), null);
  assert.equal(reconciledDay('12345', 'Europe/Berlin'), null);
  assert.equal(reconciledDay('2026-13-40', 'Europe/Berlin'), null);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd stacks/actual/db-sync && node --test test/reconciled-day.test.mjs`
Expected: FAIL — `reconciledDay` is not exported.

- [ ] **Step 3: Implement**

In `sync.mjs`, directly below `validIsoDay` (line ~126):

```js
export function reconciledDay(value, timeZone = process.env.ACTUAL_TIMEZONE ?? 'Europe/Berlin') {
  const raw = String(value ?? '').trim();
  if (validIsoDay(raw)) return raw;
  // The Actual UI reconcile flow stores Date.now().toString() — an
  // epoch-milliseconds string, not a calendar day.
  if (/^\d{12,14}$/u.test(raw)) {
    const parsed = new Date(Number(raw));
    if (Number.isFinite(parsed.getTime())) return capturedDay(parsed, timeZone);
  }
  return null;
}
```

At line 409 replace:

```js
const reconciled = validIsoDay(account.last_reconciled) ? account.last_reconciled : null;
```

with:

```js
const reconciled = reconciledDay(account.last_reconciled);
```

(The existing `reconciliation_future` / `reconciliation_stale` branches keep working — they compare calendar-day strings.)

- [ ] **Step 4: Run tests**

Run: `cd stacks/actual/db-sync && npm test`
Expected: PASS including the three new tests.

- [ ] **Step 5: Commit**

```bash
git add stacks/actual/db-sync/src/sync.mjs stacks/actual/db-sync/test/reconciled-day.test.mjs
git commit -m "fix(actual): accept epoch-ms Actual reconciliation dates"
```

### Task 4: Per-account manifest outcomes; a validated empty window is coverage

**Finding (CONFIRMED):** One account with `valid=0` in a window (a normal quiet card month) makes the whole run `partial_empty` (`import.mjs:412-420`); the manifest has no per-account outcome, so `sync.mjs:462` stamps the run-level outcome onto **every** `pipeline_run_accounts` row. The sibling account that DID import data then trips `latest_account_attempt_empty` (schema.sql:373-374) and its coverage never advances (`ranked_successes` requires `outcome='success'`, schema.sql:341). Trust goes down on legitimate data.

**Design decision:** a batch that passed validation with zero rows IS successful coverage — the importer already fails closed on suspicious emptiness (`EMPTY_BATCH_REGRESSION` throws → run outcome `failed`). So: per-account `outcome` (`success`/`empty`) in the manifest; `ranked_successes` accepts both; the `latest_account_attempt_empty` reason is removed (its job is done fail-closed at import time). Known accepted limitation: the empty-regression guard compares only same-window manifests, so cross-window sudden emptiness is not trust-gated — recorded in the Appendix.

**Files:**
- Modify: `stacks/actual/fints-actual-bridge/bin/import.mjs` (~line 412)
- Modify: `stacks/actual/db-sync/src/sync.mjs` (insertRunAccount call, line ~460)
- Modify: `stacks/actual/db-sync/src/schema.sql` (`finance_trust` view)
- Modify: `stacks/actual/cli/src/commands/finance-health.mjs` (success query + status mapping)
- Tests: `fints-actual-bridge/test/import-flow.test.mjs`, `db-sync/test/semantics.test.mjs`, `cli/test/finance-operations.test.mjs`

**Interfaces:**
- Produces: manifest `accounts[]` entries gain `outcome: 'success' | 'empty'` (set only on non-dry-run, non-failed runs). Run-level `outcome` (`success`/`partial_empty`/`empty`/`dry_run`/`failed`) is unchanged for operators.
- Consumers must read `account.outcome ?? manifest.outcome` (sync.mjs does; finance-health reads the projected column).

- [ ] **Step 1: Failing importer test** — in `import-flow.test.mjs` add:

```js
test('quiet account gets its own empty outcome while siblings stay success', async () => {
  // Build a two-account payload where account A has 2 valid transactions and
  // account B has none, using the existing fixture helpers in this file.
  // Assert on the returned manifest:
  //   manifest.outcome === 'partial_empty'                    (run level, unchanged)
  //   accounts entry for A: outcome === 'success'
  //   accounts entry for B: outcome === 'empty'
});
```

Write it against this file's existing fake-API scaffolding (`runImport({ payload, config, registry, actualApi: fake, manifestDir, ... })`) with two mapped giro accounts; copy the payload shape from the nearest existing multi-account test in the same file.

Run: `cd stacks/actual/fints-actual-bridge && npm test` — Expected: FAIL (no `outcome` on account entries).

- [ ] **Step 2: Implement in import.mjs** — before building the success manifest (line ~412):

```js
    const allAccountsEmpty = accounts.length > 0 && accounts.every((account) => account.valid === 0);
    const anyAccountEmpty = accounts.some((account) => account.valid === 0);
    if (!dryRun) {
      for (const account of accounts) account.outcome = account.valid > 0 ? 'success' : 'empty';
    }
```

(The failure manifest path at line ~425 intentionally leaves `account.outcome` unset — failed runs stamp `failed` run-level for every account, which is correct.)

- [ ] **Step 3: Consume in sync.mjs** — at the `insertRunAccount.run(...)` call (line ~460) replace the `manifest.outcome` argument with `account.outcome ?? manifest.outcome`.

- [ ] **Step 4: Update finance_trust in schema.sql**

In `ranked_successes` (line ~341): `WHERE a.outcome='success'` → `WHERE a.outcome IN ('success','empty')`.
Delete the whole `latest_account_attempt_empty` UNION branch (lines ~373-374).

- [ ] **Step 5: Update finance-health.mjs**

In the `success` prepared statement (line ~20): `a.outcome='success'` → `a.outcome IN ('success','empty')`.
In the status ladder (line ~36): `latest_attempt_${outcome}` still reports historical `partial_empty` rows, which is fine (they age out); add above it so a fresh empty is not an error status:

```js
      else if (latestAttempt.outcome !== 'success' && latestAttempt.outcome !== 'empty') status = `latest_attempt_${latestAttempt.outcome}`;
```

- [ ] **Step 6: db-sync trust test** — in `semantics.test.mjs` add a case: expected account whose latest run row has `outcome='empty'`, `requested_to` = today, fresh `finished_at` → `finance_trust.trusted = 1` (with all other fixture gates satisfied — reuse the file's existing trusted-fixture helper).

- [ ] **Step 7: Run all three suites**

Run: `cd stacks/actual/fints-actual-bridge && npm test && cd ../db-sync && npm test && cd ../cli && npm test`
Expected: all PASS. (Any import-flow assertions that expected sibling accounts to share run-level outcomes must be updated in this task.)

- [ ] **Step 8: Commit**

```bash
git add stacks/actual/fints-actual-bridge stacks/actual/db-sync stacks/actual/cli
git commit -m "fix(actual): record per-account import outcomes"
```

### Task 5: Truthful quarantine + a resolution path that survives sync

**Findings (CONFIRMED, three parts):**
1. `import.mjs:287` adds fuzzy `duplicateCandidates.length` to `summary.quarantined` although those records ARE imported — manifests claim withheld records that exist in Actual and can never be "resolved".
2. `sync.mjs:453` recomputes `pipeline_runs.resolved = (quarantined===0)` from immutable manifests every 5 minutes via INSERT OR REPLACE — clobbering any manual resolution (unlike `data_quality`, whose resolutions ARE preserved at sync.mjs:261-263). No CLI writes `pipeline_runs`.
3. `finance_trust`'s `unresolved_quarantine` (schema.sql:383-386) matches ANY historical run — one pending weak-ref transaction in one fetch = trust down forever.

**Files:**
- Modify: `stacks/actual/fints-actual-bridge/bin/import.mjs` (line 287)
- Modify: `stacks/actual/db-sync/src/sync.mjs` (resolved preservation)
- Modify: `stacks/actual/db-sync/src/schema.sql` (scope reason to latest attempts; audit table)
- Create: `stacks/actual/cli/src/commands/pipeline-resolution.mjs`
- Modify: `stacks/actual/cli/bin/actual.mjs` (register)
- Tests: `import-flow.test.mjs`, `semantics.test.mjs`, new `cli/test/pipeline-resolution.test.mjs`

**Interfaces:**
- Produces: manifest account field `duplicate_candidates` (count, informational); `quarantined` now means actually-withheld records only.
- Produces CLI: `actual pipeline-resolution --snapshot=<db> --run-id=<id> --note=<t> --reviewer=<n> --resolved-at=<UTC ISO> [--apply]` (dry-run by default) → sets `pipeline_runs.resolved=1` + appends `pipeline_resolution_audit`.
- Produces: sync preserves `resolved=1` across cycles via `priorRunResolutions`.

- [ ] **Step 1: Importer — stop counting imported records as quarantined** (with a failing test first: assert a batch with one same-day/amount/payee pair yields `summary.quarantined === 0` and `summary.duplicate_candidates === 1` and both records imported). Change line 287:

```js
        summary.valid = validated.records.length;
        summary.duplicate_candidates = validated.duplicateCandidates.length;
```

(`summary.quarantined` keeps `pendingWeak.length` from line 272 until Task 6, plus the ambiguous-migration/multi-revaluation additions which are genuine withholdings.)

- [ ] **Step 2: sync.mjs — preserve resolutions.** Next to the existing `priorQualityResolutions` read (mirror that pattern exactly), add before the manifest loop:

```js
  const priorRunResolutions = new Map(
    tableExists(db, 'pipeline_runs')
      ? db.prepare('SELECT run_id, resolved FROM pipeline_runs WHERE resolved=1').all()
          .map((row) => [row.run_id, row.resolved])
      : [],
  );
```

(If the file has no `tableExists` helper, use the same guard style `priorQualityResolutions` uses — read how it handles a fresh DB and copy it.) Then in `insertRun.run(...)` replace the final argument `totals.quarantined === 0 ? 1 : 0` with:

```js
        priorRunResolutions.get(manifest.run_id) === 1 ? 1 : (totals.quarantined === 0 ? 1 : 0),
```

- [ ] **Step 3: schema.sql — audit table + latest-scope the reason.** Add near `duplicate_resolution_audit`:

```sql
CREATE TABLE IF NOT EXISTS pipeline_resolution_audit (
  run_id      TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  reviewer    TEXT NOT NULL,
  note        TEXT NOT NULL,
  PRIMARY KEY (run_id, resolved_at)
);
```

Replace the `unresolved_quarantine` branch (lines ~383-386) with (note `latest_attempts` already exists as a CTE in this view):

```sql
  UNION SELECT 'unresolved_quarantine' FROM latest_attempts a
   JOIN pipeline_runs p ON p.run_id=a.run_id
   JOIN expected_sources e ON e.account_id=a.account_id AND e.source=a.source
   WHERE a.quarantined > 0 AND p.resolved = 0
```

- [ ] **Step 4: CLI command.** `pipeline-resolution.mjs` (modeled on `duplicate-resolution.mjs` — read that file first and keep its arg/validation/dry-run idioms; it uses `requireUtcInstant` from `../lib/validation.mjs`):

```js
import Database from 'better-sqlite3';
import { parseArgs } from '../lib/args.mjs';
import { requireUtcInstant } from '../lib/validation.mjs';

export function resolvePipelineRun({ dbPath, runId, note, reviewer, resolvedAt, apply = false }) {
  if (!dbPath) throw new Error('A snapshot SQLite path is required');
  if (!String(runId ?? '').trim()) throw new Error('run-id is required');
  if (!String(note ?? '').trim()) throw new Error('note is required');
  if (!String(reviewer ?? '').trim()) throw new Error('reviewer is required');
  requireUtcInstant(resolvedAt, 'resolved-at');
  const db = new Database(dbPath, { readonly: !apply });
  try {
    const run = db.prepare('SELECT run_id, quarantined, resolved FROM pipeline_runs WHERE run_id=?').get(runId);
    if (!run) throw new Error(`No pipeline run: ${runId}`);
    if (run.resolved === 1) return { run_id: runId, applied: false, idempotent: true };
    if (!apply) return { run_id: runId, quarantined: run.quarantined, applied: false };
    const write = db.transaction(() => {
      db.prepare('UPDATE pipeline_runs SET resolved=1 WHERE run_id=?').run(runId);
      db.prepare('INSERT INTO pipeline_resolution_audit (run_id,resolved_at,reviewer,note) VALUES (?,?,?,?)')
        .run(runId, resolvedAt, reviewer, note);
    });
    write();
    return { run_id: runId, applied: true };
  } finally { db.close(); }
}

export async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: actual pipeline-resolution --snapshot=<db> --run-id=<id> --note=<t> --reviewer=<n> --resolved-at=<UTC ISO> [--apply]');
    return;
  }
  console.log(JSON.stringify(resolvePipelineRun({
    dbPath: args.snapshot, runId: args['run-id'], note: args.note,
    reviewer: args.reviewer, resolvedAt: args['resolved-at'], apply: args.apply === true,
  }), null, 2));
}
```

Register in `bin/actual.mjs` following the exact pattern the other commands use (read the dispatch table there and add `pipeline-resolution`).

- [ ] **Step 5: Tests.** `cli/test/pipeline-resolution.test.mjs`: seed schema fixture (copy the fixture pattern from Task 1's rewritten `finance-operations.test.mjs`), insert a run with `quarantined=1, resolved=0`; assert dry-run default (no write), `--apply` resolves + audits, second apply is idempotent, unknown run throws. `semantics.test.mjs`: `unresolved_quarantine` fires only when the LATEST attempt row has quarantine — an older quarantined run followed by a clean newer run for the same account/source → trusted. And: a preserved `resolved=1` run with quarantine → trusted.

Run: all three suites. Expected: PASS.

- [ ] **Step 6: README.** In the Failure-recovery section of `stacks/actual/README.md` add: after investigating a quarantined run, resolve it with `node /app/cli/bin/actual.mjs pipeline-resolution --snapshot=/db/actual.sqlite --run-id=<id> --note="..." --reviewer=kolja --resolved-at=<UTC ISO> --apply` inside `actual_db_sync`; sync preserves the resolution.

- [ ] **Step 7: Commit**

```bash
git add stacks/actual
git commit -m "fix(actual): make quarantine truthful and resolvable"
```

### Task 6: Surface pending weak-reference transactions instead of mislabeling them

**Finding (CONFIRMED):** The old importer wrote pending (non-BOOK) transactions as `cleared:false`; the new one silently drops pending weak-reference transactions (`import.mjs:239-242`) and counts them as `quarantined` (line 272). Card pre-bookings typically ARE weak-referenced → upcoming charges invisible in Actual, balances overstate, and (pre-Task 5) trust was poisoned. **Keep the exclusion** (their fingerprints change on booking, so importing them would create duplicates) **but report honestly.**

**Files:**
- Modify: `stacks/actual/fints-actual-bridge/bin/import.mjs` (line 272)
- Modify: `stacks/actual/db-sync/src/sync.mjs` + `schema.sql` (`pipeline_run_accounts.pending_excluded` column, migration, insert)
- Modify: `stacks/actual/cli/src/commands/finance-health.mjs` (evidence)
- Tests: `import-flow.test.mjs`, `semantics.test.mjs`

- [ ] **Step 1: Failing importer test:** payload with one pending NONREF transaction → manifest account has `quarantined: 0`, `pending_excluded: 1`, and the transaction is not imported.

- [ ] **Step 2: import.mjs line 266-273** — change the summary literal:

```js
        const summary = {
          actual_account_id: mapping.actual_account_id,
          fetched: rawTransactions.length,
          valid: 0,
          added: 0,
          updated: 0,
          quarantined: 0,
          pending_excluded: pendingWeak.length,
        };
```

(Genuine withholdings — ambiguous migrations, multi-revaluation — still increment `quarantined` later.)

- [ ] **Step 3: schema.sql** — add `pending_excluded INTEGER` to `pipeline_run_accounts` (line ~123 table); in `sync.mjs` `ensureSchemaMigrations` add the same ALTER-if-missing pattern used for `data_quality.severity`; extend `insertRunAccount` statement and its `.run(...)` with `account.pending_excluded ?? 0`.

- [ ] **Step 4: finance-health.mjs** — in `evidence` add:

```js
        pending_excluded: db.prepare('SELECT COALESCE(SUM(pending_excluded),0) FROM pipeline_run_accounts a JOIN (SELECT account_id,source,MAX(run_id) run_id FROM pipeline_run_accounts GROUP BY account_id,source) l ON l.run_id=a.run_id AND l.account_id=a.account_id').pluck().get(),
```

(If this sub-select fights the schema, simplest correct alternative: sum `pending_excluded` over each account's latest run via the same ranked pattern the `quarantine` evidence query uses — keep whichever prepares clean in the test suite.)

- [ ] **Step 5: README** — replace the implication that pending weak refs are "quarantined" with: "Pending weak-reference transactions (typical for card pre-bookings) are excluded from import until they book — they are reported per-run as `pending_excluded` and do not gate trust."

- [ ] **Step 6: Run suites, commit**

```bash
git add stacks/actual
git commit -m "fix(actual): report pending weak references distinctly"
```

---

## Phase C — Importer correctness

### Task 7: Disambiguate colliding weak-reference fingerprints

**Finding (CONFIRMED, reproduced):** Weak-reference IDs are pure content fingerprints (`canonical.mjs:31`). Two genuinely identical booked NONREF transactions (two identical €2.50 ticket buys, same day/payee/notes) produce the SAME `imported_id` → `validateBatch` throws `duplicate imported_id` → the whole run fails with zero writes, recurring hourly while the pair is in the 30-day window. The Python `syn_` hash collides identically.

**Multiset-stability argument (why this respects the "no fetch-position IDs" constraint):** the suffix is assigned per occurrence within identical groups; since group members are indistinguishable, any ordering yields the same multiset of IDs, so re-fetches reproduce identical ID sets.

**Files:**
- Modify: `stacks/actual/fints-actual-bridge/bin/import.mjs` (after `records` built, ~line 264)
- Test: `fints-actual-bridge/test/import-flow.test.mjs`

- [ ] **Step 1: Failing test:** two byte-identical NONREF booked transactions in one account → run succeeds, both imported, ids differ (`...~<fp>` and `...~<fp>~2`); running the same payload again → `added=0`.

- [ ] **Step 2: Implement** — in import.mjs, after `const records = items.map(({ record }) => record);` and the opening-balance relabel, insert:

```js
        // Two indistinguishable weak-reference transactions fingerprint to the
        // same canonical ID; suffix later occurrences. Multiset-stable across
        // fetches because members of an identical group are interchangeable.
        const weakOccurrences = new Map();
        for (const item of items) {
          if (!isWeakSourceReference(item.transaction.imported_id)) continue;
          const count = (weakOccurrences.get(item.record.imported_id) ?? 0) + 1;
          weakOccurrences.set(item.record.imported_id, count);
          if (count > 1) item.record.imported_id = `${item.record.imported_id}~${count}`;
        }
```

(Strong-reference duplicates must still throw — do not suffix them.)

- [ ] **Step 3: Run bridge suite, commit**

```bash
git add stacks/actual/fints-actual-bridge
git commit -m "fix(actual): disambiguate identical weak-reference transactions"
```

### Task 8: Legacy-migration content match against the real legacy shape

**Finding (CONFIRMED — this caused the 26 duplicated giro rows at cutover):** `sameImportedContent` (`import.mjs:100-105`) compares normalized `imported_payee` first, but the OLD importer wrote `imported_payee = payee_name` while NEW records set `imported_payee = notes` (`canonical.mjs:43,49`). Legacy rows with `notes != payee_name` never match → re-imported under canonical IDs. The tests fixture the WRONG legacy shape (`imported_payee: transaction.notes` at import-flow.test.mjs:472, 487, 662), so they pass while testing nothing.

**Files:**
- Modify: `stacks/actual/fints-actual-bridge/bin/import.mjs` (lines 100-105)
- Modify: `fints-actual-bridge/test/import-flow.test.mjs` (three fixture sites)

- [ ] **Step 1: Fix the test fixtures FIRST** (they encode the bug): at lines ~472, ~487, ~662 change legacy transaction construction to the true legacy shape `imported_payee: <payee_name value>` (the old importer wrote `imported_payee: t.payee_name ?? undefined`). Run the suite — the migration tests should now FAIL, proving the bug.

- [ ] **Step 2: Broaden the content match:**

```js
function sameImportedContent(existing, record) {
  if (existing.date !== record.date || existing.amount !== record.amount) return false;
  const legacyIdentity = normalized(existing.imported_payee ?? existing.notes ?? existing.payee_name);
  return [record.imported_payee, record.notes, record.payee_name]
    .map(normalized).includes(legacyIdentity);
}
```

- [ ] **Step 3: Run bridge suite** — Expected: PASS (migration matches both legacy shapes; ambiguity guard at `planLegacyMigrations` still catches multi-matches).

- [ ] **Step 4: Commit**

```bash
git add stacks/actual/fints-actual-bridge
git commit -m "fix(actual): match legacy imports by their real payee shape"
```

### Task 9: Berlin-day revaluation date + reliable opening-balance relabel

**Findings (both CONFIRMED):**
1. Depot revaluation uses `instant(now).slice(0,10)` — the UTC day (`import.mjs:360`) — while everything else uses `financeDay(FINANCE_TIMEZONE)`. An hourly run at 00:30 Berlin on the 1st writes the revaluation into the just-closed month, mutating it after (or racing) the immutable month-close snapshot.
2. The opening-balance relabel guard `transactions.length > rawTransactions.length` (`import.mjs:265`) is false whenever ≥1 pending weak transaction was filtered in the same batch → the seed keeps the long `Seeded from camt.052 OPBD...` string as `imported_payee`, changing its identity between runs.

**Files:**
- Modify: `stacks/actual/fints-actual-bridge/bin/import.mjs` (lines ~243-265, ~360)
- Tests: `import-flow.test.mjs` (or `baader-daemon.test.mjs` for the depot case, whichever already fixtures depots)

- [ ] **Step 1: Two failing tests:**
  - Depot: fake `now = () => new Date('2026-08-31T22:30:00Z')`, `FINANCE_TIMEZONE=Europe/Berlin` via the `financeTimeZone` param → revaluation record `date === '2026-09-01'`.
  - Seed: payload with `--seed-balance` AND one pending NONREF transaction → `records[0].imported_payee === 'Opening Balance'`.

- [ ] **Step 2: Implement:**

In the seed block (line ~243):

```js
        let seeded = false;
        if (seedBalance) {
          const opening = (sourceAccount.balances ?? []).find((balance) => balance.type === 'OPBD');
          if (opening && safeIsoDate(opening.date) && Number.isFinite(opening.amount_cents)) {
            // ...existing unshift unchanged...
            seeded = true;
          }
        }
```

Line 265: `if (transactions.length > rawTransactions.length)` → `if (seeded)`.

Line 360: `date: instant(now).slice(0, 10),` → `date: financeDay(instant(now), financeTimeZone),`.

- [ ] **Step 3: Run bridge suite, commit**

```bash
git add stacks/actual/fints-actual-bridge
git commit -m "fix(actual): use finance day for revaluations and flag seeded batches"
```

### Task 10: audit-imports — legacy detection only for importer-owned accounts

**Finding (CONFIRMED):** `audit-imports.mjs:33-36` builds expected canonical prefixes from EVERY registry entry, including disabled `manual-actual` accounts (Triodos Giro/MasterCard, FNZ Depot). Their pre-cutover imported IDs are flagged `legacy_id_schemes` forever — no importer will ever rewrite them (`import.mjs:192` skips disabled) — permanent noise masking real regressions.

**Files:**
- Modify: `stacks/actual/cli/src/commands/audit-imports.mjs`
- Test: `cli/test/audit-imports.test.mjs`

- [ ] **Step 1: Failing test:** registry with a disabled `manual-actual` entry owning account `m1`; a transaction in `m1` with any imported_id → NOT in `legacy_id_schemes`; an enabled `fints-umwelt` account's non-canonical ID still IS flagged.

- [ ] **Step 2: Implement** — replace the map construction (lines 34-36):

```js
  const ownerByAccount = new Map(
    registry
      .filter((entry) => entry.source !== 'manual-actual')
      .map((entry) => [entry.actual_account_id, entry]),
  );
```

(Verify with `jq '.[].source' stacks/actual/cli/config/accounts.json` that the manual sentinel is exactly `manual-actual`; if entries use another literal, filter on that. EXECUTION RULING 2026-07-23: the exclusion is source-only — a temporarily-disabled `fints-*` account keeps its legacy audit coverage, since its migration debt is real and resumes mattering on re-enable; only permanently-manual accounts are noise.) The fuzzy/duplicate/missing-payee passes are account-agnostic and unchanged.

- [ ] **Step 3: Run cli suite, commit**

```bash
git add stacks/actual/cli
git commit -m "fix(actual): scope legacy id audit to importer-owned accounts"
```

---

## Phase D — Operational safety

### Task 11: Bound Baader daemon restarts (bank PIN-lockout risk)

**Finding (CONFIRMED):** `fints_daemon_baader` inherits `restart: unless-stopped` from `x-fints-base` (docker-compose.yml:9, service ~line 81). The old config was profile-gated `restart: "no"` and documented "so bank-side rejections do not loop forever." A hard FinTS rejection raises at dialog entry (`with client:` in daemon.py:181, BEFORE the TAN prompt could block) or the daemon exits 1/2 → Docker retries a fresh bank login every cycle, no backoff → bank-side PIN lockout risk.

**Files:**
- Modify: `stacks/actual/docker-compose.yml` (`fints_daemon_baader`)
- Modify: `stacks/actual/README.md` (failure recovery)

- [ ] **Step 1: Add an explicit restart override** to the service (compose merge: later keys win over the anchor):

```yaml
  fints_daemon_baader:
    <<: *fints-base
    container_name: fints_daemon_baader
    # Bounded: a hard bank rejection must not loop into fresh logins (PIN lockout).
    # After 3 failures the daemon stays down until "Actual - Sync Baader now".
    restart: on-failure:3
```

(Only add the `restart:` line and comment; keep every existing key of the service.)

- [ ] **Step 2: Validate** — `cd stacks/actual && docker compose config --quiet` (exit 0) and `docker compose config | grep -A2 'fints_daemon_baader:' | grep restart` shows the override. Also run `node --test ../monitoring/test/compose.test.mjs` in case it asserts restart policies.

- [ ] **Step 3: README failure recovery** — add: "If the Baader daemon exhausted its 3 restart attempts (hard bank rejection), investigate the logs BEFORE running **Actual - Sync Baader now**; repeated failed logins can lock the bank PIN."

- [ ] **Step 4: Commit**

```bash
git add stacks/actual/docker-compose.yml stacks/actual/README.md
git commit -m "fix(actual): bound Baader daemon restarts"
```

### Task 12: Make "Actual - Sync Baader now" actually fetch

**Finding (CONFIRMED):** The procedure is a `RestartStack` of the daemon (procedures.toml:85-95), but daemon.py:198-201 skips the initial fetch whenever the out-file is younger than `--fetch-interval` (3600 s) — a manual "sync now" within the hour performs no fetch for up to ~50 min. (The dropped SQLite-refresh follow-up stage is fine: `actual_db_sync` self-refreshes every 300 s.)

**Fix:** separate the crash-restart cheapness window from the fetch interval: new `--initial-fetch-max-age` (default 600 s). A restart fetches unless the last fetch is under 10 minutes old.

**Files:**
- Modify: `stacks/actual/fints-actual-bridge/src/fints_bridge/daemon.py`
- Modify: `syncs/procedures.toml` (description only)

- [ ] **Step 1: Add the argument** after the `--fetch-interval` argument (line ~150):

```python
    parser.add_argument("--initial-fetch-max-age", type=int, default=600,
                        help="on startup, skip the initial fetch only if the out-file is younger than this many seconds (default: 600)")
```

- [ ] **Step 2: Use it** — replace line 198:

```python
    skip_window = min(args.initial_fetch_max_age, args.fetch_interval)
    if existing_age_sec is not None and existing_age_sec < skip_window:
```

and update the log line to mention `skip_window` instead of `args.fetch_interval`. The backdated `last_fetch` translation (line 200) stays as-is so the hourly cadence is preserved either way.

- [ ] **Step 3: Verify** — `cd stacks/actual && docker compose build fints_daemon_baader` then
`docker compose run --rm --no-deps --entrypoint fints-daemon fints_daemon_baader --help | grep initial-fetch-max-age`
Expected: the option is listed. (If `docker compose run` conflicts with the fixed `container_name` of a running daemon, run with `--name fints_daemon_baader_check`.)

- [ ] **Step 4: procedures.toml** — update the `Actual - Sync Baader now` description to: `"Restarts the persistent Baader daemon; it fetches immediately unless the last fetch is under 10 minutes old. Attach to its TTY if an SMS TAN is required."`

- [ ] **Step 5: Commit**

```bash
git add stacks/actual/fints-actual-bridge/src/fints_bridge/daemon.py syncs/procedures.toml
git commit -m "fix(actual): fetch on manual Baader restarts"
```

---

## Phase E — Structural consolidation

### Task 13: One shared normalization + ISO-day module

**Finding (CONFIRMED):** Payee normalization exists **5×** byte-identical (`import.mjs:96`, `canonical.mjs:5`, `validate.mjs:10`, `sync.mjs:133`, `audit-imports.mjs:8`); ISO-day validation exists **6×** with diverging semantics — `validSince` (audit-imports.mjs:119) lacks an isFinite guard and THROWS `RangeError` on `'2024-13-01'` instead of returning false. These strings feed transaction fingerprints, migration matching, duplicate keys, and audit keys: one divergent tweak = same transaction hashing to different identities in different components.

**Files:**
- Create: `stacks/actual/fints-actual-bridge/src/importer/text.mjs`
- Modify: `bin/import.mjs`, `src/importer/canonical.mjs`, `src/importer/validate.mjs`, `db-sync/src/sync.mjs`, `cli/src/commands/{audit-imports,finance-health,month-close}.mjs`
- Modify: `stacks/actual/db-sync/Dockerfile` (ship the shared module)
- Test: `fints-actual-bridge/test/canonical.test.mjs` (module surface), plus all suites stay green

**Interfaces:**
- Produces: `normalizeText(value): string` and `isIsoDay(value): boolean` from `src/importer/text.mjs`. Consumers import via relative paths (`db-sync` already imports `../../cli/src/commands/subs.mjs`, so cross-package relative imports are the established pattern).

- [ ] **Step 1: Create the module** (byte-for-byte the current dominant implementations — behavior-neutral):

```js
// stacks/actual/fints-actual-bridge/src/importer/text.mjs
// The ONE definition of text/date identity. Transaction fingerprints,
// legacy-migration matching, duplicate keys, and audit keys all assume
// these functions agree byte-for-byte across importer, db-sync, and cli.
export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
}

export function isIsoDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
```

- [ ] **Step 2: Swap call sites** (each keeps its local name via wrapper where the signature differs):
  - `canonical.mjs`: delete local `normalized`, `import { normalizeText as normalized } from './text.mjs';`
  - `validate.mjs`: delete `isIsoDate`/`normalizeImportedPayee`, import `isIsoDay`, `normalizeText`; use directly.
  - `import.mjs`: delete `normalized` + `safeIsoDate` bodies → `import { normalizeText as normalized, isIsoDay } from '../src/importer/text.mjs';` and `const safeIsoDate = (value) => (isIsoDay(value) ? String(value) : null);`
  - `sync.mjs`: delete `validIsoDay`/`normalizedPayee` bodies → import from `'../../fints-actual-bridge/src/importer/text.mjs'`, keep local aliases (`const validIsoDay = isIsoDay;` `const normalizedPayee = normalizeText;`) so diff stays minimal.
  - `audit-imports.mjs`: `normalize` → alias of `normalizeText`; `validSince` → `const validSince = (value) => isIsoDay(value);` (this FIXES the RangeError crash).
  - `finance-health.mjs`: `validDay` → alias of `isIsoDay`.
  - `month-close.mjs` `parseDay` keeps its throw contract: `if (!isIsoDay(value)) throw new Error(...); return new Date(\`${value}T00:00:00Z\`);`

- [ ] **Step 3: Ship the module in the db-sync image.** Read `stacks/actual/db-sync/Dockerfile` (build context is `stacks/actual`, since compose builds it with `context: .`): add a `COPY fints-actual-bridge/src /app/fints-actual-bridge/src` line placed so the container path layout matches the relative import from `/app/db-sync/src/sync.mjs` (mirror how the existing `COPY` of `cli` is laid out for the `../../cli/...` import — copy that pattern exactly).

- [ ] **Step 4: Regression guard** — add to `canonical.test.mjs`:

```js
test('audit-style since validation never throws on regex-passing garbage', async () => {
  const { isIsoDay } = await import('../src/importer/text.mjs');
  assert.equal(isIsoDay('2024-13-01'), false);
  assert.equal(isIsoDay('2024-02-30'), false);
  assert.equal(isIsoDay('2024-02-29'), true);
});
```

- [ ] **Step 5: Verify everything** — all three `npm test` suites AND `cd stacks/actual && docker compose build actual_db_sync` (proves the COPY works). Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add stacks/actual
git commit -m "refactor(actual): single shared text and date identity module"
```

### Task 14: One manifest reader + retention + incremental ingestion

**Findings (CONFIRMED):** (a) Two divergent manifest parsers: `readPriorManifests` (import.mjs:134) accepts ANY parseable JSON while `readManifests` (sync.mjs:66) requires `schema_version===1 && run_id && source && finished_at` — a future schema bump would count as empty-batch evidence in one component and vanish from the other. (b) No pruning anywhere; ~9 k manifests/year/bank; the hourly importer AND the 5-minute sync each re-read + re-parse the whole directory — sync inside its write transaction while Grafana readers block on the DELETE-journal DB.

**Files:**
- Modify: `stacks/actual/fints-actual-bridge/src/importer/manifest.mjs` (shared reader + prune)
- Modify: `bin/import.mjs` (use shared reader; prune after write)
- Modify: `db-sync/src/sync.mjs` (use shared reader; skip already-ingested run_ids)
- Tests: bridge + db-sync suites

**Interfaces:**
- Produces from `manifest.mjs`:
  - `readRunManifests(directory, { skipRunIds = new Set() } = {}): Promise<Manifest[]>` — only `schema_version === 1` manifests with `run_id`, `source`, `finished_at`; skips files whose parsed `run_id` is in `skipRunIds`; tolerates corrupt files.
  - `pruneRunManifests(directory, { maxAgeDays = 90, now = new Date() } = {}): Promise<number>` — unlinks `*.json` files with mtime older than the cutoff, returns count.

- [ ] **Step 1: Move + unify the reader in manifest.mjs:**

```js
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export async function readRunManifests(directory, { skipRunIds = new Set() } = {}) {
  let names;
  try { names = await fs.readdir(directory); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const manifests = [];
  for (const name of names.filter((name) => name.endsWith('.json')).sort()) {
    let value = null;
    try { value = JSON.parse(await fs.readFile(join(directory, name), 'utf8')); }
    catch { continue; /* corrupt/incomplete file is never evidence */ }
    if (value?.schema_version !== 1 || !value.run_id || !value.source || !value.finished_at) continue;
    if (skipRunIds.has(value.run_id)) continue;
    manifests.push(value);
  }
  return manifests;
}

export async function pruneRunManifests(directory, { maxAgeDays = 90, now = new Date() } = {}) {
  let names;
  try { names = await fs.readdir(directory); }
  catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
  const cutoffMs = now.getTime() - maxAgeDays * 86400000;
  let pruned = 0;
  for (const name of names.filter((name) => name.endsWith('.json'))) {
    const file = join(directory, name);
    try {
      if ((await fs.stat(file)).mtimeMs < cutoffMs) { await fs.unlink(file); pruned += 1; }
    } catch { /* a concurrently removed file is fine */ }
  }
  return pruned;
}
```

- [ ] **Step 2: import.mjs** — delete `readPriorManifests`; `const priorManifests = await readRunManifests(manifestDir);` (note: this is deliberately STRICTER than before — invalid manifests no longer count as prior-batch evidence; that is the fail-closed direction). After `writeRunManifest(...)` on the success path add `await pruneRunManifests(manifestDir, { now: typeof now === 'function' ? now() : now });`.

- [ ] **Step 3: sync.mjs** — delete local `readManifests`; replace with:

```js
import { readRunManifests } from '../../fints-actual-bridge/src/importer/manifest.mjs';
```

and where manifests are read (line ~174), pass already-ingested run ids so unchanged history is not re-parsed and re-REPLACEd inside the write transaction:

```js
  const knownRunIds = new Set(
    /* same fresh-DB guard style as priorQualityResolutions */
    db.prepare('SELECT run_id FROM pipeline_runs').pluck().all(),
  );
  const manifests = await readRunManifests(effectiveManifestDir, { skipRunIds: knownRunIds });
```

CAREFUL ordering: `knownRunIds` must be read from the SAME db file before the rewrite section; place it next to `priorRunResolutions` from Task 5. `pipeline_runs`/`pipeline_run_accounts` rows persist in the DB after their files are pruned — SQLite becomes the long-term run history (that is intended; document in README: "Manifests are transport with 90-day retention; run history lives in the projection DB").

- [ ] **Step 4: Tests** — bridge: manifest-reader unit tests (valid/invalid/corrupt/skip-set/prune with mtime via `fs.utimes`); db-sync: existing pipeline tests still pass, plus one asserting a run already in `pipeline_runs` is not re-inserted (e.g., pre-insert a row with a mutated `outcome`, run sync with the same run_id file, assert the mutation survives).

- [ ] **Step 5: Run bridge + db-sync suites, commit**

```bash
git add stacks/actual
git commit -m "refactor(actual): shared manifest reader with retention"
```

### Task 15: Error codes on the error object; drop the `gates` duplicate

**Findings (CONFIRMED):** (a) `import.mjs` has three verbatim catch blocks setting `errorCode='ACTUAL_IMPORT_FAILED'` (331-334, 341-344, 388-391) and classifies by message regex (`/unexpected empty batch/i` at 280, `/^Invalid finance timezone:/` at 435) — rewording a message silently breaks classification. (b) `finance-health.mjs:50,52` returns the identical object under `finance_trust` AND `gates`; only tests distinguish them.

**Files:**
- Modify: `bin/import.mjs`, `src/importer/validate.mjs`, `cli/src/commands/finance-health.mjs`, `cli/test/finance-operations.test.mjs`

- [ ] **Step 1: validate.mjs** — the empty-batch throw (line 19-21) carries a code:

```js
  if (records.length === 0 && previousCount > 0) {
    const error = new Error(`unexpected empty batch after previous count ${previousCount}`);
    error.code = 'EMPTY_BATCH';
    throw error;
  }
```

- [ ] **Step 2: import.mjs** — add near the top:

```js
function coded(code, message, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}
```

Replace the validateBatch catch (278-282) with:

```js
        let validated;
        try {
          validated = validateBatch(records, { previousCount: evidence.successfulCount });
        } catch (error) {
          throw error.code === 'EMPTY_BATCH'
            ? coded('EMPTY_BATCH_REGRESSION', 'Unexpected empty batch regression', error)
            : error;
        }
```

Replace each of the three identical catches with `catch (cause) { throw coded('ACTUAL_IMPORT_FAILED', 'Actual import failed', cause); }`. In `financeDay`'s catch attach `error.code = 'INVALID_TIMEZONE'` on the thrown Error. Delete the `let errorCode = null;` variable; the outer catch (424-438) becomes:

```js
  } catch (cause) {
    const code = cause?.code ?? null;
    const manifest = {
      schema_version: 1, run_id: runId,
      source: sources.size === 1 ? [...sources][0]
        : intendedSources.size === 1 ? [...intendedSources][0] : 'unknown',
      importer_version: IMPORTER_VERSION,
      started_at: startedAt, finished_at: instant(now),
      requested_range: manifestRange, accounts: accounts.length ? accounts : intendedAccounts,
      outcome: 'failed',
      error_code: code === 'INVALID_TIMEZONE' ? 'VALIDATION_FAILED' : (code ?? 'VALIDATION_FAILED'),
    };
    await writeRunManifest(join(manifestDir, `${runId}.json`), manifest);
    if (code === 'INVALID_TIMEZONE') throw cause;
    if (code === 'EMPTY_BATCH_REGRESSION') throw cause;
    throw new Error(code === 'ACTUAL_IMPORT_FAILED' ? 'Actual import failed' : 'Import validation failed', { cause });
  }
```

CHECK before finalizing: run the bridge suite and diff manifest `error_code` expectations in `import-flow.test.mjs` — the observable contract (`error_code` values `VALIDATION_FAILED` / `ACTUAL_IMPORT_FAILED` / `EMPTY_BATCH_REGRESSION` and thrown message texts) must remain EXACTLY as the tests assert; adjust the mapping above if a test pins a different combination, and update the timezone manifest expectation if tests pin `error_code: 'VALIDATION_FAILED'` there (they did at review time).

- [ ] **Step 3: finance-health.mjs** — delete the `gates: financeTrust,` line; in `finance-operations.test.mjs` delete the two `assert.deepEqual(report.gates, report.finance_trust)` assertions and change `blocked.gates.reasons` to `blocked.finance_trust.reasons`.

- [ ] **Step 4: Run bridge + cli suites, commit**

```bash
git add stacks/actual
git commit -m "refactor(actual): typed import error codes"
```

### Task 16: Safe-to-spend has ONE implementation (the SQL view) + trust-reason canary

**Findings (CONFIRMED):** (a) `calculateSafeToSpend` (month-close.mjs:14) is exercised ONLY by tests; the shipped number comes from the `safe_to_spend` SQL view (schema.sql:412) that `captureMonthClose` snapshots (line 79). They already diverge: the JS accepts role `'flexible_essential'` which NOTHING produces (semantics.mjs maps "Flexible essentials" → `'essential'`), and the JS lacks the view's freshness gating. The tested implementation is not the shipped one. (b) `month-close.mjs:58-65` re-implements trust semantics by string-filtering the literal `'review_queue_exceeded'` reason — coupled to schema.sql:387's exact string with nothing pinning it.

**Files:**
- Modify: `stacks/actual/cli/src/commands/month-close.mjs` (delete `calculateSafeToSpend` + `parseDay` if now unused)
- Modify: `stacks/actual/cli/test/month-close.test.mjs` (delete its tests)
- Create: `stacks/actual/db-sync/test/safe-to-spend.test.mjs`
- Modify: `stacks/actual/db-sync/src/schema.sql` (comment) and `db-sync/test/semantics.test.mjs` (canary)

- [ ] **Step 1: Port the JS test cases to the view.** New `safe-to-spend.test.mjs` seeding the schema into a temp SQLite (fixture pattern from Task 1, dates relative to now; the view reads SQL `'now'` so freshness rows must use the real clock):

```js
// Cases to port (from the deleted calculateSafeToSpend tests), all against
// `SELECT * FROM safe_to_spend`:
// 1. discretionary +30000 available, essential -5000, unpaid discretionary
//    schedule -4000 due this month  => month_cents = 21000,
//    per_day_cents = floor(21000 / remaining_days) with remaining_days read
//    from the row itself (it is clock-derived; assert it is >= 1 and equals
//    the row's own value used in the division).
// 2. sinking-fund negative balance does NOT count as underfunding.
// 3. income schedule, completed schedule, positive-amount schedule: ignored.
// 4. stale budget_projection (fetched_at now-3600s with max_age 900)
//    => month_cents IS NULL (never a trusted zero).
// 5. current_budgets row for a different month only => month_cents IS NULL.
```

Write these as five real tests; seed `current_budgets` with `month=strftime('%Y-%m','now')`, `budget_projection`/`schedule_projection` fresh rows, `current_schedules` rows per case.

- [ ] **Step 2: Run — the five view tests must PASS against the current schema** (they characterize existing behavior; if any fails, the view has a real bug — STOP and report before "fixing" the test).

- [ ] **Step 3: Delete the JS twin** — remove `calculateSafeToSpend` (and its import/exports) from month-close.mjs and its test block from month-close.test.mjs. `captureMonthClose` is untouched (it already reads the view).

- [ ] **Step 4: Canary for the reason-string coupling** — in `semantics.test.mjs`:

```js
test('CANARY: month-close depends on this exact trust reason string', () => {
  // Seed >10 review-queue rows into a fresh schema DB, then:
  // assert JSON.parse(financeTrustRow.reasons).includes('review_queue_exceeded')
  // month-close.mjs filters this literal; renaming it in schema.sql without
  // updating month-close would hard-block or falsely unblock every close.
});
```

Implement with a real fixture (11 uncategorized on-budget transactions). Add matching comments at schema.sql's `review_queue_exceeded` line and month-close.mjs:61: `-- / // Renaming this reason requires updating the other file + the canary test.`

- [ ] **Step 5: Run cli + db-sync suites, commit**

```bash
git add stacks/actual
git commit -m "refactor(actual): make the safe-to-spend view the tested implementation"
```

### Task 17: One duplicate-candidate key construction

**Finding (CONFIRMED):** Three independent fuzzy-duplicate definitions: `validate.mjs:35` (`date|amount|normalized imported_payee`, no account), `sync.mjs:137-158` (JSON key per account, negative-only, synthetic-prefix exclusions), `audit-imports.mjs:58-63` (NUL-joined with payee fallback). Consumers can disagree about what a duplicate is; tightening normalization in one silently changes `check_id` hashes and orphans prior resolutions.

**Scope decision:** unify the KEY construction and normalization in the shared module; keep the purpose-specific FILTERS (negative-only, synthetic exclusions, >1-distinct-imported-id) where they are but documented in one place. Byte-compatibility constraint: `sync.mjs`'s `check_id` hashes must NOT change (live `data_quality` resolutions reference them).

**Files:**
- Modify: `stacks/actual/fints-actual-bridge/src/importer/text.mjs` (add key builder + synthetic constants)
- Modify: `validate.mjs`, `sync.mjs`, `audit-imports.mjs`
- Tests: all three suites; explicit hash-stability test

- [ ] **Step 1: Extend text.mjs:**

```js
// Synthetic transactions created by the importer itself. Every LIKE/regex on
// these prefixes anywhere in the stack must come from here.
export const SYNTHETIC_IMPORT_PREFIXES = Object.freeze([
  'fints-bridge-opening-balance-',
  'fints-bridge-depot-revaluation-',
]);

export function isSyntheticImportedId(importedId) {
  const value = String(importedId ?? '');
  return SYNTHETIC_IMPORT_PREFIXES.some((prefix) => value.startsWith(prefix));
}

// Canonical fuzzy-duplicate identity. accountId may be null (importer runs
// before account resolution). Callers apply their own purpose filters:
//   validateBatch: within-batch, all signs, no account.
//   db-sync:       per-account, negative amounts only, synthetic excluded.
//   audit-imports: per-account, >1 distinct imported_id required.
export function duplicateCandidateKey({ accountId = null, date, amountCents, payeeIdentity }) {
  return JSON.stringify({
    account_id: accountId, date, amount_cents: amountCents,
    normalized_payee: normalizeText(payeeIdentity),
  });
}
```

- [ ] **Step 2: Adopt with byte-compatibility.** `sync.mjs` `duplicateCandidates`: its current key is `JSON.stringify({ account_id, date, amount_cents, normalized_payee })` — the shared builder reproduces it EXACTLY (same property order); replace the inline construction and swap the synthetic regex at line 141 for `isSyntheticImportedId(transaction.imported_id)`. Also swap the `NOT LIKE 'fints-bridge-opening-balance-%'` in schema.sql's `review_queue`? — NO: SQL cannot import JS; instead add a comment at both schema.sql LIKE sites: `-- Prefixes mirror SYNTHETIC_IMPORT_PREFIXES in fints-actual-bridge/src/importer/text.mjs.` `validate.mjs` fuzzyKey → `duplicateCandidateKey({ date: record.date, amountCents: record.amount, payeeIdentity: record.imported_payee })`. `audit-imports.mjs` fuzzyKey → `duplicateCandidateKey({ accountId: transaction.account, date: transaction.date, amountCents: transaction.amount, payeeIdentity: transaction.imported_payee || transaction.payee })` — NOTE this changes the audit's internal grouping key format only (never persisted), so it is safe.

- [ ] **Step 3: Hash-stability test** in db-sync suite: seed two duplicate transactions, run sync twice, assert the `data_quality.check_id` equals the value produced before this refactor (pin one known-good hash by computing it with the OLD inline code in the test itself).

- [ ] **Step 4: Run all suites, commit**

```bash
git add stacks/actual
git commit -m "refactor(actual): shared duplicate-candidate identity"
```

### Task 18: Fetch only current + previous budget months

**Finding (CONFIRMED):** `buildSnapshot` (sync.mjs:47-48) awaits `api.getBudgetMonth` for EVERY month since budget start, sequentially, every 5 minutes — growing by one call per month forever — while all consumers (`current_budgets` gate, dashboards, month-close) only read the current month and, until its close is applied, the previous month.

**Files:**
- Modify: `stacks/actual/db-sync/src/sync.mjs` (buildSnapshot)
- Modify: `stacks/actual/runbooks/month-close.md` (constraint note)

- [ ] **Step 1: Confirm the consumer set** — `grep -rn "current_budgets" stacks/actual --include='*.mjs' --include='*.sql' --include='*.json'` and confirm every reader filters `month = strftime('%Y-%m','now')` or (month-close) an explicitly passed month. Grafana monthly history must come from `budget_snapshots`, not `current_budgets` — verify with `grep -l current_budgets stacks/monitoring/grafana/provisioning/dashboards/*.json`. If any dashboard reads historical `current_budgets` months, STOP and surface before narrowing.

- [ ] **Step 2: Implement** — replace lines 47-48:

```js
  const budgetMonths = [];
  const currentMonth = capturedDay(new Date()).slice(0, 7);
  const previousStart = new Date(`${currentMonth}-01T00:00:00Z`);
  previousStart.setUTCMonth(previousStart.getUTCMonth() - 1);
  const wantedMonths = new Set([currentMonth, previousStart.toISOString().slice(0, 7)]);
  // Only the live month and the month being closed are consumed downstream;
  // closed history is preserved in budget_snapshots at month-close.
  for (const month of (await api.getBudgetMonths()).filter((m) => wantedMonths.has(m))) {
    budgetMonths.push(await api.getBudgetMonth(month));
  }
```

- [ ] **Step 3: Runbook note** in `month-close.md`: "Run the close during the following month — `current_budgets` only carries the current and previous Actual months. To close an older month, temporarily widen `wantedMonths` in db-sync/src/sync.mjs."

- [ ] **Step 4: Run db-sync suite, commit**

```bash
git add stacks/actual
git commit -m "perf(actual): sync only live budget months"
```

### Task 19: Importer/sync scar-tissue cleanups

**Findings (CONFIRMED, bundled — each is small):**
1. `import.mjs:186-199` — a pre-pass duplicates the main loop's bankKey/mapping/ownership matching just to pre-populate failure-manifest attribution (`intendedSources`/`intendedAccounts` parallel to `sources`/`accounts`).
2. `import.mjs:175,289-295` — `recordsByActualId` is maintained all run but read once for dry-run output; fully derivable from `batches`.
3. `sync.mjs:374-396` — every schedule check is evaluated twice (once into `errors`, once into `valid`) plus dead fallbacks (`schedule.name ?? 'Unnamed schedule'`, `schedule.next_date ?? null`) that `valid` already guarantees non-null.

**Files:** `bin/import.mjs`, `db-sync/src/sync.mjs`; suites must stay green (behavior-neutral refactors — no new tests, existing tests are the guard).

- [ ] **Step 1: import.mjs — single ownership resolution.** Replace the pre-pass (186-199) and the loop's re-resolution with one resolved list built once:

```js
    const ownership = validateOwnership(registry);
    const planned = [];
    for (const bankPayload of bankPayloads(payload)) {
      const bankKey = String(bankPayload.bank?.key ?? '').trim();
      for (const sourceAccount of bankPayload.accounts ?? []) {
        const mapping = accountMapping(config, bankKey, sourceAccount);
        const owner = mapping && ownership.get(mapping.actual_account_id);
        const owned = Boolean(owner?.enabled && owner.source === `fints-${bankKey}`);
        planned.push({ bankKey, sourceAccount, mapping, owner, owned });
        if (owned) {
          intendedSources.add(owner.source);
          intendedAccounts.push({
            actual_account_id: mapping.actual_account_id,
            fetched: 0, valid: 0, added: 0, updated: 0, quarantined: 0,
          });
        }
      }
    }
```

Then the main loop iterates `planned` instead of re-walking `bankPayloads(payload)`: `if (!entry.bankKey) throw new Error('missing bank key'); if (!entry.mapping?.actual_account_id) throw new Error('account mapping missing'); if (!entry.owned) throw new Error('account ownership mismatch');` — same errors, same order, ONE matching implementation. (The `banks.length === 0 → 'empty payload'` check stays, driven by `bankPayloads(payload).length`.)

- [ ] **Step 2: import.mjs — delete `recordsByActualId`.** Remove the Map and its population; dry-run output becomes:

```js
    if (dryRun) {
      const byAccount = {};
      for (const batch of batches) {
        byAccount[batch.actualAccountId] = (byAccount[batch.actualAccountId] ?? []).concat(batch.records);
      }
      output(`${JSON.stringify(byAccount, null, 2)}\n`);
    }
```

- [ ] **Step 3: sync.mjs — single-pass schedule validation.** Replace the loop body (375-393):

```js
      for (const schedule of schedules) {
        if (typeof schedule.completed !== 'boolean') { errors.add('completed_type'); continue; }
        if (schedule.completed) continue;
        const role = scheduleRole(schedule.name);
        const failed = [];
        if (!schedule.id || !schedule.name) failed.push('identity');
        if (!role) failed.push('role');
        if (!validIsoDay(schedule.next_date)) failed.push('next_date');
        if (schedule.amountOp !== 'is') failed.push('amount_op');
        if (!Number.isInteger(schedule.amount)) failed.push('amount');
        if (Number.isInteger(schedule.amount) && role
          && !(role === 'income' ? schedule.amount > 0 : schedule.amount < 0)) failed.push('amount_sign');
        if (failed.length) { for (const f of failed) errors.add(f); continue; }
        insertSchedule.run(schedule.id, schedule.name, role, schedule.next_date, schedule.amount, 0, schedulesFetchedAt);
      }
```

- [ ] **Step 4: Run bridge + db-sync suites (they pin all observable behavior), commit**

```bash
git add stacks/actual
git commit -m "refactor(actual): remove duplicated importer and schedule passes"
```

### Task 20: Python fetcher emits `reference_quality`; JS trusts it

**Finding (CONFIRMED as design risk):** JS reverse-engineers the Python synthetic-ID format via `/^SYN_[0-9A-F]{24}$/` plus a hardcoded `WEAK_REFERENCES` bank-literal set (canonical.mjs:17-25) — an implicit cross-language string contract. A new weak token (e.g. `KEINE REF`) or a Python format change silently makes weak references look strong → position-shifted re-fetches duplicate transactions.

**Files:**
- Modify: `src/fints_bridge/fetch.py` (~line 207), `src/fints_bridge/camt052.py` (~146 + the CamtTransaction definition + its serialization site)
- Modify: `src/importer/canonical.mjs`, `bin/import.mjs`
- Tests: `canonical.test.mjs`

**Interfaces:**
- Produces: every transaction dict in fetch payloads gains `"reference_quality": "bank" | "synthetic"`.
- Produces: `isWeakReference(transaction): boolean` in canonical.mjs (object-level; falls back to the legacy string heuristics when the field is absent).

- [ ] **Step 1: fetch.py** (line ~207):

```python
    raw_ref = d.get("transaction_reference") or d.get("bank_reference")
    raw_id = raw_ref or _synthetic(booking_date, amount_cents, payee, purpose)
    return {
        "imported_id": raw_id,
        "reference_quality": "bank" if raw_ref else "synthetic",
        # ...rest of the existing dict unchanged...
    }
```

- [ ] **Step 2: camt052.py** — at line ~146 capture `bank_ref = acct_svcr_ref or end_to_end_id`, use it for `raw_id`, add a `reference_quality` field to `CamtTransaction` (`"bank" if bank_ref else "synthetic"`), and grep for where `CamtTransaction`/`raw_id` is converted into the payload transaction dict (in fetch.py) to pass the field through. Bank literals like `NONREF` come from the BANK, not `_synthetic` — those are `"bank"`-sourced strings that are still weak, so the JS literal set remains as fallback for them (see Step 3): mark only truly synthesized ids as `"synthetic"`.

- [ ] **Step 3: canonical.mjs:**

```js
export function isWeakReference(transaction) {
  if (transaction?.reference_quality === 'synthetic') return true;
  // Bank-sourced placeholder tokens (NONREF etc.) are weak even when the
  // bank supplied them; the literal set stays authoritative for those.
  return isWeakSourceReference(transaction?.imported_id);
}
```

`canonicalSourceTransactionId` switches its weak check to `isWeakReference(transaction)`; `import.mjs` pendingWeak filter and the Task-7 disambiguation switch from `isWeakSourceReference(transaction.imported_id)` to `isWeakReference(transaction)`.

- [ ] **Step 4: Tests** — canonical.test.mjs: `reference_quality:'synthetic'` with a non-SYN id → weak (fingerprint suffix applied); `reference_quality:'bank'` with id `NONREF` → still weak (literal set); absent field → legacy heuristics unchanged.

- [ ] **Step 5: Run bridge suite; rebuild check `docker compose build fints_daemon_baader`; commit**

```bash
git add stacks/actual/fints-actual-bridge
git commit -m "feat(actual): structured reference quality from the fetcher"
```

### Task 21: Restore subscription monitoring panels

**Finding (CONFIRMED):** db-sync still populates `subscriptions` (sync.mjs:215, schema.sql:61) but zero dashboards query it — the deleted `actual-recurring.json` panels ("Stale subscriptions — was recurring, recently silent", "Recurring spend per month (creep detector)", "New recurring this month") were dropped without replacement. Real signal (price creep, zombie subscriptions) is now write-only.

**Files:**
- Modify: `stacks/monitoring/grafana/provisioning/dashboards/actual-monthly.json`
- Verify: `stacks/actual/db-sync/test/dashboard-queries.test.mjs` (auto-validates every provisioned `rawQueryText`)

- [ ] **Step 1: Recover the old panel SQL:**

```bash
git show 96aec53:stacks/monitoring/grafana/provisioning/dashboards/actual-recurring.json \
  | jq -r '.panels[] | "== " + .title, (.targets[]?.rawQueryText // empty)'
```

- [ ] **Step 2: Add a "Recurring" row to actual-monthly.json** with three panels (stale subscriptions table, recurring-spend-per-month timeseries, new-recurring-this-month table), copying the JSON structure (datasource ref, `rawQueryText` target shape, grid positions after the last existing row) from existing panels in the SAME file and pasting the recovered SQL. The `subscriptions` schema is unchanged since 96aec53, so queries port verbatim; if a query referenced a deleted view, adapt it to `subscriptions` columns only and note the change in the commit body.

- [ ] **Step 3: Validate** — `jq empty stacks/monitoring/grafana/provisioning/dashboards/actual-*.json` (exit 0) and `cd stacks/actual/db-sync && npm test` (dashboard-queries suite must prepare the three new queries).

- [ ] **Step 4: Commit**

```bash
git add stacks/monitoring/grafana/provisioning/dashboards/actual-monthly.json
git commit -m "feat(grafana): restore subscription monitoring panels"
```

---

## Final Verification Gate (before any push)

- [ ] `cd stacks/actual/fints-actual-bridge && npm test` — PASS
- [ ] `cd stacks/actual/cli && npm test` — PASS
- [ ] `cd stacks/actual/db-sync && npm test` — PASS (includes dashboard queries + safe-to-spend view + canary)
- [ ] `cd stacks/actual && docker compose config --quiet` and `cd stacks/monitoring && docker compose config --quiet` — exit 0
- [ ] `jq empty stacks/monitoring/grafana/provisioning/dashboards/actual-*.json` — exit 0
- [ ] `node --test stacks/monitoring/test/compose.test.mjs` — PASS
- [ ] `cd stacks/actual && docker compose build fints_sync_umwelt fints_daemon_baader actual_db_sync` — all build
- [ ] `git status --short` clean; `git log --oneline origin/main..HEAD` shows one commit per task

## Deployment (after push — operator steps, in order)

1. Push branch → merge to `main` (Komodo auto-deploys the `actual` stack config).
2. On the server (`kolja@192.168.1.20`), rebuild locally-built images (Komodo will NOT): `cd /var/lib/komodo-periphery/stacks/actual/stacks/actual && sudo docker compose build fints_daemon_baader fints_sync_umwelt actual_db_sync && sudo docker compose up -d --no-deps fints_daemon_baader actual_db_sync`. The daemon usually resumes its FinTS dialog from `/state` without a new TAN; if `Enter TAN:` appears in logs, follow the README attach procedure.
3. Run **GitOps - Reconcile homelab**, then one manual **Monitoring - Refresh dashboards** (dashboard JSON is not auto-detected).
4. Run **Actual - Finance health**: `reconciliation_required` should clear after reconciling each account once in the Actual UI (Task 3 makes this possible — it was previously impossible); `unresolved_quarantine` should reference at most the latest runs; work remaining reasons down with the runbooks.
5. Watch one full Baader hourly cycle + one manual **Actual - Sync UmweltBank now**; verify manifests show per-account `outcome`, `duplicate_candidates`, `pending_excluded`, and a repeated window yields `added=0`.

---

## Phase F — Recorded backlog (NOT tasks; each needs its own brainstorm/plan)

These came out of the same review ("use the gained data, offer more features"). Recorded so they are not lost:

1. **Trust alerting (highest value).** `finance_trust.reasons`, per-source staleness, and quarantine are machine-readable. A Grafana alert rule (or a small cron in `actual_db_sync` + push, mirroring beerbot's FCM path) on "trust went false" / "no successful import for account X within cadence" turns the gate from something you check into something that calls you. Data: `finance_trust`, `pipeline_run_accounts`, `expected_sources`.
2. **Safe-to-spend surfacing.** Expose the `safe_to_spend` view as a Home Assistant sensor (HA already runs in this homelab) and/or a daily morning push. The number only shows when trust is true — same suppression rule as Grafana.
3. **Month-over-month trend panels.** `budget_snapshots` + `net_worth_snapshots` accumulate immutable history: savings-rate trend, envelope funded-vs-consumed drift, "fixed obligations grew X% this quarter". No raw-transaction queries needed, so panels stay trusted.
4. **Cashflow forecast.** `current_schedules` (amounts + next dates + roles) + account balances support a 30-day projected-balance line ("does the giro dip below zero before salary?") on the Home dashboard.
5. **Rule-candidates loop closure.** Render `rule-candidates` output as ready-to-paste Actual rule definitions (still human-approved — the plan constraint "operator creates rules in Actual" stands) as a weekly-review step.
6. **Portfolio allocation drift.** `holdings_history` has hourly Baader snapshots: allocation-over-time and contribution-vs-market-growth panels for the Investments dashboard. Constraint from the original plan still applies: no investment-return claims, no tax lots.
7. **Triodos closure (operational, time-bound).** On/after 2026-07-31: final Triodos fetch (creds recoverable from git history per the ops notes), import closing transfers, close both Triodos accounts in Actual.

## Appendix — complete findings ledger (traceability)

Every finding from the 2026-07-22 review and where it landed:

| # | Finding (CONFIRMED unless noted) | Disposition |
|---|---|---|
| 1 | `last_reconciled` epoch-ms vs `validIsoDay` — reconciliation gate unclearable | Task 3 |
| 2 | Fuzzy candidates counted as quarantined though imported | Task 5 |
| 3 | `pipeline_runs.resolved` recomputed each sync; no resolution path; ANY-run trust scope | Task 5 |
| 4 | Run-level outcome stamped per account; quiet account poisons siblings; coverage stalls | Task 4 |
| 5 | Weak-ref fingerprint collision fails whole run | Task 7 |
| 6 | Baader `restart: unless-stopped` → login-loop/PIN-lockout risk | Task 11 |
| 7 | Pending weak-ref transactions silently dropped and mislabeled | Task 6 |
| 8 | Legacy migration matches wrong `imported_payee` shape; tests fixture the wrong shape (caused the 26 cutover duplicates) | Task 8 |
| 9 | Depot revaluation dated in UTC → closed-month mutation | Task 9 |
| 10 | "Sync Baader now" no-ops within the fetch interval; dropped refresh stage benign (db-sync self-refreshes) | Task 12 |
| 11 | Time-bomb test: `financeHealth` without `now` + fixed fixture dates (suite currently red) | Task 1 |
| 12 | audit-imports flags disabled `manual-actual` accounts as legacy forever | Task 10 |
| 13 | Opening-balance relabel guard broken by pending filtering | Task 9 |
| 14 | Uncommitted `@actual-app/api` 26.7 bump (PLAUSIBLE incompat) | Task 2 |
| 15 | Payee normalization ×5, ISO-day ×6 (incl. `validSince` RangeError crash) | Task 13 |
| 16 | Duplicate-candidate definition ×3 with divergent keys | Task 17 |
| 17 | Manifest parsers diverge (schema_version); no retention; full re-read hourly + per 5 min inside write txn | Task 14 |
| 18 | Safe-to-spend implemented twice; tested one not shipped; dead `flexible_essential` vocabulary | Task 16 |
| 19 | month-close string-filters `review_queue_exceeded` (trust semantics in consumer) | Task 16 (canary + comments; full data-layer verdict view DEFERRED as over-engineering for one consumer) |
| 20 | Error classification via message regex; 3 identical catch blocks; mutable `errorCode` | Task 15 |
| 21 | `gates` duplicate of `finance_trust` in finance-health report | Task 15 |
| 22 | SYN_/weak-reference cross-language string contract | Task 20 |
| 23 | Synthetic-prefix magic strings matched in JS regex + SQL LIKE ×3 | Task 17 (JS constants + SQL comment cross-references; a projected `is_synthetic` COLUMN was considered and DEFERRED — the two SQL sites are stable and commented) |
| 24 | Schedule role from `[Fixed] ` name-prefix regex (PLAUSIBLE) | DEFERRED-BY-DESIGN: verified the Actual API schedule entity has NO category field, so a structural role source needs a rules/payee join — not worth it now. The prefix convention stays load-bearing and documented in the README; Task 19 keeps its validation single-pass. |
| 25 | Hourly full-history `getTransactions` for legacy-migration planning | DEFERRED: after Task 8 the migration self-completes; revisit with a per-account "migration complete" marker in stateDir if daemon latency grows. Recorded here deliberately. |
| 26 | Depot revaluation full-history fetch instead of `getAccountBalance` | DEFERRED with #25 (same call-site family, small data volume today). |
| 27 | Sequential `getBudgetMonth` for all history each sync | Task 18 |
| 28 | `finance_trust` view re-ranks full run history per panel; materialization idea | DEFERRED (YAGNI at current scale): Task 14's skip-set + file retention bounds growth; `pipeline_runs` DB rows are small. Revisit if dashboard latency is felt. |
| 29 | Pre-pass ownership duplication (`intendedSources`/`intendedAccounts`) | Task 19 |
| 30 | `recordsByActualId` derivable state | Task 19 |
| 31 | Schedule checks evaluated twice + dead fallbacks | Task 19 |
| 32 | Subscriptions table write-only after dashboard consolidation | Task 21 |
| 33 | Abort-all on unmapped/placeholder bank account (behavior change from skip-and-continue) | ACCEPTED-BY-DESIGN: fail-closed is the cutover's explicit philosophy; a new bank sub-account SHOULD stop imports until the registry names an owner. README's failure-recovery already covers it. Recorded so the change is a decision, not an accident. |
| 34 | Cross-window sudden-emptiness not trust-gated (surfaced while designing Task 4) | KNOWN LIMITATION, recorded in Task 4; the same-window `EMPTY_BATCH_REGRESSION` guard is the only emptiness tripwire. Candidate future check: compare `valid` against the previous overlapping window. |
| 35 | Depot (holdings) accounts have NO emptiness tripwire at all (surfaced in Task 4 review): the depot branch skips `validateBatch`, so a silently-empty holdings fetch gets `outcome: 'empty'` and counts as trusted coverage | KNOWN LIMITATION, flagged for the plan owner at run end. Risk assessed low: the only live depot (Baader) always carries holdings; pre-Task-4 behavior was noisy (`partial_empty`) but equally unguarded. Candidate future check: prior-holdings-evidence comparison mirroring `priorBatchEvidence`. |

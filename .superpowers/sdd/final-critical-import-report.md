# Final critical importer fixes

Date: 2026-07-18
Implementation commits: `7683571`, `e7795d0`
Production access/deployment: none

## Scope

Only the two Critical final-review blockers were changed: depot revaluation
safety and canonical transaction identity/history migration. Changes are limited
to the FinTS importer, its tests, and importer documentation.

## Root causes

### A. Depot revaluation

`bin/import.mjs` deleted every previous revaluation before importing a new
date-derived adjustment. Actual retains deleted imported IDs; therefore
`reimportDeleted: false` could suppress the replacement. A failed import after
the deletion also left no last-known-valid valuation.

The previous unit test encoded the unsafe call order (`get`, `delete`, `import`)
and used a fake that did not model Actual's retained-deletion behavior.

### B. Canonical identity and migration

`canonical.mjs` assumed the supplied bank reference was unique. Baader can
reuse placeholders such as `STARTUMS`, so nine distinct movements collapsed to
one imported ID. The canonical importer also wrote namespaced IDs without first
reconciling raw or previously canonical-but-unqualified IDs already in Actual,
allowing the first canonical run to recreate legacy history.

## RED evidence (before production-code changes)

Command:

```sh
node --test test/canonical.test.mjs test/import-flow.test.mjs
```

Observed 17 pass / 6 fail:

- nine `STARTUMS` records produced one ID (`1 !== 9`);
- equal-amount purchases with differing terminal text produced equal IDs;
- sequential depot cycles called the forbidden delete path and failed;
- injected depot-update failure did not reject because no update path existed;
- unique legacy history was imported without an ID migration;
- ambiguous legacy history did not reject and did not quarantine.

A second RED cycle caught the first mutable-field flaw:

```sh
node --test test/canonical.test.mjs
```

Observed 5 pass / 1 fail: a `PDNG` to `BOOK` transition changed the fingerprint.
Removing only `status` was insufficient: realistic lifecycle review showed that
value date, servicer metadata, payee, purpose, and even a weak raw reference may
change between pending and booked states.

The follow-up lifecycle RED run observed 6 pass / 3 fail (including one test
file parse error that was corrected before evaluating behavior):

- a strong unchanged bank reference produced different identities after
  realistic metadata changes;
- a booked weak-reference refetch changed identity when only value date and
  servicer metadata changed;
- after correcting the test syntax, a pending weak-reference record was written
  instead of being held and counted as quarantined.

Additional RED behavior tests covered changed depot value, multiple prior depot
adjustments, and later-account ambiguity preventing an earlier-account
migration. The existing implementation already satisfied those three global
atomicity behaviors; the tests now make them explicit regressions.

## Design and safety properties

### Depot

- Perform all depot reads and ambiguity checks before the first mutation.
- Accept zero or one existing revaluation; multiple existing adjustments fail
  closed for manual reconciliation before any write.
- Use one stable ID per Actual depot account.
- Import it once with `reimportDeleted: false`; thereafter call Actual's
  supported `updateTransaction(id, fields)` to atomically update the existing
  row in place.
- Never delete a revaluation in the recurring importer.
- If an update fails before commit, the prior valid valuation remains. If a
  response is lost after Actual commits, retry is idempotent because it targets
  the same row and stable imported ID.

### Canonical identity and legacy migration

- Classify evidenced non-unique placeholders (`STARTUMS`, `NONREF`, `NOREF`,
  `NOTPROVIDED`, `NOT PROVIDED`, `UNKNOWN`, `NONE`, and `N/A`) as weak
  references. Other non-empty bank references are treated as strong.
- A strong reference remains the primary namespaced identity. Pending-to-booked
  changes to status, value date, servicer metadata, payee, or purpose do not
  change that identity.
- A pending weak-reference transaction is not written to Actual. It is counted
  as fetched and quarantined until the bank supplies a booked row. The booked
  row may carry either a final strong reference or the same weak placeholder.
- A booked weak reference is qualified with a deterministic SHA-256 prefix over
  only booked-stable normalized fields: booking date, signed amount, currency,
  payee, and purpose. Value date, status, end-to-end ID, and servicer metadata
  are deliberately excluded from weak identity.
- Re-fetching booked data yields identical IDs. Reused weak references with
  stable differentiators yield distinct IDs. Truly indistinguishable booked
  rows retain the same ID and fail batch validation rather than receiving a
  fetch-order-dependent occurrence number.
- Before any mutation, read every affected account and plan legacy migration.
  Candidate aliases include the raw bank ID and the earlier namespaced but
  unqualified canonical ID. A candidate must also exactly match date, signed
  amount, and normalized imported content.
- A unique match is migrated in place with `updateTransaction` before the
  idempotent import. Multiple matches fail closed, increment the account's
  quarantine count, write a sanitized failed manifest, and perform zero writes.
- Actual imports continue to use `reimportDeleted: false`, preserving user
  deletions.

## GREEN evidence

```text
FinTS importer: npm test
49 tests, 49 pass, 0 fail

Related Actual CLI: npm test
14 tests, 14 pass, 0 fail

docker compose -f stacks/actual/docker-compose.yml config --quiet
exit 0

git diff --check
exit 0
```

Coverage includes sequential depot cycles, changed-value single-row update,
injected atomic-update failure, multiple-prior fail-closed behavior, one
effective valuation, no delete calls, nine reused references, repeated-fetch
idempotence, same-day equal-amount differentiators, pending weak quarantine,
booked weak stability, strong-reference lifecycle stability, indistinguishable
weak-row rejection, unique legacy migration, later-account ambiguity blocking
earlier-account writes, deleted-record options, and zero writes on ambiguity.

## Residual risks

- Legacy reconciliation is deliberately strict. If an old row lacks matching
  immutable imported content, it is not auto-migrated; the cutover audit must
  resolve it rather than weakening the matcher.
- Two genuinely distinct bank movements with every stable identity field equal
  are not safely distinguishable. The importer rejects/quarantines instead of
  guessing an occurrence number that could drift between fetch windows.
- Weak-reference classification is an explicit conservative allowlist. A newly
  observed bank placeholder must be added with a fixture/test before it receives
  content-qualified handling; until then it is treated as a strong reference.
- `updateTransaction` is an atomic Actual API mutation, but a network loss after
  server commit and before acknowledgement is inherently ambiguous. Stable IDs
  and in-place updates make the next retry converge safely.

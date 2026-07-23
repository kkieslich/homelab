import assert from 'node:assert/strict';
import test from 'node:test';

import { auditTransactions, renderHuman } from '../src/commands/audit-imports.mjs';

const registry = [{
  actual_account_id: 'account-1',
  source: 'fints-umwelt',
  source_account: 'umwelt-giro',
  enabled: true,
}];

function transaction(id, overrides = {}) {
  return {
    id,
    account: 'account-1',
    date: '2026-07-01',
    amount: -1_000,
    imported_id: `fints-umwelt:umwelt-giro:${id}`,
    imported_payee: 'Merchant',
    payee: 'payee-1',
    category: 'category-1',
    notes: `private note for ${id}`,
    ...overrides,
  };
}

test('classifies import identity, fuzzy, payee, and category findings without mutation or notes', () => {
  const snapshot = {
    transactions: [
      transaction('duplicate-a', { imported_id: 'repeated-bank-id' }),
      transaction('duplicate-b', { imported_id: 'repeated-bank-id', date: '2026-07-02' }),
      transaction('fuzzy-a', { date: '2026-07-03', imported_payee: ' Same  Shop ' }),
      transaction('fuzzy-b', { date: '2026-07-03', imported_payee: 'same shop' }),
      transaction('legacy', { imported_id: 'old-unscoped-bank-id', date: '2026-07-04' }),
      transaction('missing-payee', { payee: null, date: '2026-07-05' }),
      transaction('uncategorized', { category: null, date: '2026-07-06' }),
    ],
  };
  const before = structuredClone(snapshot);

  const report = auditTransactions(snapshot, registry);

  assert.deepEqual(snapshot, before);
  assert.deepEqual(report.counts, {
    duplicate_imported_ids: 1,
    fuzzy_candidates: 1,
    legacy_id_schemes: 3,
    missing_payees: 1,
    uncategorized: 1,
  });
  assert.deepEqual(report.duplicate_imported_ids[0].transactions.map((t) => t.id), ['duplicate-a', 'duplicate-b']);
  assert.deepEqual(report.fuzzy_candidates[0].transactions.map((t) => t.id), ['fuzzy-a', 'fuzzy-b']);
  assert.deepEqual(report.legacy_id_schemes.map((t) => t.id), ['duplicate-a', 'duplicate-b', 'legacy']);
  assert.equal(report.missing_payees[0].id, 'missing-payee');
  assert.equal(report.uncategorized[0].id, 'uncategorized');
  assert.deepEqual(Object.keys(report.missing_payees[0]).sort(), ['account_id', 'amount', 'date', 'id', 'imported_id']);
  assert.doesNotMatch(JSON.stringify(report), /private note/u);
  assert.doesNotMatch(JSON.stringify(report), /same shop|match_key/iu);
});

test('human output includes group counts and exact transaction IDs', () => {
  const report = auditTransactions({
    transactions: [
      transaction('one', { imported_id: 'repeat' }),
      transaction('two', { imported_id: 'repeat' }),
    ],
  }, registry);

  const output = renderHuman(report);

  assert.match(output, /Duplicate imported IDs: 1 group/u);
  assert.match(output, /one/u);
  assert.match(output, /two/u);
});

test('does not flag legacy IDs on disabled manual-actual accounts, but still flags enabled importer accounts', () => {
  const mixedRegistry = [
    {
      actual_account_id: 'm1',
      source: 'manual-actual',
      source_account: 'triodos-giro',
      enabled: false,
    },
    {
      actual_account_id: 'account-1',
      source: 'fints-umwelt',
      source_account: 'umwelt-giro',
      enabled: true,
    },
  ];

  const report = auditTransactions({
    transactions: [
      transaction('manual', { account: 'm1', imported_id: 'arbitrary-pre-cutover-id' }),
      transaction('legacy', { imported_id: 'old-unscoped-bank-id' }),
    ],
  }, mixedRegistry);

  assert.deepEqual(report.legacy_id_schemes.map((t) => t.id), ['legacy']);
});

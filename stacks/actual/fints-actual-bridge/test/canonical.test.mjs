import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalImportedId, toActualTransaction } from '../src/importer/canonical.mjs';

test('canonical ID is stable and namespaced', () => {
  assert.equal(canonicalImportedId({ source: 'fints-umwelt', sourceAccount: 'card-1', sourceTransactionId: 'CARD-001' }), 'fints-umwelt:card-1:CARD-001');
});

test('missing bank identity is rejected', () => {
  assert.throws(() => canonicalImportedId({ source: 'fints-umwelt', sourceAccount: 'card-1', sourceTransactionId: '' }), /sourceTransactionId/);
});

test('transaction conversion preserves bank data and canonicalizes identity', () => {
  assert.deepEqual(toActualTransaction({
    source: 'fints umwelt',
    sourceAccount: 'card:1',
    transaction: {
      date: '2026-07-08',
      amount_cents: -2690,
      imported_id: 'CARD/001',
      notes: 'REWE TESTMARKT DEU Berlin EUR 26,90 Umsatz vom 08.07.2026 MC Hauptkarte',
      status: 'BOOK',
    },
  }), {
    date: '2026-07-08',
    amount: -2690,
    payee_name: 'REWE TESTMARKT',
    imported_payee: 'REWE TESTMARKT DEU Berlin EUR 26,90 Umsatz vom 08.07.2026 MC Hauptkarte',
    notes: 'REWE TESTMARKT DEU Berlin EUR 26,90 Umsatz vom 08.07.2026 MC Hauptkarte',
    imported_id: 'fints%20umwelt:card%3A1:CARD%2F001',
    cleared: true,
  });
});

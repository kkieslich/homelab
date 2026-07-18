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
  const actual = toActualTransaction({
    source: 'fints umwelt',
    sourceAccount: 'card:1',
    transaction: {
      date: '2026-07-08',
      amount_cents: -2690,
      imported_id: 'CARD/001',
      notes: 'REWE TESTMARKT DEU Berlin EUR 26,90 Umsatz vom 08.07.2026 MC Hauptkarte',
      status: 'BOOK',
    },
  });
  assert.match(actual.imported_id, /^fints%20umwelt:card%3A1:CARD%2F001~[a-f0-9]{24}$/u);
  delete actual.imported_id;
  assert.deepEqual(actual, {
    date: '2026-07-08',
    amount: -2690,
    payee_name: 'REWE TESTMARKT',
    imported_payee: 'REWE TESTMARKT DEU Berlin EUR 26,90 Umsatz vom 08.07.2026 MC Hauptkarte',
    notes: 'REWE TESTMARKT DEU Berlin EUR 26,90 Umsatz vom 08.07.2026 MC Hauptkarte',
    cleared: true,
  });
});

test('reused bank references get deterministic content-qualified identities', () => {
  const transactions = Array.from({ length: 9 }, (_, index) => ({
    date: '2026-07-08', value_date: '2026-07-09', amount_cents: -(1000 + index),
    imported_id: 'STARTUMS', payee_name: `Merchant ${index}`, notes: `Purchase ${index}`,
    currency: 'EUR', status: 'BOOK',
  }));
  const ids = transactions.map((transaction) => toActualTransaction({
    source: 'fints-baader', sourceAccount: 'cash', transaction,
  }).imported_id);
  const refetched = transactions.map((transaction) => toActualTransaction({
    source: 'fints-baader', sourceAccount: 'cash', transaction: structuredClone(transaction),
  }).imported_id);

  assert.equal(new Set(ids).size, 9);
  assert.deepEqual(refetched, ids);
  assert.ok(ids.every((id) => id.includes('STARTUMS')));
});

test('same-day equal-amount purchases remain distinct when stable bank content differs', () => {
  const base = {
    date: '2026-07-08', value_date: '2026-07-09', amount_cents: -1299,
    imported_id: 'STARTUMS', payee_name: 'Cafe', currency: 'EUR', status: 'BOOK',
  };
  const first = toActualTransaction({ source: 'fints-baader', sourceAccount: 'cash', transaction: { ...base, notes: 'Terminal 123' } });
  const second = toActualTransaction({ source: 'fints-baader', sourceAccount: 'cash', transaction: { ...base, notes: 'Terminal 987' } });
  assert.notEqual(first.imported_id, second.imported_id);
});

test('booking status transition keeps the same identity', () => {
  const transaction = {
    date: '2026-07-08', value_date: '2026-07-09', amount_cents: -1299,
    imported_id: 'REF-123', payee_name: 'Cafe', notes: 'Terminal 123', currency: 'EUR',
  };
  const pending = toActualTransaction({
    source: 'fints-umwelt', sourceAccount: 'card', transaction: { ...transaction, status: 'PDNG' },
  });
  const booked = toActualTransaction({
    source: 'fints-umwelt', sourceAccount: 'card', transaction: { ...transaction, status: 'BOOK' },
  });
  assert.equal(pending.imported_id, booked.imported_id);
  assert.equal(pending.cleared, false);
  assert.equal(booked.cleared, true);
});

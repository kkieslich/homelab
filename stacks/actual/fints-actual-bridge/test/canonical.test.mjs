import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalImportedId, isWeakSourceReference, toActualTransaction } from '../src/importer/canonical.mjs';

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
  assert.equal(actual.imported_id, 'fints%20umwelt:card%3A1:CARD%2F001');
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

test('strong bank reference remains primary when lifecycle metadata changes', () => {
  const pending = toActualTransaction({
    source: 'fints-umwelt', sourceAccount: 'card', transaction: {
      date: '2026-07-08', value_date: '2026-07-08', amount_cents: -1299,
      imported_id: 'STRONG-REF-123', account_servicer_ref: 'TEMP-REF',
      payee_name: 'Pending card purchase', notes: 'Pending', currency: 'EUR', status: 'PDNG',
    },
  });
  const booked = toActualTransaction({
    source: 'fints-umwelt', sourceAccount: 'card', transaction: {
      date: '2026-07-08', value_date: '2026-07-10', amount_cents: -1299,
      imported_id: 'STRONG-REF-123', account_servicer_ref: 'FINAL-REF',
      payee_name: 'Cafe Berlin', notes: 'Terminal 987', currency: 'EUR', status: 'BOOK',
    },
  });
  assert.equal(pending.imported_id, booked.imported_id);
  assert.equal(booked.imported_id, 'fints-umwelt:card:STRONG-REF-123');
});

test('weak booked identity ignores non-stable value and servicer metadata', () => {
  const base = {
    date: '2026-07-08', amount_cents: -1299, imported_id: 'STARTUMS',
    payee_name: 'Cafe Berlin', notes: 'Terminal 987', currency: 'EUR', status: 'BOOK',
  };
  const first = toActualTransaction({
    source: 'fints-baader', sourceAccount: 'cash', transaction: {
      ...base, value_date: '2026-07-09', account_servicer_ref: 'STARTUMS',
    },
  });
  const refetched = toActualTransaction({
    source: 'fints-baader', sourceAccount: 'cash', transaction: {
      ...base, value_date: '2026-07-11', account_servicer_ref: 'NEW-METADATA',
    },
  });
  assert.equal(first.imported_id, refetched.imported_id);
});

test('two genuinely identical weak-reference transactions fingerprint to the same canonical ID (collision by design; disambiguation is import.mjs\'s job)', () => {
  const transactionA = {
    date: '2026-07-08', amount_cents: -250, imported_id: 'NONREF',
    payee_name: 'Ticket Kiosk', notes: 'Ticket Kiosk', currency: 'EUR', status: 'BOOK',
  };
  const transactionB = structuredClone(transactionA);
  const first = toActualTransaction({ source: 'fints-baader', sourceAccount: 'cash', transaction: transactionA });
  const second = toActualTransaction({ source: 'fints-baader', sourceAccount: 'cash', transaction: transactionB });
  assert.equal(first.imported_id, second.imported_id);
});

test('synthetic fetch fallback references are weak lifecycle identities', () => {
  assert.equal(isWeakSourceReference('syn_0123456789abcdef01234567'), true);
  assert.equal(isWeakSourceReference('SYN_ABCDEF0123456789ABCDEF01'), true);
  assert.equal(isWeakSourceReference('REAL-BANK-REFERENCE'), false);
  assert.equal(isWeakSourceReference('SYN_VALID_BANK_REFERENCE'), false);
  assert.equal(isWeakSourceReference('syn_x'), false);
  assert.equal(isWeakSourceReference('syn_0123456789abcdef0123456'), false);
  assert.equal(isWeakSourceReference('syn_0123456789abcdef012345678'), false);
  assert.equal(isWeakSourceReference('syn_0123456789abcdef0123456g'), false);
});

test('audit-style since validation never throws on regex-passing garbage', async () => {
  const { isIsoDay } = await import('../src/importer/text.mjs');
  assert.equal(isIsoDay('2024-13-01'), false);
  assert.equal(isIsoDay('2024-02-30'), false);
  assert.equal(isIsoDay('2024-02-29'), true);
});

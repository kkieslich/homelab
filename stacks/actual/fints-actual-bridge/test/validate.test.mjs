import assert from 'node:assert/strict';
import test from 'node:test';

import { validateBatch } from '../src/importer/validate.mjs';
import { duplicateCandidateKey } from '../src/importer/text.mjs';

test('rejects duplicate imported IDs', () => {
  assert.throws(() => validateBatch([
    { imported_id: 's:a:1', date: '2026-07-01', amount: -100 },
    { imported_id: 's:a:1', date: '2026-07-01', amount: -100 },
  ], { previousCount: 2 }), /duplicate imported_id/i);
});

test('reports distinct same-day purchases as a fuzzy duplicate candidate without removing them', () => {
  const records = [
    { imported_id: 's:a:1', date: '2026-07-01', amount: -1000, imported_payee: ' SHOP ' },
    { imported_id: 's:a:2', date: '2026-07-01', amount: -1000, imported_payee: 'shop' },
  ];

  const result = validateBatch(records, { previousCount: 2 });

  assert.equal(result.records.length, 2);
  assert.equal(result.duplicateCandidates.length, 1);
  assert.equal(result.duplicateCandidates[0].key, duplicateCandidateKey({
    date: '2026-07-01', amountCents: -1000, payeeIdentity: 'shop',
  }));
  assert.equal(result.duplicateCandidates[0].records.length, 2);
});

test('rejects records missing an imported ID', () => {
  assert.throws(() => validateBatch([
    { date: '2026-07-01', amount: 100 },
  ], { previousCount: 0 }), /imported_id.*required/i);
});

test('rejects calendar-invalid and non-ISO dates', () => {
  for (const date of ['2026-02-30', '01.07.2026', '2026-7-01']) {
    assert.throws(() => validateBatch([
      { imported_id: `s:a:${date}`, date, amount: 100 },
    ], { previousCount: 0 }), /invalid ISO date/i);
  }
});

test('rejects non-integer amounts', () => {
  assert.throws(() => validateBatch([
    { imported_id: 's:a:1', date: '2026-07-01', amount: 1.5 },
  ], { previousCount: 0 }), /amount.*integer/i);
});

test('rejects an unexpectedly empty batch', () => {
  assert.throws(() => validateBatch([], { previousCount: 1 }), /empty batch/i);
});

test('an unexpectedly empty batch error carries a typed code', () => {
  assert.throws(() => validateBatch([], { previousCount: 1 }), (error) => {
    assert.equal(error.code, 'EMPTY_BATCH');
    return true;
  });
});

test('allows an empty first batch and returns the result contract', () => {
  assert.deepEqual(validateBatch([], { previousCount: 0 }), {
    records: [],
    duplicateCandidates: [],
    warnings: [],
  });
});

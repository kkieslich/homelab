import assert from 'node:assert/strict';
import test from 'node:test';

import { validateOwnership } from '../src/importer/registry.mjs';

test('rejects multiple enabled importers for one Actual account', () => {
  assert.throws(() => validateOwnership([
    { actual_account_id: 'a1', source: 'fints-a', enabled: true },
    { actual_account_id: 'a1', source: 'fints-b', enabled: true },
  ]), /multiple enabled importers.*a1/i);
});

test('returns all ownership entries keyed by Actual account ID', () => {
  const disabled = { actual_account_id: 'a1', source: 'legacy', enabled: false };
  const enabled = { actual_account_id: 'a2', source: 'fints', enabled: true };

  const ownership = validateOwnership([disabled, enabled]);

  assert.deepEqual([...ownership], [['a1', disabled], ['a2', enabled]]);
});

test('rejects registry entries without an Actual account ID', () => {
  assert.throws(() => validateOwnership([
    { source: 'fints', enabled: true },
  ]), /actual_account_id.*required/i);
});

test('keeps the enabled owner when a disabled legacy importer is also listed', () => {
  const enabled = { actual_account_id: 'a1', source: 'fints', enabled: true };
  const disabled = { actual_account_id: 'a1', source: 'legacy', enabled: false };

  assert.equal(validateOwnership([enabled, disabled]).get('a1'), enabled);
});

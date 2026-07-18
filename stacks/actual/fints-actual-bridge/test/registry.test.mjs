import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('the production ownership registry defines all seven accounts without bank identifiers', async () => {
  const registryUrl = new URL('../../cli/config/accounts.json', import.meta.url);
  const raw = await readFile(registryUrl, 'utf8');
  const entries = JSON.parse(raw);

  assert.equal(entries.length, 7);
  assert.equal(validateOwnership(entries).size, 7);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), [
      'actual_account_id',
      'display_name',
      'enabled',
      'expected_cadence_seconds',
      'interactive_auth',
      'role',
      'source',
      'source_account',
    ]);
    assert.ok(Number.isInteger(entry.expected_cadence_seconds));
    assert.ok(entry.expected_cadence_seconds > 0);
  }
  assert.doesNotMatch(raw, /iban|credential|password|accountnumber/i);
});

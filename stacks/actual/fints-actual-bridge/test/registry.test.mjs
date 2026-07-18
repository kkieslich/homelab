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
    const expectedKeys = [
      'actual_account_id',
      'display_name',
      'enabled',
      'interactive_auth',
      'role',
      'source',
      'source_account',
    ];
    if (entry.enabled) expectedKeys.push('expected_cadence_seconds');
    assert.deepEqual(Object.keys(entry).sort(), expectedKeys.sort());
    if (entry.enabled) {
      assert.ok(Number.isInteger(entry.expected_cadence_seconds));
      assert.ok(entry.expected_cadence_seconds > 0);
    }
  }
  assert.doesNotMatch(raw, /iban|credential|password|accountnumber/i);

  const legacyIds = new Set([
    '964fd294-b9c2-48a6-81ba-74f0d7470a29',
    'd4ac8e5b-d0d3-43e9-ac05-29ff6c0f2e93',
    'e2e7ab6d-e53d-416b-a56c-58f30d421160',
  ]);
  for (const entry of entries.filter(({ actual_account_id }) => legacyIds.has(actual_account_id))) {
    assert.equal(entry.enabled, false);
    assert.equal('expected_cadence_seconds' in entry, false);
  }
});

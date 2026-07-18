import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const configUrl = new URL('../config/category-groups.json', import.meta.url);

const expectedGroups = new Map([
  ['fixed_obligation', 'Fixed obligations'],
  ['flexible_essential', 'Flexible essentials'],
  ['discretionary', 'Discretionary'],
  ['sinking_fund', 'Sinking funds'],
  ['savings_investing', 'Savings and investing'],
  ['income', 'Income'],
]);

async function loadConfig() {
  return JSON.parse(await readFile(configUrl, 'utf8'));
}

test('category group contract contains exactly the six supported roles', async () => {
  const config = await loadConfig();
  const actual = new Map(config.groups.map(({ role, name }) => [role, name]));

  assert.deepEqual(actual, expectedGroups);
  assert.equal(config.groups.length, expectedGroups.size);
});

test('category group contract contains no duplicate roles or names', async () => {
  const { groups } = await loadConfig();
  const roles = groups.map(({ role }) => role);
  const names = groups.map(({ name }) => name);

  assert.equal(new Set(roles).size, roles.length);
  assert.equal(new Set(names).size, names.length);
});

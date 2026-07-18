import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('card fixture contains no real banking data', async () => {
  const text = await readFile(new URL('./fixtures/card-transactions.json', import.meta.url), 'utf8');
  const fixture = JSON.parse(text);
  assert.equal(fixture.bank.key, 'fixture-bank');
  assert.equal(fixture.accounts[0].iban, 'DE00000000000000000000');
  assert.ok(fixture.accounts[0].transactions.length >= 3);
});

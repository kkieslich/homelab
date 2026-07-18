import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runImport } from '../bin/import.mjs';

const config = {
  banks: {
    fixture: {
      accounts: [{ iban: 'SECRET-IBAN', actual_account_id: 'actual-account-1' }],
    },
  },
};
const registry = [{
  actual_account_id: 'actual-account-1',
  source: 'fints-fixture',
  source_account: 'fixture-cash',
  enabled: true,
}];
const transaction = {
  date: '2026-07-01', amount_cents: -1234, payee_name: 'PRIVATE PAYEE',
  notes: 'PRIVATE NOTE', imported_id: 'bank-id-1', status: 'BOOK',
};
const payload = {
  bank: { key: 'fixture' },
  requested_range: { from: '2026-06-01', to: '2026-07-01' },
  accounts: [{ iban: 'SECRET-IBAN', transactions: [transaction] }],
};

async function manifestsIn(directory) {
  const names = await readdir(directory);
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))));
}

test('imports a validated canonical batch with deleted-record protection', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  const calls = [];
  const fakeActual = {
    async importTransactions(...args) {
      calls.push(args);
      return { added: ['one'], updated: [] };
    },
  };

  await runImport({
    payload, config, registry, actualApi: fakeActual, manifestDir, dryRun: false,
    now: () => new Date('2026-07-18T10:00:00.000Z'),
  });

  assert.deepEqual(calls, [[
    'actual-account-1',
    [{
      date: '2026-07-01', amount: -1234, payee_name: 'PRIVATE PAYEE',
      imported_payee: 'PRIVATE NOTE', notes: 'PRIVATE NOTE',
      imported_id: 'fints-fixture:fixture-cash:bank-id-1', cleared: true,
    }],
    { reimportDeleted: false },
  ]]);
  const [manifest] = await manifestsIn(manifestDir);
  assert.equal(manifest.outcome, 'success');
  assert.deepEqual(manifest.accounts, [{
    actual_account_id: 'actual-account-1', fetched: 1, valid: 1,
    added: 1, updated: 0, quarantined: 0,
  }]);
});

test('validation failure makes no API calls and writes no sensitive fields', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  let calls = 0;
  const invalid = structuredClone(payload);
  invalid.requested_range.secret = 'PRIVATE RANGE NOTE';
  invalid.accounts[0].transactions.push({ ...transaction, payee_name: 'ANOTHER SECRET' });

  await assert.rejects(() => runImport({
    payload: invalid, config, registry,
    actualApi: { async importTransactions() { calls += 1; } },
    manifestDir, dryRun: false,
    now: () => new Date('2026-07-18T10:00:00.000Z'),
  }), /validation failed/i);

  assert.equal(calls, 0);
  const [manifest] = await manifestsIn(manifestDir);
  assert.equal(manifest.outcome, 'failed');
  assert.equal(manifest.error_code, 'VALIDATION_FAILED');
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /PRIVATE|SECRET|PAYEE|NOTE|IBAN|bank-id/i);
});

test('API errors are reduced to a controlled error code', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  await assert.rejects(() => runImport({
    payload, config, registry,
    actualApi: { async importTransactions() { throw new Error('PRIVATE NOTE request body'); } },
    manifestDir, dryRun: false,
    now: () => new Date('2026-07-18T10:00:00.000Z'),
  }), /Actual import failed/);
  const [manifest] = await manifestsIn(manifestDir);
  assert.equal(manifest.error_code, 'ACTUAL_IMPORT_FAILED');
  assert.doesNotMatch(JSON.stringify(manifest), /PRIVATE|request body/i);
});

test('dry run validates and records counts without calling Actual', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  let calls = 0;
  const result = await runImport({
    payload, config, registry,
    actualApi: { async importTransactions() { calls += 1; } },
    manifestDir, dryRun: true,
    now: () => new Date('2026-07-18T10:00:00.000Z'),
  });
  assert.equal(calls, 0);
  assert.equal(result.outcome, 'dry_run');
});

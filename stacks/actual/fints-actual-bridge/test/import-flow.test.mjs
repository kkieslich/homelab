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

test('sanitizes malicious requested range strings in success and failure manifests', async () => {
  for (const shouldFail of [false, true]) {
    const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
    const malicious = structuredClone(payload);
    malicious.requested_range = { from: '2026-07-01 PIN=1234', to: 'IBAN PRIVATE PAYEE' };
    if (shouldFail) malicious.accounts[0].transactions.push({ ...transaction });
    await runImport({
      payload: malicious, config, registry,
      actualApi: { async importTransactions() { return { added: [], updated: [] }; } },
      manifestDir, dryRun: false,
      now: () => new Date('2026-07-18T10:00:00.000Z'),
    }).catch(() => {});
    const [manifest] = await manifestsIn(manifestDir);
    assert.deepEqual(manifest.requested_range, { from: null, to: null });
    assert.doesNotMatch(JSON.stringify(manifest), /PIN|IBAN|PRIVATE|PAYEE|1234/i);
  }
});

test('records the real daemon banks window in the manifest', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  const daemonPayload = {
    fetched_at: '2026-07-18T10:00:00Z',
    banks: [{
      bank: { key: 'fixture' },
      window: { start: '2026-06-18', end: '2026-07-18' },
      accounts: [{ iban: 'SECRET-IBAN', transactions: [transaction] }],
    }],
  };
  const manifest = await runImport({
    payload: daemonPayload, config, registry,
    actualApi: { importTransactions: async () => ({ added: [], updated: [] }) },
    manifestDir,
  });
  assert.deepEqual(manifest.requested_range, { from: '2026-06-18', to: '2026-07-18' });
});

test('rejects conflicting daemon bank windows before calling Actual', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  let calls = 0;
  const conflicting = {
    banks: [
      { bank: { key: 'fixture' }, window: { start: '2026-06-18', end: '2026-07-18' }, accounts: [{ iban: 'SECRET-IBAN', transactions: [transaction] }] },
      { bank: { key: 'fixture' }, window: { start: '2026-06-17', end: '2026-07-18' }, accounts: [{ iban: 'SECRET-IBAN', transactions: [transaction] }] },
    ],
  };
  await assert.rejects(() => runImport({
    payload: conflicting, config, registry,
    actualApi: { importTransactions: async () => { calls += 1; return {}; } },
    manifestDir,
  }), /validation failed/i);
  assert.equal(calls, 0);
  const [manifest] = await manifestsIn(manifestDir);
  assert.equal(manifest.outcome, 'failed');
  assert.equal(manifest.error_code, 'VALIDATION_FAILED');
  assert.deepEqual(manifest.requested_range, { from: null, to: null });
});

test('keeps a missing single-bank window privacy-safe and explicit', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  const missing = { banks: [{ bank: { key: 'fixture' }, accounts: [{ iban: 'SECRET-IBAN', transactions: [transaction] }] }] };
  const manifest = await runImport({
    payload: missing, config, registry,
    actualApi: { importTransactions: async () => ({ added: [], updated: [] }) },
    manifestDir,
  });
  assert.deepEqual(manifest.requested_range, { from: null, to: null });
});

test('rejects a missing window in a multi-bank daemon payload', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  const ambiguous = {
    banks: [
      { bank: { key: 'fixture' }, window: { start: '2026-06-18', end: '2026-07-18' }, accounts: [] },
      { bank: { key: 'fixture' }, accounts: [] },
    ],
  };
  await assert.rejects(() => runImport({
    payload: ambiguous, config, registry, actualApi: {}, manifestDir,
  }), /validation failed/i);
  const [manifest] = await manifestsIn(manifestDir);
  assert.deepEqual(manifest.requested_range, { from: null, to: null });
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

test('seed balance prepends the stable canonical opening balance transaction', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  const seeded = structuredClone(payload);
  seeded.accounts[0].balances = [{ type: 'OPBD', date: '2026-07-01', amount_cents: 5000, currency: 'EUR' }];
  let records;
  await runImport({
    payload: seeded, config, registry,
    actualApi: { async importTransactions(_id, value) { records = value; return {}; } },
    manifestDir, seedBalance: true,
    now: () => new Date('2026-07-18T10:00:00.000Z'),
  });
  assert.deepEqual(records[0], {
    date: '2026-06-30', amount: 5000, payee_name: 'Opening Balance',
    imported_payee: 'Opening Balance',
    notes: 'Seeded from camt.052 OPBD 2026-07-01 50.00 EUR',
    imported_id: 'fints-fixture:fixture-cash:fints-bridge-opening-balance-actual-account-1',
    cleared: true,
  });
});

test('dry run emits canonical transaction JSON through the injected output', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  const output = [];
  await runImport({
    payload, config, registry, actualApi: {}, manifestDir, dryRun: true,
    output: (value) => output.push(value),
    now: () => new Date('2026-07-18T10:00:00.000Z'),
  });
  const parsed = JSON.parse(output.join(''));
  assert.equal(parsed['actual-account-1'][0].imported_id, 'fints-fixture:fixture-cash:bank-id-1');
  assert.equal(parsed['actual-account-1'][0].notes, 'PRIVATE NOTE');
});

test('restores depot revaluation and holdings persistence', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'import-state-'));
  const depotPayload = {
    bank: { key: 'fixture' },
    accounts: [{ iban: 'DEPOT-ID', type: 'depot', holdings: [{ total_value_cents: 15000, isin: 'TEST' }] }],
  };
  const depotConfig = { banks: { fixture: { accounts: [{ iban: 'DEPOT-ID', actual_account_id: 'depot-1' }] } } };
  const depotRegistry = [{ actual_account_id: 'depot-1', source: 'fints-fixture', source_account: 'fixture-depot', enabled: true }];
  const calls = [];
  const fakeActual = {
    async getTransactions(...args) { calls.push(['get', ...args]); return [{ id: 'old', imported_id: 'fints-bridge-depot-revaluation-old', amount: 2000 }, { amount: 1000 }]; },
    async deleteTransaction(id) { calls.push(['delete', id]); },
    async importTransactions(...args) { calls.push(['import', ...args]); return { added: ['new'], updated: [] }; },
  };
  await runImport({
    payload: depotPayload, config: depotConfig, registry: depotRegistry,
    actualApi: fakeActual, manifestDir, stateDir,
    now: () => new Date('2026-07-18T10:00:00.000Z'),
  });
  assert.deepEqual(calls[0], ['get', 'depot-1', '1900-01-01', '2100-01-01']);
  assert.deepEqual(calls[1], ['delete', 'old']);
  assert.equal(calls[2][0], 'import');
  assert.equal(calls[2][1], 'depot-1');
  assert.equal(calls[2][2][0].amount, 14000);
  assert.deepEqual(calls[2][3], { reimportDeleted: false });
  const holdings = JSON.parse(await readFile(join(stateDir, 'holdings.json'), 'utf8'));
  assert.equal(holdings.holdings[0].isin, 'TEST');
  assert.equal(holdings.holdings[0].depot_actual_account_id, 'depot-1');
});

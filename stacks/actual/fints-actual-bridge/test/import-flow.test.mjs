import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runImport } from '../bin/import.mjs';
import { toActualTransaction } from '../src/importer/canonical.mjs';

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

  const expected = toActualForTest(transaction);
  assert.deepEqual(calls, [[
    'actual-account-1',
    [expected],
    { reimportDeleted: false },
  ]]);
  const [manifest] = await manifestsIn(manifestDir);
  assert.equal(manifest.outcome, 'success');
  assert.deepEqual(manifest.accounts, [{
    actual_account_id: 'actual-account-1', fetched: 1, valid: 1,
    added: 1, updated: 0, quarantined: 0,
  }]);
});

test('rejects and sanitizes invalid explicit requested range strings', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  const malicious = structuredClone(payload);
  malicious.requested_range = { from: '2026-07-01 PIN=1234', to: 'IBAN PRIVATE PAYEE' };
  let calls = 0;
  await assert.rejects(() => runImport({
    payload: malicious, config, registry,
    actualApi: { async importTransactions() { calls += 1; return {}; } },
    manifestDir,
  }), /validation failed/i);
  assert.equal(calls, 0);
  const [manifest] = await manifestsIn(manifestDir);
  assert.deepEqual(manifest.requested_range, { from: null, to: null });
  assert.doesNotMatch(JSON.stringify(manifest), /PIN|IBAN|PRIVATE|PAYEE|1234/i);
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

test('rejects missing, incomplete, and invalid single banks windows before Actual', async () => {
  for (const window of [undefined, { start: '2026-06-18' }, { start: 'not-a-date', end: '2026-07-18' }]) {
    const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
    let calls = 0;
    const missing = { banks: [{ bank: { key: 'fixture' }, window, accounts: [{ iban: 'SECRET-IBAN', transactions: [transaction] }] }] };
    await assert.rejects(() => runImport({
      payload: missing, config, registry,
      actualApi: { importTransactions: async () => { calls += 1; return {}; } },
      manifestDir,
    }), /validation failed/i);
    assert.equal(calls, 0);
    const [manifest] = await manifestsIn(manifestDir);
    assert.deepEqual(manifest.requested_range, { from: null, to: null });
  }
});

test('rejects partial or invalid explicit ranges even with a valid nested window', async () => {
  for (const requestedRange of [
    { from: '2026-06-18' },
    { from: 'invalid', to: '2026-07-18' },
  ]) {
    const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
    let calls = 0;
    const ambiguous = {
      requested_range: requestedRange,
      banks: [{
        bank: { key: 'fixture' },
        window: { start: '2026-06-18', end: '2026-07-18' },
        accounts: [{ iban: 'SECRET-IBAN', transactions: [transaction] }],
      }],
    };
    await assert.rejects(() => runImport({
      payload: ambiguous, config, registry,
      actualApi: { importTransactions: async () => { calls += 1; return {}; } },
      manifestDir,
    }), /validation failed/i);
    assert.equal(calls, 0);
    const [manifest] = await manifestsIn(manifestDir);
    assert.deepEqual(manifest.requested_range, { from: null, to: null });
  }
});

test('allows a clearly legacy non-banks payload without a range', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  const legacy = { bank: { key: 'fixture' }, accounts: [{ iban: 'SECRET-IBAN', transactions: [transaction] }] };
  const manifest = await runImport({
    payload: legacy, config, registry,
    actualApi: { importTransactions: async () => ({ added: [], updated: [] }) },
    manifestDir,
  });
  assert.equal(manifest.outcome, 'success');
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
  invalid.accounts[0].transactions.push({ ...transaction });

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
  assert.match(records[0].imported_id, /^fints-fixture:fixture-cash:fints-bridge-opening-balance-actual-account-1~[a-f0-9]{24}$/u);
  delete records[0].imported_id;
  assert.deepEqual(records[0], {
    date: '2026-06-30', amount: 5000, payee_name: 'Opening Balance',
    imported_payee: 'Opening Balance',
    notes: 'Seeded from camt.052 OPBD 2026-07-01 50.00 EUR',
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
  assert.equal(parsed['actual-account-1'][0].imported_id, toActualForTest(transaction).imported_id);
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
    async updateTransaction(...args) { calls.push(['update', ...args]); return []; },
    async importTransactions(...args) { calls.push(['import', ...args]); return { added: ['new'], updated: [] }; },
  };
  await runImport({
    payload: depotPayload, config: depotConfig, registry: depotRegistry,
    actualApi: fakeActual, manifestDir, stateDir,
    now: () => new Date('2026-07-18T10:00:00.000Z'),
  });
  assert.deepEqual(calls[0], ['get', 'depot-1', '1900-01-01', '2100-01-01']);
  assert.equal(calls[1][0], 'update');
  assert.equal(calls[1][1], 'old');
  assert.equal(calls[1][2].amount, 14000);
  assert.equal(calls[1][2].imported_id, 'fints-bridge-depot-revaluation-depot-1');
  const holdings = JSON.parse(await readFile(join(stateDir, 'holdings.json'), 'utf8'));
  assert.equal(holdings.holdings[0].isin, 'TEST');
  assert.equal(holdings.holdings[0].depot_actual_account_id, 'depot-1');
});

function depotSetup() {
  return {
    payload: { bank: { key: 'fixture' }, accounts: [{
      iban: 'DEPOT-ID', type: 'depot', holdings: [{ total_value_cents: 15000, isin: 'TEST' }],
    }] },
    config: { banks: { fixture: { accounts: [{ iban: 'DEPOT-ID', actual_account_id: 'depot-1' }] } } },
    registry: [{ actual_account_id: 'depot-1', source: 'fints-fixture', source_account: 'fixture-depot', enabled: true }],
  };
}

test('depot revaluation is non-destructive and idempotent across sequential cycles', async () => {
  const setup = depotSetup();
  const transactions = [{ id: 'base', imported_id: 'bank-transfer', amount: 1000 }];
  let nextId = 1;
  const calls = [];
  const actualApi = {
    async getTransactions() { return structuredClone(transactions); },
    async importTransactions(_account, records, options) {
      calls.push(['import', structuredClone(records), options]);
      for (const record of records) {
        const found = transactions.find((tx) => tx.imported_id === record.imported_id);
        if (found) Object.assign(found, record);
        else transactions.push({ id: `new-${nextId++}`, ...record });
      }
      return { added: ['ok'], updated: [] };
    },
    async updateTransaction(id, fields) {
      calls.push(['update', id, structuredClone(fields)]);
      Object.assign(transactions.find((tx) => tx.id === id), fields);
      return [];
    },
    async deleteTransaction(id) { calls.push(['delete', id]); throw new Error('must not delete'); },
  };

  for (let cycle = 0; cycle < 2; cycle += 1) {
    await runImport({ ...setup, actualApi, manifestDir: await mkdtemp(join(tmpdir(), 'import-flow-')), now: () => new Date('2026-07-18T10:00:00Z') });
  }

  const valuations = transactions.filter((tx) => tx.imported_id?.startsWith('fints-bridge-depot-revaluation-'));
  assert.equal(valuations.length, 1);
  assert.equal(valuations[0].amount, 14000);
  assert.equal(transactions.reduce((sum, tx) => sum + tx.amount, 0), 15000);
  assert.equal(calls.filter(([kind]) => kind === 'delete').length, 0);
  assert.equal(calls.filter(([kind]) => kind === 'import').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'update').length, 1);
});

test('failed depot update retains the previous valid valuation and never deletes it', async () => {
  const setup = depotSetup();
  const transactions = [
    { id: 'base', imported_id: 'bank-transfer', amount: 1000 },
    { id: 'valuation', imported_id: 'fints-bridge-depot-revaluation-depot-1', amount: 9000 },
  ];
  const calls = [];
  const actualApi = {
    async getTransactions() { return structuredClone(transactions); },
    async updateTransaction() { calls.push('update'); throw new Error('injected update failure'); },
    async importTransactions() { calls.push('import'); return {}; },
    async deleteTransaction() { calls.push('delete'); },
  };
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  await assert.rejects(() => runImport({
    ...setup, actualApi, manifestDir,
    now: () => new Date('2026-07-18T10:00:00Z'),
  }), /Actual import failed/);
  assert.deepEqual(calls, ['update']);
  assert.equal(transactions.reduce((sum, tx) => sum + tx.amount, 0), 10000);
  assert.equal(transactions.find((tx) => tx.id === 'valuation').amount, 9000);
});

test('reconciles one legacy transaction to its canonical ID before importing', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  const canonical = toActualForTest(transaction);
  const calls = [];
  const actualApi = {
    async getTransactions() { return [{
      id: 'legacy-1', imported_id: transaction.imported_id, date: transaction.date,
      amount: transaction.amount_cents, imported_payee: transaction.notes, notes: transaction.notes,
    }]; },
    async updateTransaction(id, fields) { calls.push(['update', id, fields]); },
    async importTransactions(account, records, options) { calls.push(['import', account, records, options]); return { added: [], updated: ['legacy-1'] }; },
  };
  await runImport({ payload, config, registry, actualApi, manifestDir });
  assert.deepEqual(calls[0], ['update', 'legacy-1', { imported_id: canonical.imported_id }]);
  assert.equal(calls[1][0], 'import');
  assert.deepEqual(calls[1][3], { reimportDeleted: false });
});

test('ambiguous legacy reconciliation fails closed with quarantine and zero writes', async () => {
  const manifestDir = await mkdtemp(join(tmpdir(), 'import-flow-'));
  const legacy = {
    imported_id: transaction.imported_id, date: transaction.date,
    amount: transaction.amount_cents, imported_payee: transaction.notes, notes: transaction.notes,
  };
  const writes = [];
  await assert.rejects(() => runImport({
    payload, config, registry, manifestDir,
    actualApi: {
      async getTransactions() { return [{ id: 'legacy-1', ...legacy }, { id: 'legacy-2', ...legacy }]; },
      async updateTransaction(...args) { writes.push(['update', ...args]); },
      async importTransactions(...args) { writes.push(['import', ...args]); },
    },
  }), /validation failed/i);
  assert.deepEqual(writes, []);
  const [manifest] = await manifestsIn(manifestDir);
  assert.equal(manifest.accounts[0].quarantined, 1);
  assert.equal(manifest.error_code, 'VALIDATION_FAILED');
});

test('nine reused references import once and a repeated fetch performs no duplicate adds', async () => {
  const repeated = Array.from({ length: 9 }, (_, index) => ({
    date: '2026-07-01', value_date: '2026-07-02', amount_cents: -(1000 + index),
    payee_name: `Merchant ${index}`, notes: `Terminal ${index}`,
    imported_id: 'STARTUMS', currency: 'EUR', status: 'BOOK',
  }));
  const repeatedPayload = structuredClone(payload);
  repeatedPayload.accounts[0].transactions = repeated;
  const stored = [];
  let added = 0;
  const actualApi = {
    async getTransactions() { return structuredClone(stored); },
    async updateTransaction() { throw new Error('unexpected migration'); },
    async importTransactions(_account, records, options) {
      assert.deepEqual(options, { reimportDeleted: false });
      const newlyAdded = [];
      for (const record of records) {
        if (!stored.some((existing) => existing.imported_id === record.imported_id)) {
          stored.push({ id: `stored-${stored.length}`, ...record });
          newlyAdded.push(record.imported_id);
          added += 1;
        }
      }
      return { added: newlyAdded, updated: [] };
    },
  };
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await runImport({
      payload: structuredClone(repeatedPayload), config, registry, actualApi,
      manifestDir: await mkdtemp(join(tmpdir(), 'import-flow-')),
    });
  }
  assert.equal(stored.length, 9);
  assert.equal(new Set(stored.map(({ imported_id: id }) => id)).size, 9);
  assert.equal(added, 9);
});

function toActualForTest(sourceTransaction) {
  return toActualTransaction({ source: 'fints-fixture', sourceAccount: 'fixture-cash', transaction: sourceTransaction });
}

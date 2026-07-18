#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as actual from '@actual-app/api';
import * as toml from 'smol-toml';

import { toActualTransaction } from '../src/importer/canonical.mjs';
import { writeRunManifest } from '../src/importer/manifest.mjs';
import { validateOwnership } from '../src/importer/registry.mjs';
import { validateBatch } from '../src/importer/validate.mjs';

const IMPORTER_VERSION = '0.1.0';

function instant(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function bankPayloads(payload) {
  return payload?.banks ?? (payload?.bank ? [{ bank: payload.bank, accounts: payload.accounts ?? [] }] : []);
}

function accountMapping(config, bankKey, account) {
  return (config?.banks?.[bankKey]?.accounts ?? []).find((candidate) =>
    (account.iban && candidate.iban === account.iban)
    || (account.account_number != null && String(candidate.accountnumber) === String(account.account_number)));
}

function requestedRange(payload) {
  const range = payload.requested_range ?? payload;
  return {
    from: range.from ?? range.start ?? payload.date_from ?? null,
    to: range.to ?? range.end ?? payload.date_to ?? null,
  };
}

function resultCount(result, key) {
  return Array.isArray(result?.[key]) ? result[key].length : 0;
}

export async function runImport({ payload, config, registry, actualApi, manifestDir, dryRun = false, now = () => new Date() }) {
  const runId = randomUUID();
  const startedAt = instant(now);
  const batches = [];
  const accounts = [];
  const sources = new Set();
  let errorCode = null;

  try {
    const ownership = validateOwnership(registry);
    const banks = bankPayloads(payload);
    if (banks.length === 0) throw new Error('empty payload');

    for (const bankPayload of banks) {
      const bankKey = String(bankPayload.bank?.key ?? '').trim();
      if (!bankKey) throw new Error('missing bank key');
      for (const sourceAccount of bankPayload.accounts ?? []) {
        if (sourceAccount.type === 'depot') continue;
        const mapping = accountMapping(config, bankKey, sourceAccount);
        if (!mapping?.actual_account_id) throw new Error('account mapping missing');
        const owner = ownership.get(mapping.actual_account_id);
        if (!owner?.enabled || owner.source !== `fints-${bankKey}`) throw new Error('account ownership mismatch');
        sources.add(owner.source);

        const rawTransactions = sourceAccount.transactions ?? [];
        const records = rawTransactions.map((transaction) => toActualTransaction({
          source: owner.source,
          sourceAccount: owner.source_account,
          transaction,
        }));
        const summary = {
          actual_account_id: mapping.actual_account_id,
          fetched: rawTransactions.length,
          valid: 0,
          added: 0,
          updated: 0,
          quarantined: 0,
        };
        accounts.push(summary);
        const validated = validateBatch(records, { previousCount: rawTransactions.length });
        summary.valid = validated.records.length;
        summary.quarantined = validated.duplicateCandidates.length;
        batches.push({ actualAccountId: mapping.actual_account_id, records: validated.records, summary });
      }
    }

    if (!dryRun) {
      for (const batch of batches) {
        if (batch.records.length === 0) continue;
        let result;
        try {
          result = await actualApi.importTransactions(batch.actualAccountId, batch.records, { reimportDeleted: false });
        } catch {
          errorCode = 'ACTUAL_IMPORT_FAILED';
          throw new Error('Actual import failed');
        }
        batch.summary.added = resultCount(result, 'added');
        batch.summary.updated = resultCount(result, 'updated');
      }
    }

    const manifest = {
      schema_version: 1, run_id: runId,
      source: sources.size === 1 ? [...sources][0] : 'multiple',
      importer_version: IMPORTER_VERSION,
      started_at: startedAt, finished_at: instant(now),
      requested_range: requestedRange(payload), accounts,
      outcome: dryRun ? 'dry_run' : 'success', error_code: null,
    };
    await writeRunManifest(join(manifestDir, `${runId}.json`), manifest);
    return manifest;
  } catch (cause) {
    const manifest = {
      schema_version: 1, run_id: runId,
      source: sources.size === 1 ? [...sources][0] : 'unknown',
      importer_version: IMPORTER_VERSION,
      started_at: startedAt, finished_at: instant(now),
      requested_range: requestedRange(payload ?? {}), accounts,
      outcome: 'failed', error_code: errorCode ?? 'VALIDATION_FAILED',
    };
    await writeRunManifest(join(manifestDir, `${runId}.json`), manifest);
    throw new Error(errorCode ? 'Actual import failed' : 'Import validation failed', { cause });
  }
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  try { process.loadEnvFile('.env'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const args = parseArgs({ options: {
    bank: { type: 'string' }, all: { type: 'boolean', default: false }, in: { type: 'string' },
    config: { type: 'string', default: 'banks.toml' }, registry: { type: 'string', default: 'accounts.json' },
    'manifest-dir': { type: 'string', default: join(process.env.STATE_DIR ?? '.', 'import-runs') },
    'data-dir': { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
    'seed-balance': { type: 'boolean', default: false },
  } }).values;
  if ((!args.bank && !args.all) || (args.bank && args.all)) {
    console.error('Usage: actual-import (--bank <name> | --all) [--in <path>] [--dry-run]');
    process.exitCode = 2;
    return;
  }

  const config = toml.parse(await fs.readFile(args.config, 'utf8'));
  const registry = JSON.parse(await fs.readFile(args.registry, 'utf8'));
  const payload = JSON.parse(args.in ? await fs.readFile(args.in, 'utf8') : await readStdin());
  if (args.bank) {
    const filtered = bankPayloads(payload).filter((item) => item.bank?.key === args.bank);
    if (filtered.length === 0) throw new Error(`Payload contains no entry for bank '${args.bank}'`);
    payload.banks = filtered;
    delete payload.bank;
    delete payload.accounts;
  }

  if (args['dry-run']) {
    await runImport({ payload, config, registry, actualApi: actual, manifestDir: args['manifest-dir'], dryRun: true });
    return;
  }
  const actualConfig = config.actual;
  if (!actualConfig) throw new Error('Missing [actual] section in banks.toml');
  const password = process.env[actualConfig.password_env];
  if (!password) throw new Error(`Missing env var ${actualConfig.password_env} for the Actual server password`);
  const dataDir = args['data-dir'] ?? join(tmpdir(), 'fints-actual-bridge');
  await fs.mkdir(dataDir, { recursive: true });
  await actual.init({ dataDir, serverURL: process.env.ACTUAL_SERVER_URL || actualConfig.server_url, password });
  try {
    const budgetPassword = actualConfig.budget_password_env ? process.env[actualConfig.budget_password_env] : undefined;
    await actual.downloadBudget(actualConfig.sync_id, budgetPassword ? { password: budgetPassword } : undefined);
    await runImport({ payload, config, registry, actualApi: actual, manifestDir: args['manifest-dir'] });
  } finally {
    await actual.shutdown();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

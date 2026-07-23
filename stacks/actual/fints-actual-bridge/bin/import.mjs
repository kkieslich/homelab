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

import { canonicalImportedId, isWeakSourceReference, toActualTransaction } from '../src/importer/canonical.mjs';
import { pruneRunManifests, readRunManifests, writeRunManifest } from '../src/importer/manifest.mjs';
import { validateOwnership } from '../src/importer/registry.mjs';
import { validateBatch } from '../src/importer/validate.mjs';
import { normalizeText as normalized, isIsoDay } from '../src/importer/text.mjs';

const IMPORTER_VERSION = '0.1.0';

// Only codes this importer sets itself may reach a manifest's error_code.
// Foreign codes (e.g. Node fs EACCES/ENOSPC) must not leak into the contract.
const IMPORT_ERROR_CODES = new Set(['ACTUAL_IMPORT_FAILED', 'EMPTY_BATCH_REGRESSION', 'INVALID_TIMEZONE']);

function coded(code, message, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}

function instant(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function financeDay(value, timeZone = process.env.FINANCE_TIMEZONE ?? 'Europe/Berlin') {
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  } catch (error) {
    throw coded('INVALID_TIMEZONE', `Invalid finance timezone: ${timeZone}`, error);
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function bankPayloads(payload) {
  return payload?.banks ?? (payload?.bank ? [{ bank: payload.bank, accounts: payload.accounts ?? [] }] : []);
}

function accountMapping(config, bankKey, account) {
  return (config?.banks?.[bankKey]?.accounts ?? []).find((candidate) =>
    (account.iban && candidate.iban === account.iban)
    || (account.account_number != null && String(candidate.accountnumber) === String(account.account_number)));
}

function validateRange(range, today) {
  if (!range.from || !range.to || range.from > range.to) throw new Error('import range must be ordered');
  if (range.to > today) throw new Error('import range cannot extend into the future');
  return range;
}

function requestedRange(payload, today) {
  const explicit = payload.requested_range != null
    || payload.from != null || payload.start != null || payload.date_from != null
    || payload.to != null || payload.end != null || payload.date_to != null;
  if (explicit) {
    const range = payload.requested_range ?? payload;
    const result = {
      from: safeIsoDate(range.from ?? range.start ?? payload.date_from),
      to: safeIsoDate(range.to ?? range.end ?? payload.date_to),
    };
    if (!result.from || !result.to) throw new Error('explicit import range must be complete and valid');
    return validateRange(result, today);
  }

  if (!Array.isArray(payload.banks)) return { from: null, to: null };
  const banks = payload.banks;
  if (banks.length === 0) throw new Error('banks payload must include a complete range');
  const ranges = banks.map(({ window } = {}) => ({
    from: safeIsoDate(window?.start),
    to: safeIsoDate(window?.end),
  }));
  if (ranges.some(({ from, to }) => !from || !to)) throw new Error('bank windows must be complete and valid');
  for (const range of ranges) validateRange(range, today);
  if (banks.length === 1) return ranges[0];
  const identity = `${ranges[0].from}\u0000${ranges[0].to}`;
  if (ranges.some(({ from, to }) => `${from}\u0000${to}` !== identity)) {
    throw new Error('multiple bank windows must match');
  }
  return ranges[0];
}

const safeIsoDate = (value) => (isIsoDay(value) ? String(value) : null);

function resultCount(result, key) {
  return Array.isArray(result?.[key]) ? result[key].length : 0;
}

function sameImportedContent(existing, record) {
  if (existing.date !== record.date || existing.amount !== record.amount) return false;
  const legacyIdentity = normalized(existing.imported_payee ?? existing.notes ?? existing.payee_name);
  return [record.imported_payee, record.notes, record.payee_name]
    .map(normalized).includes(legacyIdentity);
}

function legacyAliases({ source, sourceAccount, transaction }) {
  const raw = String(transaction.imported_id ?? '').trim();
  return new Set([
    raw,
    canonicalImportedId({ source, sourceAccount, sourceTransactionId: raw }),
  ]);
}

function planLegacyMigrations(existing, batch) {
  const migrations = [];
  const claimed = new Set();
  for (const item of batch.items) {
    if (existing.some((transaction) => transaction.imported_id === item.record.imported_id)) continue;
    const aliases = legacyAliases(item);
    const matches = existing.filter((transaction) =>
      !claimed.has(transaction.id)
      && aliases.has(String(transaction.imported_id ?? '').trim())
      && sameImportedContent(transaction, item.record));
    if (matches.length > 1) return { migrations: [], ambiguous: 1 };
    if (matches.length === 1) {
      claimed.add(matches[0].id);
      migrations.push({ id: matches[0].id, imported_id: item.record.imported_id });
    }
  }
  return { migrations, ambiguous: 0 };
}

function priorBatchEvidence(manifests, source, accountId, range) {
  const sameWindow = (manifest) => manifest.source === source
    && manifest.requested_range?.from === range.from
    && manifest.requested_range?.to === range.to
    && (manifest.accounts ?? []).some((account) => account.actual_account_id === accountId);
  const relevant = manifests.filter(sameWindow);
  const successfulCounts = relevant
    .filter((manifest) => manifest.outcome === 'success')
    .map((manifest) => manifest.accounts.find((account) => account.actual_account_id === accountId)?.valid ?? 0);
  return {
    successfulCount: successfulCounts.length ? Math.max(...successfulCounts) : 0,
    previouslyObservedEmpty: relevant.some((manifest) => manifest.outcome === 'empty'),
  };
}

export async function runImport({
  payload, config, registry, actualApi, manifestDir, dryRun = false,
  seedBalance = false, output = () => {}, stateDir, now = () => new Date(),
  financeTimeZone = process.env.FINANCE_TIMEZONE ?? 'Europe/Berlin',
}) {
  const runId = randomUUID();
  const startedAt = instant(now);
  const batches = [];
  const accounts = [];
  const depotJobs = [];
  const allHoldings = [];
  const perBank = new Map();
  const sources = new Set();
  const intendedSources = new Set();
  const intendedAccounts = [];
  let manifestRange = { from: null, to: null };

  try {
    // Resolve safe ownership context before range validation so even a
    // pre-import failure can be attributed to the intended expected accounts.
    // `planned` is the single bankKey/mapping/ownership resolution pass: it
    // drives both the failure-manifest attribution below and the main loop's
    // error checks further down, so the matching logic exists exactly once.
    const ownership = validateOwnership(registry);
    const banks = bankPayloads(payload);
    const planned = banks.map((bankPayload) => {
      const bankKey = String(bankPayload.bank?.key ?? '').trim();
      const entries = (bankPayload.accounts ?? []).map((sourceAccount) => {
        const mapping = accountMapping(config, bankKey, sourceAccount);
        const owner = mapping && ownership.get(mapping.actual_account_id);
        const owned = Boolean(owner?.enabled && owner.source === `fints-${bankKey}`);
        return { sourceAccount, mapping, owner, owned };
      });
      return { bankKey, entries };
    });
    for (const { entries } of planned) {
      for (const entry of entries) {
        if (!entry.owned) continue;
        intendedSources.add(entry.owner.source);
        intendedAccounts.push({
          actual_account_id: entry.mapping.actual_account_id,
          fetched: 0, valid: 0, added: 0, updated: 0, quarantined: 0,
        });
      }
    }
    // Resolve the one manifest range before any Actual API write. A multi-bank
    // payload cannot safely share one range unless every bank window matches.
    manifestRange = requestedRange(payload, financeDay(startedAt, financeTimeZone));
    const priorManifests = await readRunManifests(manifestDir);
    if (banks.length === 0) throw new Error('empty payload');

    for (const { bankKey, entries } of planned) {
      if (!bankKey) throw new Error('missing bank key');
      for (const entry of entries) {
        const { sourceAccount, mapping, owner, owned } = entry;
        if (!mapping?.actual_account_id) throw new Error('account mapping missing');
        if (!owned) throw new Error('account ownership mismatch');
        sources.add(owner.source);

        if (sourceAccount.type === 'depot') {
          const holdings = sourceAccount.holdings ?? [];
          const summary = {
            actual_account_id: mapping.actual_account_id,
            fetched: holdings.length, valid: holdings.length,
            added: 0, updated: 0, quarantined: 0,
          };
          accounts.push(summary);
          if (holdings.length > 0) {
            depotJobs.push({ bankKey, sourceAccount, mapping, summary });
            for (const holding of holdings) allHoldings.push({
              bank: bankKey,
              depot_iban: sourceAccount.iban,
              depot_actual_account_id: mapping.actual_account_id,
              depot_display_name: mapping.display_name ?? sourceAccount.iban,
              ...holding,
            });
          }
          continue;
        }

        const rawTransactions = sourceAccount.transactions ?? [];
        const pendingWeak = rawTransactions.filter((transaction) =>
          isWeakSourceReference(transaction.imported_id) && transaction.status !== 'BOOK');
        const transactions = rawTransactions.filter((transaction) =>
          !isWeakSourceReference(transaction.imported_id) || transaction.status === 'BOOK');
        let seeded = false;
        if (seedBalance) {
          const opening = (sourceAccount.balances ?? []).find((balance) => balance.type === 'OPBD');
          if (opening && safeIsoDate(opening.date) && Number.isFinite(opening.amount_cents)) {
            const seedDate = new Date(`${opening.date}T00:00:00Z`);
            seedDate.setUTCDate(seedDate.getUTCDate() - 1);
            transactions.unshift({
              date: seedDate.toISOString().slice(0, 10),
              amount_cents: opening.amount_cents,
              payee_name: 'Opening Balance',
              notes: `Seeded from camt.052 OPBD ${opening.date} ${(opening.amount_cents / 100).toFixed(2)} ${opening.currency}`,
              imported_id: `fints-bridge-opening-balance-${mapping.actual_account_id}`,
              status: 'BOOK',
            });
            seeded = true;
          }
        }
        const items = transactions.map((transaction) => ({
          source: owner.source,
          sourceAccount: owner.source_account,
          transaction,
          record: toActualTransaction({ source: owner.source, sourceAccount: owner.source_account, transaction }),
        }));
        const records = items.map(({ record }) => record);
        if (seeded) records[0].imported_payee = 'Opening Balance';
        // Two indistinguishable weak-reference transactions fingerprint to the
        // same canonical ID; suffix later occurrences. Multiset-stable across
        // fetches because members of an identical group are interchangeable.
        const weakOccurrences = new Map();
        for (const item of items) {
          if (!isWeakSourceReference(item.transaction.imported_id)) continue;
          const count = (weakOccurrences.get(item.record.imported_id) ?? 0) + 1;
          weakOccurrences.set(item.record.imported_id, count);
          if (count > 1) item.record.imported_id = `${item.record.imported_id}~${count}`;
        }
        const summary = {
          actual_account_id: mapping.actual_account_id,
          fetched: rawTransactions.length,
          valid: 0,
          added: 0,
          updated: 0,
          quarantined: 0,
          pending_excluded: pendingWeak.length,
        };
        accounts.push(summary);
        const evidence = priorBatchEvidence(priorManifests, owner.source, mapping.actual_account_id, manifestRange);
        let validated;
        try {
          validated = validateBatch(records, { previousCount: evidence.successfulCount });
        } catch (error) {
          throw error.code === 'EMPTY_BATCH'
            ? coded('EMPTY_BATCH_REGRESSION', 'Unexpected empty batch regression', error)
            : error;
        }
        if (records.length === 0) {
          summary.empty_batch = evidence.previouslyObservedEmpty ? 'previously_observed_empty' : 'first_observed';
        }
        summary.valid = validated.records.length;
        summary.duplicate_candidates = validated.duplicateCandidates.length;
        batches.push({ bankKey, actualAccountId: mapping.actual_account_id, records: validated.records, items, summary });
      }
    }

    if (dryRun) {
      const byAccount = {};
      for (const batch of batches) {
        byAccount[batch.actualAccountId] = (byAccount[batch.actualAccountId] ?? []).concat(batch.records);
      }
      output(`${JSON.stringify(byAccount, null, 2)}\n`);
    } else {
      // Finish every ambiguity/read check before the first mutation. This makes
      // canonical-ID migration fail closed rather than partially importing.
      const migrationPlans = [];
      for (const batch of batches) {
        if (batch.records.length === 0 || typeof actualApi.getTransactions !== 'function') continue;
        const existing = await actualApi.getTransactions(batch.actualAccountId, '1900-01-01', '2100-01-01');
        const plan = planLegacyMigrations(existing, batch);
        if (plan.ambiguous) {
          batch.summary.quarantined += plan.ambiguous;
          throw new Error('ambiguous legacy transaction identity');
        }
        migrationPlans.push(...plan.migrations);
      }

      const revaluationPrefix = 'fints-bridge-depot-revaluation-';
      const depotPlans = [];
      for (const job of depotJobs) {
        const target = job.sourceAccount.holdings.reduce((sum, holding) => sum + (holding.total_value_cents || 0), 0);
        const existing = await actualApi.getTransactions(job.mapping.actual_account_id, '1900-01-01', '2100-01-01');
        const prior = existing.filter((transaction) => (transaction.imported_id ?? '').startsWith(revaluationPrefix));
        if (prior.length > 1) {
          job.summary.quarantined += prior.length;
          throw new Error('multiple depot revaluation transactions require manual reconciliation');
        }
        const current = existing
          .filter((transaction) => !(transaction.imported_id ?? '').startsWith(revaluationPrefix))
          .reduce((sum, transaction) => sum + transaction.amount, 0);
        depotPlans.push({ job, target, delta: target - current, prior: prior[0] });
      }

      try {
        for (const migration of migrationPlans) {
          await actualApi.updateTransaction(migration.id, { imported_id: migration.imported_id });
        }
      } catch (cause) {
        throw coded('ACTUAL_IMPORT_FAILED', 'Actual import failed', cause);
      }

      for (const batch of batches) {
        if (batch.records.length === 0) continue;
        let result;
        try {
          result = await actualApi.importTransactions(batch.actualAccountId, batch.records, { reimportDeleted: false });
        } catch (cause) {
          throw coded('ACTUAL_IMPORT_FAILED', 'Actual import failed', cause);
        }
        batch.summary.added = resultCount(result, 'added');
        batch.summary.updated = resultCount(result, 'updated');
        if (batch.bankKey) {
          const bucket = perBank.get(batch.bankKey) ?? { added: 0, updated: 0 };
          bucket.added += batch.summary.added;
          bucket.updated += batch.summary.updated;
          perBank.set(batch.bankKey, bucket);
        }
      }

      for (const plan of depotPlans) {
        const { job, target, delta, prior } = plan;
        try {
          if (delta !== 0) {
            const record = {
              date: financeDay(instant(now), financeTimeZone), amount: delta,
              payee_name: 'Holdings revaluation', imported_payee: 'Holdings revaluation',
              notes: `Auto-adjustment so depot balance equals SUM(holdings.total_value) = €${(target / 100).toFixed(2)}`,
              imported_id: `${revaluationPrefix}${job.mapping.actual_account_id}`,
              cleared: true,
            };
            if (prior) {
              // payee_name is an import-only convenience field; updateTransaction
              // accepts only real transactions-table fields.
              const { payee_name: _importOnly, ...updateFields } = record;
              await actualApi.updateTransaction(prior.id, updateFields);
              job.summary.updated = 1;
            } else {
              const result = await actualApi.importTransactions(job.mapping.actual_account_id, [record], { reimportDeleted: false });
              job.summary.added = resultCount(result, 'added');
              job.summary.updated = resultCount(result, 'updated');
            }
          } else if (prior) {
            await actualApi.updateTransaction(prior.id, {
              amount: 0,
              imported_id: `${revaluationPrefix}${job.mapping.actual_account_id}`,
            });
            job.summary.updated = 1;
          }
          const bucket = perBank.get(job.bankKey) ?? { added: 0, updated: 0 };
          bucket.added += job.summary.added;
          bucket.updated += job.summary.updated;
          perBank.set(job.bankKey, bucket);
        } catch (cause) {
          throw coded('ACTUAL_IMPORT_FAILED', 'Actual import failed', cause);
        }
      }

      if (stateDir && allHoldings.length > 0) {
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(join(stateDir, 'holdings.json'), `${JSON.stringify({
          fetched_at: instant(now), holdings: allHoldings,
        }, null, 2)}\n`);
      }
      if (stateDir && perBank.size > 0) {
        await fs.mkdir(stateDir, { recursive: true });
        const statusPath = join(stateDir, 'fints-status.json');
        let status = { last_runs: {} };
        try { status = { last_runs: {}, ...JSON.parse(await fs.readFile(statusPath, 'utf8')) }; }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
        const timestamp = instant(now);
        for (const [bankKey, counts] of perBank) status.last_runs[bankKey] = { ts: timestamp, ...counts };
        await fs.writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`);
      }
    }

    const allAccountsEmpty = accounts.length > 0 && accounts.every((account) => account.valid === 0);
    const anyAccountEmpty = accounts.some((account) => account.valid === 0);
    if (!dryRun) {
      for (const account of accounts) account.outcome = account.valid > 0 ? 'success' : 'empty';
    }
    const manifest = {
      schema_version: 1, run_id: runId,
      source: sources.size === 1 ? [...sources][0] : 'multiple',
      importer_version: IMPORTER_VERSION,
      started_at: startedAt, finished_at: instant(now),
      requested_range: manifestRange, accounts,
      outcome: dryRun ? 'dry_run' : allAccountsEmpty ? 'empty' : anyAccountEmpty ? 'partial_empty' : 'success', error_code: null,
    };
    await writeRunManifest(join(manifestDir, `${runId}.json`), manifest);
    await pruneRunManifests(manifestDir, { now: typeof now === 'function' ? now() : now });
    return manifest;
  } catch (cause) {
    const code = IMPORT_ERROR_CODES.has(cause?.code) ? cause.code : null;
    const manifest = {
      schema_version: 1, run_id: runId,
      source: sources.size === 1 ? [...sources][0]
        : intendedSources.size === 1 ? [...intendedSources][0] : 'unknown',
      importer_version: IMPORTER_VERSION,
      started_at: startedAt, finished_at: instant(now),
      requested_range: manifestRange, accounts: accounts.length ? accounts : intendedAccounts,
      outcome: 'failed',
      error_code: code === 'INVALID_TIMEZONE' ? 'VALIDATION_FAILED' : (code ?? 'VALIDATION_FAILED'),
    };
    await writeRunManifest(join(manifestDir, `${runId}.json`), manifest);
    if (code === 'INVALID_TIMEZONE') throw cause;
    if (code === 'EMPTY_BATCH_REGRESSION') throw cause;
    throw new Error(code === 'ACTUAL_IMPORT_FAILED' ? 'Actual import failed' : 'Import validation failed', { cause });
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
    await runImport({
      payload, config, registry, actualApi: actual, manifestDir: args['manifest-dir'], dryRun: true,
      seedBalance: args['seed-balance'], output: (value) => process.stdout.write(value),
    });
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
    await runImport({
      payload, config, registry, actualApi: actual, manifestDir: args['manifest-dir'],
      seedBalance: args['seed-balance'], stateDir: process.env.STATE_DIR ?? new URL('..', import.meta.url).pathname,
    });
  } finally {
    await actual.shutdown();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

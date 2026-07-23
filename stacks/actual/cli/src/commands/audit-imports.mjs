import fs from 'node:fs';

import { parseArgs } from '../lib/args.mjs';
import { withActual } from '../lib/client.mjs';

const REGISTRY_URL = new URL('../../config/accounts.json', import.meta.url);

function normalize(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
}

function publicTransaction(transaction) {
  return {
    id: transaction.id,
    account_id: transaction.account,
    date: transaction.date,
    amount: transaction.amount,
    imported_id: transaction.imported_id ?? null,
  };
}

function grouped(map, keyName) {
  return [...map.entries()]
    .filter(([, transactions]) => transactions.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, transactions]) => ({
      [keyName]: key,
      transactions: transactions.map(publicTransaction).sort((a, b) => a.id.localeCompare(b.id)),
    }));
}

export function auditTransactions(snapshot, registry) {
  const transactions = snapshot.transactions ?? [];
  const ownerByAccount = new Map(
    registry
      .filter((entry) => entry.enabled && entry.source !== 'manual-actual')
      .map((entry) => [entry.actual_account_id, entry]),
  );
  const importedIds = new Map();
  const fuzzy = new Map();
  const legacy = [];
  const missingPayees = [];
  const uncategorized = [];

  for (const transaction of transactions) {
    const importedId = String(transaction.imported_id ?? '').trim();
    if (importedId) {
      const duplicateKey = `${transaction.account}\u0000${importedId}`;
      const duplicates = importedIds.get(duplicateKey) ?? [];
      duplicates.push(transaction);
      importedIds.set(duplicateKey, duplicates);

      const owner = ownerByAccount.get(transaction.account);
      const canonicalPrefix = owner
        ? `${encodeURIComponent(owner.source)}:${encodeURIComponent(owner.source_account)}:`
        : null;
      if (canonicalPrefix && !importedId.startsWith(canonicalPrefix)) legacy.push(publicTransaction(transaction));
    }

    const payeeIdentity = normalize(transaction.imported_payee) || normalize(transaction.payee);
    if (payeeIdentity) {
      const fuzzyKey = [transaction.account, transaction.date, transaction.amount, payeeIdentity].join('\u0000');
      const candidates = fuzzy.get(fuzzyKey) ?? [];
      candidates.push(transaction);
      fuzzy.set(fuzzyKey, candidates);
    }
    if (!transaction.payee) missingPayees.push(publicTransaction(transaction));
    if (!transaction.category && !transaction.transfer_id) uncategorized.push(publicTransaction(transaction));
  }

  const duplicateImportedIds = grouped(importedIds, 'imported_id').map((group) => ({
    ...group,
    imported_id: group.imported_id.split('\u0000').slice(1).join('\u0000'),
  }));
  const fuzzyCandidates = grouped(fuzzy, 'match_key')
    .filter((group) => new Set(group.transactions.map((transaction) => transaction.imported_id)).size > 1)
    .map(({ transactions }) => ({ transactions }));
  const byId = (a, b) => a.id.localeCompare(b.id);
  legacy.sort(byId);
  missingPayees.sort(byId);
  uncategorized.sort(byId);

  return {
    counts: {
      duplicate_imported_ids: duplicateImportedIds.length,
      fuzzy_candidates: fuzzyCandidates.length,
      legacy_id_schemes: legacy.length,
      missing_payees: missingPayees.length,
      uncategorized: uncategorized.length,
    },
    duplicate_imported_ids: duplicateImportedIds,
    fuzzy_candidates: fuzzyCandidates,
    legacy_id_schemes: legacy,
    missing_payees: missingPayees,
    uncategorized,
  };
}

export function renderHuman(report) {
  const sections = [
    ['Duplicate imported IDs', 'duplicate_imported_ids'],
    ['Fuzzy candidates', 'fuzzy_candidates'],
    ['Legacy ID schemes', 'legacy_id_schemes'],
    ['Missing payees', 'missing_payees'],
    ['Uncategorized', 'uncategorized'],
  ];
  const lines = ['Actual import audit', ''];
  for (const [label, key] of sections) {
    const count = report.counts[key];
    const unit = ['duplicate_imported_ids', 'fuzzy_candidates'].includes(key) ? 'group' : 'transaction';
    lines.push(`${label}: ${count} ${unit}${count === 1 ? '' : 's'}`);
    const findings = report[key];
    for (const finding of findings) {
      const transactions = finding.transactions ?? [finding];
      lines.push(`  ${transactions.map((transaction) => transaction.id).join(', ')}`);
    }
  }
  return lines.join('\n');
}

function validSince(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export async function run(argv) {
  const args = parseArgs(argv);
  const since = args.since ?? '1900-01-01';
  if (!validSince(since)) throw new Error('--since must be a valid YYYY-MM-DD date');
  const registry = JSON.parse(fs.readFileSync(REGISTRY_URL, 'utf8'));
  const transactions = await withActual(async (api) => {
    const result = [];
    for (const account of await api.getAccounts()) {
      for (const transaction of await api.getTransactions(account.id, since, '2100-01-01')) {
        result.push({ ...transaction, account: transaction.account ?? account.id });
      }
    }
    return result;
  });
  const report = auditTransactions({ transactions }, registry);
  console.log(args.json ? JSON.stringify(report, null, 2) : renderHuman(report));
}

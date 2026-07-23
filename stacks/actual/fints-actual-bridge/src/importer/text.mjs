// The ONE definition of text/date identity. Transaction fingerprints,
// legacy-migration matching, duplicate keys, and audit keys all assume
// these functions agree byte-for-byte across importer, db-sync, and cli.
export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
}

export function isIsoDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

// Synthetic transactions created by the importer itself. Every LIKE/regex on
// these prefixes anywhere in the stack must come from here.
export const SYNTHETIC_IMPORT_PREFIXES = Object.freeze([
  'fints-bridge-opening-balance-',
  'fints-bridge-depot-revaluation-',
]);

export function isSyntheticImportedId(importedId) {
  const value = String(importedId ?? '');
  return SYNTHETIC_IMPORT_PREFIXES.some((prefix) => value.startsWith(prefix));
}

// Canonical fuzzy-duplicate identity. accountId may be null (importer runs
// before account resolution). Callers apply their own purpose filters:
//   validateBatch: within-batch, all signs, no account.
//   db-sync:       per-account, negative amounts only, synthetic excluded.
//   audit-imports: per-account, >1 distinct imported_id required.
export function duplicateCandidateKey({ accountId = null, date, amountCents, payeeIdentity }) {
  return JSON.stringify({
    account_id: accountId, date, amount_cents: amountCents,
    normalized_payee: normalizeText(payeeIdentity),
  });
}

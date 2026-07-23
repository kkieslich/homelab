import { createHash } from 'node:crypto';

import { extractCardMerchant } from './merchant.mjs';
import { normalizeText as normalized } from './text.mjs';

export function transactionFingerprint(transaction) {
  const stableFields = [
    transaction.date, transaction.amount_cents, transaction.currency,
    transaction.payee_name, transaction.notes,
  ].map(normalized).join('\u0000');
  return createHash('sha256').update(stableFields).digest('hex').slice(0, 24);
}

const WEAK_REFERENCES = new Set([
  'STARTUMS', 'NONREF', 'NOREF', 'NOTPROVIDED', 'NOT PROVIDED', 'UNKNOWN', 'NONE', 'N/A',
]);

export function isWeakSourceReference(value) {
  const reference = String(value ?? '').normalize('NFKC').trim().toUpperCase();
  // Both Python fetcher fallbacks emit syn_ + sha256(...).hexdigest()[:24].
  return WEAK_REFERENCES.has(reference) || /^SYN_[0-9A-F]{24}$/u.test(reference);
}

// Prefers the fetcher's structured `reference_quality` field over reverse-
// engineering the ID string. Only truly SYNTHESIZED ids are "synthetic";
// bank-supplied placeholder tokens (e.g. NONREF) are "bank"-sourced but still
// weak, so the literal/pattern check in isWeakSourceReference stays as the
// fallback for those — 'bank' quality does NOT short-circuit to false.
// Absent field (older payloads, tests) falls through to the legacy heuristics.
export function isWeakReference(transaction) {
  if (transaction?.reference_quality === 'synthetic') return true;
  return isWeakSourceReference(transaction?.imported_id);
}

export function canonicalSourceTransactionId(transaction) {
  const supplied = String(transaction?.imported_id ?? '').trim();
  if (!supplied) throw new Error('sourceTransactionId is required');
  return isWeakReference(transaction)
    ? `${supplied}~${transactionFingerprint(transaction)}`
    : supplied;
}

export function canonicalImportedId({ source, sourceAccount, sourceTransactionId }) {
  for (const [name, value] of Object.entries({ source, sourceAccount, sourceTransactionId })) {
    if (!String(value ?? '').trim()) throw new Error(`${name} is required`);
  }
  return [source, sourceAccount, sourceTransactionId].map((v) => encodeURIComponent(String(v).trim())).join(':');
}

export function toActualTransaction({ source, sourceAccount, transaction }) {
  const raw = transaction.notes ?? transaction.payee_name ?? '';
  const candidate = transaction.payee_name?.trim() || extractCardMerchant(raw);
  return {
    date: transaction.date,
    amount: transaction.amount_cents,
    payee_name: candidate || undefined,
    imported_payee: raw || undefined,
    notes: raw || undefined,
    imported_id: canonicalImportedId({
      source, sourceAccount, sourceTransactionId: canonicalSourceTransactionId(transaction),
    }),
    cleared: transaction.status === 'BOOK',
  };
}

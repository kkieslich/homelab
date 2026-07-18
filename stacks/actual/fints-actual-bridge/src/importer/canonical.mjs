import { createHash } from 'node:crypto';

import { extractCardMerchant } from './merchant.mjs';

function normalized(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
}

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
  return WEAK_REFERENCES.has(reference) || reference.startsWith('SYN_');
}

export function canonicalSourceTransactionId(transaction) {
  const supplied = String(transaction?.imported_id ?? '').trim();
  if (!supplied) throw new Error('sourceTransactionId is required');
  return isWeakSourceReference(supplied)
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

import { extractCardMerchant } from './merchant.mjs';

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
    imported_id: canonicalImportedId({ source, sourceAccount, sourceTransactionId: transaction.imported_id }),
    cleared: transaction.status === 'BOOK',
  };
}

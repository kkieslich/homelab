import { isIsoDay, normalizeText } from './text.mjs';

export function validateBatch(records, { previousCount } = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (!Number.isInteger(previousCount) || previousCount < 0) {
    throw new TypeError('previousCount must be a non-negative integer');
  }
  if (records.length === 0 && previousCount > 0) {
    throw new Error(`unexpected empty batch after previous count ${previousCount}`);
  }

  const importedIds = new Set();
  const fuzzyGroups = new Map();

  for (const [index, record] of records.entries()) {
    const importedId = String(record?.imported_id ?? '').trim();
    if (!importedId) throw new Error(`record ${index}: imported_id is required`);
    if (importedIds.has(importedId)) throw new Error(`duplicate imported_id: ${importedId}`);
    importedIds.add(importedId);

    if (!isIsoDay(record.date)) throw new Error(`record ${index}: invalid ISO date`);
    if (!Number.isInteger(record.amount)) throw new Error(`record ${index}: amount must be an integer`);

    const fuzzyKey = `${record.date}|${record.amount}|${normalizeText(record.imported_payee)}`;
    const group = fuzzyGroups.get(fuzzyKey) ?? [];
    group.push(record);
    fuzzyGroups.set(fuzzyKey, group);
  }

  const duplicateCandidates = [...fuzzyGroups]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, records: group }));

  return { records, duplicateCandidates, warnings: [] };
}

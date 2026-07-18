export function validateOwnership(entries) {
  if (!Array.isArray(entries)) throw new TypeError('ownership registry must be an array');

  const ownership = new Map();
  const enabledOwners = new Set();

  for (const entry of entries) {
    const accountId = String(entry?.actual_account_id ?? '').trim();
    if (!accountId) throw new Error('actual_account_id is required for every ownership entry');

    if (entry.enabled) {
      if (enabledOwners.has(accountId)) {
        throw new Error(`multiple enabled importers target Actual account ${accountId}`);
      }
      enabledOwners.add(accountId);
    }

    const current = ownership.get(accountId);
    if (!current || entry.enabled) ownership.set(accountId, entry);
  }

  return ownership;
}

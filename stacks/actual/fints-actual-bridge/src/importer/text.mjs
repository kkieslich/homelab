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

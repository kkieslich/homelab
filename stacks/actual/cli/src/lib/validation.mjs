export function requireUtcInstant(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw new Error(`${label} must be a non-empty UTC ISO timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) {
    throw new Error(`${label} must be a valid UTC ISO timestamp`);
  }
  return value;
}

export function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

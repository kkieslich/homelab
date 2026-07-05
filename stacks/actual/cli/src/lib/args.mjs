// Minimal --key / --key=value argv parser. Returns { key: value, key2: true, _: ['positional'] }.
// Avoids depending on parseArgs which has different conventions across Node versions.
export function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) out[a.slice(2)] = true;
      else out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      out._.push(a);
    }
  }
  return out;
}

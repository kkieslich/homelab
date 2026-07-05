// Loads stacks/actual/.env into process.env. Never overrides values already set
// (so container env_file: continues to win). Idempotent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// stacks/actual/cli/src/lib/env.mjs -> stacks/actual/.env
const DEFAULT_ENV_PATH = path.resolve(HERE, '../../../.env');

let loaded = false;

export function loadEnv(envPath = process.env.ACTUAL_ENV_FILE ?? DEFAULT_ENV_PATH) {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export function requireEnv(name) {
  loadEnv();
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

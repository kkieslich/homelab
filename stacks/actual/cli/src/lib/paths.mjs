import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(HERE, '../..');

export const CONFIG_DIR = path.join(CLI_ROOT, 'config');
export const CACHE_DIR = process.env.ACTUAL_CACHE_DIR ?? path.join(os.tmpdir(), 'actual-cli');
export const SNAPSHOT_PATH = path.join(CACHE_DIR, 'transactions.json');
export const ACTUAL_DATA_DIR = path.join(CACHE_DIR, 'actual-data');

export function ensureCache() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(ACTUAL_DATA_DIR, { recursive: true });
}

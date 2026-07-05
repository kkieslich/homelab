// Long-running container: every REFRESH_INTERVAL_SEC, pull a snapshot from the
// Actual server and write it into the SQLite read-replica that Grafana queries.

import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import * as api from '@actual-app/api';
import { syncToSqlite } from './sync.mjs';

const REFRESH_INTERVAL_SEC = parseInt(process.env.REFRESH_INTERVAL_SEC ?? '300', 10);
const SERVER_URL = process.env.ACTUAL_SERVER_URL ?? 'http://actual_server:5006';
const PASSWORD = process.env.ACTUAL_PASSWORD;
const SYNC_ID = process.env.ACTUAL_BUDGET_ID;
const FINTS_STATUS_PATH = process.env.FINTS_STATUS_PATH ?? '/fints/fints-status.json';
const HOLDINGS_PATH = process.env.HOLDINGS_PATH ?? '/fints/holdings.json';
const BUDGET_PATH = process.env.BUDGET_PATH ?? '/budget/budget.json';
const DB_PATH = process.env.ACTUAL_DB_PATH ?? '/db/actual.sqlite';
const ACTUAL_DATA_DIR = process.env.ACTUAL_DATA_DIR ?? path.join(os.tmpdir(), 'actual-db-sync');

if (!PASSWORD || !SYNC_ID) {
  console.error('FATAL: ACTUAL_PASSWORD and ACTUAL_BUDGET_ID must be set');
  process.exit(1);
}

let running = false;

async function refresh() {
  if (running) {
    console.error('[sync] previous run still in flight, skipping');
    return;
  }
  running = true;
  const start = Date.now();
  try {
    await fsp.mkdir(ACTUAL_DATA_DIR, { recursive: true });
    await api.init({ dataDir: ACTUAL_DATA_DIR, serverURL: SERVER_URL, password: PASSWORD });
    try {
      await api.downloadBudget(SYNC_ID);
      const counts = await syncToSqlite(DB_PATH, FINTS_STATUS_PATH, HOLDINGS_PATH, BUDGET_PATH);
      console.error(
        `[sync] ok in ${((Date.now() - start) / 1000).toFixed(1)}s ` +
        `— ${counts.transactions} txs, ${counts.accounts} accounts, ${counts.subscriptions} subs, ` +
        `${counts.holdings} holdings (history total: ${counts.holdings_history}), ` +
        `${counts.budgets} budget targets ` +
        `-> ${DB_PATH}`,
      );
    } finally {
      await api.shutdown();
    }
  } catch (err) {
    console.error('[sync] FAILED:', err);
  } finally {
    running = false;
  }
}

console.error(`[db-sync] starting; server=${SERVER_URL} db=${DB_PATH} refresh=${REFRESH_INTERVAL_SEC}s`);
await refresh();
setInterval(refresh, REFRESH_INTERVAL_SEC * 1000);

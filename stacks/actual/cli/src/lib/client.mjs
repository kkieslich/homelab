import * as api from '@actual-app/api';
import { loadEnv, requireEnv } from './env.mjs';
import { ACTUAL_DATA_DIR, ensureCache } from './paths.mjs';

// Opens an Actual API session, runs `fn(api)`, and shuts down — even on error.
// Centralises the env + init/teardown boilerplate that used to be duplicated
// across every script.
export async function withActual(fn) {
  loadEnv();
  const serverURL = process.env.ACTUAL_SERVER_URL ?? 'https://actual.home.kki.berlin';
  const password = requireEnv('ACTUAL_PASSWORD');
  const syncId = requireEnv('ACTUAL_BUDGET_ID');
  ensureCache();

  await api.init({ dataDir: ACTUAL_DATA_DIR, serverURL, password });
  try {
    await api.downloadBudget(syncId);
    return await fn(api);
  } finally {
    await api.shutdown();
  }
}

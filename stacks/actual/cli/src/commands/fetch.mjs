// Download the entire budget (accounts, categories, payees, transactions)
// to a local snapshot file. Used as input by analyze + subs (so they don't each
// re-download) and as a debugging artifact.

import fs from 'node:fs';
import { withActual } from '../lib/client.mjs';
import { SNAPSHOT_PATH } from '../lib/paths.mjs';

export async function fetchSnapshot() {
  return withActual(async (api) => {
    const accounts = await api.getAccounts();
    const categoryGroups = await api.getCategoryGroups();
    const categories = await api.getCategories();
    const payees = await api.getPayees();
    const transactions = [];
    for (const acct of accounts) {
      const txs = await api.getTransactions(acct.id, '1900-01-01', '2100-01-01');
      for (const t of txs) transactions.push({ ...t, account_name: acct.name });
    }
    return {
      fetched_at: new Date().toISOString(),
      accounts,
      categoryGroups,
      categories,
      payees: payees.map((p) => ({ id: p.id, name: p.name, transfer_acct: p.transfer_acct })),
      transactions,
    };
  });
}

export async function run() {
  const snapshot = await fetchSnapshot();
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  console.error(
    `Wrote ${snapshot.transactions.length} transactions, ` +
    `${snapshot.categories.length} categories, ` +
    `${snapshot.accounts.length} accounts -> ${SNAPSHOT_PATH}`,
  );
}

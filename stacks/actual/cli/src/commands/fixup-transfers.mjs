// Repair transfer transactions whose mirror was never created.
//
// Symptom: a transaction has its payee set to a transfer-payee (i.e. it
// references another account) but its `transfer_id` is null — Actual didn't
// auto-create the mirror tx on the other side, so it shows in the UI as
// "no category" and pollutes the source account's balance reporting.
//
// This is a known race during bulk payee updates done via the API (we hit
// it during the original brokerage→transfers conversion).
//
// What this command does, for each orphan:
//   1. Add a mirror tx to the target account with the opposite sign and a
//      deterministic imported_id (so re-runs are idempotent).
//   2. Re-fetch the target to get the mirror's UUID.
//   3. Link both sides via `transfer_id`.

import { parseArgs } from '../lib/args.mjs';
import { withActual } from '../lib/client.mjs';

export async function run(argv) {
  const args = parseArgs(argv);
  const apply = !!args.apply;

  await withActual(async (api) => {
    const accounts = await api.getAccounts();
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const payees = await api.getPayees();
    const transferAcctByPayee = new Map(payees.filter((p) => p.transfer_acct).map((p) => [p.id, p.transfer_acct]));

    // Find orphans across every account: payee is a transfer-payee but transfer_id is null.
    const orphansByTarget = new Map(); // targetAcctId -> [{tx, sourceAcct}]
    for (const acct of accounts) {
      const txs = await api.getTransactions(acct.id, '1900-01-01', '2100-01-01');
      for (const t of txs) {
        if (t.transfer_id) continue;
        const targetId = transferAcctByPayee.get(t.payee);
        if (!targetId) continue;
        if (!orphansByTarget.has(targetId)) orphansByTarget.set(targetId, []);
        orphansByTarget.get(targetId).push({ tx: t, sourceAcct: acct });
      }
    }

    const total = Array.from(orphansByTarget.values()).reduce((s, arr) => s + arr.length, 0);
    console.error(`Found ${total} orphan transfer(s) across ${orphansByTarget.size} target account(s)`);
    if (total === 0) return;

    for (const [targetId, items] of orphansByTarget.entries()) {
      const target = accountById.get(targetId);
      console.error(`\n${target?.name ?? targetId}: ${items.length} orphan(s)`);
      for (const { tx, sourceAcct } of items) {
        console.error(`  ${tx.date}  €${(tx.amount / 100).toFixed(2)}  from "${sourceAcct.name}"  ${(tx.notes || '').slice(0, 50)}`);
      }
    }
    if (!apply) {
      console.error('\n(dry run — pass --apply to create mirrors and link them)');
      return;
    }

    let linked = 0;
    let failed = 0;
    for (const [targetId, items] of orphansByTarget.entries()) {
      // For each target, find the source-account transfer-payee once (used as
      // the mirror's payee so it points back at the source).
      const transferPayeeIdByAcct = new Map();
      for (const { sourceAcct } of items) {
        if (transferPayeeIdByAcct.has(sourceAcct.id)) continue;
        const tp = payees.find((p) => p.transfer_acct === sourceAcct.id);
        if (tp) transferPayeeIdByAcct.set(sourceAcct.id, tp.id);
      }

      // Build mirror records with a unique notes-marker so we can find them
      // after addTransactions (which returns "ok", not the new IDs).
      // We use addTransactions (not importTransactions) because importTransactions
      // calls reconcileTransactions, which auto-creates a reverse mirror back on
      // the source account — duplicating the orphan we're trying to link to.
      const mirrors = items
        .map(({ tx, sourceAcct }) => {
          const srcTp = transferPayeeIdByAcct.get(sourceAcct.id);
          if (!srcTp) return null;
          const marker = `[bridge-mirror:${tx.id}]`;
          return {
            tx,
            marker,
            mirror: {
              date: tx.date,
              amount: -tx.amount,
              payee: srcTp,
              notes: `${tx.notes ?? ''} ${marker}`.trim(),
              cleared: tx.cleared,
            },
          };
        })
        .filter(Boolean);

      // addTransactions with default runTransfers=false — no auto-mirror.
      await api.addTransactions(targetId, mirrors.map((m) => m.mirror));

      // Re-fetch and look up each mirror by its notes marker, then link both sides.
      const targetTxs = await api.getTransactions(targetId, '1900-01-01', '2100-01-01');
      for (const { tx, marker } of mirrors) {
        const m = targetTxs.find((t) => (t.notes || '').includes(marker));
        if (!m) {
          console.error(`  !! mirror not found for orphan ${tx.id} (marker=${marker})`);
          failed++;
          continue;
        }
        await api.updateTransaction(tx.id, { transfer_id: m.id });
        await api.updateTransaction(m.id, { transfer_id: tx.id });
        linked++;
      }
    }
    console.error(`\nLinked ${linked} transfer pair(s); ${failed} failed.`);
  });
}

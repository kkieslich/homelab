// Apply rule-based categorization from config/categorization.json. Idempotent —
// only writes when a category would actually change. Default is dry run.
//
// Two phases run in order:
//   1. payeeSplits — rewrite the payee on transactions that match a "from"
//      payee + notes regex. Used to break aggregator lumps (PayPal Europe,
//      Klarna, Apple Services) into their actual underlying merchants so
//      cadence-based subscription detection can see them.
//   2. rules — assign categories based on the (now-split) payee + notes.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../lib/args.mjs';
import { CONFIG_DIR } from '../lib/paths.mjs';
import { withActual } from '../lib/client.mjs';

function transferMatches(rule, tx, payeeNameById, accountNameById) {
  const m = rule.match || {};
  const payeeName = payeeNameById[tx.payee] || '';
  const accountName = accountNameById[tx.account] || '';
  if (m.payee && !m.payee.includes(payeeName)) return false;
  if (m.payee_regex && !new RegExp(m.payee_regex, 'i').test(payeeName)) return false;
  if (m.notes_regex && !new RegExp(m.notes_regex, 'i').test(tx.notes || '')) return false;
  if (m.notes && !(tx.notes || '').includes(m.notes)) return false;
  if (m.amount_sign === 'positive' && tx.amount <= 0) return false;
  if (m.amount_sign === 'negative' && tx.amount >= 0) return false;
  if (m.account && !m.account.includes(accountName)) return false;
  if (m.from_account && accountName !== m.from_account) return false;
  return true;
}

function ruleMatches(rule, tx, payeeNameById) {
  const m = rule.match;
  const payeeName = payeeNameById[tx.payee] || '';
  if (m.payee && !m.payee.includes(payeeName)) return false;
  if (m.payee_regex && !new RegExp(m.payee_regex, 'i').test(payeeName)) return false;
  if (m.notes_regex && !new RegExp(m.notes_regex, 'i').test(tx.notes || '')) return false;
  if (m.amount_sign === 'positive' && tx.amount <= 0) return false;
  if (m.amount_sign === 'negative' && tx.amount >= 0) return false;
  return true;
}

function splitMatches(split, tx, payeeNameById) {
  const payeeName = payeeNameById[tx.payee] || '';
  const fromList = Array.isArray(split.from) ? split.from : [split.from];
  if (!fromList.includes(payeeName)) return false;
  if (split.notes_regex && !new RegExp(split.notes_regex, 'i').test(tx.notes || '')) return false;
  if (split.notes && !(tx.notes || '').includes(split.notes)) return false;
  return true;
}

// Apply a payeeAutoSplit rule: returns the extracted merchant name (cleaned),
// or null if the rule doesn't match or yields garbage.
function autoSplitExtract(rule, tx, payeeNameById) {
  const payeeName = payeeNameById[tx.payee] || '';
  const fromList = Array.isArray(rule.from) ? rule.from : [rule.from];
  if (!fromList.includes(payeeName)) return null;
  if (!rule.extract_regex) return null;
  const m = (tx.notes || '').match(new RegExp(rule.extract_regex, 'i'));
  if (!m || !m[1]) return null;
  // Cleanup pipeline:
  //   - take the first '/' segment (PayPal sometimes appends '/ABBUCHUNG VOM PAYPAL-KONTO')
  //   - collapse whitespace
  //   - strip trailing punctuation
  let extracted = m[1].split('/')[0].replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
  if (!extracted) return null;
  // Sanity gate: skip captures that look like FinTS metadata leaking through
  // (empty merchant fields cause regexes to swallow EREF/MREF/CRED/IBAN tokens)
  // or that contain no letters at all.
  if (/^(EREF|MREF|CRED|IBAN|BIC|SVWZ|ABWA|ABWE)[: ]/i.test(extracted)) return null;
  if (!/[a-zA-ZäöüÄÖÜß]/.test(extracted)) return null;
  return extracted;
}

export async function run(argv) {
  const args = parseArgs(argv);
  const apply = !!args.apply;
  const recatFallback = !!args['recat-fallback'];
  const recatNames = (args['recat-categories'] ?? '').toString().split(',').map((s) => s.trim()).filter(Boolean);
  const clearOffBudget = !!args['clear-offbudget'];
  const config = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'categorization.json'), 'utf8'));

  await withActual(async (api) => {
    const groups = await api.getCategoryGroups();
    const groupByName = Object.fromEntries(groups.map((g) => [g.name, g]));
    const existingCats = await api.getCategories();
    const catByName = new Map(existingCats.map((c) => [c.name, c]));

    for (const nc of config.newCategories) {
      if (catByName.has(nc.name)) continue;
      const grp = groupByName[nc.group];
      if (!grp) { console.error(`!! group not found: ${nc.group}`); continue; }
      if (apply) {
        const id = await api.createCategory({ name: nc.name, group_id: grp.id, is_income: !!nc.is_income });
        catByName.set(nc.name, { id, name: nc.name, group_id: grp.id, is_income: !!nc.is_income });
        console.error(`+ created category "${nc.name}" in "${nc.group}"`);
      } else {
        catByName.set(nc.name, { id: '__pending__', name: nc.name, group_id: grp.id, is_income: !!nc.is_income });
        console.error(`+ would create category "${nc.name}" in "${nc.group}"`);
      }
    }

    const accounts = await api.getAccounts();
    const accountByName = Object.fromEntries(accounts.map((a) => [a.name, a]));
    const accountNameById = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
    const offBudgetAccountIds = new Set(accounts.filter((a) => a.offbudget).map((a) => a.id));
    const payees = await api.getPayees();
    const payeeNameById = Object.fromEntries(payees.map((p) => [p.id, p.name]));
    const payeeIdByName = new Map(payees.map((p) => [p.name, p.id]));
    // Set of payee IDs that represent transfers to/from another account in
    // Actual. Used downstream to skip transfer-payee transactions in category
    // assignment (a real transfer has no spending category).
    const transferPayeeIds = new Set(payees.filter((p) => p.transfer_acct).map((p) => p.id));
    // Build "target account name → transfer payee ID" lookup for transferRules.
    const transferPayeeByAccountName = {};
    for (const p of payees) {
      if (p.transfer_acct) {
        const acc = accounts.find((a) => a.id === p.transfer_acct);
        if (acc) transferPayeeByAccountName[acc.name] = p.id;
      }
    }

    const allTxs = [];
    for (const acct of accounts) {
      const list = await api.getTransactions(acct.id, '1900-01-01', '2100-01-01');
      for (const t of list) allTxs.push(t);
    }
    // Off-budget accounts (e.g. brokerage depots) carry transactions whose
    // category has no budget meaning. Always exclude them from categorization
    // so the bridge's "Holdings revaluation" tx doesn't end up under "General".
    const txs = allTxs.filter((t) => !offBudgetAccountIds.has(t.account));

    // One-time fix: strip any existing category from off-budget txs (e.g. the
    // €20k Holdings revaluation that the older categorizer wrongly tagged
    // "General"). Idempotent; no-op if everything is already null.
    if (clearOffBudget) {
      const wronglyCategorized = allTxs.filter((t) => offBudgetAccountIds.has(t.account) && t.category);
      console.error(`\nFound ${wronglyCategorized.length} off-budget tx(s) with stray categories.`);
      if (apply) {
        for (const t of wronglyCategorized) {
          await api.updateTransaction(t.id, { category: null });
        }
        if (wronglyCategorized.length) console.error(`Cleared ${wronglyCategorized.length} off-budget categories.`);
      } else if (wronglyCategorized.length) {
        console.error('(dry run — pass --apply to clear)');
      }
    }

    // ===== Phase 1: payee splits (explicit + auto-extract) =====
    // Walk every transaction and try (a) explicit `payeeSplits` first (most
    // specific), then (b) `payeeAutoSplits` regex-extraction (catches anything
    // matching the aggregator's "Ihr Einkauf bei <merchant>" pattern). For
    // each match, ensure the target payee exists then queue the update.
    const payeeUpdates = [];      // {id, payee, fromName, toName}
    const payeeMoves = {};        // "from -> to" -> count

    async function ensurePayeeId(name) {
      if (payeeIdByName.has(name)) return payeeIdByName.get(name);
      if (apply) {
        const id = await api.createPayee({ name });
        payeeIdByName.set(name, id);
        payeeNameById[id] = name;
        console.error(`+ created payee "${name}"`);
        return id;
      }
      payeeIdByName.set(name, '__pending__');
      console.error(`+ would create payee "${name}"`);
      return '__pending__';
    }

    // Pre-create target payees for explicit splits so the IDs exist.
    for (const split of config.payeeSplits ?? []) {
      if (split.to) await ensurePayeeId(split.to);
    }

    for (const tx of txs) {
      let newName = null;

      // (a) Explicit splits first.
      for (const split of config.payeeSplits ?? []) {
        if (splitMatches(split, tx, payeeNameById)) { newName = split.to; break; }
      }
      // (b) Auto-extract fallback.
      if (!newName) {
        for (const rule of config.payeeAutoSplits ?? []) {
          const extracted = autoSplitExtract(rule, tx, payeeNameById);
          if (extracted) { newName = extracted; break; }
        }
      }
      if (!newName) continue;

      const targetId = await ensurePayeeId(newName);
      if (!targetId || tx.payee === targetId) continue;
      const fromName = payeeNameById[tx.payee] || '(none)';
      payeeUpdates.push({ id: tx.id, payee: targetId, fromName, toName: newName });
      const k = `${fromName} -> ${newName}`;
      payeeMoves[k] = (payeeMoves[k] || 0) + 1;
      // Reflect locally so the category phase below uses the new payee.
      tx.payee = targetId;
    }

    if (Object.keys(payeeMoves).length) {
      console.error('\nPayee splits:');
      for (const [k, n] of Object.entries(payeeMoves).sort((a, b) => b[1] - a[1])) {
        console.error(`  ${String(n).padStart(4)}  ${k}`);
      }
      console.error(`Payee changes (different from current): ${payeeUpdates.length}`);
    }

    // ===== Phase 1.5: transfer conversions =====
    // Convert "real" cross-account flows (stock buys, deposits between own
    // accounts) into proper Actual Transfers. Setting payee to the target
    // account's transfer payee + clearing the category triggers Actual's
    // built-in transfer machinery: the mirror tx on the other account is
    // auto-created with linked transfer_id, and the cash outflow becomes
    // budget-neutral (treated as moved-to-savings, not spent).
    const transferUpdates = [];   // {id, payee, fromAccount, toAccount}
    const transferMoves = {};     // "from -> to" -> count
    if (Array.isArray(config.transferRules)) {
      for (const tx of txs) {
        for (const rule of config.transferRules) {
          if (!transferMatches(rule, tx, payeeNameById, accountNameById)) continue;
          const targetId = transferPayeeByAccountName[rule.transfer_to_account_name];
          if (!targetId) {
            console.error(`!! transferRule target "${rule.transfer_to_account_name}" — no transfer payee found (account doesn't exist?)`);
            break;
          }
          if (tx.payee === targetId) break;     // already a transfer
          const fromAccount = accountNameById[tx.account] || '?';
          transferUpdates.push({ id: tx.id, payee: targetId, fromAccount, toAccount: rule.transfer_to_account_name });
          const k = `${fromAccount} -> ${rule.transfer_to_account_name}`;
          transferMoves[k] = (transferMoves[k] || 0) + 1;
          // Locally mark as transfer so the category phase below skips it.
          tx.payee = targetId;
          tx.category = null;
          break;
        }
      }
    }
    if (Object.keys(transferMoves).length) {
      console.error('\nTransfer conversions:');
      for (const [k, n] of Object.entries(transferMoves).sort((a, b) => b[1] - a[1])) {
        console.error(`  ${String(n).padStart(4)}  ${k}`);
      }
      console.error(`Transfer changes: ${transferUpdates.length}`);
    }

    const fallbackCat = catByName.get(config.fallback);
    const recatCatIds = new Set(
      recatNames.map((name) => {
        const c = catByName.get(name);
        if (!c) console.error(`!! --recat-categories: category "${name}" not found, ignoring`);
        return c?.id;
      }).filter(Boolean),
    );

    const stats = {};
    const updates = [];
    const changes = [];
    let unmatched = 0;

    for (const tx of txs) {
      // Real transfers (linked to another account) have no spending semantics;
      // never assign them a category.
      if (tx.transfer_id || transferPayeeIds.has(tx.payee)) continue;
      if (tx.category) {
        const inRecatList = recatCatIds.has(tx.category);
        const inFallback = recatFallback && fallbackCat && tx.category === fallbackCat.id;
        if (!inRecatList && !inFallback) continue;
      }
      let categoryName = config.fallback;
      let matched = false;
      for (const r of config.rules) {
        if (!r.match) continue;
        if (ruleMatches(r, tx, payeeNameById)) { categoryName = r.category; matched = true; break; }
      }
      if (!matched) unmatched++;
      const cat = catByName.get(categoryName);
      if (!cat) { console.error(`!! category not found: "${categoryName}" (tx ${tx.id})`); continue; }
      stats[categoryName] = (stats[categoryName] || 0) + 1;
      if (tx.category === cat.id) continue;
      const fromName = tx.category ? (existingCats.find((c) => c.id === tx.category)?.name ?? '?') : '(none)';
      changes.push({ id: tx.id, fromName, toName: categoryName });
      updates.push({ id: tx.id, category: cat.id });
    }

    console.error('\nClassification breakdown (counts evaluated this run):');
    for (const [name, count] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
      console.error(`  ${String(count).padStart(4)}  ${name}`);
    }
    console.error(`\nTotal evaluated: ${Object.values(stats).reduce((a, b) => a + b, 0)} (unmatched -> fallback: ${unmatched})`);
    console.error(`Actual changes (different from current): ${changes.length}`);
    if (changes.length) {
      const moves = {};
      for (const c of changes) { const k = `${c.fromName} -> ${c.toName}`; moves[k] = (moves[k] || 0) + 1; }
      console.error('\nCategory moves:');
      for (const [k, n] of Object.entries(moves).sort((a, b) => b[1] - a[1])) {
        console.error(`  ${String(n).padStart(4)}  ${k}`);
      }
    }

    if (apply) {
      console.error('\nApplying updates...');
      let done = 0;
      for (const u of payeeUpdates) {
        await api.updateTransaction(u.id, { payee: u.payee });
        if (++done % 50 === 0) console.error(`  payee: ${done}/${payeeUpdates.length}`);
      }
      if (payeeUpdates.length) console.error(`Applied ${payeeUpdates.length} payee splits.`);
      done = 0;
      for (const u of transferUpdates) {
        // Setting payee to a transfer-payee triggers Actual's transfer auto-mirror.
        // Clearing the category prevents leftover spending categorization.
        await api.updateTransaction(u.id, { payee: u.payee, category: null });
        if (++done % 50 === 0) console.error(`  transfers: ${done}/${transferUpdates.length}`);
      }
      if (transferUpdates.length) console.error(`Applied ${transferUpdates.length} transfer conversions.`);
      done = 0;
      for (const u of updates) {
        await api.updateTransaction(u.id, { category: u.category });
        if (++done % 50 === 0) console.error(`  category: ${done}/${updates.length}`);
      }
      console.error(`Applied ${done} category assignments.`);
    } else {
      console.error('\n(dry run — pass --apply to write changes)');
    }
  });
}

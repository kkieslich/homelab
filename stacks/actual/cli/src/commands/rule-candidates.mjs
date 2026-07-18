import { parseArgs } from '../lib/args.mjs';
import { withActual } from '../lib/client.mjs';

const RISK_PATTERNS = [
  ['aggregator', /\b(?:paypal|amazon|klarna)\b/iu],
  ['cash', /\b(?:atm|cash|geldautomat|bargeld)\b/iu],
  ['person_to_person', /\b(?:p2p|person[ -]to[ -]person|friends?\s*(?:&|and)\s*family)\b/iu],
];

function finiteThreshold(value, fallback, name, { integer = false } = {}) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`--${name} must be a non-negative ${integer ? 'integer' : 'number'}`);
  }
  return parsed;
}

function riskFlags(payeeName, personPayees) {
  const flags = RISK_PATTERNS
    .filter(([, pattern]) => pattern.test(payeeName))
    .map(([flag]) => flag);
  if (personPayees.has(payeeName.toLocaleLowerCase('und')) && !flags.includes('person_to_person')) {
    flags.push('person_to_person');
  }
  return flags;
}

export function generateRuleCandidates(snapshot, options = {}) {
  const minCount = finiteThreshold(options.minCount, 3, 'min-count', { integer: true });
  const minConfidence = finiteThreshold(options.minConfidence, 0.9, 'min-confidence');
  if (minConfidence > 1) throw new Error('--min-confidence must not exceed 1');

  const accounts = new Map((snapshot.accounts ?? []).map((account) => [account.id, account]));
  const categories = new Map((snapshot.categories ?? []).map((category) => [category.id, category]));
  const payees = new Map((snapshot.payees ?? []).map((payee) => [payee.id, payee]));
  const transferPayees = new Set((snapshot.payees ?? []).filter((payee) => payee.transfer_acct).map((payee) => payee.id));
  const reviewCategories = new Set(
    (snapshot.categories ?? [])
      .filter((category) => category.name?.trim().toLocaleLowerCase('und') === 'needs review')
      .map((category) => category.id),
  );
  const personPayees = new Set((options.personPayees ?? []).map((name) => name.toLocaleLowerCase('und')));
  const grouped = new Map();

  for (const transaction of snapshot.transactions ?? []) {
    if (accounts.get(transaction.account)?.offbudget) continue;
    if (!transaction.payee || !transaction.category || reviewCategories.has(transaction.category)) continue;
    if (transaction.transfer_id || transferPayees.has(transaction.payee)) continue;
    if (!payees.has(transaction.payee) || !categories.has(transaction.category)) continue;

    const group = grouped.get(transaction.payee) ?? { categories: new Map(), variants: new Set() };
    group.categories.set(transaction.category, (group.categories.get(transaction.category) ?? 0) + 1);
    const variant = String(transaction.imported_payee ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (variant) group.variants.add(variant);
    grouped.set(transaction.payee, group);
  }

  const candidates = [];
  for (const [payeeId, group] of grouped) {
    const count = [...group.categories.values()].reduce((sum, current) => sum + current, 0);
    const [categoryId, dominantCount] = [...group.categories.entries()]
      .sort(([leftId, leftCount], [rightId, rightCount]) => rightCount - leftCount || leftId.localeCompare(rightId))[0];
    const confidence = dominantCount / count;
    if (count < minCount || confidence < minConfidence) continue;
    const payeeName = payees.get(payeeId).name;
    const flags = riskFlags(payeeName, personPayees);
    candidates.push({
      payee_id: payeeId,
      payee_name: payeeName,
      count,
      dominant_category_id: categoryId,
      dominant_category: categories.get(categoryId).name,
      confidence,
      imported_payee_variants: [...group.variants].sort((left, right) => left.localeCompare(right)),
      risk_flags: flags,
      manual_only: flags.length > 0,
    });
  }
  return candidates.sort((left, right) => right.count - left.count || left.payee_name.localeCompare(right.payee_name));
}

export function renderHuman(candidates) {
  const lines = ['Actual native rule candidates (read-only)', ''];
  for (const candidate of candidates) {
    const review = candidate.manual_only ? ` MANUAL ONLY: ${candidate.risk_flags.join(', ')}` : '';
    lines.push(`${candidate.payee_name} -> ${candidate.dominant_category} (${candidate.count}, ${(candidate.confidence * 100).toFixed(1)}%)${review}`);
    for (const variant of candidate.imported_payee_variants) lines.push(`  imported: ${variant}`);
  }
  if (candidates.length === 0) lines.push('No candidates meet the thresholds.');
  return lines.join('\n');
}

export async function run(argv) {
  const args = parseArgs(argv);
  const minCount = finiteThreshold(args['min-count'], 3, 'min-count', { integer: true });
  const minConfidence = finiteThreshold(args['min-confidence'], 0.9, 'min-confidence');
  const snapshot = await withActual(async (api) => {
    const accounts = await api.getAccounts();
    const categories = await api.getCategories();
    const payees = await api.getPayees();
    const transactions = [];
    for (const account of accounts) {
      const accountTransactions = await api.getTransactions(account.id, '1900-01-01', '2100-01-01');
      transactions.push(...accountTransactions.map((transaction) => ({
        ...transaction,
        account: transaction.account ?? account.id,
      })));
    }
    return { accounts, categories, payees, transactions };
  });
  const candidates = generateRuleCandidates(snapshot, { minCount, minConfidence });
  console.log(args.json ? JSON.stringify(candidates, null, 2) : renderHuman(candidates));
}

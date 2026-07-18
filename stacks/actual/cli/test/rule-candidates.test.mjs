import assert from 'node:assert/strict';
import test from 'node:test';

import { generateRuleCandidates } from '../src/commands/rule-candidates.mjs';

function history(payee, categories) {
  return categories.map((category, index) => ({
    id: `${payee}-${index}`,
    account: 'checking',
    payee,
    category,
    imported_payee: `${payee} raw ${index % 2}`,
  }));
}

const base = {
  accounts: [
    { id: 'checking', name: 'Checking', offbudget: false },
    { id: 'portfolio', name: 'Portfolio', offbudget: true },
  ],
  categories: [
    { id: 'groceries', name: 'Groceries' },
    { id: 'shopping', name: 'Shopping' },
    { id: 'review', name: 'Needs Review' },
  ],
  payees: [
    { id: 'local-shop', name: 'Local Shop' },
    { id: 'mixed-shop', name: 'Mixed Shop' },
    { id: 'paypal', name: 'PayPal Europe' },
    { id: 'amazon', name: 'Amazon' },
    { id: 'klarna', name: 'Klarna' },
    { id: 'atm', name: 'ATM Withdrawal' },
    { id: 'person', name: 'Max Mustermann' },
    { id: 'transfer', name: 'Savings transfer', transfer_acct: 'savings' },
  ],
};

test('scores dominant categories and keeps risky payees manual-only regardless of score', () => {
  const snapshot = {
    ...base,
    transactions: [
      ...history('local-shop', Array(10).fill('groceries')),
      ...history('mixed-shop', [...Array(9).fill('groceries'), 'shopping']),
      ...history('paypal', Array(10).fill('shopping')),
      ...history('amazon', Array(10).fill('shopping')),
      ...history('klarna', Array(10).fill('shopping')),
      ...history('atm', Array(10).fill('shopping')),
      ...history('person', Array(10).fill('shopping')),
    ],
  };

  const candidates = generateRuleCandidates(snapshot, {
    minCount: 3,
    minConfidence: 0.9,
    personPayees: ['Max Mustermann'],
  });

  const byPayee = new Map(candidates.map((candidate) => [candidate.payee_name, candidate]));
  assert.equal(byPayee.get('Local Shop').confidence, 1);
  assert.equal(byPayee.get('Mixed Shop').confidence, 0.9);
  assert.equal(byPayee.get('Local Shop').manual_only, false);
  for (const name of ['PayPal Europe', 'Amazon', 'Klarna', 'ATM Withdrawal', 'Max Mustermann']) {
    assert.equal(byPayee.get(name).manual_only, true, name);
    assert.ok(byPayee.get(name).risk_flags.length > 0, name);
  }
});

test('uses only reviewed on-budget non-transfer history and returns stable raw variants', () => {
  const snapshot = {
    ...base,
    transactions: [
      ...history('local-shop', Array(3).fill('groceries')),
      { id: 'unreviewed', account: 'checking', payee: 'local-shop', category: null },
      { id: 'fallback', account: 'checking', payee: 'local-shop', category: 'review' },
      { id: 'offbudget', account: 'portfolio', payee: 'local-shop', category: 'shopping' },
      { id: 'linked-transfer', account: 'checking', payee: 'local-shop', category: 'shopping', transfer_id: 'mirror' },
      { id: 'transfer-payee', account: 'checking', payee: 'transfer', category: 'shopping' },
    ],
  };
  const before = structuredClone(snapshot);

  const candidates = generateRuleCandidates(snapshot, { minCount: 3, minConfidence: 0.9 });

  assert.deepEqual(snapshot, before);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].count, 3);
  assert.equal(candidates[0].dominant_category, 'Groceries');
  assert.deepEqual(candidates[0].imported_payee_variants, ['local-shop raw 0', 'local-shop raw 1']);
});

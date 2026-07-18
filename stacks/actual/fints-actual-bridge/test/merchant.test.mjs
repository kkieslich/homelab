import test from 'node:test';
import assert from 'node:assert/strict';

import { extractCardMerchant } from '../src/importer/merchant.mjs';

test('extracts a domestic card merchant', () => {
  assert.equal(extractCardMerchant('REWE TESTMARKT DEU Berlin EUR 26,90 Umsatz vom 08.07.2026 MC Hauptkarte'), 'REWE TESTMARKT');
});

test('extracts a foreign card merchant before exchange-rate details', () => {
  assert.equal(extractCardMerchant('HIGHWAY TOLL JPN FUKUOKA JPY 1.070,00 KURS: 185,44 1,50% AUSLANDSUMS. 0,09Umsatz vom 16.06.2026'), 'HIGHWAY TOLL');
});

test('rejects numeric-only merchant references', () => {
  assert.equal(extractCardMerchant('22207136 DEU BERLIN EUR 20,00 Umsatz vom 13.07.2026 MC Hauptkarte'), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { reconciledDay } from '../src/sync.mjs';

test('epoch-ms string maps to the Berlin calendar day', () => {
  // 2026-07-21T23:30:00Z is already July 22 in Europe/Berlin (CEST, UTC+2).
  assert.equal(reconciledDay(String(Date.UTC(2026, 6, 21, 23, 30)), 'Europe/Berlin'), '2026-07-22');
  assert.equal(reconciledDay(String(Date.UTC(2026, 0, 15, 12, 0)), 'Europe/Berlin'), '2026-01-15');
});

test('ISO day passes through unchanged', () => {
  assert.equal(reconciledDay('2026-07-18', 'Europe/Berlin'), '2026-07-18');
});

test('garbage, empty, and short numerics return null', () => {
  assert.equal(reconciledDay('not-a-date', 'Europe/Berlin'), null);
  assert.equal(reconciledDay('', 'Europe/Berlin'), null);
  assert.equal(reconciledDay(null, 'Europe/Berlin'), null);
  assert.equal(reconciledDay('12345', 'Europe/Berlin'), null);
  assert.equal(reconciledDay('2026-13-40', 'Europe/Berlin'), null);
});

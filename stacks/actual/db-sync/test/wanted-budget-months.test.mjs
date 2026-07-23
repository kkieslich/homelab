import test from 'node:test';
import assert from 'node:assert/strict';
import { wantedBudgetMonths } from '../src/sync.mjs';

test('returns the current and previous Actual budget month', () => {
  // 2026-07-15T12:00:00Z is July 15 in Europe/Berlin (CEST, UTC+2).
  assert.deepEqual(wantedBudgetMonths(new Date(Date.UTC(2026, 6, 15, 12, 0))), ['2026-07', '2026-06']);
});

test('crosses a January -> December year boundary', () => {
  // 2026-01-05T12:00:00Z is January 5 in Europe/Berlin (CET, UTC+1).
  assert.deepEqual(wantedBudgetMonths(new Date(Date.UTC(2026, 0, 5, 12, 0))), ['2026-01', '2025-12']);
});

test('defaults to the current instant when no date is supplied', () => {
  const [current, previous] = wantedBudgetMonths();
  assert.equal(current.length, 7);
  assert.notEqual(current, previous);
});

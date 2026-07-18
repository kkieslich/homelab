import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Grafana mounts the DELETE-journal Actual replica read-only', () => {
  const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /actual-db:\/actual-db:ro/);
  assert.doesNotMatch(compose, /WAL mode requires every reader/);
});

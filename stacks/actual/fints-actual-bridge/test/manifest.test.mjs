import assert from 'node:assert/strict';
import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { pruneRunManifests, readRunManifests } from '../src/importer/manifest.mjs';

function validManifest(run_id, overrides = {}) {
  return {
    schema_version: 1, run_id, source: 'fints-fixture',
    started_at: '2026-07-18T09:00:00Z', finished_at: '2026-07-18T09:01:00Z',
    requested_range: { from: '2026-07-01', to: '2026-07-18' },
    accounts: [], outcome: 'success', error_code: null,
    ...overrides,
  };
}

test('readRunManifests returns an empty array for a missing directory', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'manifest-')), 'does-not-exist');
  assert.deepEqual(await readRunManifests(dir), []);
});

test('readRunManifests parses valid schema_version 1 manifests in filename order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
  await writeFile(join(dir, 'b.json'), JSON.stringify(validManifest('run-b')));
  await writeFile(join(dir, 'a.json'), JSON.stringify(validManifest('run-a')));
  const manifests = await readRunManifests(dir);
  assert.deepEqual(manifests.map((m) => m.run_id), ['run-a', 'run-b']);
});

test('readRunManifests rejects manifests missing schema_version 1 or required identity fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
  await writeFile(join(dir, 'no-schema.json'), JSON.stringify({ run_id: 'x', source: 's', finished_at: 'f' }));
  await writeFile(join(dir, 'wrong-schema.json'), JSON.stringify(validManifest('run-wrong', { schema_version: 2 })));
  await writeFile(join(dir, 'missing-run-id.json'), JSON.stringify(validManifest(undefined)));
  await writeFile(join(dir, 'missing-source.json'), JSON.stringify(validManifest('run-x', { source: undefined })));
  await writeFile(join(dir, 'missing-finished-at.json'), JSON.stringify(validManifest('run-y', { finished_at: undefined })));
  await writeFile(join(dir, 'non-json.json'), 'not json at all');
  assert.deepEqual(await readRunManifests(dir), []);
});

test('readRunManifests tolerates a corrupt/truncated file among otherwise-valid ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
  await writeFile(join(dir, 'a-corrupt.json'), '{ "schema_version": 1, "run_id": "trunc');
  await writeFile(join(dir, 'b-valid.json'), JSON.stringify(validManifest('run-valid')));
  const manifests = await readRunManifests(dir);
  assert.deepEqual(manifests.map((m) => m.run_id), ['run-valid']);
});

test('readRunManifests ignores non-.json files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
  await writeFile(join(dir, 'run.json'), JSON.stringify(validManifest('run-1')));
  await writeFile(join(dir, 'README.md'), '# not a manifest');
  const manifests = await readRunManifests(dir);
  assert.deepEqual(manifests.map((m) => m.run_id), ['run-1']);
});

test('readRunManifests skips run ids present in skipRunIds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
  await writeFile(join(dir, 'a.json'), JSON.stringify(validManifest('run-a')));
  await writeFile(join(dir, 'b.json'), JSON.stringify(validManifest('run-b')));
  const manifests = await readRunManifests(dir, { skipRunIds: new Set(['run-a']) });
  assert.deepEqual(manifests.map((m) => m.run_id), ['run-b']);
});

test('pruneRunManifests returns 0 for a missing directory', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'manifest-')), 'does-not-exist');
  assert.equal(await pruneRunManifests(dir), 0);
});

test('pruneRunManifests removes only .json files older than the retention window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
  await writeFile(join(dir, 'old.json'), JSON.stringify(validManifest('run-old')));
  await writeFile(join(dir, 'recent.json'), JSON.stringify(validManifest('run-recent')));
  await writeFile(join(dir, 'old-not-json.txt'), 'irrelevant');
  const now = new Date('2026-07-22T00:00:00Z');
  const old = new Date(now.getTime() - 91 * 86400000);
  const recent = new Date(now.getTime() - 10 * 86400000);
  await utimes(join(dir, 'old.json'), old, old);
  await utimes(join(dir, 'recent.json'), recent, recent);
  await utimes(join(dir, 'old-not-json.txt'), old, old);

  const pruned = await pruneRunManifests(dir, { now });

  assert.equal(pruned, 1);
  const remaining = (await readdir(dir)).sort();
  assert.deepEqual(remaining, ['old-not-json.txt', 'recent.json']);
});

test('pruneRunManifests respects a custom maxAgeDays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manifest-'));
  await writeFile(join(dir, 'a.json'), JSON.stringify(validManifest('run-a')));
  const now = new Date('2026-07-22T00:00:00Z');
  const fiveDaysAgo = new Date(now.getTime() - 5 * 86400000);
  await utimes(join(dir, 'a.json'), fiveDaysAgo, fiveDaysAgo);

  assert.equal(await pruneRunManifests(dir, { now, maxAgeDays: 90 }), 0);
  assert.equal(await pruneRunManifests(dir, { now, maxAgeDays: 3 }), 1);
});

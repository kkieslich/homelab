import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

export async function writeRunManifest(path, manifest) {
  const directory = dirname(path);
  await fs.mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

// The one validated manifest reader shared by the importer (prior-batch
// evidence) and db-sync (pipeline_runs projection). Deliberately strict:
// schema_version must be exactly 1 and the identity fields must be present,
// so a corrupt/incomplete/future-schema file is never counted as evidence in
// either consumer. `skipRunIds` lets a caller avoid re-reading manifests
// whose run is already durably recorded elsewhere (e.g. the sync DB): both
// writers name manifests `${run_id}.json`, so a skipped run's file is
// filtered by filename without being opened, with a post-parse run_id check
// as a safety net for files whose name doesn't match their content.
export async function readRunManifests(directory, { skipRunIds = new Set() } = {}) {
  let names;
  try { names = await fs.readdir(directory); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const manifests = [];
  for (const name of names.filter((name) => name.endsWith('.json')).sort()) {
    if (skipRunIds.has(name.slice(0, -'.json'.length))) continue;
    let value = null;
    try { value = JSON.parse(await fs.readFile(join(directory, name), 'utf8')); }
    catch { continue; /* corrupt/incomplete file is never evidence */ }
    if (value?.schema_version !== 1 || !value.run_id || !value.source || !value.finished_at) continue;
    if (skipRunIds.has(value.run_id)) continue;
    manifests.push(value);
  }
  return manifests;
}

// Manifests are transport with bounded retention; run history lives on in
// the projection DB's pipeline_runs table (see stacks/actual/README.md).
export async function pruneRunManifests(directory, { maxAgeDays = 90, now = new Date() } = {}) {
  let names;
  try { names = await fs.readdir(directory); }
  catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
  const cutoffMs = now.getTime() - maxAgeDays * 86400000;
  let pruned = 0;
  for (const name of names.filter((name) => name.endsWith('.json'))) {
    const file = join(directory, name);
    try {
      if ((await fs.stat(file)).mtimeMs < cutoffMs) { await fs.unlink(file); pruned += 1; }
    } catch { /* a concurrently removed file is fine */ }
  }
  return pruned;
}

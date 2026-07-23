import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const bridgeDir = fileURLToPath(new URL('..', import.meta.url));
const composeFile = resolve(bridgeDir, '..', 'docker-compose.yml');

test('Baader runs as an interactive persistent daemon with guarded imports', async () => {
  const { stdout } = await execFileAsync(
    'docker',
    ['compose', '-f', composeFile, 'config', '--format', 'json'],
    { cwd: resolve(bridgeDir, '..') },
  );
  const config = JSON.parse(stdout);
  const daemon = config.services.fints_daemon_baader;

  assert.ok(daemon, 'persistent fints_daemon_baader service must exist');
  assert.equal(config.services.fints_sync_baader, undefined);
  assert.equal(daemon.container_name, 'fints_daemon_baader');
  assert.equal(daemon.stdin_open, true);
  assert.equal(daemon.tty, true);
  assert.equal(daemon.restart, 'on-failure:3');
  assert.deepEqual(daemon.profiles ?? [], []);

  const command = Array.isArray(daemon.command)
    ? daemon.command.join(' ')
    : daemon.command;
  assert.match(command, /fints-daemon/);
  assert.match(command, /--bank(?:=| )fnz/);
  assert.match(command, /--out(?:=| )\/state\/fnz-fetch\.json/);
  assert.match(command, /--fetch-interval(?:=| )3600/);
  assert.match(command, /--heartbeat-interval(?:=| )180/);
  assert.match(command, /--days(?:=| )30/);
  assert.match(command, /--import-after/);
  assert.match(command, /--registry \/app\/accounts\.json/);
  assert.match(command, /--manifest-dir \/state\/import-runs/);
});

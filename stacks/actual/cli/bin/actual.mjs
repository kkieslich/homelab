#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.resolve(HERE, '../src/commands');

const COMMANDS = {
  fetch:            'Download the latest budget snapshot to the local cache.',
  analyze:          'Spending breakdown by category over a rolling window.',
  subs:             'Detect recurring subscriptions from transaction cadence.',
  'audit-imports':  'Audit import IDs, duplicate candidates, payees, and categories (read-only).',
  'rule-candidates': 'Suggest conservative native Actual rules from reviewed history (read-only).',
  categorize:       'Apply rule-based categorization (config/categorization.json).',
  'fixup-transfers': 'Link orphan transfer txs (payee=transfer-payee but no transfer_id) by creating their missing mirrors.',
};

function printHelp() {
  console.error('Usage: actual <command> [options]\n\nCommands:');
  for (const [name, desc] of Object.entries(COMMANDS)) {
    console.error(`  ${name.padEnd(12)} ${desc}`);
  }
  console.error('\nRun `actual <command> --help` for command-specific options.');
}

const [, , cmd, ...rest] = process.argv;
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printHelp();
  process.exit(cmd ? 0 : 2);
}
if (!(cmd in COMMANDS)) {
  console.error(`Unknown command: ${cmd}\n`);
  printHelp();
  process.exit(2);
}

const mod = await import(pathToFileURL(path.join(COMMANDS_DIR, `${cmd}.mjs`)));
await mod.run(rest);

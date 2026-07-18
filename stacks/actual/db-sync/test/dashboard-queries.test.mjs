import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARDS = path.resolve(HERE, '../../../monitoring/grafana/provisioning/dashboards');
const SCHEMA = fs.readFileSync(path.resolve(HERE, '../src/schema.sql'), 'utf8');
const EXPECTED = new Map([
  ['actual-home.json', 'actual-home'],
  ['actual-monthly.json', 'actual-monthly'],
  ['actual-investments-pipeline.json', 'actual-investments-pipeline'],
]);
const CANONICAL = new Set([
  'accounts', 'current_budgets', 'budget_snapshots', 'net_worth_snapshots',
  'ordinary_income', 'consumption', 'savings_contributions', 'review_queue',
  'finance_trust', 'holdings', 'holdings_history', 'pipeline_runs',
  'expected_sources', 'data_quality',
]);

function queries(value, found = []) {
  if (Array.isArray(value)) for (const item of value) queries(item, found);
  else if (value && typeof value === 'object') {
    if (typeof value.rawQueryText === 'string') found.push(value.rawQueryText);
    for (const child of Object.values(value)) queries(child, found);
  }
  return found;
}

function substituteGrafanaVariables(sql) {
  return sql
    .replaceAll(/\$\{[^}:]+:sqlstring\}/g, "'all'")
    .replaceAll(/\$\{[^}:]+:csv\}/g, 'all')
    .replaceAll(/\$\{[^}]+\}/g, '30')
    .replaceAll(/\$__timeFrom\(\)/g, "datetime('now','-30 days')")
    .replaceAll(/\$__timeTo\(\)/g, "datetime('now')");
}

function referencedRelations(sql) {
  return [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)]
    .map(match => match[1].toLowerCase())
    .filter(name => !['latest', 'latest_runs', 'months', 'monthly', 'cur', 'prev',
      'roles', 'payee_baseline', 'latest_capture', 'portfolio', 'run_days'].includes(name));
}

test('ships exactly the three Actual-first dashboards with stable UIDs', () => {
  const actualFiles = fs.readdirSync(DASHBOARDS)
    .filter(name => name.startsWith('actual-') && name.endsWith('.json'))
    .sort();
  assert.deepEqual(actualFiles, [...EXPECTED.keys()].sort());
  for (const [name, uid] of EXPECTED) {
    const dashboard = JSON.parse(fs.readFileSync(path.join(DASHBOARDS, name), 'utf8'));
    assert.equal(dashboard.uid, uid);
    assert.ok(dashboard.panels.length >= 6, `${name} needs a useful summary-to-detail layout`);
    assert.ok(dashboard.panels.every(panel => panel.description?.trim()), `${name} panels need definitions/freshness context`);
  }
});

test('every dashboard query prepares against the canonical projection schema', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  try {
    for (const name of EXPECTED.keys()) {
      const dashboard = JSON.parse(fs.readFileSync(path.join(DASHBOARDS, name), 'utf8'));
      for (const raw of queries(dashboard)) {
        const sql = substituteGrafanaVariables(raw);
        assert.doesNotThrow(() => db.prepare(sql), `${name}: ${sql}`);
      }
    }
  } finally {
    db.close();
  }
});

test('dashboard SQL uses only canonical Task 9-10 relations', () => {
  for (const name of EXPECTED.keys()) {
    const dashboard = JSON.parse(fs.readFileSync(path.join(DASHBOARDS, name), 'utf8'));
    for (const sql of queries(dashboard)) {
      for (const relation of referencedRelations(sql)) {
        assert.ok(CANONICAL.has(relation), `${name} references non-canonical relation ${relation}`);
      }
      assert.doesNotMatch(sql, /\bFROM\s+transactions\b|\bJOIN\s+transactions\b/i);
    }
  }
});

test('financial headline queries are trust-gated or use immutable snapshots', () => {
  const home = JSON.parse(fs.readFileSync(path.join(DASHBOARDS, 'actual-home.json'), 'utf8'));
  const headlineTitles = new Set([
    'Net worth — close', 'Liquid — close',
    'Safe — month', 'Safe — day', 'Savings rate',
  ]);
  const headlines = home.panels.filter(panel => headlineTitles.has(panel.title));
  assert.equal(headlines.length, headlineTitles.size);
  for (const panel of headlines) {
    const sql = queries(panel).join('\n');
    assert.match(sql, /finance_trust|net_worth_snapshots/i, `${panel.title} must expose trust or immutable snapshot semantics`);
  }
});

test('trust and palette configuration remain legible without default green/red semantics', () => {
  for (const name of EXPECTED.keys()) {
    const raw = fs.readFileSync(path.join(DASHBOARDS, name), 'utf8');
    assert.doesNotMatch(raw, /\"mode\"\s*:\s*\"fixedColor\"/);
    assert.doesNotMatch(raw, /\"(?:green|red)\"/i);
  }
  const home = JSON.parse(fs.readFileSync(path.join(DASHBOARDS, 'actual-home.json'), 'utf8'));
  const trust = home.panels.find(panel => panel.title === 'Finance projection trust');
  assert.match(queries(trust)[0], /SELECT\s+trusted\s+AS\s+value/i);
  const mappings = trust.fieldConfig.defaults.mappings ?? [];
  assert.ok(JSON.stringify(mappings).includes('TRUSTED'));
  assert.ok(JSON.stringify(mappings).includes('DO NOT USE'));
});

test('stat titles fit compact Grafana cards', () => {
  for (const name of EXPECTED.keys()) {
    const dashboard = JSON.parse(fs.readFileSync(path.join(DASHBOARDS, name), 'utf8'));
    for (const panel of dashboard.panels.filter(item => item.type === 'stat')) {
      const limit = panel.gridPos.w <= 6 ? 18 : 24;
      assert.ok(panel.title.length <= limit, `${name}: stat title is too long: ${panel.title}`);
    }
  }
});

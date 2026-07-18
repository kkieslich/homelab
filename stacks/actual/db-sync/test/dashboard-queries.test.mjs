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
  const tokens = sql.match(/"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]+\]|'(?:''|[^'])*'|[a-z_][a-z0-9_$]*|[(),.;]/gi) ?? [];
  const word = token => token && !/^['(),.;]$/.test(token);
  const normalize = token => token.replace(/^(?:"|`|\[)|(?:"|`|\])$/g, '').replaceAll('""', '"').toLowerCase();
  const ctes = new Set();
  for (const match of sql.matchAll(/(?:^|,)\s*("(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]+\]|[a-z_][a-z0-9_$]*)\s*(?:\([^)]*\))?\s+AS\s*\(/gi)) {
    ctes.add(normalize(match[1]));
  }
  for (let i = 0; i < tokens.length; i++) {
    if (normalize(tokens[i]) !== 'with') continue;
    i++;
    if (normalize(tokens[i]) === 'recursive') i++;
    while (i < tokens.length && word(tokens[i])) {
      ctes.add(normalize(tokens[i]));
      while (i < tokens.length && normalize(tokens[i]) !== 'as') i++;
      if (tokens[++i] !== '(') break;
      let depth = 1;
      while (++i < tokens.length && depth) {
        if (tokens[i] === '(') depth++;
        else if (tokens[i] === ')') depth--;
      }
      if (tokens[i + 1] !== ',') break;
      i += 2;
    }
    break;
  }
  const relations = [];
  const fromDepths = new Set();
  let depth = 0;
  let expectSource = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const keyword = normalize(token);
    if (token === '(') { if (expectSource) expectSource = false; depth++; continue; }
    if (token === ')') { fromDepths.delete(depth); depth--; continue; }
    if (keyword === 'from') { fromDepths.add(depth); expectSource = true; continue; }
    if (keyword === 'join') { expectSource = true; continue; }
    if (['where', 'group', 'having', 'order', 'limit', 'union', 'except', 'intersect', 'returning'].includes(keyword)) {
      fromDepths.delete(depth); expectSource = false; continue;
    }
    if (token === ',' && fromDepths.has(depth)) { expectSource = true; continue; }
    if (!expectSource || !word(token) || token.startsWith("'")) continue;
    let relation = normalize(token);
    if (tokens[i + 1] === '.' && word(tokens[i + 2])) {
      relation = normalize(tokens[i + 2]);
      i += 2;
    }
    if (!ctes.has(relation)) relations.push(relation);
    expectSource = false;
  }
  return relations;
}

function panelByTitle(dashboard, title) {
  const panel = dashboard.panels.find(item => item.title === title);
  assert.ok(panel, `missing panel ${title}`);
  return panel;
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

test('every financial target exposes a query-level freshness field', () => {
  const financialPanels = {
    'actual-home.json': ['Net worth — close', 'Liquid — close', 'Safe — month', 'Safe — day',
      'Savings rate', 'Current envelope funding and consumption by role'],
    'actual-monthly.json': ['Income — close', 'Spend — close', 'Savings rate', 'Contributions',
      'Monthly income, consumption, and contributions', 'Consumption mix by canonical role',
      'Month-over-month category drivers', 'Month-over-month merchant drivers',
      'Consumption and three-month rolling average', 'Annualized irregular-cost funding',
      'Recent unusual consumption'],
    'actual-investments-pipeline.json': ['Contributions', 'Portfolio value', 'Holdings valued',
      'Reported portfolio value over time', 'Current portfolio allocation'],
  };
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  try {
    for (const [name, titles] of Object.entries(financialPanels)) {
      const dashboard = JSON.parse(fs.readFileSync(path.join(DASHBOARDS, name), 'utf8'));
      for (const title of titles) {
        for (const sql of queries(panelByTitle(dashboard, title))) {
          const columns = db.prepare(substituteGrafanaVariables(sql)).columns().map(column => column.name.toLowerCase());
          assert.ok(columns.some(column => ['data_as_of', 'captured_at', 'evaluated_at', 'latest_month'].includes(column)),
            `${name} / ${title} lacks a query-level freshness field: ${columns.join(', ')}`);
        }
      }
    }
  } finally {
    db.close();
  }
});

test('relation extraction rejects quoted, qualified, and comma-joined non-canonical sources', () => {
  for (const sql of [
    'SELECT * FROM "transactions"',
    'SELECT * FROM main.transactions AS t',
    'SELECT * FROM accounts a, transactions t WHERE a.id=t.account_id',
  ]) {
    assert.ok(referencedRelations(sql).includes('transactions'), sql);
    assert.throws(() => {
      for (const relation of referencedRelations(sql)) assert.ok(CANONICAL.has(relation), relation);
    }, /transactions/);
  }
  assert.deepEqual(referencedRelations('WITH monthly AS (SELECT month FROM consumption) SELECT * FROM monthly JOIN accounts a ON 1=1').sort(),
    ['accounts', 'consumption']);
  assert.deepEqual(referencedRelations('SELECT * FROM "main"."ordinary_income" i'), ['ordinary_income']);
});

test('month-over-month drivers compare the two latest observed closes including appeared and disappeared items', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO accounts VALUES ('checking','Checking',0,0,0)`).run();
  db.prepare(`INSERT INTO budget_snapshots VALUES
    ('2026-04','2026-04-30T23:00:00Z','c','Category','essential',0,0,0,0),
    ('2026-06','2026-06-30T23:00:00Z','c','Category','essential',0,0,0,0)`).run();
  const insert = db.prepare(`INSERT INTO transactions
    (id,date,account_id,account_name,account_offbudget,amount_cents,payee_name,category_id,
     category_name,category_group_name,category_role,category_is_income,cleared,reconciled,
     is_transfer,imported_id,year,month,ymd_unix)
    VALUES (@id,@date,'checking','Checking',0,@amount,@payee,@category,@category,
      'Flexible essentials','essential',0,1,1,0,@id,@year,@month,@unix)`);
  for (const row of [
    ['april-stay','2026-04-03',-10000,'Shop Stay','Stay'],
    ['april-gone','2026-04-04',-5000,'Shop Gone','Gone'],
    ['june-stay','2026-06-03',-13000,'Shop Stay','Stay'],
    ['june-new','2026-06-04',-2000,'Shop New','New'],
  ]) {
    const [id, date, amount, payee, category] = row;
    insert.run({ id, date, amount, payee, category, year: Number(date.slice(0, 4)), month: date.slice(0, 7), unix: Date.parse(`${date}T00:00:00Z`) / 1000 });
  }
  const dashboard = JSON.parse(fs.readFileSync(path.join(DASHBOARDS, 'actual-monthly.json'), 'utf8'));
  for (const [title, label] of [['Month-over-month category drivers', 'Category'], ['Month-over-month merchant drivers', 'Merchant']]) {
    const rows = db.prepare(queries(panelByTitle(dashboard, title))[0]).all();
    const gone = rows.find(row => row[label] === (label === 'Category' ? 'Gone' : 'Shop Gone'));
    const appeared = rows.find(row => row[label] === (label === 'Category' ? 'New' : 'Shop New'));
    assert.equal(gone['Change EUR'], -50);
    assert.equal(appeared['Change EUR'], 20);
    assert.equal(gone.latest_month, '2026-06');
    assert.equal(gone.prior_month, '2026-04');
  }
  db.close();
});

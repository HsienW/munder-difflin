'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  HIVE_COST_LEDGER_FILE_NAME,
  HIVE_LOG_FILE_NAME,
  HiveManager
} = loadTs('src/main/hive.ts');

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jsonl-append-'));
  const root = path.join(home, 'hive');
  fs.mkdirSync(root);
  const hive = new HiveManager(() => home);
  t.after(() => {
    hive.closeAppendFiles();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, root, hive };
}

function sample(usd) {
  return {
    agentId: 'agent-1', sessionId: 'session-1', ts: 123,
    input: 1, output: 2, cacheRead: 3, cacheCreation: 4,
    model: 'model-1', usd
  };
}

test('Hive log and ledger preserve their schemas across close and reopen', (t) => {
  const { root, hive } = setup(t);
  hive.appendLog({ kind: 'first' });
  hive.appendLog({ kind: 'second' });
  hive.appendCostLedger(sample(1));
  hive.appendCostLedger(sample(2));

  assert.ok(hive.lastLogAppendAt() > 0);
  hive.closeAppendFiles();
  hive.appendLog({ kind: 'third' });

  const logs = fs.readFileSync(path.join(root, HIVE_LOG_FILE_NAME), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.deepEqual(logs.map((row) => row.kind), ['first', 'second', 'third']);
  assert.equal(logs.every((row) => typeof row.ts === 'number'), true);

  const ledger = fs.readFileSync(path.join(root, HIVE_COST_LEDGER_FILE_NAME), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.deepEqual(ledger.map((row) => row.usd), [1, 2]);
  assert.deepEqual(Object.keys(ledger[0]), [
    'agent_id', 'session_id', 'ts', 'input', 'output',
    'cache_read', 'cache_creation', 'model', 'usd'
  ]);
});

test('serialization failures are contained and do not claim log activity', (t) => {
  const { root, hive } = setup(t);
  const cyclic = {};
  cyclic.self = cyclic;

  assert.doesNotThrow(() => hive.appendLog(cyclic));
  assert.equal(hive.lastLogAppendAt(), 0);
  assert.equal(fs.existsSync(path.join(root, HIVE_LOG_FILE_NAME)), false);
});

test('append never recreates a removed Hive root', (t) => {
  const { root, hive } = setup(t);
  hive.appendLog({ kind: 'before-remove' });
  hive.closeAppendFiles();
  fs.rmSync(root, { recursive: true, force: true });

  assert.doesNotThrow(() => hive.appendLog({ kind: 'after-remove' }));
  assert.doesNotThrow(() => hive.appendCostLedger(sample(1)));
  assert.equal(fs.existsSync(root), false);
});

test('malformed and NUL-terminated historical tails are never rewritten', (t) => {
  const { root, hive } = setup(t);
  const file = path.join(root, HIVE_LOG_FILE_NAME);
  const tail = Buffer.from('{"unfinished":\u0000', 'utf8');
  fs.writeFileSync(file, tail);

  assert.doesNotThrow(() => hive.appendLog({ kind: 'after-tail' }));
  hive.closeAppendFiles();

  const content = fs.readFileSync(file);
  assert.deepEqual(content.subarray(0, tail.length), tail);
  assert.ok(content.subarray(tail.length).includes(Buffer.from('"kind":"after-tail"')));
});

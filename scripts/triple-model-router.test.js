'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createRouter,
  appendLog,
  loadClassifierPrompt,
  parseClassification,
  pickTier,
} = require('./triple-model-router.js');

const MODELS = { T1: 't1', T2: 't2', T2_fallback: 't2b', T3: 't3' };
const CLASSIFIER = 'You route one task to a tier.';

function classification(tier, conf = 0.9, reason = 'one_step') {
  return JSON.stringify({ tier, reason, conf });
}

/** Fake backend. `script(model, prompt)` returns text, or throws to simulate a failed call. */
function stubBackend(script) {
  const calls = [];
  const backend = async ({ model, prompt }) => {
    calls.push(model);
    const text = script(model, prompt);
    if (text instanceof Error) throw text;
    return { text, in_tok: 10, out_tok: 5 };
  };
  backend.calls = calls;
  return backend;
}

const isClassifierCall = (prompt) => prompt.startsWith(CLASSIFIER);

test('hard-floor flag goes straight to T3 without a classifier call', async () => {
  const backend = stubBackend(() => 'answer');
  const router = createRouter({ backend, models: MODELS, classifierPrompt: CLASSIFIER });
  const rec = await router.handle({ id: '1', type: 'review', flags: ['identity'], text: 'who am I' });
  assert.deepEqual(backend.calls, ['t3']);
  assert.equal(rec.tier, 'T3');
  assert.equal(rec.reason, 'identity');
  assert.equal(rec.verify, 'pass');
});

test('confident T1 classification runs on T1', async () => {
  const backend = stubBackend((model, prompt) => (isClassifierCall(prompt) ? classification('T1', 0.9) : 'label: spam'));
  const router = createRouter({ backend, models: MODELS, classifierPrompt: CLASSIFIER });
  const rec = await router.handle({ id: '2', type: 'classify', text: 'buy now' });
  assert.deepEqual(backend.calls, ['t1', 't1']);
  assert.equal(rec.tier, 'T1');
  assert.equal(rec.output, 'label: spam');
});

test('a T3 suggestion without a hard-floor flag is downgraded to T2', async () => {
  const backend = stubBackend((model, prompt) => (isClassifierCall(prompt) ? classification('T3', 0.95) : 'done'));
  const router = createRouter({ backend, models: MODELS, classifierPrompt: CLASSIFIER });
  const rec = await router.handle({ id: '3', type: 'summary', text: 'long doc' });
  assert.deepEqual(backend.calls, ['t1', 't2']);
  assert.equal(rec.tier, 'T2');
});

test('a failing T2 call retries once on the fallback with the same prompt', async () => {
  const prompts = [];
  const backend = stubBackend((model, prompt) => {
    if (isClassifierCall(prompt)) return classification('T2', 0.9, 'multi_step');
    prompts.push(prompt);
    if (model === 't2') return new Error('overloaded');
    return 'fallback answer';
  });
  const router = createRouter({ backend, models: MODELS, classifierPrompt: CLASSIFIER });
  const rec = await router.handle({ id: '4', type: 'summary', text: 'draft it' });
  assert.deepEqual(backend.calls, ['t1', 't2', 't2b']);
  assert.equal(prompts[0], prompts[1]);
  assert.equal(rec.output, 'fallback answer');
  assert.equal(rec.tier, 'T2');
  assert.equal(rec.esc, 0);
});

test('a failed verification escalates T1 to T2 exactly once', async () => {
  const backend = stubBackend((model, prompt) => {
    if (isClassifierCall(prompt)) return classification('T1', 0.9);
    return model === 't1' ? 'bad' : 'OK: verified';
  });
  const router = createRouter({ backend, models: MODELS, classifierPrompt: CLASSIFIER });
  const rec = await router.handle({ id: '5', type: 'extract', text: 'pull ids', check: (out) => out.startsWith('OK') });
  assert.equal(rec.tier, 'T2');
  assert.equal(rec.esc, 1);
  assert.equal(rec.verify, 'pass');
});

test('a T3 failure has nowhere to escalate and is logged as fail', async () => {
  const backend = stubBackend(() => 'nope');
  const router = createRouter({ backend, models: MODELS, classifierPrompt: CLASSIFIER });
  const rec = await router.handle({
    id: '6',
    type: 'review',
    flags: ['high_stakes_review'],
    text: 'audit',
    check: () => false,
  });
  assert.equal(rec.tier, 'T3');
  assert.equal(rec.verify, 'fail');
  assert.equal(rec.esc, 0);
});

test('repeat of a passing task is served from cache with no model calls', async () => {
  const backend = stubBackend((model, prompt) => (isClassifierCall(prompt) ? classification('T1', 0.9) : 'cached'));
  const router = createRouter({ backend, models: MODELS, classifierPrompt: CLASSIFIER });
  await router.handle({ id: '7a', type: 'classify', text: 'same input' });
  const callsAfterFirst = backend.calls.length;
  const rec = await router.handle({ id: '7b', type: 'classify', text: 'same input' });
  assert.equal(backend.calls.length, callsAfterFirst);
  assert.equal(rec.tier, 'T0');
  assert.equal(rec.reason, 'cache');
  assert.equal(rec.output, 'cached');
});

test('a deterministic transform never reaches a model', async () => {
  const backend = stubBackend(() => 'should not run');
  const router = createRouter({ backend, models: MODELS, classifierPrompt: CLASSIFIER });
  const rec = await router.handle({ id: '8', text: 'abc', transform: (t) => t.toUpperCase() });
  assert.deepEqual(backend.calls, []);
  assert.equal(rec.tier, 'T0');
  assert.equal(rec.output, 'ABC');
});

test('unparseable classifier output routes to T2 with reason unclear', () => {
  assert.deepEqual(parseClassification('not json at all'), { tier: 'T2', reason: 'unclear', conf: 0 });
  assert.equal(pickTier({ tier: 'T1', conf: 0.5 }), 'T2');
  assert.equal(pickTier({ tier: 'T1', conf: 0.8 }), 'T1');
});

test('missing model config is rejected at construction', () => {
  assert.throws(
    () => createRouter({ backend: stubBackend(() => ''), models: { T1: 't1', T2: 't2' }, classifierPrompt: CLASSIFIER }),
    /missing model for T3/,
  );
});

test('usage log writes one JSON line per call with the SOP §7 fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
  const file = path.join(dir, 'router-usage.jsonl');
  const backend = stubBackend((model, prompt) => (isClassifierCall(prompt) ? classification('T1', 0.9) : 'hi'));
  const router = createRouter({ backend, models: MODELS, classifierPrompt: CLASSIFIER, log: appendLog(file) });
  await router.handle({ id: '9', type: 'classify', text: 'hello' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  for (const field of ['ts', 'task', 'type', 'tier', 'reason', 'conf', 'esc', 'verify', 'in_tok', 'out_tok']) {
    assert.ok(field in lines[0], `missing field ${field}`);
  }
  assert.equal(lines[0].in_tok, 20);
  fs.rmSync(dir, { recursive: true });
});

test('classifier prompt loads from the reference file without the changelog', () => {
  const prompt = loadClassifierPrompt();
  assert.ok(prompt.startsWith('You route one task to a tier.'));
  assert.ok(!prompt.includes('## Changelog'));
});

#!/usr/bin/env node
/**
 * triple-model-router.js
 *
 * Starter router for the three-tier doctrine. Implements the dispatch order in
 * references/triple-model-router-sop.md (§2 to §7). No dependencies; needs Node 18+.
 *
 * Usage:
 *   ROUTER_T1_MODEL=<name> ROUTER_T2_MODEL=<name> ROUTER_T2_FALLBACK=<name> \
 *   ROUTER_T3_MODEL=<name> ANTHROPIC_API_KEY=<key> \
 *   node scripts/triple-model-router.js "question" [--type summary] [--flags identity,architecture]
 *
 * Model names come from env vars, so no model identifiers are committed to the repo.
 * Usage log: ROUTER_LOG (default ./router-usage.jsonl), one JSON line per call.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HARD_FLOOR = new Set([
  'identity',
  'architecture',
  'high_stakes_review',
  'irreversible',
  'precision_critical',
]);
const THRESHOLDS = { T1: 0.8, T2: 0.7 };
const NEXT_TIER = { T1: 'T2', T2: 'T3' };
const CLASSIFIER_FILE = path.join(__dirname, '..', 'references', 'triple-model-router-prompt-v2.md');

/** Pulls the prompt body out of the SOP-format file: the text between the first two `---` lines. */
function loadClassifierPrompt(file = CLASSIFIER_FILE) {
  const parts = fs.readFileSync(file, 'utf8').split(/^---$/m);
  if (parts.length < 3) throw new Error(`classifier prompt block not found in ${file}`);
  return parts[1].trim();
}

/** Parses the classifier's JSON. Anything unparseable is treated as "unclear", which routes to T2. */
function parseClassification(text) {
  try {
    const obj = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
    if (['T1', 'T2', 'T3'].includes(obj.tier) && typeof obj.conf === 'number') return obj;
  } catch {
    // fall through to the default below
  }
  return { tier: 'T2', reason: 'unclear', conf: 0 };
}

/** SOP §2 step 3. A T3 suggestion without a hard-floor flag is downgraded to T2. */
function pickTier(classification) {
  if (classification.tier === 'T1' && classification.conf >= THRESHOLDS.T1) return 'T1';
  return 'T2';
}

function defaultVerify(task, out) {
  if (typeof out !== 'string' || out.trim().length === 0) return false;
  return task.check ? Boolean(task.check(out)) : true;
}

function appendLog(file) {
  return (record) => fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

/**
 * Anthropic Messages API backend. Returns { text, in_tok, out_tok } using the usage
 * numbers the API reports, not estimates.
 */
function anthropicBackend({ apiKey = process.env.ANTHROPIC_API_KEY, maxTokens = 1024, fetchFn = fetch } = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  return async ({ model, prompt }) => {
    const res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`model call failed: HTTP ${res.status}`);
    const data = await res.json();
    const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { text, in_tok: data.usage?.input_tokens ?? 0, out_tok: data.usage?.output_tokens ?? 0 };
  };
}

/**
 * Builds a router. `backend({ model, prompt })` must resolve to { text, in_tok, out_tok }.
 * `models` is { T1, T2, T2_fallback, T3 }. T2_fallback is optional.
 */
function createRouter({
  backend,
  models,
  classifierPrompt,
  verify = defaultVerify,
  log = () => {},
  cacheTtlMs = 60 * 60 * 1000,
  now = () => Date.now(),
}) {
  for (const key of ['T1', 'T2', 'T3']) {
    if (!models[key]) throw new Error(`missing model for ${key}`);
  }
  const cache = new Map();

  async function generate(tier, prompt, usage) {
    const candidates = tier === 'T2' ? [models.T2, models.T2_fallback] : [models[tier]];
    let lastErr;
    for (const model of candidates.filter(Boolean)) {
      try {
        const r = await backend({ model, prompt });
        usage.in_tok += r.in_tok || 0;
        usage.out_tok += r.out_tok || 0;
        return r.text;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async function classify(task, usage) {
    const input = { type: task.type, flags: task.flags, text_tokens: Math.ceil(task.text.length / 4), text: task.text };
    try {
      const text = await generate('T1', `${classifierPrompt}\n\n${JSON.stringify(input)}`, usage);
      return parseClassification(text);
    } catch {
      return { tier: 'T2', reason: 'unclear', conf: 0 };
    }
  }

  function record(task, fields) {
    const rec = {
      ts: new Date(now()).toISOString(),
      task: task.id,
      type: task.type ?? null,
      ...fields,
    };
    log(rec);
    return rec;
  }

  async function handle(task) {
    const key = `${task.type ?? ''}\n${task.text}`;

    // SOP §2 step 1: deterministic work and cache hits never reach a model.
    if (task.transform) {
      const output = task.transform(task.text);
      return { ...record(task, { tier: 'T0', reason: 'template', esc: 0, verify: 'pass', in_tok: 0, out_tok: 0 }), output };
    }
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheTtlMs) {
      return { ...record(task, { tier: 'T0', reason: 'cache', esc: 0, verify: 'pass', in_tok: 0, out_tok: 0 }), output: hit.output };
    }

    // SOP §2 step 2: hard-floor flags go straight to T3.
    const usage = { in_tok: 0, out_tok: 0 };
    const flags = task.flags ?? [];
    const floorFlag = flags.find((f) => HARD_FLOOR.has(f));
    let tier;
    let reason;
    let conf = null;
    if (floorFlag) {
      tier = 'T3';
      reason = floorFlag;
    } else {
      // SOP §2 step 3: classify on T1.
      const classification = await classify(task, usage);
      tier = pickTier(classification);
      reason = classification.reason;
      conf = classification.conf;
    }

    // SOP §2 step 4 to §4: execute, verify, escalate once per tier.
    let esc = 0;
    let out;
    let verdict;
    for (;;) {
      try {
        out = await generate(tier, task.text, usage);
      } catch {
        out = undefined;
      }
      verdict = verify(task, out) ? 'pass' : 'fail';
      if (verdict === 'pass' || !NEXT_TIER[tier]) break;
      tier = NEXT_TIER[tier];
      esc += 1;
    }

    if (verdict === 'pass') cache.set(key, { output: out, at: now() });
    const rec = record(task, { tier, reason, conf, esc, verify: verdict, ...usage });
    return { ...rec, output: out };
  }

  return { handle };
}

function parseArgs(argv) {
  const args = { type: undefined, flags: [], text: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--type') args.type = argv[++i];
    else if (argv[i] === '--flags') args.flags = (argv[++i] ?? '').split(',').filter(Boolean);
    else args.text.push(argv[i]);
  }
  return { ...args, text: args.text.join(' ') };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.text) throw new Error('usage: node scripts/triple-model-router.js "<task>" [--type T] [--flags a,b]');
  const env = process.env;
  const router = createRouter({
    backend: anthropicBackend(),
    models: {
      T1: env.ROUTER_T1_MODEL,
      T2: env.ROUTER_T2_MODEL,
      T2_fallback: env.ROUTER_T2_FALLBACK,
      T3: env.ROUTER_T3_MODEL,
    },
    classifierPrompt: loadClassifierPrompt(),
    log: appendLog(env.ROUTER_LOG || 'router-usage.jsonl'),
  });
  const { output, ...rec } = await router.handle({ id: `cli-${Date.now()}`, type: args.type, flags: args.flags, text: args.text });
  process.stdout.write(`${output ?? ''}\n`);
  process.stderr.write(`${JSON.stringify(rec)}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = {
  createRouter,
  anthropicBackend,
  appendLog,
  loadClassifierPrompt,
  parseClassification,
  pickTier,
  HARD_FLOOR,
};

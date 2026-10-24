# Triple-Model Router — SOP

Companion to `token-reduction-doctrine.md` and `triple-model-router-prompt-v2.md`. The doctrine decides what each tier sends and stores; this SOP decides which tier handles each call.

## 1. Tiers

| Tier | Role | Runs on | Cost per token |
|------|------|---------|----------------|
| T0 | No model. Cache, template, or code path. | Local code | 0 |
| T1 | Chat, classification, slot-fill, reformat. | `<T1_MODEL>` (local or smallest hosted) | lowest model tier |
| T2 | Multi-step reasoning, long-context analysis, summarize-then-discard. | `<T2_MODEL>` (cheap reasoning API) with `<T2_FALLBACK>` | ~10–20× below T3 |
| T3 | Precision work and hard-floor purposes. | `<T3_MODEL>` (heavy) | highest |

Model names are configuration, not part of this SOP. Set them in the router config. They are placeholders here so the SOP stays valid across model swaps.

## 2. Dispatch order

Evaluate top to bottom. Stop at the first match.

1. **Deterministic?** Cache hit (within TTL), fixed transform (parse, regex, format), or templated reply → **T0**. No model call.
2. **Hard floor?** Any flag in §3 → **T3**, no classification.
3. **Classify.** Run the T1 classifier (`triple-model-router-prompt-v2.md`). It returns `tier`, `reason`, `confidence`.
   - `tier = T1` and `confidence ≥ 0.80` → **T1**.
   - `tier = T2` and `confidence ≥ 0.70` → **T2**.
   - Otherwise → **T2** (cheap default for anything non-trivial), unless a hard-floor flag applies.
4. **Execute** on the chosen tier.
5. **Verify** the output against the task's checks (§5).
6. **Escalate once** on failure (§4). Never fan out to several tiers and reconcile.

The classifier itself runs on T1. It is a single call with a fixed output schema, not a reasoning step.

## 3. Hard-floor flags (bypass classification → T3)

| Flag | Meaning |
|------|---------|
| `identity` | Decisions about who the agent is or what it has committed to. |
| `architecture` | Changes to system design, schemas, or interfaces others depend on. |
| `high_stakes_review` | Security, legal, financial, or production-safety review. |
| `irreversible` | Deletes, sends external messages, moves money, or publishes. |
| `precision_critical` | Caller marks the path as one where a wrong answer costs more than the call. |

Hard floor means "must use the heavy model." The doctrine still applies: T3 output stays delta-shaped and free of narration.

## 4. Escalation

| From | Trigger | To |
|------|---------|----|
| T0 | Cache miss, or transform fails validation | T1 |
| T1 | Output fails its schema, or verifier flags it | T2 |
| T2 | Verifier flags twice, or primary model errors and fallback also fails | T3 |
| Any | Caller sets `precision_critical` | T3 directly |

Cascade rule: a T2 failure first retries on `<T2_FALLBACK>` with the **same prompt**. Only after that does it escalate to T3. A bloated T2 prompt is therefore paid twice, which is why the doctrine's prompt budgets apply.

Retries are capped at one per tier. Repeated failure at T3 goes to a human, not another call.

## 5. Verification

Each task type declares its checks. The router runs them. Examples:

| Task type | Check |
|-----------|-------|
| Classification | Output matches the enum; `confidence` present |
| Extraction | Every extracted ID resolves (file exists, record found) |
| Summary | Every claim traces to a provided source span |
| Code change | Tests pass and the diff touches only listed files |

Flagged outputs count toward the verification-fail rate (§7). A tier whose prompts keep getting flagged needs better prompts before it needs a different classifier.

## 6. Quotas

Quotas stop one tier from silently taking over. They do not replace a correct classifier.

| Tier | Target share (rolling 7 days) | Alert when |
|------|-------------------------------|------------|
| T0 | Not quota-managed | — |
| T1 | 30% | > 10% over target |
| T2 | 65% | > 10% over target |
| T3 | 5% | > 10% over target |

When an alert fires, check in this order: (1) do the prompts sent to that tier violate the doctrine (bloat, restated context, uncompressed examples)? (2) does the classifier route too high or too low? (3) only then tune thresholds.

Do not lower a threshold to hit a quota. That moves cost into quality, which the doctrine's quality floor forbids.

## 7. Usage log

One JSON object per router decision, appended to `router-usage.jsonl`:

```json
{"ts":"2026-10-24T14:03:22Z","task":"T-0147","type":"summary","tier":"T2","reason":"multi_source","conf":0.84,"esc":0,"verify":"pass","in_tok":2140,"out_tok":310}
```

| Field | Meaning |
|-------|---------|
| `ts` | UTC timestamp, absolute (no relative times) |
| `task` | Task ID |
| `type` | Task type from §5 |
| `tier` | Final tier that produced the accepted output |
| `reason` | Classifier reason code, or hard-floor flag, or `cache`/`template` |
| `conf` | Classifier confidence |
| `esc` | Number of escalations |
| `verify` | `pass` or `fail` |
| `in_tok` / `out_tok` | Measured tokens, not estimates |

Rules:
- Append only. Never edit a past line.
- Read recent slices for quota math (last 7 days). Never load the whole log into a prompt.
- Rotate monthly when the file exceeds 5 MB: copy to `router-usage-YYYY-MM.jsonl.bak` first, then start a new file. Keep backups until the next rotation.

## 8. Metrics

Report these per 14-day window. Report the three token classes from doctrine §14 separately.

| Metric | Definition |
|--------|------------|
| Tier share | Calls per tier ÷ total model calls |
| Escalation rate | Calls with `esc ≥ 1` ÷ total |
| Verify-fail rate | `verify = fail` ÷ total |
| Output tokens per task | Sum of `out_tok` ÷ tasks completed, per tier |
| Cost per task | Token counts × published prices, per tier |

## 9. Change control

The router prompt and this SOP are versioned like code.

- Each prompt change gets a version bump, a changelog line, and an entry in the self-modification log (doctrine §13).
- Keep the previous version file. Rollback means switching the version pointer in config.
- Before shipping a change, run the same task set against the old and new versions. Ship only if task success, correctness, and completeness are each equal or better (doctrine §12).
- Review window: 14 days after each change. Roll back if verify-fail rate or escalation rate worsens against the prior window, even if tokens fell.

## 10. Configuration

```yaml
tiers:
  T1: <T1_MODEL>
  T2: <T2_MODEL>
  T2_fallback: <T2_FALLBACK>
  T3: <T3_MODEL>
thresholds:
  t1_conf: 0.80
  t2_conf: 0.70
quota_targets: {T1: 0.30, T2: 0.65, T3: 0.05}
quota_alert_over: 0.10
cache_ttl_seconds: 3600
prompt_version: v2
```

## 11. Verification of this SOP

Before relying on the router, confirm each of these:

- [ ] Every hard-floor flag routes to T3 in a test run.
- [ ] A deterministic task never reaches a model call (check the log for `tier: T0`).
- [ ] A forced T2 failure retries on the fallback with an identical prompt, then escalates once.
- [ ] Usage log lines parse as JSON and contain every field in §7.
- [ ] Changing `prompt_version` in config switches the classifier without code edits.

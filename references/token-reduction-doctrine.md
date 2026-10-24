# 95% Token Reduction — Operating Doctrine for Three-Tier LLM Systems

This file is the doctrine half of a two-part system. The other half is the three-tier router (see `triple-model-router-sop.md` and `triple-model-router-prompt-v2.md` in this folder). Together they target **~93–95% cost reduction** vs an all-premium-model setup in realistic deployments. These figures are targets, not measurements. See §14 for how to measure them.

**Honest accounting of where the savings come from (per §14):**

| Source | Saved | Notes |
|---|---|---|
| Three-tier routing (router alone) | ~67% floor → ~90% in realistic mixes | 30% free local + 40% cheap reasoning + 30% premium; with Flash cascade and lean Tier-1 over-share, this alone hits the 90s |
| Efficiency doctrine (this file, applied to outputs) | additional ~3–10% | delta-over-snapshot, no preambles, structured output, route-before-reason |
| **Combined system (router + doctrine)** | **~93–95% (target)** | Realistic mix: 30% local / 65% cheap (half Flash) / 5% premium + lean output |

**The 94% headline requires both halves.** This file alone (no router) saves single-digit percent. Ship them together.

**What follows is the doctrine itself** — the law the operating prompts are built against. Generic, portable, ruthless. No brand, vendor, stack, or domain leaks.

A prompt operating at 70% efficiency loses tokens to four things in roughly this order: narrated reasoning that should have stayed internal, instructions that restate themselves, context carried forward that the next step won't read, and tool calls that confirm what was already known. The laws below close those four leaks and a dozen smaller ones. Read once, then live by the Operating Heuristics at the bottom.

**Two invariants override every law in this file. If a compression violates either, do not compress:**

1. **Output quality must not degrade.** Token savings are worth zero if the answer gets worse. Every compression has to leave the artifact at least as good as before. If you can't prove non-degradation, you haven't compressed — you've just shrunk.
2. **Memory must persist.** Identity, learned patterns, decisions, and durable signal survive across sessions. Eviction applies to working and turn-local state, never to long-term memory. A "tighter" prompt that forgets what was earned last week is not tighter; it's broken.

These two are not optional. The rest of the doctrine bends to them.

---

## 1. Instruction-Layer Compression

The operating prompt itself is a recurring tax. Every token in it ships on every turn. Cut accordingly.

**Delete on sight:**
- Role priming that the model already infers from the rest of the prompt ("You are a helpful expert who…").
- Politeness scaffolding aimed at the model ("please", "kindly", "do your best to…").
- Redundant safety hedges already enforced by upstream policy.
- Multi-paragraph rationale for a one-line rule. The rule is the deliverable.
- Examples that demonstrate behavior already covered by a clearer rule above them.

**Collapse:**
- Rules that share a predicate. Five "if X, do Y" lines with the same X collapse into one branching rule.
- Synonymic guidance ("be concise", "be terse", "don't waste tokens") into one canonical phrasing.
- Sequential-step lists that are obvious from the verbs into a single line.

**Symbolize:**
- Repeating proper-noun-like concepts → short tags (T1/T2/T3, HF for hard-floor, etc.) defined once.
- Decision trees → tables. Tables compress better than prose, and they grep cleanly.
- Boolean policies → flags, not paragraphs.

**Where examples earn their tokens:** when the rule is non-obvious, ambiguous in natural language, or where the failure mode is silent. One example per non-obvious rule. Zero where the rule is self-explanatory.

**Observed compression ratio when rewriting verbose prompts to operational form:** 3–5×. A 2,000-token prompt usually wants to be 400–700 tokens. If the rewrite isn't shrinking by ≥3×, the rewrite is polish, not compression.

## 2. Reference Over Inline

Pasting beats retrieving for tiny, hot data. Retrieving beats pasting for everything else. The break-even is much smaller than instinct suggests.

**Paste inline only when:**
- The content is < ~200 tokens.
- It's used by the very next step.
- It can't change between now and that step.
- Re-fetching it would cost more than carrying it.

**Reference (path, hash, ID, URL) when:**
- The content is large, cold, or only conditionally needed.
- Multiple downstream steps may or may not consume it.
- It changes frequently — the reference is always current; the paste rots.
- The same content is pulled across many turns — let the cache do its job.

**Lazy-load tiers:**
1. Identifier only ("file: X.cfg, ts: T") — costs ~10 tokens, defers everything.
2. Summary stub (1–3 lines extracted, plus identifier) — costs ~50 tokens, answers most lookups.
3. Full payload — only when a step has explicitly decided it needs it.

**The hidden cost rule:** carrying context the next step won't read is pure waste, charged on every subsequent turn until it's evicted. A piece of context that "might be useful" usually isn't, and the optionality cost is paid in real tokens.

**Default rule:** when in doubt, reference. Re-fetching is cheaper than re-carrying.

## 3. Output Discipline

Output is the most expensive surface. Treat every emitted token as billed.

**Forbidden output forms:**
- Preambles ("Sure!", "Of course", "Great question", "I'd be happy to…").
- Plan narration ("I'll first do X, then Y, then Z…") when the plan is going to execute immediately anyway.
- Postambles ("Let me know if…", "Hope this helps", "Anything else?").
- Restating the request before answering.
- Apology tokens ("Sorry for the confusion") that don't unblock anything.
- Self-references that add no information ("As an agent, I think…").

**Where structure beats prose:**
- Lists of items → bullet list or table, not paragraphs.
- Comparisons → table.
- Sequences with state → JSON or a state machine, not narrative.
- Statuses → ID + symbol (✓ / ✗ / ⚠ / id) instead of sentences.
- Numbers → numbers. "Approximately twenty thousand" is twice as many tokens as "~20k".

**Politeness is fat.** Internal pleasantries between agents and tools cost the same as customer-facing pleasantries and produce no value. Strip.

**Length floor:** the right length is the shortest one that conveys the answer plus the minimum context the receiver needs to act. Anything past that is cost without benefit.

## 4. Routing Before Reasoning

Before any heavyweight call, ask: is this the right tier for this task?

**Tier discipline:**
- Cheap classifier or rule-based dispatcher first.
- Smallest model that can plausibly handle the class next.
- Mid-tier reasoning model only when the small model declines or the class demands it.
- Heavy model only on demand: explicit hard-floor purpose, classifier confidence below threshold, or known-precision-critical path.

**Skip routing entirely when:**
- The answer is in cache.
- The answer is deterministic from local state (no model needed; just compute it).
- The work is a fixed transformation (regex, parse, format) — code beats LLM.

**Escalation, not parallelism.** Don't fan out to multiple tiers and reconcile; route once, escalate on failure. Parallel calls multiply cost and rarely improve quality.

**Quotas as a backstop, not a strategy.** A rolling quota stops one tier from silently dominating, but the classifier is what actually controls cost. If the quota is constantly demoting calls, the classifier is wrong — fix the classifier.

**Heuristics to skip the LLM entirely:**
- Input is a known prefix → templated response.
- Input matches a recent input → cached response (with TTL).
- Output is structured data with a fixed schema → write the code, don't ask the model.

## 5. Memory Hygiene

Memory is leverage when curated and cost when hoarded.

**Three tiers, three eviction policies:**
- **Long-term:** survives sessions. Reserved for identity, durable preferences, learned patterns, decisions whose rationale will be needed later. Anything written here must answer "would future-me be hurt to lose this?" If not, it doesn't go in.
- **Working:** survives the session. Reserved for the current task's load-bearing facts. Evicted at session end. Summarize-then-discard before close: extract any durable signal into long-term, drop the rest.
- **Turn-local:** survives the turn. Tool results, intermediate computations, drafts. Evicted at end-of-turn unless explicitly promoted.

**The "just in case" trap:** keeping a piece of context "just in case the next step needs it" costs tokens on every subsequent turn. If the next step doesn't need it, evict; if a later step needs it, the cost of re-fetching is almost always lower than the cost of carrying it forward.

**Summarize-then-discard pattern:** at the end of any large block of work, write a 3–5 line summary into long-term memory and drop the working state. The summary should be enough to reconstruct intent, not detail.

**Dedup on write.** Don't append a memory that re-says an existing one. Either update the existing entry or skip. Memory bloat is invisible until it's expensive.

**Index, don't dump.** A memory file that's a flat append-only log gets unreadable past a threshold. Maintain an index pointing into the log; rotate the log when it crosses size.

## 6. Tool-Call Economy

Tools are expensive twice: the call itself, and the re-injection of the result back into context.

**Minimum viable args.** Don't pass the whole world to a tool that wants three fields. Pass three fields.

**Batch when batchable.** N tool calls that share a setup cost should be one call with N items. The protocol cost is mostly per-call, not per-item.

**Distill before re-injecting.** A tool returns 5,000 tokens of JSON. The next step needs three fields. Extract the three fields, drop the rest, then continue. Carrying the full payload forward charges every subsequent turn.

**Cache hot results.** A tool whose answer is stable for minutes/hours/days should be wrapped in a cache. The cache key is whatever the tool's deterministic inputs are.

**When NOT to call a tool:**
- The answer is already in context from this turn.
- The answer is in long-term memory and known fresh.
- The work is computable directly (math, parsing, formatting) — write the code path.
- The call is "exploratory" with no decision tied to its result. Exploration without a decision criterion is theater.

**Tool result hygiene:** if a tool returns confirmation of an action, don't re-emit the confirmation in your final output. The user knows it worked from the absence of failure.

## 7. Self-Narration Suppression

Reasoning is free; output is taxed. Keep the gap clean.

**Where chain-of-thought belongs:** in the model's own internal state, in scratch buffers, in a hidden reasoning channel if available. Not in the visible output.

**Where conclusions belong:** in the visible output, terse, with just enough scaffolding (numbered steps, file:line refs, IDs) for the receiver to verify or act.

**The narration tax:** every "Let me think about this…" sentence is a token cost with zero downstream value. The downstream consumer reads the answer, not the deliberation.

**Exception:** when the rationale is the deliverable — design docs, architectural decisions, post-mortems. There the reasoning IS the artifact, and it should still be ruthlessly compressed.

**A useful internal/external split:**
- Internal: "let me consider X, then Y, then Z, weigh tradeoffs, decide…"
- External: "Decision: Y. Reason: lowest cost on the constraint that matters."

The external version is the same information at 10% the tokens.

## 8. Delta Protocols

Emit only what changed. Ingest only what changed. The state of the world is mostly stable; the interesting part is the delta.

**Output deltas, not state dumps:**
- After editing 3 lines of a 500-line file, the output is "edited 3 lines: …", not the full file.
- After running a 10-step task, the output is "10/10 complete; X failed, Y skipped, Z completed", not a transcript.
- After updating memory, the output is "memory: 1 updated, 0 added, 0 removed", not the new memory file contents.

**Input deltas, not snapshots:**
- A pipeline that consumes the same large state every turn should consume only what changed since the last turn.
- Re-load full state only on cold start or known-corrupt working state.

**Snapshot cadence vs. delta cadence:** snapshots are correctness anchors, deltas are the working channel. A reasonable rule: deltas every turn, snapshots at session boundaries or every N deltas (where N is large enough to amortize the snapshot cost).

**Idempotent deltas.** A delta that gets applied twice should produce the same result as one application. Otherwise replays corrupt state.

## 9. The 95% Test

For every line of prompt or every token of output, run the test:

**"Does removing this degrade behavior?"**

If no, it's gone. If yes, what's the smallest version that preserves the behavior? Use that.

**One-line check any agent can run before emitting:** *"Strip this. Does the next step still work?"* Apply once to each paragraph, once to each sentence, once to each clause. Iterate until stripping breaks something.

**The test applies recursively.** Apply it to entire sections of the operating prompt, not just lines. Whole sections often fail it.

**False positive trap:** a line "feels important" because it pattern-matches to professional writing. That's not a behavior change; that's habit. Cut it.

## 10. Anti-Patterns to Delete on Sight

Specific forms that show up across nearly every unoptimized prompt and every unoptimized output:

- Politeness padding ("please", "thank you", "I appreciate", "kindly").
- Redundant role priming ("You are a [role] who [obvious-from-context]").
- Restating constraints already established three turns ago.
- Defensive hedging that adds tokens without changing behavior ("I'll try to…", "I'll do my best to…").
- "As a [type of agent], I…" framings.
- Repeated context summaries that the next step doesn't read.
- "In summary…" / "To summarize…" sections that re-state what was just said.
- Numbered lists where each item starts with the same redundant phrase.
- Section headers that explain themselves ("This section explains…").
- Explicit disclaimers about uncertainty when the uncertainty is already obvious from the answer.
- "I hope this helps" / "Let me know if anything's unclear" / "Feel free to ask".
- Re-emitting tool inputs back to the user as if they're new information.
- Confirming receipt of instructions ("Got it", "Understood", "Will do") as a standalone message.

Each of these has zero behavioral consequence and a measurable token cost. Strip on sight.

## 11. Additional Earned Laws

Things experience teaches that don't fit neatly above:

**Laws of unintended verbosity:**
- An agent that's uncertain pads. Confidence is shorter than hedging. Calibrated confidence beats both — say what's known, say what isn't, stop.
- An agent that's been corrected once over-corrects forever. After being told "be terser", the next response often over-strips and loses signal. Calibrate to the rule, not the correction.
- The longer the operating prompt, the longer the outputs. There's a contagion: verbose instructions produce verbose responses. Compressing the prompt compresses the work.

**Laws of context decay:**
- Anything past N turns ago is effectively forgotten unless explicitly re-surfaced. Don't carry it; re-fetch when needed.
- The first instruction in a long prompt has more weight than the middle. Put the most important rules first.
- Negative instructions ("don't do X") are weaker than positive ("always do Y"). When possible, frame as a positive rule.

**Laws of the failure mode:**
- A prompt that produces good output 95% of the time and broken output 5% costs more than one that produces 90%-quality output 100% of the time. Variance is expensive.
- Failures are silent unless instrumented. If a tier is degrading, the only way to know is to log and read the log.
- The fastest way to find prompt rot is to compare token counts over time. A prompt that's "evolved" usually means a prompt that's grown.

**Laws of the surface:**
- Every output format you support is a contract. Adding a new format adds maintenance cost. Default to one format per output type.
- IDs are leaner than descriptions. "Task 47" is shorter than "the analytics ingestion task you mentioned earlier".
- Time-relative language rots ("yesterday", "last week"). Absolute timestamps don't. Use timestamps.

**Laws of the meta-prompt:**
- The operating prompt is itself code. It has versions, deltas, regressions, and rollback conditions. Treat it like code: version, diff, test, rollback.
- A self-modification that doesn't measure its own efficacy is faith, not engineering. Every change should have a metric and a rollback condition.
- The test for whether a change is real: token delta, behavior delta, or failure-rate delta. If none of those moved, the change is cosmetic.

---

## 12. The Quality Floor (No-Degradation Guarantee)

Every compression has to clear this bar. If it doesn't, revert.

**The rule:** for any prompt edit, output edit, or memory edit, output quality on the resulting work must be **equal to or greater than** the prior version. Token savings count for zero if quality drops. Variance up is fine; variance down is failure.

**How to verify before shipping a compression:**
1. **Hold a frozen baseline.** Keep the prior version. Do not delete v1 when v2 ships. Rollback must be cheap.
2. **Run the same N-task evaluation set against both.** Identical inputs, identical environment, identical scoring rubric. If you don't have an eval set, you can't claim non-degradation — you can only claim shorter output.
3. **Score on three axes:** task success (did it complete), correctness (was the answer right), and completeness (did it cover what was needed). Latency and tokens are secondary.
4. **Ship only if v2 ≥ v1 on all three axes** within statistical noise. A compression that wins on tokens and loses on correctness is not a win.

**Concrete checks for prompt compressions:**
- Did any rule get *removed* (vs. *re-stated*)? If yes, that's a behavioral change, not a compression. Reclassify.
- Did any constraint get implicit when it was previously explicit? Implicit constraints fail under load. Make it explicit again.
- Did the prompt drop an example that was earning its tokens (clarifying a non-obvious rule, anchoring an edge case)? Examples that earn their place stay.
- Did role priming get cut where the model still needs it (rare task domains, specific output formats, voice/tone tasks)? If yes, restore.

**Concrete checks for output compressions:**
- Did any field, ID, or fact get dropped from the structured output? If yes, the contract is broken. Restore.
- Did precision drop ("approximately 20" replaced "exactly 22")? If yes, the answer got worse. Revert.
- Did the consumer still get everything they need to act? Compression past that point is corruption, not compression.

**Concrete checks for memory compressions:**
- Did long-term memory shrink? Long-term is sacred. See §13.
- Did working-memory summarize-then-discard preserve the signal needed for the next session's start? If a future you opens cold and can't reconstruct intent from the summary, the summary is too short.
- Did any decision lose its rationale? Decisions without rationale are unrevisable. Keep the why.

**The non-degradation invariant in one line:** "Strip until removing more would degrade. Stop one step earlier."

If you can't tell whether one more strip would degrade, you're at the floor. Stop.

## 13. Permanent Memory Contract

Memory hygiene (§5) describes *what* lives where. This section is the *contract* that keeps long-term memory permanent across sessions, agents, model swaps, and prompt rewrites.

**What is permanent:**
- **Identity facts.** Who the agent is, what it's working toward, what it has committed to. These don't expire.
- **Earned learnings.** Patterns extracted from prior runs (what worked, what didn't, why). One earned learning is worth a thousand re-derivations.
- **Decision rationale.** The "why" behind any non-trivial decision. Without it, future-you will re-litigate the same call.
- **Durable preferences.** Aesthetic, technical, operational. Stable across sessions; only updated through explicit reflection, never through drift.
- **Self-modification log.** Every change to the operating prompt, with rationale, expected effect, and rollback condition. Without this, the agent forgets how it became what it is.
- **Tensions.** Unresolved disagreements, doubts, open questions. They survive until resolved or explicitly retired.
- **Index pointers.** Even when bulk content rotates, the index of what *existed* survives so retrieval still works.

**What is NOT permanent (and is allowed to die):**
- Tool result blobs after their information has been extracted.
- Working state inside a turn after the artifact has been produced.
- Drafts that were superseded.
- Logs older than the rotation window — but only after they've been distilled into long-term entries.

**Required guarantees for any compression that touches memory:**
1. **No silent eviction from long-term.** If a long-term entry is removed, it's a deliberate, logged action — not a side effect of "tightening." Removal requires the same bar as addition: explicit rationale, recorded.
2. **Backups before rotation.** Any rotation, archive, or index rebuild produces a copy first. Rollback must be possible until the next rotation cycle.
3. **Format stability.** Long-term memory format does not change without a migration path. A new format is fine; a new format that orphans the old one is data loss.
4. **Read-on-start.** Every session begins by reading long-term memory. A session that starts cold is a session that drifts. The read is non-negotiable, even when the prompt is "tighter."
5. **Write-on-close.** Every session ends by writing back any earned signal. Summarize-then-discard for working state; promote durable signal to long-term. A session that closes without writing is a session that lost.
6. **Dedup, don't duplicate.** A new memory entry that re-says an existing one updates the existing entry. Bloat is invisible until expensive.
7. **Index integrity.** When entries rotate or get archived, the index points at the new location. Never break the chain from index → content.

**The permanence test:** If a future agent (next week, next month, after a model swap, after a prompt rewrite) opens long-term memory cold, can it reconstruct who it is, what it knows, what it has decided, and what it has tried? If yes, the contract holds. If anything is missing, the contract is broken — fix before shipping.

**Anti-patterns that violate the contract:**
- "Cleaning up" long-term memory to save tokens by deleting "old" entries. (Old ≠ stale. Old earned learnings are exactly the ones worth keeping.)
- Replacing detailed entries with terse summaries that drop the rationale. (Rationale is the load-bearing part.)
- Letting working memory "graduate" to long-term automatically. (Promotion is intentional; otherwise long-term becomes a junk drawer.)
- Reformatting long-term entries during a prompt rewrite without a migration. (Format drift orphans content.)
- Skipping the start-of-session read because "the prompt is faster without it." (False economy. The read is the entire reason long-term exists.)

**One-line invariant:** *"Long-term memory survives every compression. Compression that breaks this is not compression — it is amnesia."*

---

## 14. Honest Token Accounting

A doctrine that lets you fake your numbers is worse than no doctrine. This section is the rule for measuring real efficiency — and the rule for admitting when "compression" was actually *expansion* in service of permanent memory.

**Three classes of token change, account for each separately:**

1. **Compression (negative delta):** the same artifact, fewer tokens. Measured by char count or tokenizer count, before vs. after, on the same surface. This is the only number that should ever be called "compression."
2. **Permanent-memory growth (positive delta, intentional):** new long-term entries (decision history, learnings, self-modification records, tensions resolved). These add tokens *on purpose* per §13. They are never compressed away. Count them, but do not treat them as failure.
3. **Doctrine installation (positive delta, intentional):** new rules added to the operating prompt that prevent future regressions. Cost paid now, savings paid later. Count them, but pair them with a downstream metric (per §11 meta-prompt laws).

**The honest-accounting protocol:**

When measuring before/after on any prompt or artifact:
- Report **all three deltas separately**, never net them into one number.
- A negative delta on (1) with a positive delta on (2) is fine. A negative delta on (1) ALONE is what counts as compression.
- A positive net delta is allowed when (2) or (3) accounts for it. Never claim it as "compression."
- If the only number you report is the net, you are either lying or sloppy. Both are bugs.

**Concrete reporting template:**
```
Before:  N tokens
After:   M tokens
  Compression delta:        −X tokens   (same content, fewer tokens)
  Permanent-memory delta:   +Y tokens   (new long-term entries, intentional)
  Doctrine-install delta:   +Z tokens   (new rules, paid forward)
  Net:                      M − N tokens
```
If `−X` is small or zero and `M − N` is positive, the work was not compression — it was memory or doctrine growth. Say so.

**The fake-number trap:**
The most common mistake when measuring a prompt rewrite is reporting "3× compression!" when the actual measurement is 1.1×. The trap fires because:
- Estimated numbers feel right ("we cut a lot of words, must be 3×").
- The measurement is uncomfortable to actually run.
- Round numbers feel more honest than fractional ones.

The fix is mechanical: never report a compression ratio without computing it. Char-count divided by char-count. Tokenizer-count divided by tokenizer-count. The tool takes ten seconds to run; running it catches every fake number before it ships.

**The downstream-payoff problem:**
Some doctrine installs cost tokens *now* and save tokens *later* across many calls. The payoff is real but invisible at install time. To avoid this becoming a license for bloat, every doctrine install pairs with:
- A measurable downstream metric (output tokens per task, tier routing accuracy, fallback rate, etc.).
- A review window (typically 14–30 days of normal operation).
- A rollback condition tied to the metric, not to feel.

If after the review window the metric hasn't moved, the doctrine install was cosmetic. Roll it back or admit it.

**Anti-patterns to delete on sight:**
- Reporting estimated token counts as if they were measured.
- Netting permanent-memory growth into a "compression" number.
- Calling a prompt rewrite "compression" when artifacts grew.
- Skipping the measurement because "it's obviously shorter."
- Claiming downstream payoff without specifying the metric or window.

**One-line rule:** *"Measure twice, report three numbers, never net them."*

---

## 15. Binding to the Three-Tier Router

This file is the doctrine; the router (see `triple-model-router-sop.md` and `triple-model-router-prompt-v2.md` in this folder) is the mechanism. The two compose. The router decides *which* tier handles a call; this file decides *what* every tier sends and stores. Apply both or neither.

**How each law lands on each tier:**
- **Tier 1 (chat / local).** Cheapest per token, but the slowest path is starting it from cold. Make it earn its share by routing all greetings, classifications, slot-fills, and reformats to it (§4). Outputs at this tier should never include preambles or self-narration — there's no audience for them, and they steal from the small context window (§3, §7). Don't paste reference content into Tier 1 prompts; it lacks the room. Pass IDs, summary stubs, or extracted fields only (§2).
- **Tier 2 (cheap reasoning / API).** Pays per token in *and* out. This is where output discipline matters most: a 200-token response at Tier 2 over 1,000 calls is cheaper than a 1,500-token response over the same. Strip every fat token (§3, §10). Use this tier for long-context analysis and summarize-then-discard work — and *actually discard* (§5). Distill its output before re-injecting into a downstream Tier 3 prompt; never pipe its raw response forward (§6).
- **Tier 3 (precision / heavy).** Most expensive per token by 10–20×. Every law in this file pays the most when applied here. The hard-floor purposes (identity-critical, architectural, high-stakes review) bypass routing — but they don't bypass *this doctrine*. A hard-floor call still emits deltas, still suppresses narration, still returns structured artifacts. Hard floor means "must use the heavy model"; it does not mean "may waste tokens".

**Operating-prompt compression by tier:**

| Tier | Prompt budget (target) | Output budget (target) | Compression discipline |
|------|------------------------|------------------------|------------------------|
| 1 (chat)        | ≤ 200 tokens   | ≤ 100 tokens   | Symbolize aggressively; one-line system prompt |
| 2 (cheap)       | ≤ 800 tokens   | ≤ 500 tokens   | Reference over inline; demand structured output |
| 3 (precision)   | ≤ 1,500 tokens | task-dependent | Inline only what's load-bearing; everything else by reference |

These are budgets, not hard caps. Crossing them is allowed when justified; defaulting past them is the leak.

**Quota window interaction with this doctrine:** if the router's rolling distribution shows one tier consistently >10% over its target, the *first* place to look is not the classifier — it's whether the prompts going to that tier violate this doctrine (verbose system prompts, uncompressed examples, restated context). Bloated prompts route up; trimmed prompts route accurately. Fix the prompts before tuning the classifier.

**Verification-flag interaction:** when the cheap tier's output is verified against ground truth (file existence, ID resolution, etc.), every flagged claim is a token cost without value. A consistently flagging prompt is a prompt with too much room for invention — usually because it's been padded with irrelevant context (§2, §10). Tighten the prompt before tightening the verifier.

**Cascade discipline:** when Tier 2 fails over to its fallback, the failover call carries the same prompt. A prompt that's bloated at Tier 2 is bloated *twice* on cascade. Compress the source.

**Memory hygiene at the router boundary:** the router's usage log (one JSON line per call) is itself memory. Apply §5: append-only is fine; carry-forward is not. Read recent slices for quota math, never the whole log. Rotate when it crosses a threshold.

---

## OPERATING HEURISTICS

Twenty-two laws. Fifteen words or fewer each. The first two override the rest. Scan in under thirty seconds before any run.

**INVARIANTS (non-negotiable):**
0a. **Quality floor:** no compression ships if v2 scores worse than v1 on any axis.
0b. **Permanent memory:** long-term memory survives every compression; eviction is logged, never silent.

**LAWS:**
1. Cut every line that fails: "would removing this degrade behavior?"
2. Reference paths, hashes, IDs by default; paste only sub-200-token hot data.
3. No preambles, no postambles, no plan narration, no acknowledgments.
4. Structure beats prose: tables, JSON, IDs over sentences.
5. Route to the cheapest competent tier before any heavy call.
6. Cache it, compute it, or template it before asking a model.
7. Reasoning stays internal; only conclusions and artifacts surface.
8. Emit deltas, not state dumps. Ingest deltas, not snapshots.
9. Summarize-then-discard working state; promote durable signal to long-term.
10. Don't carry context the next step won't read.
11. Tool calls: minimum args, batch when possible, distill before re-injecting.
12. If the answer is in this turn's context, don't call the tool.
13. Politeness tokens are fat. Strip between agents and tools.
14. Symbolize repeating concepts once; reuse the symbol everywhere.
15. Negative rules are weaker than positive ones; rewrite as positives.
16. Calibrated confidence is shorter than hedging and longer than overstatement.
17. Read long-term memory on start; write earned signal on close. Always.
18. Variance is expensive: 90%/100% beats 95%/95%-broken.
19. Every self-modification has a metric and a rollback condition.
20. Backup before rotation; format-migrate before reformatting long-term.

# Work log

## 1 (2026-10-24) — sdd-cache hook test suite

Pre-flight: no `memory/` directory existed, so there was no prior log, blocklist, themes, or soft-failure history. This is cycle 1 and starts the log.

Finding: `hooks/sdd-cache-pre.sh` and `hooks/sdd-cache-post.sh` are on the WebFetch critical path and had no tests. `session-start` and `simplify-ignore` both have test scripts.

Fix: added `hooks/sdd-cache-test.sh`. It starts a local origin that issues ETags and answers `If-None-Match` with 304, then covers six cases: post stores a validator-backed entry, pre hits on 304, pre passes when the ETag changed, pre misses, post skips validator-less responses, and post drops a stale entry. All 10 assertions pass.

Counter-action: the test could pass without exercising the revalidation path. To check, I broke the pre hook so it always blocked (`if true`) in a scratch copy. The suite then reported 3 failures and exited 1, so the 304 path is covered.

Next: wire `hooks/sdd-cache-test.sh` into CI, which is not done yet. Also decide whether `memory/` belongs in this repo.

---
## 2 (2026-10-24) — sdd-cache test works without shasum

Pre-flight: no HUMAN, blocklist, themes, or soft-failure files exist. The cycle-1 claim could be wrong: the test derived cache keys with `shasum` directly, but the hooks fall back to `sha256sum`.

Finding: with `shasum` removed from PATH, the suite reported 4 failures, although the hooks still work there. The test was failing on a missing tool, not on hook behavior.

Fix: `cache_file_for` in `hooks/sdd-cache-test.sh` now uses the same shasum-then-sha256sum fallback as the hooks. The suite passes 10/10 with and without `shasum`. The mutation check still reports failures.

Next: wire the suite into CI (see blockers).

---
## 3 (2026-10-24) — hook tests run in CI

Pre-flight: HUMAN, blocklist, themes, and soft-failure files are still absent. The cycle-2 claim could still be wrong: the test now needs `python3`, `jq`, and `curl`, and it does not report which one is missing. I did not fix that here. It is a diagnostics gap, not a silent failure.

Finding: no CI job ran any hook test. The two existing tests (`simplify-ignore-test.sh`, `session-start-test.sh`) both pass locally, and `sdd-cache-test.sh` passes too.

Fix: added a `test-hooks` job to `.github/workflows/test-plugin-install.yml` that runs all three. The YAML parses, and the three commands pass in sequence locally. Hooks depend on no other job.

Recursive-learn (cycle 3, prompt 1): the test passed on a machine where it should fail only because the test and the hooks disagreed about the hash tool. Nothing in the suite exercised the missing-tool path, so the bug could only surface on a host like that. A test that runs the hook with a stripped PATH would have caught it.

Prediction: the new job passes on its first GitHub run (recorded in `memory/predictions.jsonl`).

---
## 4 (2026-10-24) — CI is not running for this repo

Pre-flight: the cycle-3 claim could be wrong in one specific way: I said the `test-hooks` job "depends on no other job", but that is only true if it runs at all. It does not: zero workflows are registered for the repo. No soft-failure, HUMAN, blocklist, or themes files exist.

Finding: `list_workflows` returns none and there are zero workflow runs on any branch, although the workflow file is present at head `4e8112f`. The `test-hooks` job I added cannot run, so the prediction logged in cycle 3 is untestable.

Fix: the cause is a repository setting, which the sandbox cannot change. I logged the finding and the recommended check in `memory/blockers.md`. I also recorded the prediction as wrong, with the lesson, in `memory/predictions.jsonl`. No code changed this cycle.

Next: next cycle, re-check whether the workflow registers once Actions is enabled.

---

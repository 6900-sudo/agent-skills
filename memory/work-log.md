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

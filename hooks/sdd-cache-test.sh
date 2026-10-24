#!/bin/bash
# sdd-cache-test.sh — Tests for the sdd-cache pre/post WebFetch hooks
#
# Runs both hooks against a local origin that issues ETags and answers
# If-None-Match with 304, so the revalidation path is exercised for real.
# Run: bash hooks/sdd-cache-test.sh

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"

# The hooks skip silently when these are missing; the test needs them, so
# name the missing one instead of failing somewhere downstream.
for tool in jq curl python3; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'sdd-cache-test: missing required tool: %s\n' "$tool" >&2; exit 1; }
done

PASS=0 FAIL=0
TMPDIR=$(mktemp -d)
SERVER_PID=""
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TMPDIR"' EXIT

export CLAUDE_PROJECT_DIR="$TMPDIR/project"
mkdir -p "$CLAUDE_PROJECT_DIR"

# Origin: /doc answers with the ETag stored in $ETAG_FILE (changeable mid-test);
# /bare answers with no validators at all. It writes its bound port to argv[2].
ETAG_FILE="$TMPDIR/etag"
echo '"v1"' > "$ETAG_FILE"
cat > "$TMPDIR/origin.py" <<'PY'
import http.server, sys

ETAG_FILE, PORT_FILE = sys.argv[1], sys.argv[2]

class Handler(http.server.BaseHTTPRequestHandler):
    def _respond(self, head_only):
        if self.path == "/bare":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "5")
            self.end_headers()
            if not head_only:
                self.wfile.write(b"bare\n")
            return
        etag = open(ETAG_FILE).read().strip()
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("ETag", etag)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", "6")
        self.end_headers()
        if not head_only:
            self.wfile.write(b"page\n")

    def do_GET(self):
        self._respond(head_only=False)

    def do_HEAD(self):
        self._respond(head_only=True)

    def log_message(self, *args):
        pass

server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
open(PORT_FILE, "w").write(str(server.server_address[1]))
server.serve_forever()
PY

python3 "$TMPDIR/origin.py" "$ETAG_FILE" "$TMPDIR/port" &
SERVER_PID=$!

for _ in $(seq 1 50); do [ -s "$TMPDIR/port" ] && break; sleep 0.1; done
BASE="http://127.0.0.1:$(cat "$TMPDIR/port")"

assert() {
  local label="$1" ok="$2"
  if [ "$ok" = "1" ]; then
    PASS=$((PASS + 1)); printf '  PASS: %s\n' "$label"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL: %s\n' "$label" >&2
  fi
}

# Build PreToolUse / PostToolUse payloads for WebFetch.
pre_input()  { jq -nc --arg u "$1" '{tool_input: {url: $u, prompt: "p"}}'; }
post_input() { jq -nc --arg u "$1" --arg c "$2" '{tool_input: {url: $u, prompt: "p"}, tool_response: {result: $c}}'; }

# Must match the hooks: sha256(URL), first 32 hex chars. The hooks fall back
# to sha256sum when shasum is missing, so the test does the same.
cache_file_for() {
  local key
  if command -v shasum >/dev/null 2>&1; then
    key=$(printf '%s' "$1" | shasum -a 256 | cut -c1-32)
  else
    key=$(printf '%s' "$1" | sha256sum | cut -c1-32)
  fi
  printf '%s/.claude/sdd-cache/%s.json' "$CLAUDE_PROJECT_DIR" "$key"
}

# ── Test 1: post stores a response that carries validators ───────────────
printf 'Test 1: post hook stores validator-backed response\n'
URL="$BASE/doc"
bash "$HOOKS_DIR/sdd-cache-post.sh" <<<"$(post_input "$URL" "cached body")"
CF=$(cache_file_for "$URL")
assert "cache file written" "$([ -f "$CF" ] && echo 1 || echo 0)"
assert "etag captured" "$([ "$(jq -r .etag "$CF" 2>/dev/null)" = '"v1"' ] && echo 1 || echo 0)"
assert "content captured" "$([ "$(jq -r .content "$CF" 2>/dev/null)" = "cached body" ] && echo 1 || echo 0)"

# ── Test 2: pre serves from cache on 304 (exit 2, payload on stderr) ─────
printf 'Test 2: pre hook cache hit on 304\n'
set +e
ERR=$(bash "$HOOKS_DIR/sdd-cache-pre.sh" <<<"$(pre_input "$URL")" 2>&1 >/dev/null)
RC=$?
set -e
assert "exit code is 2" "$([ "$RC" -eq 2 ] && echo 1 || echo 0)"
assert "stderr names the cache hit" "$(printf '%s' "$ERR" | grep -q 'Cache hit for' && echo 1 || echo 0)"
assert "stderr carries cached body" "$(printf '%s' "$ERR" | grep -q 'cached body' && echo 1 || echo 0)"

# ── Test 3: origin changed its ETag → pre lets WebFetch proceed ──────────
printf 'Test 3: pre hook passes through when origin changed\n'
echo '"v2"' > "$ETAG_FILE"
set +e
bash "$HOOKS_DIR/sdd-cache-pre.sh" <<<"$(pre_input "$URL")" >/dev/null 2>&1
RC=$?
set -e
assert "exit code is 0 (no hit)" "$([ "$RC" -eq 0 ] && echo 1 || echo 0)"
echo '"v1"' > "$ETAG_FILE"

# ── Test 4: pre with no cache entry passes through ───────────────────────
printf 'Test 4: pre hook miss\n'
set +e
bash "$HOOKS_DIR/sdd-cache-pre.sh" <<<"$(pre_input "$BASE/never-fetched")" >/dev/null 2>&1
RC=$?
set -e
assert "exit code is 0 (miss)" "$([ "$RC" -eq 0 ] && echo 1 || echo 0)"

# ── Test 5: response without validators is never cached ──────────────────
printf 'Test 5: post hook skips validator-less responses\n'
BARE="$BASE/bare"
bash "$HOOKS_DIR/sdd-cache-post.sh" <<<"$(post_input "$BARE" "bare body")"
assert "no cache file for validator-less URL" "$([ ! -f "$(cache_file_for "$BARE")" ] && echo 1 || echo 0)"

# ── Test 6: post removes an existing entry once validators disappear ─────
printf 'Test 6: post hook removes stale entry when validators vanish\n'
mkdir -p "$(dirname "$(cache_file_for "$BARE")")"
jq -nc '{url: "x", prompt: "p", etag: "\"v0\"", last_modified: "", content: "old", fetched_at: 0}' \
  > "$(cache_file_for "$BARE")"
bash "$HOOKS_DIR/sdd-cache-post.sh" <<<"$(post_input "$BARE" "bare body")"
assert "stale entry removed" "$([ ! -f "$(cache_file_for "$BARE")" ] && echo 1 || echo 0)"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

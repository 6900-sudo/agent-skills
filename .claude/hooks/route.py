#!/usr/bin/env python3
"""PreToolUse router: deterministic allow/deny, no model call."""
import json, os, re, sys

event = json.load(sys.stdin)
tool = event.get("tool_name", "")
args = event.get("tool_input", {})
root = os.path.realpath(os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd()))

def deny(reason):
    print(reason, file=sys.stderr)
    sys.exit(2)  # exit 2 blocks the call and sends stderr back to Claude

if tool in ("Write", "Edit"):
    path = os.path.realpath(args.get("file_path", ""))
    if path != root and not path.startswith(root + os.sep):
        deny(f"Blocked: {path} is outside the repo. Edit files inside {root} only.")

if tool == "Bash":
    cmd = args.get("command", "")
    if re.match(r"\s*(grep|rg|find|cat|head|tail)\b", cmd):
        deny("Use the Grep, Glob or Read tools instead of shell grep/find/cat/head/tail.")
    if re.search(r"\bgit\s+push\b.*(?<![\w./-])(main|master)(?![\w./-])", cmd):
        deny("Blocked: do not push to main or master. Push your working branch.")

sys.exit(0)

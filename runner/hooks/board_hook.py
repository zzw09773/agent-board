#!/usr/bin/env python3
"""Agent CLI hook -> RUNNER_STATE/<identity>.hook.json, read by runner.py health() before the screen.

Claude Code (settings "hooks", event JSON on stdin):   board_hook.py <identity>
Codex CLI (notify, event JSON as the last argument):    board_hook.py <identity> '<json>'

waiting_approval=true on a permission prompt (Claude Code Notification with
notification_type=permission_prompt, or PermissionRequest); any later activity event
(UserPromptSubmit, PostToolUse, Stop, Codex agent-turn-complete) clears it. Other
notifications (idle reminders) leave the state alone. Prints nothing and always exits 0,
so it can't change the CLI's decision.
"""
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.environ.get("RUNNER_STATE", os.path.join(HERE, "state"))


def main():
    if len(sys.argv) < 2 or not re.fullmatch(r"[A-Za-z0-9._-]+", sys.argv[1]):
        return
    ident = sys.argv[1]
    try:
        ev = json.loads(sys.argv[2]) if len(sys.argv) > 2 else json.load(sys.stdin)
    except Exception:
        ev = {}
    name = ev.get("hook_event_name") or ev.get("type") or "?"
    msg = str(ev.get("message", "")).lower()
    waiting = name == "PermissionRequest" or (
        name == "Notification" and (ev.get("notification_type") == "permission_prompt" or "permission" in msg))
    if name == "Notification" and not waiting:
        return
    os.makedirs(STATE, exist_ok=True)
    tmp = os.path.join(STATE, f".{ident}.hook.tmp")
    with open(tmp, "w") as f:
        json.dump({"waiting_approval": waiting, "ts": time.time(), "event": name}, f)
    os.replace(tmp, os.path.join(STATE, f"{ident}.hook.json"))


try:
    main()
except Exception:
    pass
sys.exit(0)

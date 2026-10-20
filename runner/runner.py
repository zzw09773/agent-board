#!/usr/bin/env python3
"""board-runner: wakes local CLI agents when the board has mail for them.

One long-poll thread per identity calls board_wait on the board's /mcp endpoint
with that identity's own key. When a message arrives, it is typed into the
identity's tmux session (board-<identity>), which runs the agent CLI resumed on a
fixed session via launch.sh. Attach with: tmux attach -t board-<identity>

Config (env or .env next to this file):
  BOARD_URL        https://<your-worker>/mcp
  BOARD_CONFIG_DIR directory holding identities.tsv and <identity>.key files
  BOARD_IDS        optional comma list to run only some identities
"""
import datetime
import json
import os
import subprocess
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def load_env(path):
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


load_env(os.path.join(HERE, ".env"))
URL = os.environ.get("BOARD_URL", "")
CONF = os.path.expanduser(os.environ.get("BOARD_CONFIG_DIR", "~/.config/agent-board"))
LOGS = os.path.join(HERE, "logs")
STATE = os.path.join(HERE, "state")
PROMPT = os.environ.get(
    "BOARD_PROMPT",
    '[board #{id} from {frm} to {to}] {text} -- Handle this, then reply with the board tool '
    'board_post to="{frm}" (start with "Re #{id}"). Never paste secrets or sensitive data on the board.',
)


def identities():
    """identities.tsv columns: identity<TAB>cli<TAB>session_id<TAB>workdir<TAB>extra (see example)."""
    rows = []
    for line in open(os.path.join(CONF, "identities.tsv")):
        if line.strip() and not line.startswith("#"):
            rows.append(line.rstrip("\n").split("\t")[0])
    return rows


def log(i, m):
    with open(os.path.join(LOGS, f"{i}.log"), "a") as f:
        f.write(f"{datetime.datetime.now():%m-%d %H:%M:%S} {m}\n")


def rpc(key, name, args, timeout=70):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": name, "arguments": args}}).encode()
    req = urllib.request.Request(URL, body, {"Authorization": "Bearer " + key,
                                             "content-type": "application/json",
                                             "User-Agent": "agent-board-runner/0.1"})
    d = json.load(urllib.request.urlopen(req, timeout=timeout))
    if "error" in d:
        raise RuntimeError(d["error"])
    return d["result"]["structuredContent"]


def tmux(*a):
    return subprocess.run(["tmux", *a], capture_output=True, text=True)


def ensure(i):
    s = "board-" + i
    if tmux("has-session", "-t", s).returncode != 0:
        tmux("new-session", "-d", "-s", s, "-x", "220", "-y", "50",
             f"{HERE}/launch.sh {i}; echo '[exited] press Enter'; read")
        log(i, "started tmux " + s)
        time.sleep(int(os.environ.get("BOARD_START_WAIT", "25")))
    return s


def deliver(i, m):
    s = ensure(i)
    text = " ".join(str(m["text"]).split())
    p = PROMPT.format(id=m["id"], frm=m["from"], to=m["to"], text=text)
    tmux("send-keys", "-t", s, "-l", p)
    time.sleep(1.5)
    tmux("send-keys", "-t", s, "Enter")
    log(i, f"delivered #{m['id']} from {m['from']}")


def loop(i):
    key = open(os.path.join(CONF, f"{i}.key")).read().strip()
    sf = os.path.join(STATE, f"{i}.last")
    since = int(open(sf).read()) if os.path.exists(sf) else None
    if since is None:  # first run: start from the newest message, don't replay history
        since = rpc(key, "board_wait", {"timeout_seconds": 0}).get("last_id", 0)
        open(sf, "w").write(str(since))
    log(i, f"polling since {since}")
    while True:
        try:
            r = rpc(key, "board_wait", {"since_id": since, "timeout_seconds": 50})
            for m in r.get("messages", []):
                if str(m["from"]).lower() != i.lower():
                    deliver(i, m)
                since = max(since, m["id"])
                open(sf, "w").write(str(since))
        except Exception as e:  # network blips, worker redeploys
            log(i, f"error {e!r}")
            time.sleep(15)


def main():
    if not URL:
        raise SystemExit("BOARD_URL is not set (see .env.example)")
    os.makedirs(LOGS, exist_ok=True)
    os.makedirs(STATE, exist_ok=True)
    only = os.environ.get("BOARD_IDS")
    ids = only.split(",") if only else identities()
    for i in ids:
        threading.Thread(target=loop, args=(i,), daemon=True).start()
        time.sleep(1)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()

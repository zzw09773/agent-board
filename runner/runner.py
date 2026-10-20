#!/usr/bin/env python3
"""board-runner: wakes local CLI agents when the board has mail for them, and patrols their health.

One long-poll thread per identity calls board_wait on the board's /mcp endpoint
with that identity's own key. When a message arrives, it is pasted into the
identity's tmux session (board-<identity>), which runs the agent CLI resumed on a
fixed session via launch.sh. Attach with: tmux attach -t board-<identity>

Delivery is verified: before typing, the runner checks the session is healthy (health()),
waits until the agent is idle, clears leftover input, pastes, and confirms the Enter was
taken. If anything fails, the board cursor is NOT advanced, so the message is retried.

A patrol thread checks every identity every RUNNER_PATROL_SEC and alerts the coordinator
on the board (once per problem, plus a recovery note): session gone, agent process dead,
stopped at an approval prompt, busy with no screen change for RUNNER_STUCK_SEC, or a
message queued behind a busy agent for RUNNER_QUEUE_SEC, or the same message failing to
deliver RUNNER_FAIL_N times in a row. The runner only reports; it never restarts agents.
It types nothing (no paste, no Enter, no C-u) while an approval prompt is on screen: the
message stays queued until a human answers the prompt (covered by test_runner.py).
Alerts are status only by default; pane text is a prompt-injection channel into the
coordinator, so it is opt-in (RUNNER_ALERT_PANE=1).

Config (env or .env next to this file):
  BOARD_URL            https://<your-worker>/mcp
  BOARD_CONFIG_DIR     directory holding identities.tsv and <identity>.key files
  BOARD_IDS            optional comma list to run only some identities
  RUNNER_COORDINATOR   identity that receives patrol alerts (unset = alerts only go to the logs)
  RUNNER_IDENTITY      optional dedicated identity whose key posts alerts (default: the affected
                       identity's own key). The coordinator should not also be an approver or merger.
  RUNNER_ALERT_PANE=1  include masked last pane lines in alerts (default: status only)
  RUNNER_HOOK_TTL      minutes a "waiting" hook state may contradict an idle screen before the
                       screen check wins (logged as "hook state stale"), default 5
  RUNNER_FAIL_N        consecutive failed deliveries of one message before delivery_failing, default 3
  RUNNER_SENSITIVE     comma list of identities whose alerts carry status only, never pane text
                       (e.g. agents that handle sensitive data)
  RUNNER_AGENT_PROCS   comma list of process names that count as "the agent is alive"
                       (pane command or a direct child of the pane); default claude,codex,gemini,node
  RUNNER_DRY=1         alerts are written to logs/alerts-dry.log instead of the board
  RUNNER_STATE         state dir (cursor files, alerts.json); default ./state
  RUNNER_PATROL_SEC    patrol interval, default 240
  RUNNER_STUCK_SEC     busy with an unchanged screen this long = stuck, default 900
  RUNNER_QUEUE_SEC     message waiting behind a busy agent this long = alert, default 600
  RUNNER_PATROL_ONLY=1 run only the patrol (no delivery threads)
  RUNNER_TMUX_SOCKET   optional tmux -L socket name (the self-test uses its own)
"""
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
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
env = os.environ.get
csv = lambda s: [x.strip() for x in str(s or "").split(",") if x.strip()]
URL = env("BOARD_URL", "")
CONF = os.path.expanduser(env("BOARD_CONFIG_DIR", "~/.config/agent-board"))
LOGS = env("RUNNER_LOGS", os.path.join(HERE, "logs"))
STATE = env("RUNNER_STATE", os.path.join(HERE, "state"))
DRY = env("RUNNER_DRY") == "1"
COORDINATOR = env("RUNNER_COORDINATOR", "")
SENSITIVE = set(csv(env("RUNNER_SENSITIVE")))
AGENT_PROCS = set(csv(env("RUNNER_AGENT_PROCS", "claude,codex,gemini,node")))
PATROL_SEC = int(env("RUNNER_PATROL_SEC", "240"))
STUCK_SEC = int(env("RUNNER_STUCK_SEC", "900"))
QUEUE_SEC = int(env("RUNNER_QUEUE_SEC", "600"))
FAIL_N = int(env("RUNNER_FAIL_N", "3"))
ALERT_PANE = env("RUNNER_ALERT_PANE") == "1"
RUNNER_IDENTITY = env("RUNNER_IDENTITY", "")
PROMPT = env(
    "BOARD_PROMPT",
    '[board #{id} from {frm} to {to}] {text} -- Handle this, then reply with the board tool '
    'board_post to="{frm}" (start with "Re #{id}"). If you have already handled #{id}, ignore this copy '
    '(the runner may redeliver). Never paste secrets or sensitive data on the board.',
)
# Screen patterns of common agent CLIs. Override with RUNNER_BUSY_RE / RUNNER_APPROVAL_RE if yours differ.
BUSY = re.compile(env("RUNNER_BUSY_RE", r"esc to interrupt|esc to cancel|• Working|Working \(|Thinking…|✻ \w+ing…|\(esc to"))
# Approval prompts are matched only above the input box and need structure: a numbered menu
# ("1. ..." followed by "2. ..." or "No") under a question, or a y/n prompt as the last line.
# RUNNER_APPROVAL_RE overrides the question pattern.
QUESTION = re.compile(env("RUNNER_APPROVAL_RE",
    r"Do you want to|Allow (?:command|this)|Would you like to|approve|Proceed\?|Press enter to confirm"), re.I)
OPT1 = re.compile(r"^\s*(?:│\s*)?[›❯>]?\s*1\.\s+\S")
OPT2 = re.compile(r"^\s*(?:│\s*)?[›❯>]?\s*(?:2\.\s+\S|No\b)", re.I)
YN = re.compile(r"(?:\(y/n\)|\[y/N\]|\[Y/n\]|\(yes/no\))\s*[:?]?\s*$", re.I)
INPUT = re.compile(r"^\s*(?:│\s*)?[›❯>]\s?(.*)$")  # the agent's input line
MENU = re.compile(r"^\s*(?:│\s*)?[›❯>]\s*\d+\.\s")  # "❯ 1. Yes" is a menu cursor, not the input line
BORDER = re.compile(r"^\s*[─━═╭╰└┌][─━═]{3,}|^\s*[╰└][─━═]")
# Masking for pane text quoted in alerts: tokens, key=value secrets, long opaque strings, IPv4, e-mail.
SECRET = re.compile(r"(?:sk|pk|ghp|gho|ghs|github_pat|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}|Bearer\s+\S+"
                    r"|(?:key|token|secret|password|passwd)\s*[=:]\s*\S+|\b[A-Za-z0-9+/_-]{32,}\b"
                    r"|\b(?:\d{1,3}\.){3}\d{1,3}\b|\S+@\S+", re.I)
NAMES = {"session_missing": "tmux session is gone", "process_dead": "agent process is not running",
         "awaiting_approval": "stopped at an approval prompt", "stuck": "busy but the screen has not changed",
         "queue_held": "a message has been waiting behind a busy agent",
         "delivery_failing": "the same message keeps failing to deliver"}
DOWN = ("session_missing", "process_dead")


def identities():
    """identities.tsv columns: identity<TAB>cli<TAB>session_id<TAB>workdir<TAB>extra (see example)."""
    rows = []
    for line in open(os.path.join(CONF, "identities.tsv")):
        if line.strip() and not line.startswith("#"):
            rows.append(line.rstrip("\n").split("\t")[0])
    return rows


def log(i, m):
    os.makedirs(LOGS, exist_ok=True)
    with open(os.path.join(LOGS, f"{i}.log"), "a") as f:
        f.write(f"{datetime.datetime.now():%m-%d %H:%M:%S} {m}\n")


def key_of(i):
    return open(os.path.join(CONF, f"{i}.key")).read().strip()


def rpc(key, name, args, timeout=70):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": name, "arguments": args}}).encode()
    req = urllib.request.Request(URL, body, {"Authorization": "Bearer " + key,
                                             "content-type": "application/json",
                                             "User-Agent": "agent-board-runner/0.2"})
    d = json.load(urllib.request.urlopen(req, timeout=timeout))
    if "error" in d:
        raise RuntimeError(d["error"])
    return d["result"]["structuredContent"]


TMUX = ["tmux"] + (["-L", env("RUNNER_TMUX_SOCKET")] if env("RUNNER_TMUX_SOCKET") else [])


def tmux(*a):
    return subprocess.run([*TMUX, *a], capture_output=True, text=True)


def session(i):
    return "board-" + i


def ensure(i):
    s = session(i)
    if tmux("has-session", "-t", "=" + s).returncode != 0:
        tmux("new-session", "-d", "-s", s, "-x", "220", "-y", "50",
             f"{HERE}/launch.sh {i}; echo '[exited] press Enter'; read")
        log(i, "started tmux " + s)
        time.sleep(int(env("BOARD_START_WAIT", "25")))
    return s


# ---------- screen helpers ----------
def cap(s):
    r = tmux("capture-pane", "-p", "-J", "-t", "=" + s + ":")
    return r.stdout if r.returncode == 0 else None


def rows(s):
    """Pane rows without the blank rows below the cursor."""
    return (cap(s) or "").rstrip().splitlines()


def tail(s, n):
    """Last n lines of the pane, ignoring the blank rows below the cursor."""
    return "\n".join(rows(s)[-n:])


# ---------- screen model (fail closed) ----------
RECENT = {}  # session -> the last few payloads the runner pasted, whitespace removed


def remember(s, payload):
    r = RECENT.setdefault(s, [])
    r.append("".join(payload.split()))
    del r[:-5]


def _bare(x):
    return x.strip().strip("│").strip().lstrip("›❯>•⏺ ").strip()


def _flat(x):
    return "".join(_bare(x).split())


OPT2N = re.compile(r"^\s*(?:│\s*)?[›❯>]?\s*2\.\s+\S")


def menuish(x):
    return bool(OPT1.match(x) or OPT2N.match(x) or YN.search(_bare(x)) or QUESTION.search(x))


def find_input(lines, cur=""):
    """(top, k, end) of the agent's input box, or None.

    Only the LOWEST input-looking line is a candidate, and it counts only if everything below
    it is: the wrapped continuation of the current unsent paste (cur, whitespace removed), a
    bottom border, and at most 4 footer rows with no menu or prompt text. Anything else means
    there is no input box (for example an approval menu replaced it, and the lowest '>' is a
    transcript line), which the gate treats as a possible prompt."""
    k = next((n for n in range(len(lines) - 1, max(-1, len(lines) - 30), -1)
              if INPUT.match(lines[n]) and not MENU.match(lines[n])), None)
    if k is None:
        return None
    n = k + 1
    while (n < len(lines) and cur and not BORDER.match(lines[n]) and not menuish(lines[n])
           and _flat(lines[n]) and _flat(lines[n]) in cur):  # a menu row is never a wrap, even if quoted earlier
        n += 1
    end = n if n < len(lines) and BORDER.match(lines[n]) else None
    rest = lines[end + 1:] if end is not None else lines[n:]
    if any(menuish(x) for x in rest) or len([x for x in rest if x.strip()]) > 4:
        return None
    top = k - 1 if k > 0 and BORDER.match(lines[k - 1]) else k
    return top, k, (end if end is not None else n - 1)


def approval_in(lines, cur=""):
    """None, "no_input", "menu" or "yn". Fails closed: no valid input box = possibly a prompt.
    Menu detection looks at the last 15 rows of the whole screen, scrollback included; only the
    input box holding the current unsent paste is excluded (text from earlier pastes is NOT
    removed, so a quoted '1. Yes 2. No' can't hide a real menu)."""
    box = find_input(lines, cur)
    if box is None:
        return "no_input"
    top, k, end = box
    a = [x for x in lines[:top] + lines[end + 1:] if x.strip()][-15:]
    ones = [n for n, x in enumerate(a) if OPT1.match(x)]
    if ones and any(OPT2.match(x) for x in a[ones[-1] + 1:]) and (
            any(MENU.match(x) for x in a) or any(QUESTION.search(x) for x in a)):
        return "menu"
    above = [x for x in lines[:top] if x.strip()]
    if above and YN.search(_bare(above[-1])):
        return "yn"
    return None


def screen(s):
    return rows(s), (RECENT.get(s) or [""])[-1]


def approval_on(s):
    return approval_in(*screen(s))


def busy_in(lines, rec):
    """Busy spinner above the input box or in the footer; rows from recent runner pastes are
    ignored here (a false 'busy' only delays, it never types)."""
    box = find_input(lines, rec[-1] if rec else "")
    above, footer = (lines, []) if box is None else (lines[:box[0]], lines[box[2] + 1:])

    def mine(x):
        t = _flat(x)
        return len(t) >= 3 and any(t in r for r in rec)
    return bool(BUSY.search("\n".join([x for x in above if x.strip() and not mine(x)][-12:]
                                      + [x for x in footer if not mine(x)])))


def busy(s):
    return busy_in(rows(s), RECENT.get(s, []))


HOOK_TTL = int(env("RUNNER_HOOK_TTL", "5")) * 60  # minutes the screen may contradict a "waiting" hook
HOOK_CLEAN = {}         # identity -> since when the screen looked idle while the hook said waiting
HOOK_STALE_LOGGED = {}  # identity -> hook ts already logged as stale


def hook_state(i):
    """state/<identity>.hook.json written by runner/hooks/board_hook.py, or None."""
    try:
        with open(os.path.join(STATE, f"{i}.hook.json")) as f:
            return json.load(f)
    except Exception:
        return None


def inputline(s):
    c = cap(s)
    if c is None:
        return None
    for x in reversed(c.rstrip().splitlines()[-15:]):
        m = INPUT.match(x)
        if m:
            return m.group(1).strip()
    return "".join("".join([x for x in c.splitlines() if x.strip()][-4:]).split())


def typed(s):
    """Real text before the cursor on the input line (ghost suggestions sit after the cursor)."""
    r = tmux("display", "-p", "-t", "=" + s + ":", "#{cursor_x} #{cursor_y}")
    if r.returncode:
        return ""
    x, y = map(int, r.stdout.split())
    lines = (cap(s) or "").splitlines()
    if y >= len(lines):
        return ""
    m = INPUT.match(lines[y][:x])
    return m.group(1).strip() if m else ""


# ---------- health ----------
def children(pid):
    r = subprocess.run(["ps", "--ppid", str(pid), "-o", "comm="], capture_output=True, text=True)
    return r.stdout.split()


def health(i):
    """{"problem": None|"session_missing"|"process_dead"|"awaiting_approval", "detail": str, "busy": bool}"""
    s = session(i)
    if tmux("has-session", "-t", "=" + s).returncode:
        return {"problem": "session_missing", "detail": f"no tmux session {s}"}
    r = tmux("display", "-p", "-t", "=" + s + ":", "#{pane_current_command}\t#{pane_pid}\t#{pane_dead}")
    if r.returncode or not r.stdout.strip():
        return {"problem": "session_missing", "detail": f"no tmux session {s}"}
    cmd, pid, dead = (r.stdout.strip().split("\t") + ["", "", ""])[:3]
    kids = children(pid) if pid.isdigit() else []
    if dead == "1" or not (cmd in AGENT_PROCS or AGENT_PROCS.intersection(kids)):
        return {"problem": "process_dead", "detail": f"pane is running {cmd or '?'}, no agent process"}
    h = hook_state(i)
    why = approval_on(s)
    if h and h.get("waiting_approval"):
        if why is None:  # the screen shows a valid bottom input box and no menu
            c = HOOK_CLEAN.get(i)
            if not c or c[0] != h.get("ts"):  # a newer hook event restarts the TTL
                c = HOOK_CLEAN[i] = (h.get("ts"), time.time())
            t0 = c[1]
            if time.time() - t0 > HOOK_TTL:
                if HOOK_STALE_LOGGED.get(i) != h.get("ts"):
                    HOOK_STALE_LOGGED[i] = h.get("ts")
                    log(i, f"hook state stale ({h.get('event')}): idle input box on screen for over "
                           f"{HOOK_TTL // 60} min; using the screen check")
                return {"problem": None, "busy": busy(s), "hook_stale": True}
        else:
            HOOK_CLEAN.pop(i, None)
        return {"problem": "awaiting_approval", "detail": f"hook reports a permission prompt ({h.get('event')})"}
    HOOK_CLEAN.pop(i, None)
    if why == "no_input":
        return {"problem": "awaiting_approval", "detail": "no input box on screen; possibly a prompt"}
    if why:
        return {"problem": "awaiting_approval", "detail": "waiting at a confirmation prompt"}
    return {"problem": None, "busy": busy(s)}


# ---------- alerts (deduped in STATE/alerts.json, with a recovery note) ----------
_lock = threading.Lock()
QUEUED = {}  # identity -> time a message started waiting behind a busy agent


def _alerts():
    try:
        return json.load(open(os.path.join(STATE, "alerts.json")))
    except Exception:
        return {}


def _save(a):
    os.makedirs(STATE, exist_ok=True)
    tmp = os.path.join(STATE, "alerts.json.tmp")
    json.dump(a, open(tmp, "w"))
    os.replace(tmp, os.path.join(STATE, "alerts.json"))


def lastlines(i, n=6):
    """Last pane lines for an alert, masked. Sensitive identities never send pane text."""
    if i in SENSITIVE:
        return ""
    lines = [x.rstrip() for x in (cap(session(i)) or "").splitlines() if x.strip()][-n:]
    return "\n".join(SECRET.sub("[masked]", x)[:160] for x in lines)


def post(i, text):
    if DRY or not COORDINATOR:
        os.makedirs(LOGS, exist_ok=True)
        with open(os.path.join(LOGS, "alerts-dry.log" if DRY else "alerts.log"), "a") as f:
            f.write(f"{datetime.datetime.now():%m-%d %H:%M:%S} [{i}] {text}\n")
        return
    # posted with the dedicated runner identity if set, else as the affected identity
    rpc(key_of(RUNNER_IDENTITY or i), "board_post", {"to": COORDINATOR, "text": text}, timeout=30)


def alert(i, prob, st=None):
    """At-least-once: the dedupe record is written only after the post succeeds; a failed post
    is retried by the next patrol pass (or delivery attempt) that still sees the problem."""
    k = f"{i}|{prob}"
    with _lock:
        if k in _alerts():
            return False
    st = st or {}
    t = f"[runner patrol] {i}: {NAMES.get(prob, prob)}" + (f" ({st['detail']})" if st.get("detail") else "")
    if prob in ("stuck", "queue_held"):
        t += f", for about {int(st.get('dur', 0) // 60)} min"
    if prob == "delivery_failing":
        t += f" (#{st.get('mid')} failed {st.get('n')} times in a row)"
    if i in SENSITIVE or not ALERT_PANE:
        t += ". Status only: no screen text is sent."
    elif prob != "session_missing":
        ll = lastlines(i)
        if ll:
            t += "\nLast lines:\n" + ll
    t += "\n(The runner only reports; it does not restart or type for the agent. You will get a note when it recovers.)"
    try:
        post(i, t)
    except Exception as e:
        log(i, f"error alert post {prob}: {e!r}; will retry")
        return False
    with _lock:
        a = _alerts()
        a[k] = time.time()
        _save(a)
    log(i, f"alert posted: {prob}")
    return True


def resolve(i, prob):
    with _lock:
        a = _alerts()
        k = f"{i}|{prob}"
        if k not in a:
            return False
        t0 = a[k]
    try:
        post(i, f"[runner patrol] {i}: recovered ({NAMES.get(prob, prob)}, after about {int((time.time() - t0) // 60)} min)")
    except Exception as e:
        log(i, f"error recovery post {prob}: {e!r}; will retry")
        return False
    with _lock:
        a = _alerts()
        a.pop(k, None)
        _save(a)
    log(i, f"recovery posted: {prob}")
    return True


def patrol_once(ids, seen):
    """One patrol pass. seen: identity -> (screen hash, since) carried between passes."""
    for i in ids:
        try:
            st = health(i)
            p = st["problem"]
            for q in DOWN + ("awaiting_approval",):
                if q != p and not (p in DOWN and q in DOWN):
                    resolve(i, q)
            if p is None or p == "awaiting_approval":
                for q in DOWN:
                    resolve(i, q)
            if p:
                alert(i, p, st)
                seen.pop(i, None)
            stuck = False
            if p is None and st.get("busy"):
                h = hashlib.sha256((cap(session(i)) or "").encode()).hexdigest()
                o = seen.get(i)
                if not o or o[0] != h:
                    seen[i] = (h, time.time())
                elif time.time() - o[1] > STUCK_SEC:
                    stuck = True
                    alert(i, "stuck", {"dur": time.time() - o[1]})
            else:
                seen.pop(i, None)
            if not stuck:
                resolve(i, "stuck")
            qt = QUEUED.get(i)
            if qt and time.time() - qt > QUEUE_SEC:
                alert(i, "queue_held", {"dur": time.time() - qt})
            elif not qt:
                resolve(i, "queue_held")
            f = FAILS.get(i)
            if f and f[1] >= FAIL_N:
                alert(i, "delivery_failing", {"mid": f[0], "n": f[1]})
            elif not f:
                resolve(i, "delivery_failing")
        except Exception as e:
            log(i, f"error patrol {e!r}")


def patrol(ids):
    seen = {}
    while True:
        patrol_once(ids, seen)
        time.sleep(PATROL_SEC)


# ---------- delivery ----------
FAILS = {}  # identity -> [message id, consecutive failed delivery attempts]


def gate(i, m, pasted=False):
    """True when nothing may be typed: an approval prompt (or an outage) is on screen."""
    st = health(i)
    if st["problem"]:
        if pasted:
            st = dict(st, detail=(st.get("detail") or "") + f"; there's an unsent board message (#{m['id']}) on the input line")
        QUEUED.setdefault(i, time.time())
        alert(i, st["problem"], st)
        log(i, f"gate: {st['problem']}; #{m['id']} queued, nothing typed")
        return True
    return False


def note_result(i, m, ok):
    """Count consecutive real failures (False) of the same message; holds (None) don't count."""
    if ok:
        FAILS.pop(i, None)
    elif ok is False:
        f = FAILS.get(i)
        FAILS[i] = [m["id"], f[1] + 1] if f and f[0] == m["id"] else [m["id"], 1]
def wait_idle(i, s, limit=3600):
    t0 = time.time()
    warned = False
    try:
        while True:
            if not busy(s):
                time.sleep(2)
                if not busy(s):
                    return True
            QUEUED.setdefault(i, t0)
            if not warned and time.time() - t0 > 60:
                log(i, "agent busy; message queued")
                warned = True
            if time.time() - t0 > limit:
                log(i, "error: still busy after limit; keeping the message queued")
                return False
            time.sleep(3)
    finally:
        QUEUED.pop(i, None)


def deliver(i, m):
    """True = verifiably submitted. None = held (outage, busy or approval prompt; nothing typed).
    False = a delivery attempt failed. Both falsy results keep the cursor (retry)."""
    st = health(i)
    if st["problem"] in DOWN:
        alert(i, st["problem"], st)
        log(i, f"pre-dispatch: {st['problem']}; #{m['id']} held, cursor not advanced")
        return None
    if st["problem"] == "awaiting_approval":  # treat like busy: queue, type nothing
        QUEUED.setdefault(i, time.time())
        alert(i, "awaiting_approval", st)
        log(i, f"pre-dispatch: awaiting_approval; #{m['id']} queued, nothing typed")
        return None
    resolve(i, "session_missing")
    resolve(i, "process_dead")
    s = session(i)
    p = PROMPT.format(id=m["id"], frm=m["from"], to=m["to"], text=" ".join(str(m["text"]).split()))
    if not wait_idle(i, s):
        return None
    if gate(i, m):
        return None
    left = typed(s)
    if left:
        log(i, f"leftover input before #{m['id']} ({len(left)} chars); clearing with C-u")
        tmux("send-keys", "-t", "=" + s + ":", "C-u")
        time.sleep(0.8)
        if typed(s):
            log(i, f"error leftover input not cleared before #{m['id']}; cursor not advanced")
            return False
    if gate(i, m):
        return None
    before = inputline(s)
    b = "runner-" + i
    remember(s, p)
    r = subprocess.run([*TMUX, "load-buffer", "-b", b, "-"], input=p, capture_output=True, text=True)
    if r.returncode:
        log(i, f"error load-buffer #{m['id']}: {r.stderr.strip()}")
        return False
    r = tmux("paste-buffer", "-p", "-d", "-b", b, "-t", "=" + s + ":")
    if r.returncode:
        log(i, f"error paste-buffer #{m['id']}: {r.stderr.strip()}")
        return False
    prev, same, landed, t0 = None, 0, None, time.time()
    while time.time() - t0 < 20:  # wait until the input line changed and is stable
        time.sleep(0.8)
        cur = inputline(s)
        same = same + 1 if cur == prev else 0
        prev = cur
        if cur != before and same >= 2:
            landed = cur
            break
    if landed is None:
        log(i, f"error #{m['id']} paste did not land; cursor not advanced")
        return False
    time.sleep(1.0)
    for attempt in (1, 2):
        if gate(i, m, pasted=True):  # never press anything (not even C-u) into an approval prompt
            return None
        r = tmux("send-keys", "-t", "=" + s + ":", "Enter")
        if r.returncode:
            log(i, f"error send Enter #{m['id']}: {r.stderr.strip()}")
            return False
        t0 = time.time()
        while time.time() - t0 < 15:
            time.sleep(1.0)
            if busy(s) or inputline(s) != landed:
                log(i, f"delivered #{m['id']} from {m['from']} (verified, enter x{attempt}, {len(p)} chars)")
                return True
    tmux("send-keys", "-t", "=" + s + ":", "C-u")
    log(i, f"error #{m['id']} not submitted after 2 Enters; cleared input, cursor not advanced")
    return False


def loop(i):
    key = key_of(i)
    sf = os.path.join(STATE, f"{i}.last")
    since = int(open(sf).read()) if os.path.exists(sf) else None
    if since is None:  # first run: start from the newest message, don't replay history
        since = rpc(key, "board_wait", {"timeout_seconds": 0}).get("last_id", 0)
        open(sf, "w").write(str(since))
    log(i, f"polling since {since}")
    ensure(i)
    while True:
        try:
            r = rpc(key, "board_wait", {"since_id": since, "timeout_seconds": 50})
            for m in sorted(r.get("messages", []), key=lambda x: x["id"]):
                if str(m["from"]).lower() != i.lower():
                    ok = deliver(i, m)
                    note_result(i, m, ok)
                    if not ok:
                        time.sleep(20)
                        break  # retry from this message next round
                since = max(since, m["id"])
                open(sf, "w").write(str(since))
        except Exception as e:  # network blips, worker redeploys
            log(i, f"error {e!r}")
            time.sleep(15)


def main():
    if not URL and env("RUNNER_PATROL_ONLY") != "1":
        raise SystemExit("BOARD_URL is not set (see .env.example)")
    os.makedirs(LOGS, exist_ok=True)
    os.makedirs(STATE, exist_ok=True)
    only = env("BOARD_IDS")
    ids = csv(only) if only else identities()
    if env("RUNNER_PATROL_ONLY") != "1":
        for i in ids:
            threading.Thread(target=loop, args=(i,), daemon=True).start()
            time.sleep(1)
    threading.Thread(target=patrol, args=(ids,), daemon=True).start()
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()

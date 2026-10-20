#!/usr/bin/env python3
"""Self-test for runner.py health checks, patrol, masking and alert dedupe.

Runs against throwaway tmux sessions on a private tmux socket (never your real sessions),
with RUNNER_DRY=1 so alerts go to a temp log instead of the board. Skipped when tmux is absent.
Run: python3 runner/test_runner.py
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="runner-test-")
SOCK = f"runner-selftest-{os.getpid()}"
PFX = f"selftest{os.getpid()}"
SENS = PFX + "-sensitive"
os.environ.update({"RUNNER_DRY": "1", "RUNNER_STATE": os.path.join(TMP, "state"), "RUNNER_LOGS": os.path.join(TMP, "logs"),
                   "RUNNER_TMUX_SOCKET": SOCK, "RUNNER_AGENT_PROCS": "sleep", "RUNNER_SENSITIVE": SENS,
                   "RUNNER_STUCK_SEC": "1", "RUNNER_QUEUE_SEC": "1", "BOARD_CONFIG_DIR": TMP})
spec = importlib.util.spec_from_file_location("runner", os.path.join(HERE, "runner.py"))
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)
HAVE_TMUX = shutil.which("tmux") is not None


def start(i, shell):
    R.tmux("kill-session", "-t", "=" + R.session(i))
    assert R.tmux("new-session", "-d", "-s", R.session(i), "-x", "200", "-y", "40", shell).returncode == 0
    time.sleep(0.6)


def kill(i):
    R.tmux("kill-session", "-t", "=" + R.session(i))


def dry():
    try:
        return open(os.path.join(TMP, "logs", "alerts-dry.log")).read()
    except FileNotFoundError:
        return ""


def alerts():
    try:
        return json.load(open(os.path.join(TMP, "state", "alerts.json")))
    except FileNotFoundError:
        return {}


@unittest.skipUnless(HAVE_TMUX, "tmux not installed")
class RunnerSelfTest(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        subprocess.run(["tmux", "-L", SOCK, "kill-server"], capture_output=True)
        shutil.rmtree(TMP, ignore_errors=True)

    def test_health_states(self):
        self.assertEqual(R.health(PFX + "-nope")["problem"], "session_missing")
        start(PFX + "-shell", "cat")                                   # pane runs something that isn't the agent
        self.assertEqual(R.health(PFX + "-shell")["problem"], "process_dead")
        start(PFX + "-ok", "sh -c 'echo ready; exec sleep 600'")      # the "agent" (sleep) is the pane command
        self.assertEqual(R.health(PFX + "-ok"), {"problem": None, "busy": False})
        start(PFX + "-child", "sh -c 'sleep 600; true'")              # the agent is a child of the pane's shell
        self.assertIsNone(R.health(PFX + "-child")["problem"])
        start(PFX + "-ask", "sh -c 'echo \"Do you want to proceed? (y/n)\"; exec sleep 600'")
        self.assertEqual(R.health(PFX + "-ask")["problem"], "awaiting_approval")
        # exact session match: board-<x>-ok must not satisfy board-<x>
        self.assertEqual(R.health(PFX)["problem"], "session_missing")

    def test_masking_and_sensitive_status_only(self):
        secret = "sk-" + "A1b2C3d4E5f6G7h8I9j0"
        line = f"token={secret} Bearer abc.def 10.20.30.40 ops@example.com plain words"
        start(PFX + "-mask", f"sh -c 'echo \"{line}\"; exec cat'")
        ll = R.lastlines(PFX + "-mask")
        self.assertIn("plain words", ll)
        for leak in (secret, "abc.def", "10.20.30.40", "ops@example.com"):
            self.assertNotIn(leak, ll)
        R.alert(PFX + "-mask", "process_dead", {"detail": "pane is running cat"})
        self.assertIn("[masked]", dry())
        self.assertNotIn(secret, dry())
        start(SENS, f"sh -c 'echo \"{line}\"; exec cat'")
        self.assertEqual(R.lastlines(SENS), "")
        R.alert(SENS, "process_dead", {"detail": "x"})
        sens = [x for x in dry().split("\n") if f"[{SENS}]" in x][0]
        self.assertIn("Status only", sens)
        self.assertNotIn("plain words", dry().split(f"[{SENS}]", 1)[1].split("(The runner only reports")[0])

    def test_patrol_dedupe_and_recovery(self):
        i = PFX + "-rec"
        start(i, "cat")
        R.patrol_once([i], {}); R.patrol_once([i], {})
        self.assertEqual(dry().count(f"[{i}] [runner patrol] {i}: agent process is not running"), 1, "deduped")
        self.assertIn(f"{i}|process_dead", alerts())
        kill(i)
        R.patrol_once([i], {})
        self.assertIn(f"{i}|session_missing", alerts())
        self.assertIn(f"{i}|process_dead", alerts(), "down -> down keeps the first alert open")
        start(i, "sh -c 'exec sleep 600'")
        R.patrol_once([i], {})
        self.assertFalse([k for k in alerts() if k.startswith(i + "|")])
        self.assertIn(f"{i}: recovered (agent process is not running", dry())
        self.assertIn(f"{i}: recovered (tmux session is gone", dry())

    def test_stuck_and_queue_held(self):
        i = PFX + "-busy"
        start(i, "sh -c 'echo \"Working (esc to interrupt)\"; exec sleep 600'")
        self.assertTrue(R.health(i)["busy"])
        seen = {}
        R.patrol_once([i], seen); time.sleep(1.3); R.patrol_once([i], seen); R.patrol_once([i], seen)
        self.assertEqual(dry().count(f"{i}: busy but the screen has not changed"), 1)
        R.QUEUED[i] = time.time() - 5
        R.patrol_once([i], seen)
        self.assertIn(f"{i}: a message has been waiting behind a busy agent", dry())
        R.QUEUED.pop(i)
        start(i, "sh -c 'echo idle; exec sleep 600'")
        R.patrol_once([i], seen)
        self.assertIn(f"{i}: recovered (busy but the screen has not changed", dry())
        self.assertIn(f"{i}: recovered (a message has been waiting", dry())

    def test_pre_dispatch_holds_message(self):
        i = PFX + "-gone"
        ok = R.deliver(i, {"id": 42, "from": "someone", "to": i, "text": "hello"})
        self.assertFalse(ok, "message is held (cursor not advanced) when the session is missing")
        self.assertIn(f"{i}|session_missing", alerts())


if __name__ == "__main__":
    unittest.main(verbosity=2)

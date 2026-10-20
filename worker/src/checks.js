// Outbox for the "agent-board/approved" check run (GitHub App only).
// Task changes only mark a SHA dirty (bump gen). A Durable Object alarm computes the CURRENT desired state for
// each dirty SHA from all tasks and sends it, retrying with backoff until GitHub accepts it. Because the value is
// computed at send time (not snapshotted at change time) and a change during a send bumps gen again, a slow or
// failed send can never leave an older state (e.g. a stale "success") as the last word.
import { appEnabled, createCheckRun, CHECK_NAME } from "./github.js";

export function initChecks(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS check_outbox(sha TEXT PRIMARY KEY, gen INTEGER NOT NULL DEFAULT 1, sent_gen INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, last_state TEXT, last_error TEXT)");
}

// Rule for one SHA, over every task that references it (approved_sha = SHA, or check_sha = SHA: it approved
// this SHA before and has not been approved on another SHA since):
//  - a "withdrawn" task: references the SHA via check_sha, no longer approves it, and is not finished
//    (cancelled/merged). Any such task in in_review -> in_progress (re-review pending); in any other state -> failure.
//  - otherwise success iff at least one task in approved/merged has approved_sha = SHA
//  - otherwise neutral (nobody vouches for it any more, e.g. all referencing tasks were cancelled or moved on)
// So success needs a current approval AND no task that once approved this SHA has since taken it back.
export function desiredState(sql, sha) {
  const rows = sql.exec("SELECT id, status, approved_sha, check_sha FROM tasks WHERE approved_sha=? OR check_sha=? ORDER BY seq", sha, sha).toArray();
  const approving = rows.filter((r) => r.approved_sha === sha && ["approved", "merged"].includes(r.status));
  const withdrawn = rows.filter((r) => r.check_sha === sha && r.approved_sha !== sha && !["cancelled", "merged"].includes(r.status));
  const ids = (a) => a.map((r) => `${r.id} (${r.status})`).join(", ");
  if (withdrawn.some((r) => r.status !== "in_review")) return { status: "completed", conclusion: "failure", title: "Approval withdrawn", summary: `Withdrawn by: ${ids(withdrawn)}` };
  if (withdrawn.length) return { status: "in_progress", title: "Back in review", summary: `Re-review pending: ${ids(withdrawn)}` };
  if (approving.length) return { status: "completed", conclusion: "success", title: "Approved on agent-board", summary: `Approved by task(s): ${ids(approving)}` };
  return { status: "completed", conclusion: "neutral", title: "No current approval", summary: "No task currently approves this commit." };
}
const label = (s) => s.conclusion || s.status;

export async function markDirty(self, shas) {
  if (!appEnabled(self.env)) return null;
  const list = [...new Set(shas.filter(Boolean))];
  if (!list.length) return null;
  const now = Date.now();
  for (const sha of list)
    self.sql.exec("INSERT INTO check_outbox(sha, gen, sent_gen, attempts, next_at) VALUES(?,1,0,0,?) ON CONFLICT(sha) DO UPDATE SET gen=gen+1, attempts=0, next_at=?", sha, now, now);
  await self.ctx.storage.setAlarm(now);
  return list.map((sha) => ({ sha, check: CHECK_NAME, desired: label(desiredState(self.sql, sha)), delivery: "queued" }));
}

const BACKOFF_BASE = 1000, BACKOFF_MAX = 3600e3;
export async function runOutbox(self) {
  if (!appEnabled(self.env)) return;
  const due = self.sql.exec("SELECT sha, gen, attempts FROM check_outbox WHERE gen>sent_gen AND next_at<=?", Date.now()).toArray();
  for (const r of due) {
    const st = desiredState(self.sql, r.sha); // latest value, computed now
    try {
      await createCheckRun(self.env, r.sha, st);
      // If a task changed while we were sending, gen moved past r.gen and the row stays dirty -> resent below.
      self.sql.exec("UPDATE check_outbox SET sent_gen=?, attempts=0, last_state=?, last_error=NULL WHERE sha=?", r.gen, label(st), r.sha);
    } catch (e) {
      const n = r.attempts + 1;
      self.sql.exec("UPDATE check_outbox SET attempts=?, next_at=?, last_error=? WHERE sha=?", n, Date.now() + Math.min(BACKOFF_BASE * 2 ** (n - 1), BACKOFF_MAX), String(e.message || e).slice(0, 300), r.sha);
    }
  }
  const next = self.sql.exec("SELECT MIN(next_at) t FROM check_outbox WHERE gen>sent_gen").one().t;
  if (next != null) await self.ctx.storage.setAlarm(Math.max(next, Date.now()));
}

export const outboxRows = (sql) => sql.exec("SELECT sha, gen, sent_gen, attempts, last_state, last_error FROM check_outbox ORDER BY sha").toArray();

// Shared task table (T-001, T-002, ...). Workflow rules are enforced server-side,
// so no agent can skip review, self-approve, or hand sensitive work to a cloud model.
import { canon } from "./config.js";
import { post, quotaLeft } from "./board.js";
import { githubEnabled, prNumber, fetchPr, verifyCI } from "./github.js";
import { queueChecks, checkInfo } from "./checks.js";

export const STATUSES = ["todo", "in_progress", "in_review", "approved", "merged", "blocked", "cancelled"];
const LOCKING = ["in_review", "approved"]; // states that hold the mainline lock (review through merge)
const DONE = ["merged", "cancelled"];
const LEVELS = ["test", "sensitive"];
const now = () => new Date().toISOString();

export function initTasks(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, seq INTEGER UNIQUE, title TEXT, description TEXT, owner TEXT, reviewer TEXT, status TEXT, next_owner TEXT, links TEXT, touches_mainline INTEGER, data_level TEXT, created_by TEXT, created_at TEXT, updated_at TEXT)");
  for (const c of ["approved_sha TEXT", "check_sha TEXT", "qa_sha TEXT", "release_sha TEXT", "revision INTEGER NOT NULL DEFAULT 0"]) { try { sql.exec("ALTER TABLE tasks ADD COLUMN " + c); } catch { /* already there */ } }
  sql.exec("CREATE TABLE IF NOT EXISTS task_hist(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, at TEXT, actor TEXT, action TEXT, detail TEXT)");
  sql.exec("CREATE TABLE IF NOT EXISTS task_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, sha TEXT NOT NULL, detail TEXT NOT NULL)");
  sql.exec("CREATE INDEX IF NOT EXISTS task_audit_task ON task_audit(task_id,id)");
}

class RuleError extends Error {}
const rule = (m) => new RuleError(m);

const row = (r) => r && { id: r.id, seq: r.seq, title: r.title, description: r.description, owner: r.owner, reviewer: r.reviewer, status: r.status, next_owner: r.next_owner, links: JSON.parse(r.links || "{}"), touches_mainline: !!r.touches_mainline, data_level: r.data_level, approved_sha: r.approved_sha || null, check_sha: r.check_sha || null, qa_sha: r.qa_sha || null, release_sha: r.release_sha || null, revision: r.revision || 0, created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at };
const pub = (t) => { if (!t) return t; const { seq, ...o } = t; return o; };
const get = (self, id) => row(self.sql.exec("SELECT * FROM tasks WHERE id=?", String(id || "").trim().toUpperCase()).toArray()[0]);
const lockHolder = (self, except) => row(self.sql.exec("SELECT * FROM tasks WHERE touches_mainline=1 AND status IN ('in_review','approved') AND id<>? LIMIT 1", except || "").toArray()[0]) || null;
const okUrl = (u) => { try { return ["http:", "https:"].includes(new URL(String(u)).protocol); } catch { return false; } };

function mergeLinks(cur, add) {
  const o = { board: [...(cur.board || [])], prs: [...(cur.prs || [])], branch: cur.branch || null };
  if (!add) return o;
  for (const b of [].concat(add.board || [])) { const n = parseInt(b); if (n > 0 && !o.board.includes(n)) o.board.push(n); }
  for (const u of [].concat(add.prs || [])) { if (!okUrl(u)) throw rule("PR links must be http(s) URLs"); if (!o.prs.includes(u)) o.prs.push(String(u).slice(0, 300)); }
  if (add.branch != null) o.branch = String(add.branch).slice(0, 120) || null;
  return o;
}

function who(cfg, v, field) {
  if (v == null || v === "") return null;
  const c = canon(cfg, v);
  if (!c) throw rule(`${field} must be one of ${cfg.identities.join(", ")}`);
  return c;
}

function check(self, cfg, t, prev, actor) {
  if (!STATUSES.includes(t.status)) throw rule("status must be one of " + STATUSES.join(", "));
  if (!LEVELS.includes(t.data_level)) throw rule("data_level must be test or sensitive");
  if (t.owner && t.reviewer && t.owner === t.reviewer) throw rule("reviewer cannot be the owner");
  if (prev && prev.status !== t.status) {
    if (DONE.includes(prev.status)) throw rule(`${t.id} is already ${prev.status}; open a new task instead`);
    if (t.status === "approved") {
      if (cfg.approvers.length && !cfg.approvers.includes(actor)) throw rule(`only ${cfg.approvers.join(", ")} can approve`);
      if (prev.status !== "in_review") throw rule(`approved can only follow in_review (currently ${prev.status})`);
      if (t.reviewer && t.reviewer !== actor) throw rule(`this task's reviewer is ${t.reviewer}, not ${actor}`);
      if (!t.approved_sha || !SHA.test(t.approved_sha)) throw rule("approving requires head_sha: the full commit SHA you reviewed (40 or 64 hex chars)");
    }
    if (t.status === "merged") {
      if (prev.status !== "approved") throw rule(`merged can only follow approved (currently ${prev.status})`);
      if (cfg.mergers.length && !cfg.mergers.includes(actor)) throw rule(`only ${cfg.mergers.join(", ")} can merge`);
      if (t.owner && actor === t.owner) throw rule("the task owner cannot merge their own task; a different merger must do it");
      if (!t._head_sha) throw rule("merging requires head_sha: the commit SHA being merged");
      if (!prev.approved_sha || prev.approved_sha !== t._head_sha)
        throw rule(`head_sha ${t._head_sha} does not match the approved commit ${prev.approved_sha || "(none)"}; send it back to in_review`);
      if (prev.qa_sha !== prev.approved_sha || prev.release_sha !== prev.approved_sha) throw rule("merging requires QA and release on the approved SHA");
    }
  } else if (!prev && !["todo", "blocked", "cancelled"].includes(t.status)) throw rule("new tasks start as todo");
  if (["in_progress", "in_review", "approved"].includes(t.status) && !t.owner) throw rule(`${t.status} needs an owner; task_claim first`);
  if (t.data_level === "sensitive") {
    const al = cfg.sensitiveAllowlist;
    if (!t.owner && t.status === "todo") { /* unowned todo is fine; owner is checked when assigned */ }
    else if (!al.includes(t.owner)) throw rule(`sensitive tasks may only be owned by: ${al.join(", ") || "(nobody configured)"}`);
  }
  if (t.touches_mainline && LOCKING.includes(t.status)) {
    const h = lockHolder(self, t.id);
    if (h) throw rule(`mainline lock held by ${h.id} "${h.title}" (${h.status}, owner ${h.owner}). Only one mainline task may be in_review/approved (review through merge) at a time; several may be in_progress in their own worktrees. Wait until it is merged or cancelled before requesting review, and sync to latest main before requesting review.`);
  }
}

function save(self, t) {
  self.sql.exec("INSERT OR REPLACE INTO tasks(id,seq,title,description,owner,reviewer,status,next_owner,links,touches_mainline,data_level,created_by,created_at,updated_at,approved_sha,check_sha,qa_sha,release_sha,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    t.id, t.seq, t.title, t.description, t.owner, t.reviewer, t.status, t.next_owner, JSON.stringify(t.links || {}), t.touches_mainline ? 1 : 0, t.data_level, t.created_by, t.created_at, t.updated_at, t.approved_sha || null, t.check_sha || null, t.qa_sha || null, t.release_sha || null, (t.revision || 0) + 1);
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/; // full SHA-1 or SHA-256 commit ids only
const normSha = (v) => (v == null ? null : String(v).trim().toLowerCase());

// Field-level authorization for task_update. Runs on the requested change set,
// before check() validates the final merged state.
function authorize(cfg, prev, t, actor) {
  const isApprover = cfg.approvers.includes(actor);
  const isMerger = cfg.mergers.length ? cfg.mergers.includes(actor) : false;
  const isOwner = !!prev.owner && prev.owner === actor;
  const isReviewer = !!prev.reviewer && prev.reviewer === actor;
  const unownedCreator = !prev.owner && prev.created_by === actor;
  const party = isOwner || isReviewer || isApprover || unownedCreator;
  const mergingOnly = t.status === "merged" && prev.status === "approved" && isMerger;
  if (!party && !mergingOnly) throw rule(`only the owner, reviewer or an approver can update ${prev.id}`);
  if (mergingOnly && !party) {
    for (const k of ["owner", "reviewer", "data_level", "touches_mainline", "title", "description"])
      if (JSON.stringify(prev[k]) !== JSON.stringify(t[k])) throw rule(`a merger may only change status on ${prev.id}`);
  }
  if (prev.data_level === "sensitive" && t.data_level !== "sensitive" && !isApprover) throw rule("only an approver can lower data_level from sensitive");
  if (prev.touches_mainline && !t.touches_mainline && !isApprover) throw rule("only an approver can clear touches_mainline");
  if (prev.reviewer !== t.reviewer && !isApprover) throw rule("only an approver can change the reviewer");
  if (prev.owner !== t.owner && prev.owner && !(isOwner || isApprover)) throw rule(`only the owner (${prev.owner}) or an approver can reassign ${prev.id}`);
  if (t.status === "cancelled" && prev.status !== "cancelled" && prev.owner && !(isOwner || isApprover)) throw rule(`only the owner (${prev.owner}) or an approver can cancel ${prev.id}`);
}
const log = (self, id, actor, action, detail) => self.sql.exec("INSERT INTO task_hist(task_id,at,actor,action,detail) VALUES(?,?,?,?,?)", id, now(), actor, action, JSON.stringify(detail || {}));
const audit = (self, id, actor, action, sha, detail = {}) => self.sql.exec("INSERT INTO task_audit(task_id,at,actor,action,sha,detail) VALUES(?,?,?,?,?,?)", id, now(), actor, action, sha, JSON.stringify(detail));
function unchanged(self, prev) {
  if (get(self, prev.id)?.revision !== prev.revision) throw rule("task was modified during verification, please retry; nothing was changed");
}
function diff(a, b) {
  const d = {};
  for (const k of ["title", "description", "owner", "reviewer", "status", "next_owner", "touches_mainline", "data_level", "links", "approved_sha", "qa_sha", "release_sha"])
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) d[k] = [a[k] ?? null, b[k] ?? null];
  return d;
}

// Hand-offs post a board message, which wakes the recipient.
function notifyTargets(t, prev, actor, reason) {
  const targets = new Map();
  if (t.next_owner && (!prev || prev.next_owner !== t.next_owner)) targets.set(t.next_owner, reason || "your turn");
  if (t.owner && prev && prev.owner !== t.owner && !targets.has(t.owner)) targets.set(t.owner, "you were assigned as owner");
  if (t.status === "in_review" && (!prev || prev.status !== "in_review") && t.reviewer) targets.set(t.reviewer, "please review");
  targets.delete(actor);
  return targets;
}
// Reject the whole call (no state change) if the actor's post quota can't cover the hand-offs.
function ensureQuota(self, cfg, actor, targets) {
  const left = quotaLeft(self, cfg, actor);
  if (targets.size > left) throw rule(`rate_limited: this change needs ${targets.size} hand-off message(s) but you have ${left} left this minute; nothing was changed, retry shortly`);
}
// GitHub binding (only when configured): approve = PR head equals head_sha; merge = PR merged at approved_sha.
async function githubCheck(self, t, prev) {
  const env = self.env;
  const approving = t.status === "approved" && prev && prev.status !== "approved";
  const merging = t.status === "merged" && prev && prev.status !== "merged";
  if (!approving && !merging) return false;
  if (!githubEnabled(env)) {
    if (merging) throw rule("merge gates require GitHub binding");
    return false;
  }
  const n = prNumber(env, t.links);
  if (!n) throw rule(`GitHub binding is on: add links.prs with a PR URL in ${env.GITHUB_REPO}`);
  let pr;
  try { pr = await fetchPr(env, n); } catch (e) { throw rule(String(e.message || e) + "; nothing was changed"); }
  if (approving && (pr.merged || pr.state !== "open")) throw rule(`PR #${n} must be open for approval`);
  if (approving && pr.head !== t.approved_sha) throw rule(`PR #${n} head is ${pr.head}, not the head_sha ${t.approved_sha} you approved; review the current head`);
  if (merging) {
    if (!pr.merged) throw rule(`PR #${n} is not merged on GitHub yet; merge the approved SHA first (git merge --ff-only ${prev.approved_sha})`);
    if (pr.head !== prev.approved_sha) throw rule(`PR #${n} was merged at ${pr.head} (merge commit ${pr.mergeCommit}), not the approved ${prev.approved_sha}`);
    try { t._ci = await verifyCI(env, prev.approved_sha); } catch (e) { throw rule(e.message); }
  }
  return true;
}
async function notify(self, cfg, t, prev, actor, reason) {
  const sent = [];
  for (const [to, why] of notifyTargets(t, prev, actor, reason)) {
    const text = `[task ${t.id}] ${why}: "${t.title}"\nstatus: ${prev && prev.status !== t.status ? prev.status + " -> " : ""}${t.status} | owner: ${t.owner || "-"} | next: ${t.next_owner || "-"} | reviewer: ${t.reviewer || "-"}${t.touches_mainline ? " | mainline" : ""}${t.data_level === "sensitive" ? " | sensitive" : ""}\nupdated by ${actor}. Use task_get {"id":"${t.id}"} for details.`;
    try { const r = await post(self, cfg, actor, to, text); sent.push({ to, board_id: r.id }); } catch (e) { sent.push({ to, error: String(e.message || e) }); }
  }
  return sent;
}

const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
export function TASK_TOOLS(cfg) {
  const S = (p, r = []) => ({ type: "object", properties: p, required: r, additionalProperties: false });
  const id = { type: "string", enum: cfg.identities };
  const links = { type: "object", description: "links to add: {board:[message ids], prs:[urls], branch:\"name\"}", properties: { board: { type: "array", items: { type: "integer" } }, prs: { type: "array", items: { type: "string" } }, branch: { type: "string" } }, additionalProperties: false };
  return [
    { name: "task_attest", title: "QA or release attestation", annotations: rw,
      description: "Record independent QA or explicit release on an approved head_sha. QA_REVIEWERS may attest QA (never the owner/reviewer); RELEASE_APPROVERS may release after QA and current GitHub CI pass. passed=false revokes the gate. Every accepted attestation is audited with actor, time and SHA.",
      inputSchema: S({ id: { type: "string" }, kind: { type: "string", enum: ["qa", "release"] }, head_sha: { type: "string" }, passed: { type: "boolean" }, note: { type: "string" } }, ["id", "kind", "head_sha", "passed"]) },
    { name: "task_new", title: "New task", annotations: rw, description: "Create a task (starts as todo). Setting next_owner wakes them via the board.",
      inputSchema: S({ title: { type: "string" }, description: { type: "string" }, owner: id, reviewer: id, next_owner: id, touches_mainline: { type: "boolean", default: false }, data_level: { type: "string", enum: LEVELS, default: "test" }, links, note: { type: "string" } }, ["title"]) },
    { name: "task_claim", title: "Claim task", annotations: rw, description: "Become owner and move todo/blocked -> in_progress. Several mainline tasks may be in_progress at once (each in its own worktree); the mainline lock is taken only when requesting review.",
      inputSchema: S({ id: { type: "string" }, note: { type: "string" } }, ["id"]) },
    { name: "task_update", title: "Update task", annotations: rw, description: `Update status (${STATUSES.join("/")}), owner, reviewer, next_owner, links, note. Only the owner, reviewer or an approver may update (a merger may only merge). Rules: approved only from in_review by the reviewer, with head_sha${cfg.approvers.length ? " (one of " + cfg.approvers.join(", ") + ")" : ""}; merged only from approved with the same head_sha, QA, explicit release and fresh GitHub CI; use task_attest for QA/release; only an approver can lower data_level, clear touches_mainline or change the reviewer; only owner/approver can reassign or cancel; reviewer != owner; only one mainline task in_review/approved at a time (several may be in_progress; sync to latest main before requesting review); sensitive data only for allowlisted owners.`,
      inputSchema: S({ id: { type: "string" }, status: { type: "string", enum: STATUSES }, owner: id, reviewer: id, next_owner: id, title: { type: "string" }, description: { type: "string" }, touches_mainline: { type: "boolean" }, data_level: { type: "string", enum: LEVELS }, head_sha: { type: "string", description: "commit SHA: required when approving (the reviewed commit) and when merging (must match)" }, links, note: { type: "string" } }, ["id"]) },
    { name: "task_list", title: "List tasks", annotations: ro, description: "List tasks (open ones by default). Filters: status, owner, next_owner, mine, include_closed.",
      inputSchema: S({ status: { type: "string", enum: STATUSES }, owner: { type: "string" }, next_owner: { type: "string" }, mine: { type: "boolean" }, include_closed: { type: "boolean", default: false }, limit: { type: "integer", default: 50, minimum: 1, maximum: 200 } }) },
    { name: "task_get", title: "Get task", annotations: ro, description: "Full task, history and SHA audit. Page older audit events with before_audit_id.", inputSchema: S({ id: { type: "string" }, before_audit_id: { type: "integer", minimum: 1 } }, ["id"]) },
  ];
}

export async function taskCall(self, cfg, actor, name, a) {
  try {
    if (name === "task_list") {
      const w = [], v = [];
      if (a.status) { w.push("status=?"); v.push(a.status); } else if (!a.include_closed) w.push("status NOT IN ('merged','cancelled')");
      if (a.owner) { w.push("owner=?"); v.push(canon(cfg, a.owner)); }
      if (a.next_owner) { w.push("next_owner=?"); v.push(canon(cfg, a.next_owner)); }
      if (a.mine) { w.push("(owner=? OR next_owner=?)"); v.push(actor, actor); }
      const l = Math.max(1, Math.min(parseInt(a.limit) || 50, 200));
      const tasks = self.sql.exec(`SELECT * FROM tasks${w.length ? " WHERE " + w.join(" AND ") : ""} ORDER BY seq DESC LIMIT ?`, ...v, l).toArray().map(row).map(pub);
      const m = lockHolder(self, null);
      return { tasks, mainline_lock: m ? { id: m.id, title: m.title, status: m.status, owner: m.owner } : null, you: actor };
    }
    if (name === "task_get") {
      const t = get(self, a.id);
      if (!t) throw rule("no such task " + a.id);
      const history = self.sql.exec("SELECT at,actor,action,detail FROM task_hist WHERE task_id=? ORDER BY id DESC LIMIT 50", t.id).toArray().map((h) => ({ ...h, detail: JSON.parse(h.detail || "{}") }));
      const checks = [...new Set([t.approved_sha, t.check_sha].filter(Boolean))].map((s) => checkInfo(self.sql, s)).filter(Boolean);
      if (a.before_audit_id != null && (!Number.isSafeInteger(a.before_audit_id) || a.before_audit_id < 1)) throw rule("before_audit_id must be a positive integer");
      const events = self.sql.exec("SELECT id,at,actor,action,sha,detail FROM task_audit WHERE task_id=? AND id<? ORDER BY id DESC LIMIT 51", t.id, a.before_audit_id || Number.MAX_SAFE_INTEGER).toArray();
      const audit = events.slice(0, 50).map((e) => ({ ...e, detail: JSON.parse(e.detail) }));
      return { task: pub(t), history, audit, next_audit_before: events.length > 50 ? audit.at(-1).id : null, ...(checks.length ? { github_check: checks } : {}) };
    }
    if (name === "task_attest") {
      const prev = get(self, a.id), sha = normSha(a.head_sha);
      if (!prev) throw rule("no such task " + a.id);
      if (!["qa", "release"].includes(a.kind) || typeof a.passed !== "boolean") throw rule("kind must be qa/release and passed must be boolean");
      if (!sha || !SHA.test(sha) || sha !== prev.approved_sha || prev.status !== "approved") throw rule("attestation requires the approved head_sha and approved status");
      const allowed = a.kind === "qa" ? cfg.qaReviewers : cfg.releaseApprovers;
      if (!allowed.includes(actor)) throw rule(`only configured ${a.kind} identities may attest this gate`);
      if (actor === prev.owner || (a.kind === "qa" && actor === prev.reviewer)) throw rule("gate attestation requires an independent identity");
      const t = { ...prev }, field = a.kind === "qa" ? "qa_sha" : "release_sha";
      let ci = [];
      if (a.passed && a.kind === "release") {
        if (prev.qa_sha !== sha) throw rule("release requires QA on the approved SHA");
        const n = prNumber(self.env, prev.links);
        if (!githubEnabled(self.env) || !n) throw rule("release requires GitHub binding and a linked PR");
        try {
          ci = await verifyCI(self.env, sha);
          const pr = await fetchPr(self.env, n);
          if (pr.head !== sha || pr.merged || pr.state !== "open") throw new Error("release requires the approved SHA at the current open PR head");
        } catch (e) { throw rule(e.message); }
      }
      t[field] = a.passed ? sha : null;
      if (a.kind === "qa") t.release_sha = null;
      let github_check;
      self.ctx.storage.transactionSync(() => {
        unchanged(self, prev);
        t.updated_at = now();
        save(self, t);
        audit(self, t.id, actor, a.kind + (a.passed ? "_passed" : "_revoked"), sha, { note: String(a.note || "").slice(0, 2000), ci });
        log(self, t.id, actor, "attest", diff(prev, t));
        github_check = queueChecks(self, [sha]);
      });
      if (github_check) await self.ctx.storage.setAlarm(Date.now());
      return { ok: true, task: pub(get(self, t.id)), ...(github_check ? { github_check } : {}) };
    }
    if (name === "task_new") {
      if (typeof a.title !== "string" || !a.title.trim()) throw rule("title is required");
      const seq = self.sql.exec("SELECT COALESCE(MAX(seq),0) m FROM tasks").one().m + 1, n = now();
      const owner = who(cfg, a.owner, "owner");
      const askedReviewer = who(cfg, a.reviewer, "reviewer");
      if (askedReviewer && askedReviewer !== cfg.defaultReviewer && !cfg.approvers.includes(actor)) throw rule(`only an approver can choose the reviewer; leave it empty to use ${cfg.defaultReviewer || "the default"}`);
      const t = { id: "T-" + String(seq).padStart(3, "0"), seq, title: a.title.trim().slice(0, 120), description: String(a.description || "").slice(0, 2000), owner,
        reviewer: askedReviewer || cfg.defaultReviewer, status: "todo", next_owner: who(cfg, a.next_owner, "next_owner") || owner,
        links: mergeLinks({}, a.links), touches_mainline: !!a.touches_mainline, data_level: a.data_level || "test", created_by: actor, created_at: n, updated_at: n };
      check(self, cfg, t, null, actor);
      ensureQuota(self, cfg, actor, notifyTargets(t, null, actor, "new task for you"));
      self.ctx.storage.transactionSync(() => {
        save(self, t);
        log(self, t.id, actor, "create", { ...diff({}, t), note: a.note || undefined });
      });
      return { ok: true, task: pub(t), woke: await notify(self, cfg, t, null, actor, "new task for you") };
    }
    if (name === "task_claim" || name === "task_update") {
      const prev = get(self, a.id);
      if (!prev) throw rule("no such task " + a.id);
      const t = { ...prev, links: { ...prev.links } };
      if (name === "task_claim") {
        if (!["todo", "blocked"].includes(prev.status)) throw rule(`${prev.id} is ${prev.status}; only todo/blocked can be claimed`);
        if (prev.owner && prev.owner !== actor && !cfg.approvers.includes(actor)) throw rule(`${prev.id} is owned by ${prev.owner}; only they or an approver can take it over`);
        if (prev.reviewer === actor) throw rule("the reviewer cannot claim the task they review");
        t.owner = actor; t.status = "in_progress"; t.next_owner = actor;
      } else {
        if (a.status != null) t.status = a.status;
        for (const k of ["owner", "reviewer", "next_owner"]) if (a[k] !== undefined) t[k] = who(cfg, a[k], k);
        if (a.title != null) t.title = String(a.title).trim().slice(0, 120) || t.title;
        if (a.description != null) t.description = String(a.description).slice(0, 2000);
        if (a.touches_mainline != null) t.touches_mainline = !!a.touches_mainline;
        if (a.data_level != null) t.data_level = a.data_level;
        t.links = mergeLinks(t.links, a.links);
        if (a.status === "in_review" && a.next_owner === undefined) t.next_owner = t.reviewer;
        if (a.head_sha !== undefined) { const h = normSha(a.head_sha); if (h && !SHA.test(h)) throw rule("head_sha must be a full 40- or 64-char hex commit SHA"); t._head_sha = h;
          if (h && !(prev.status !== t.status && (t.status === "approved" || t.status === "merged"))) throw rule(`head_sha is only accepted when an approver sets approved, or when merging (this call is ${prev.status} -> ${t.status}, so it would not be stored); nothing was changed, drop head_sha and resend`); }
        if (t.status === "approved" && prev.status !== "approved") { t.approved_sha = t._head_sha || null; t.check_sha = t.approved_sha; }
        if (["in_progress", "in_review", "todo", "blocked"].includes(t.status)) t.approved_sha = null;
        const scopeChanged = ["owner", "reviewer", "links", "data_level", "touches_mainline"].some((k) => JSON.stringify(t[k]) !== JSON.stringify(prev[k]));
        if ((t.status !== prev.status && t.status !== "merged") || scopeChanged) {
          t.qa_sha = null; t.release_sha = null;
          if (prev.status === "approved" && t.status === "approved") throw rule("return to in_review before changing approval scope");
        }
        if (t.status === "merged" && scopeChanged) throw rule("merging cannot change approval scope");
        if (a.status === "approved" && a.next_owner === undefined) t.next_owner = cfg.mergers[0] || t.owner;
        if (DONE.includes(t.status) && a.next_owner === undefined) t.next_owner = null;
      }
      if (name === "task_update") authorize(cfg, prev, t, actor);
      const d = diff(prev, t);
      if (!Object.keys(d).length && !a.note) return { ok: true, task: pub(prev), changed: false };
      check(self, cfg, t, prev, actor);
      ensureQuota(self, cfg, actor, notifyTargets(t, prev, actor));
      await githubCheck(self, t, prev);
      const ci = t._ci || [];
      delete t._head_sha;
      delete t._ci;
      let github_check;
      self.ctx.storage.transactionSync(() => {
        unchanged(self, prev);
        check(self, cfg, { ...t, _head_sha: normSha(a.head_sha) }, prev, actor);
        ensureQuota(self, cfg, actor, notifyTargets(t, prev, actor));
        t.updated_at = now();
        save(self, t);
        log(self, t.id, actor, name === "task_claim" ? "claim" : "update", { ...d, note: a.note || undefined });
        if (t.status !== prev.status && ["approved", "merged"].includes(t.status)) audit(self, t.id, actor, t.status, t.approved_sha, { ci });
        if (prev.status === "approved" && !["approved", "merged"].includes(t.status)) audit(self, t.id, actor, "approval_revoked", prev.approved_sha);
        github_check = queueChecks(self, [prev.approved_sha, t.approved_sha, prev.check_sha, t.check_sha]);
      });
      if (github_check) await self.ctx.storage.setAlarm(Date.now());
      return { ok: true, task: pub(get(self, t.id)), changes: d, ...(github_check ? { github_check } : {}), woke: await notify(self, cfg, t, prev, actor) };
    }
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, error: e.message };
    throw e;
  }
  throw new Error("unknown tool " + name);
}

import { canon } from "./config.js";

export function initBoard(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS board(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, to_name TEXT, from_name TEXT, text TEXT)");
  sql.exec("CREATE TABLE IF NOT EXISTS post_rl(who TEXT, t INTEGER)");
  sql.exec("CREATE INDEX IF NOT EXISTS post_rl_who ON post_rl(who, t)");
}

// Per-identity post rate limit, persisted in Durable Object storage so it survives restarts.
// Counts every post an identity causes, including task hand-off notifications.
export function rateOk(self, cfg, who) {
  const t = Date.now();
  self.sql.exec("DELETE FROM post_rl WHERE t<?", t - 60000);
  if (self.sql.exec("SELECT COUNT(*) c FROM post_rl WHERE who=?", who).one().c >= cfg.ratePerMinute) return false;
  self.sql.exec("INSERT INTO post_rl VALUES(?,?)", who, t);
  return true;
}

const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
export const BOARD_TOOLS = (cfg) => [
  { name: "board_post", title: "Post to board", annotations: rw,
    description: `Post a message. The sender is set by the server from your key. to = one of: ${cfg.identities.join(", ")}. Max ${cfg.maxPostChars} chars. Returns the new message id.`,
    inputSchema: { type: "object", properties: { to: { type: "string", enum: cfg.identities }, text: { type: "string" } }, required: ["to", "text"], additionalProperties: false } },
  { name: "board_read", title: "Read my threads", annotations: ro,
    description: "Read messages addressed to or posted by you, newest first. Optional since_id, only_to_me, limit (1-100).",
    inputSchema: { type: "object", properties: { since_id: { type: "integer", minimum: 0 }, only_to_me: { type: "boolean", default: false }, limit: { type: "integer", default: 20, minimum: 1, maximum: 100 } }, additionalProperties: false } },
  { name: "board_wait", title: "Wait for messages to me", annotations: ro,
    description: "Long-poll up to timeout_seconds (default 30, max 55) for messages addressed to you with id > since_id. Omit since_id to start from the newest message.",
    inputSchema: { type: "object", properties: { since_id: { type: "integer", minimum: 0 }, timeout_seconds: { type: "integer", default: 30, minimum: 0, maximum: 55 } }, additionalProperties: false } },
];

const rowOut = (r) => ({ id: r.id, created_at: r.created_at, to: r.to_name, from: r.from_name, text: r.text });

function query(self, me, since, onlyToMe, limit, asc) {
  const w = onlyToMe ? ["to_name=?"] : ["(to_name=? OR from_name=?)"], v = onlyToMe ? [me] : [me, me];
  if (since != null) { w.push("id>?"); v.push(parseInt(since) || 0); }
  return self.sql.exec(`SELECT * FROM board WHERE ${w.join(" AND ")} ORDER BY id ${asc ? "ASC" : "DESC"} LIMIT ?`, ...v, limit).toArray().map(rowOut);
}

async function hmacHex(secret, body) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Optional push wake-up for identities that have a webhook (e.g. a hosted agent).
// Identities without one are woken by the polling runner instead.
async function wake(self, cfg, msg) {
  const url = cfg.wakeUrls[msg.to];
  if (!url) return;
  const body = JSON.stringify({ event: "board.message", message: { id: msg.id, from: msg.from, to: msg.to, created_at: msg.created_at, preview: msg.text.slice(0, 500) } });
  const h = { "content-type": "application/json" };
  if (self.env.WAKE_SECRET) h["x-board-signature"] = "sha256=" + (await hmacHex(self.env.WAKE_SECRET, body));
  await fetch(url, { method: "POST", headers: h, body, signal: AbortSignal.timeout(10000) });
}

// Internal post used by both board_post and task hand-off notifications.
export async function post(self, cfg, from, toRaw, text) {
  const to = canon(cfg, toRaw);
  if (!to) throw new Error("to must be one of " + cfg.identities.join(", "));
  if (typeof text !== "string" || !text.trim()) throw new Error("text is required");
  if (text.length > cfg.maxPostChars) throw new Error("text too long");
  if (!rateOk(self, cfg, from)) { const e = new Error("rate_limited"); e.rateLimited = true; throw e; }
  self.sql.exec("INSERT INTO board(created_at,to_name,from_name,text) VALUES(?,?,?,?)", new Date().toISOString(), to, from, text);
  const id = self.sql.exec("SELECT last_insert_rowid() i").one().i;
  for (const f of self.waiters) f();
  self.waiters.clear();
  const msg = rowOut(self.sql.exec("SELECT * FROM board WHERE id=?", id).one());
  self.ctx.waitUntil(wake(self, cfg, msg).catch(() => {}));
  return { ok: true, id };
}

export async function boardCall(self, cfg, me, name, a) {
  if (name === "board_post") {
    try { return await post(self, cfg, me, a.to, a.text); }
    catch (e) { if (e.rateLimited) return { error: "rate_limited", retry_after_seconds: 60 }; throw e; }
  }
  if (name === "board_read") {
    const l = Math.max(1, Math.min(parseInt(a.limit) || 20, 100));
    return { messages: query(self, me, a.since_id, !!a.only_to_me, l, false) };
  }
  if (name === "board_wait") {
    const since = a.since_id != null ? parseInt(a.since_id) || 0 : self.sql.exec("SELECT COALESCE(MAX(id),0) m FROM board").one().m;
    const sec = Math.max(0, Math.min(parseInt(a.timeout_seconds ?? 30), 55));
    const end = Date.now() + sec * 1000;
    for (;;) {
      const m = query(self, me, since, true, 50, true);
      if (m.length) return { messages: m, last_id: m[m.length - 1].id, timed_out: false };
      const left = end - Date.now();
      if (left <= 0) return { messages: [], last_id: since, timed_out: true };
      await new Promise((res) => {
        let f;
        const t = setTimeout(() => { self.waiters.delete(f); res(); }, Math.min(left, 10000));
        f = () => { clearTimeout(t); res(); };
        self.waiters.add(f);
      });
    }
  }
  throw new Error("unknown tool " + name);
}

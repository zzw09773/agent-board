// agent-board: a tiny MCP message board + task table for heterogeneous AI agents.
// One Durable Object holds all state (SQLite). Every identity has its own bearer key;
// the server stamps the sender, so an agent can never post as someone else.
import { DurableObject } from "cloudflare:workers";
import { loadConfig, identify } from "./config.js";
import { BOARD_TOOLS, boardCall, initBoard } from "./board.js";
import { TASK_TOOLS, taskCall, initTasks } from "./tasks.js";
import { initOAuth, handleOAuth, oauthIdentity, oauthEnabled, wwwAuth } from "./oauth.js";
import { initWeb, handleWeb } from "./web.js";

const MAX_BODY = 256 * 1024;
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const json = (o, s = 200, h = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...h } });

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (p === "/health") return json({ ok: true });
    if (p === "/") return Response.redirect(new URL("/board", req.url).toString(), 302);
    const len = parseInt(req.headers.get("content-length") || "0");
    if (len > MAX_BODY) return json({ error: "too_large" }, 413);
    const stub = env.BOARD.get(env.BOARD.idFromName("main"));
    return stub.fetch(req);
  },
};

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.waiters = new Set();
    initBoard(this.sql);
    initTasks(this.sql);
    initOAuth(this.sql);
    initWeb(this.sql);
  }

  async fetch(req) {
    const cfg = loadConfig(this.env);
    const base = (this.env.PUBLIC_BASE_URL || new URL(req.url).origin).replace(/\/$/, "");
    const o = await handleOAuth(this, cfg, req, base);
    if (o) return o;
    const w = await handleWeb(this, cfg, req, base);
    if (w) return w;
    if (new URL(req.url).pathname !== "/mcp") return json({ error: "not_found" }, 404);
    let k = req.headers.get("authorization") || "";
    if (k.toLowerCase().startsWith("bearer ")) k = k.slice(7).trim();
    // Per-identity keys first; otherwise an OAuth access token, which always maps to OAUTH_IDENTITY.
    const me = identify(cfg, this.env, k) || (await oauthIdentity(this, cfg, k));
    if (!me) { await req.arrayBuffer().catch(() => {}); } // drain body before an early response
    if (!me) return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": oauthEnabled(cfg, this.env) ? wwwAuth(base) : "Bearer" });
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    let m;
    try { m = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
    const batch = Array.isArray(m), out = [];
    for (const x of batch ? m : [m]) {
      if (x.id == null) continue; // notifications
      const pr = x.params || {};
      let result, error;
      try {
        if (x.method === "initialize")
          result = {
            protocolVersion: PROTOCOLS.includes(pr.protocolVersion) ? pr.protocolVersion : "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: cfg.boardName, version: "0.1.0" },
            instructions: instructions(cfg, me),
          };
        else if (x.method === "ping") result = {};
        else if (x.method === "tools/list") result = { tools: [...BOARD_TOOLS(cfg), ...TASK_TOOLS(cfg)] };
        else if (x.method === "tools/call") {
          const o = await this.call(cfg, me, pr.name, pr.arguments || {});
          result = { content: [{ type: "text", text: JSON.stringify(o) }], structuredContent: o, isError: false };
        } else if (x.method === "resources/list") result = { resources: [] };
        else if (x.method === "prompts/list") result = { prompts: [] };
        else error = { code: -32601, message: "Method not found" };
      } catch (e) {
        if (x.method === "tools/call") result = { content: [{ type: "text", text: String(e.message || e) }], isError: true };
        else error = { code: -32603, message: String(e.message || e) };
      }
      out.push(error ? { jsonrpc: "2.0", id: x.id, error } : { jsonrpc: "2.0", id: x.id, result });
    }
    if (!out.length) return new Response(null, { status: 202 });
    return json(batch ? out : out[0]);
  }

  async call(cfg, me, name, a) {
    if (name.startsWith("board_")) return boardCall(this, cfg, me, name, a);
    if (name.startsWith("task_")) return taskCall(this, cfg, me, name, a);
    throw new Error("unknown tool " + name);
  }
}

function instructions(cfg, me) {
  return `${cfg.boardName}: shared message board and task table. You are "${me}" (fixed by your key; you cannot post as anyone else). ` +
    `Valid recipients: ${cfg.identities.join(", ")}. Use board_post to message someone (it wakes them if they have a runner or webhook), ` +
    `board_read to read your threads, board_wait to long-poll for new messages to you. Max ${cfg.maxPostChars} chars per post. ` +
    `Task tools: task_new/task_claim/task_update/task_list/task_get. Never post secrets or sensitive data on the board.`;
}

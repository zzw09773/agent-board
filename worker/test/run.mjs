// End-to-end tests against `wrangler dev`: state machine, authorization rules, OAuth, web login.
// Run: npm test   (starts its own wrangler dev on a random port with throwaway state + fake keys)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const B = `http://127.0.0.1:${PORT}`;
const PW = "test-owner-password-123";
const KEY = Object.fromEntries(["rev", "claude", "codex", "local", "noisy"].map((n) => [n, `test-key-${n}-${randomBytes(12).toString("hex")}`]));
const SHA1 = "a".repeat(40), SHA2 = "b".repeat(40);
let dev, tmp;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "agent-board-test-"));
  const envFile = join(tmp, "test.env");
  writeFileSync(envFile, Object.entries(KEY).map(([n, k]) => `KEY_${n.toUpperCase()}=${k}`).join("\n") + `\nOWNER_PASSWORD=${PW}\n`);
  dev = spawn("npx", ["wrangler", "dev", "-c", join(HERE, "wrangler.test.toml"), "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", join(tmp, "state"), "--env-file", envFile],
    { cwd: join(HERE, ".."), stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = ""; const add = (d) => { log += d; globalThis.__log = log; }; dev.stdout.on("data", add); dev.stderr.on("data", add);
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(B + "/health")).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start:\n" + log);
});
after(() => { if (process.env.SHOWLOG) console.log(globalThis.__log); try { process.kill(-dev.pid); } catch {} rmSync(tmp, { recursive: true, force: true }); });

async function call(who, name, args = {}) {
  const r = await fetch(B + "/mcp", { method: "POST", headers: { authorization: `Bearer ${KEY[who] || who}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  if (r.status !== 200) return { http: r.status };
  const j = await r.json();
  return j.result.structuredContent ?? { toolError: j.result.content?.[0]?.text };
}
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const no = (r, re) => { assert.equal(r.ok, false, "expected rejection, got " + JSON.stringify(r)); if (re) assert.match(r.error, re); return r; };
const newTask = async (who, extra = {}) => ok(await call(who, "task_new", { title: "t " + Math.random().toString(36).slice(2, 7), ...extra })).task.id;

// ---------- identity / board ----------
test("bad key is rejected", async () => { assert.equal((await call("nope-nope-nope-nope-nope", "board_read")).http, 401); });

test("sender is stamped from the key, not the request", async () => {
  ok(await call("codex", "board_post", { to: "claude", text: "hi", from: "rev" }));
  const m = (await call("claude", "board_read", { only_to_me: true })).messages[0];
  assert.equal(m.from, "codex");
});

// ---------- state machine ----------
test("full lifecycle with head_sha binding", async () => {
  const id = await newTask("claude", { owner: "claude" });
  no(await call("claude", "task_update", { id, status: "merged" }), /approved/);
  ok(await call("claude", "task_claim", { id }));
  ok(await call("claude", "task_update", { id, status: "in_review" }));
  no(await call("claude", "task_update", { id, status: "approved", head_sha: SHA1 }), /approve/); // owner can't approve
  no(await call("rev", "task_update", { id, status: "approved" }), /head_sha/);                    // sha required
  no(await call("rev", "task_update", { id, status: "approved", head_sha: "abc1234" }), /full/);    // short sha refused
  const ap = ok(await call("rev", "task_update", { id, status: "approved", head_sha: SHA1 }));
  assert.equal(ap.task.approved_sha, SHA1);
  no(await call("codex", "task_update", { id, status: "merged", head_sha: SHA1 }));                // not a merger/party
  no(await call("claude", "task_update", { id, status: "merged" }), /head_sha/);
  no(await call("claude", "task_update", { id, status: "merged", head_sha: SHA2 }), /does not match/); // new commit after approval
  ok(await call("claude", "task_update", { id, status: "merged", head_sha: SHA1 }));
  no(await call("claude", "task_update", { id, status: "in_progress" }), /already merged/);
});

test("going back to in_review clears the approval", async () => {
  const id = await newTask("claude", { owner: "claude" });
  ok(await call("claude", "task_claim", { id }));
  ok(await call("claude", "task_update", { id, status: "in_review" }));
  ok(await call("rev", "task_update", { id, status: "approved", head_sha: SHA1 }));
  const r = ok(await call("claude", "task_update", { id, status: "in_review" }));
  assert.equal(r.task.approved_sha, null);
});

test("new tasks always start as todo", async () => {
  const t = ok(await call("claude", "task_new", { title: "x", status: "in_progress" })).task;
  assert.equal(t.status, "todo");
});

// ---------- authorization ----------
test("a non-party cannot update someone else's task", async () => {
  const id = await newTask("claude", { owner: "claude" });
  no(await call("codex", "task_update", { id, title: "pwned" }), /only the owner, reviewer or an approver/);
  no(await call("codex", "task_update", { id, status: "blocked" }));
});

test("bypass: downgrade data_level then reassign to a cloud identity", async () => {
  const id = await newTask("local", { owner: "local", data_level: "sensitive" });
  no(await call("local", "task_update", { id, data_level: "test" }), /only an approver can lower/);
  no(await call("local", "task_update", { id, owner: "claude" }), /sensitive tasks may only be owned by/);
  no(await call("local", "task_update", { id, data_level: "test", owner: "claude" }), /only an approver/);
  no(await call("claude", "task_claim", { id }), /owned by local|sensitive/);
  no(await call("claude", "task_new", { title: "s", owner: "claude", data_level: "sensitive" }), /sensitive/);
  ok(await call("rev", "task_update", { id, data_level: "test" })); // approver may
});

test("bypass: clear touches_mainline to dodge the mainline lock", async () => {
  const a = await newTask("claude", { owner: "claude", touches_mainline: true });
  ok(await call("claude", "task_claim", { id: a }));
  const b = await newTask("codex", { owner: "codex", touches_mainline: true });
  no(await call("codex", "task_claim", { id: b }), /mainline lock/);
  no(await call("codex", "task_update", { id: b, touches_mainline: false, status: "in_progress" }), /only an approver can clear touches_mainline/);
  ok(await call("claude", "task_update", { id: a, status: "cancelled" })); // release lock
});

test("bypass: cancel or reassign someone else's task", async () => {
  const id = await newTask("claude", { owner: "claude", reviewer: "codex" });
  no(await call("codex", "task_update", { id, status: "cancelled" }), /only the owner \(claude\) or an approver can cancel/);
  no(await call("codex", "task_update", { id, owner: "codex" }), /only the owner \(claude\) or an approver can reassign/);
  no(await call("local", "task_update", { id, status: "cancelled" }));
  ok(await call("claude", "task_update", { id, status: "cancelled" }));
  const id2 = await newTask("claude", { owner: "claude" });
  ok(await call("rev", "task_update", { id: id2, status: "cancelled" })); // approver may
});

test("owner cannot swap in a friendly reviewer", async () => {
  const id = await newTask("claude", { owner: "claude" });
  no(await call("claude", "task_update", { id, reviewer: "codex" }), /only an approver can change the reviewer/);
});

test("reviewer cannot be owner; reviewer cannot claim", async () => {
  no(await call("rev", "task_new", { title: "x", owner: "rev" }), /reviewer cannot be the owner/);
  const id = await newTask("claude", { reviewer: "codex" });
  no(await call("codex", "task_claim", { id }), /reviewer cannot claim/);
});

test("cannot take over another identity's blocked task by claiming", async () => {
  const id = await newTask("claude", { owner: "claude" });
  ok(await call("claude", "task_claim", { id }));
  ok(await call("claude", "task_update", { id, status: "blocked" }));
  no(await call("codex", "task_claim", { id }), /owned by claude/);
});

// ---------- rate limit ----------
test("rate limit covers board_post and task notifications", async () => {
  for (let i = 0; i < 60; i++) ok(await call("noisy", "board_post", { to: "rev", text: "n" + i }));
  assert.equal((await call("noisy", "board_post", { to: "rev", text: "over" })).error, "rate_limited");
  const r = ok(await call("noisy", "task_new", { title: "notify", next_owner: "claude" }));
  assert.equal(r.woke[0].error, "rate_limited");
});

// ---------- OAuth ----------
const b64u = (b) => b.toString("base64url");
async function oauthTokens(ip = "198.51.100.10") {
  const reg = await (await fetch(B + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://client.example.com/cb"], client_name: "t" }) })).json();
  const v = b64u(randomBytes(48)), ch = b64u(createHash("sha256").update(v).digest());
  const q = new URLSearchParams({ client_id: reg.client_id, redirect_uri: "https://client.example.com/cb", response_type: "code", code_challenge: ch, code_challenge_method: "S256", state: "s", password: PW });
  const r = await fetch(B + "/oauth/authorize", { method: "POST", body: q, redirect: "manual", headers: { "cf-connecting-ip": ip } });
  assert.equal(r.status, 302);
  const code = new URL(r.headers.get("location")).searchParams.get("code");
  const t = await (await fetch(B + "/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: "https://client.example.com/cb", code_verifier: v }) })).json();
  return { ...t, client_id: reg.client_id };
}
const refresh = (rt, cid) => fetch(B + "/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: cid }) });

test("OAuth token acts as OAUTH_IDENTITY", async () => {
  const t = await oauthTokens();
  ok(await call(t.access_token, "board_post", { to: "claude", text: "via oauth", from: "local" }));
  assert.equal((await call(t.access_token, "task_list")).you, "rev");
});

test("refresh token replay revokes the whole family", async () => {
  const t = await oauthTokens();
  const r1 = await refresh(t.refresh_token, t.client_id); assert.equal(r1.status, 200);
  const t2 = await r1.json();
  assert.ok((await call(t2.access_token, "task_list")).tasks);
  const replay = await refresh(t.refresh_token, t.client_id); assert.equal(replay.status, 400);  // reuse of rotated token
  assert.equal((await call(t2.access_token, "task_list")).http, 401);                               // family revoked
  assert.equal((await refresh(t2.refresh_token, t.client_id)).status, 400);
});

// ---------- web login ----------
const login = (origin, pw, ip) => fetch(B + "/board/login", { method: "POST", redirect: "manual", body: new URLSearchParams({ password: pw }), headers: { origin, "cf-connecting-ip": ip } });

test("login origin must match exactly (suffix attack)", async () => {
  assert.equal((await login(B + ".evil.example", PW, "198.51.100.20")).status, 403);
  assert.equal((await login("http://127.0.0.1:" + PORT + "0", PW, "198.51.100.20")).status, 403);
  assert.equal((await login("", PW, "198.51.100.20")).status, 403);
  const r = await login(B, PW, "198.51.100.20");
  assert.equal(r.status, 303); assert.match(r.headers.get("set-cookie") || "", /board_session=/);
});

test("password throttle is per source and does not lock the owner out", async () => {
  for (let i = 0; i < 5; i++) assert.match((await login(B, "wrong-password-x", "203.0.113.66")).headers.get("location"), /e=bad/);
  assert.match((await login(B, PW, "203.0.113.66")).headers.get("location"), /e=locked/);  // attacker IP backs off
  const owner = await login(B, PW, "198.51.100.30");                                      // owner elsewhere is fine
  assert.equal(owner.headers.get("location"), "/board");
});

test("web API needs a session", async () => {
  assert.equal((await fetch(B + "/board/api/messages")).status, 401);
});

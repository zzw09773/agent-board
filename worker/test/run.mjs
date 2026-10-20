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
import { createServer } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const B = `http://127.0.0.1:${PORT}`;
const PORT2 = PORT + 1, B2 = `http://127.0.0.1:${PORT2}`;           // second instance: GitHub binding on, short password
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Mock GitHub API: PRS[n] = { head, merged, merge_commit_sha }
const PRS = {};
// STATUSES[sha] = [{state, context}, ...] records commit statuses the board wrote. PRS[n].delay slows the PR lookup.
const STATUSES = {};
const gh = createServer((req, res) => {
  if (req.headers.authorization !== "Bearer gh-test-token") { res.writeHead(401); return res.end("{}"); }
  const st = req.url.match(/^\/repos\/test-org\/test-repo\/statuses\/([0-9a-f]+)$/);
  if (st && req.method === "POST") {
    let b = ""; req.on("data", (d) => (b += d));
    return req.on("end", () => { const j = JSON.parse(b); (STATUSES[st[1]] ||= []).push({ state: j.state, context: j.context }); res.writeHead(201, { "content-type": "application/json" }); res.end("{}"); });
  }
  const m = req.url.match(/^\/repos\/test-org\/test-repo\/pulls\/(\d+)$/);
  const pr = m && PRS[m[1]];
  if (!pr) { res.writeHead(404); return res.end("{}"); }
  setTimeout(() => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ head: { sha: pr.head }, merged: pr.merged, merge_commit_sha: pr.merge_commit_sha || null }));
  }, pr.delay || 0);
});
const PW = "test-owner-password-123";
const KEY = Object.fromEntries(["rev", "claude", "codex", "local", "noisy", "merger"].map((n) => [n, `test-key-${n}-${randomBytes(12).toString("hex")}`]));
const SHA1 = "a".repeat(40), SHA2 = "b".repeat(40);
let dev, dev2, tmp;

function start(port, envFile, extra, logName) {
  const p = spawn("npx", ["wrangler", "dev", "-c", join(HERE, "wrangler.test.toml"), "--port", String(port), "--ip", "127.0.0.1", "--persist-to", join(tmp, "state-" + port), "--env-file", envFile, "--inspector-port", String(port + 10000), ...extra],
    { cwd: join(HERE, ".."), stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = ""; const add = (d) => { log += d; globalThis[logName] = log; }; p.stdout.on("data", add); p.stderr.on("data", add);
  return p;
}
async function ready(base, logName) {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + "/health")).ok) return; } catch {} await sleep(500); }
  throw new Error("wrangler dev did not start:\n" + globalThis[logName]);
}
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "agent-board-test-"));
  await new Promise((r) => gh.listen(0, "127.0.0.1", r));
  const keys = Object.entries(KEY).map(([n, k]) => `KEY_${n.toUpperCase()}=${k}`).join("\n");
  const env1 = join(tmp, "a.env"), env2 = join(tmp, "b.env");
  writeFileSync(env1, keys + `\nOWNER_PASSWORD=${PW}\n`);
  writeFileSync(env2, keys + `\nOWNER_PASSWORD=${PW}\nGITHUB_TOKEN=gh-test-token\n`);
  dev = start(PORT, env1, [], "__log");
  dev2 = start(PORT2, env2, ["--var", "GITHUB_REPO:test-org/test-repo", "--var", "GITHUB_COMMIT_STATUS:1", "--var", `GITHUB_API_BASE:http://127.0.0.1:${gh.address().port}`], "__log2");
  await ready(B, "__log"); await ready(B2, "__log2");
});
after(() => { if (process.env.SHOWLOG) console.log(globalThis.__log, globalThis.__log2); for (const p of [dev, dev2]) { try { process.kill(-p.pid); } catch {} } gh.close(); rmSync(tmp, { recursive: true, force: true }); });

async function call(who, name, args = {}, base = B) {
  const r = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${KEY[who] || who}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  if (r.status !== 200) return { http: r.status };
  const j = await r.json();
  return j.result.structuredContent ?? { toolError: j.result.content?.[0]?.text };
}
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const no = (r, re) => { assert.equal(r.ok, false, "expected rejection, got " + JSON.stringify(r)); if (re) assert.match(r.error, re); return r; };
const newTask = async (who, extra = {}, base = B) => ok(await call(who, "task_new", { title: "t " + Math.random().toString(36).slice(2, 7), ...extra }, base)).task.id;

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
  no(await call("local", "task_update", { id, status: "merged", head_sha: SHA1 }));                // not a merger/party
  no(await call("claude", "task_update", { id, status: "merged", head_sha: SHA1 }), /only merger, codex can merge/);
  no(await call("merger", "task_update", { id, status: "merged" }), /head_sha/);
  no(await call("merger", "task_update", { id, status: "merged", head_sha: SHA2 }), /does not match/); // new commit after approval
  ok(await call("merger", "task_update", { id, status: "merged", head_sha: SHA1 }));
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
  const id = await newTask("rev", { owner: "claude", reviewer: "codex" });
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
  const id = await newTask("rev", { reviewer: "codex" });
  no(await call("codex", "task_claim", { id }), /reviewer cannot claim/);
});

test("cannot take over another identity's blocked task by claiming", async () => {
  const id = await newTask("claude", { owner: "claude" });
  ok(await call("claude", "task_claim", { id }));
  ok(await call("claude", "task_update", { id, status: "blocked" }));
  no(await call("codex", "task_claim", { id }), /owned by claude/);
});

// ---------- rate limit ----------
test("bypass: hand-off over quota is rejected whole, not silently dropped", async () => {
  for (let i = 0; i < 60; i++) ok(await call("noisy", "board_post", { to: "rev", text: "n" + i }));
  assert.equal((await call("noisy", "board_post", { to: "rev", text: "over" })).error, "rate_limited");
  const before = (await call("rev", "task_list", { include_closed: true, limit: 200 })).tasks.length;
  no(await call("noisy", "task_new", { title: "notify", next_owner: "claude" }), /rate_limited: .*nothing was changed/);
  const after = (await call("rev", "task_list", { include_closed: true, limit: 200 })).tasks.length;
  assert.equal(after, before, "no task may be created when the hand-off can't be sent");
  ok(await call("noisy", "task_new", { title: "no hand-off needed" })); // a change that posts nothing still works
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

test("bypass: refresh token replay after the grace window revokes the whole family", async () => {
  const t = await oauthTokens();
  const r1 = await refresh(t.refresh_token, t.client_id); assert.equal(r1.status, 200);
  const t2 = await r1.json();
  assert.ok((await call(t2.access_token, "task_list")).tasks);
  const retry = await refresh(t.refresh_token, t.client_id);                                       // idempotent retry within grace
  assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), t2, "grace retry returns the same new pair");
  await sleep(10500);
  const replay = await refresh(t.refresh_token, t.client_id); assert.equal(replay.status, 400);  // reuse after grace
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

// ---------- second review ----------
test("bypass: owner who is also a merger cannot merge their own task", async () => {
  const id = await newTask("codex", { owner: "codex" });
  ok(await call("codex", "task_claim", { id }));
  ok(await call("codex", "task_update", { id, status: "in_review" }));
  ok(await call("rev", "task_update", { id, status: "approved", head_sha: SHA1 }));
  no(await call("codex", "task_update", { id, status: "merged", head_sha: SHA1 }), /owner cannot merge/);
  ok(await call("merger", "task_update", { id, status: "merged", head_sha: SHA1 }));
});

test("bypass: non-approver cannot pick a friendly reviewer in task_new", async () => {
  no(await call("claude", "task_new", { title: "x", owner: "claude", reviewer: "codex" }), /only an approver can choose the reviewer/);
  const t = ok(await call("claude", "task_new", { title: "x", owner: "claude" })).task; assert.equal(t.reviewer, "rev");
  ok(await call("claude", "task_new", { title: "x", reviewer: "rev" }));                 // naming the default is fine
  assert.equal(ok(await call("rev", "task_new", { title: "x", reviewer: "codex" })).task.reviewer, "codex"); // approver may
});

test("bypass: rotating IPv6 addresses inside one /64 shares one throttle", async () => {
  for (let i = 1; i <= 5; i++) assert.match((await login(B, "wrong-password-x", `2001:db8:1:2::${i}`)).headers.get("location"), /e=bad/);
  assert.match((await login(B, PW, "2001:db8:1:2:ffff::99")).headers.get("location"), /e=locked/);   // same /64
  assert.match((await login(B, PW, "2001:0db8:0001:0002:0:0:0:abcd")).headers.get("location"), /e=locked/); // long form, same /64
  assert.equal((await login(B, PW, "2001:db8:1:3::1")).headers.get("location"), "/board");             // next /64 is fine
});

const ghTask = async (pr) => {
  const id = await newTask("rev", { owner: "claude", links: pr ? { prs: [`https://github.com/test-org/test-repo/pull/${pr}`] } : undefined }, B2);
  ok(await call("claude", "task_claim", { id }, B2)); ok(await call("claude", "task_update", { id, status: "in_review" }, B2));
  return id;
};
test("GitHub binding: approve must match the real PR head", async () => {
  no(await call("rev", "task_update", { id: await ghTask(null), status: "approved", head_sha: SHA1 }, B2), /add links.prs/);
  PRS[7] = { head: SHA2, merged: false };
  const id = await ghTask(7);
  no(await call("rev", "task_update", { id, status: "approved", head_sha: SHA1 }, B2), /PR #7 head is b+, not/);
  ok(await call("rev", "task_update", { id, status: "approved", head_sha: SHA2 }, B2));
});

test("bypass: GitHub binding refuses a merge of anything but the approved SHA", async () => {
  PRS[8] = { head: SHA1, merged: false };
  const id = await ghTask(8);
  ok(await call("rev", "task_update", { id, status: "approved", head_sha: SHA1 }, B2));
  no(await call("merger", "task_update", { id, status: "merged", head_sha: SHA1 }, B2), /not merged on GitHub/);
  PRS[8] = { head: SHA2, merged: true, merge_commit_sha: "c".repeat(40) };       // new commit pushed, then branch merged
  no(await call("merger", "task_update", { id, status: "merged", head_sha: SHA1 }, B2), /not the approved/);
  PRS[8] = { head: SHA1, merged: true, merge_commit_sha: SHA1 };                 // ff-only merge of the approved SHA
  ok(await call("merger", "task_update", { id, status: "merged", head_sha: SHA1 }, B2));
});

test("no board-wide lockout: a distributed flood does not slow the owner down", async () => {
  const lg = (pw, ip) => fetch(B2 + "/board/login", { method: "POST", redirect: "manual", body: new URLSearchParams({ password: pw }), headers: { origin: B2, "cf-connecting-ip": ip } });
  for (let i = 0; i < 120; i++) await lg("wrong-password-x", `198.18.${i >> 8}.${i & 255}`);
  assert.equal((await lg(PW, "198.19.0.2")).headers.get("location"), "/board", "owner gets in immediately");
  for (let i = 0; i < 5; i++) await lg("wrong-password-x", "198.19.0.9");
  assert.match((await lg(PW, "198.19.0.9")).headers.get("location"), /e=locked/, "per-source backoff still applies");
});

test("bypass: race - approve in flight while the owner sends the task back (slow GitHub)", async () => {
  const id = await ghTask(11);
  const SR = "f".repeat(40); PRS[11] = { head: SR, merged: false, delay: 1500 };
  const approving = call("rev", "task_update", { id, status: "approved", head_sha: SR }, B2);
  await sleep(400);
  ok(await call("claude", "task_update", { id, status: "in_progress", note: "found a bug" }, B2));
  no(await approving, /modified during verification, please retry/);
  const g = await call("rev", "task_get", { id }, B2);
  assert.equal(g.task.status, "in_progress");
  assert.equal(g.task.approved_sha, null);
  const statuses = g.history.map((h) => h.detail.status).filter(Boolean).map((x) => x[1]);
  assert.deepEqual(statuses.reverse(), ["todo", "in_progress", "in_review", "in_progress"], "history has no approval");
  assert.equal(STATUSES[SR], undefined, "no success status was written for the rejected approval");
});

test("GitHub commit status: approve writes success, withdrawing writes pending/failure", async () => {
  const S3 = "d".repeat(40), S4 = "e".repeat(40);
  const id = await ghTask(12); PRS[12] = { head: S3, merged: false };
  ok(await call("rev", "task_update", { id, status: "approved", head_sha: S3 }, B2));
  assert.deepEqual(STATUSES[S3], [{ state: "success", context: "agent-board/approved" }]);
  ok(await call("claude", "task_update", { id, status: "in_review" }, B2));
  assert.deepEqual(STATUSES[S3].at(-1), { state: "pending", context: "agent-board/approved" });
  PRS[12] = { head: S4, merged: false };
  ok(await call("rev", "task_update", { id, status: "approved", head_sha: S4 }, B2));
  assert.deepEqual(STATUSES[S4], [{ state: "success", context: "agent-board/approved" }]);
  ok(await call("claude", "task_update", { id, status: "in_progress" }, B2));
  assert.deepEqual(STATUSES[S4].at(-1), { state: "failure", context: "agent-board/approved" });
});

test("unit: source keys are /32 for IPv4 and /64 for IPv6; password minimum is 16", async () => {
  const { sourceKey, passwordOk, MIN_PASSWORD } = await import("../src/oauth.js");
  assert.equal(sourceKey("203.0.113.7"), "203.0.113.7");
  assert.equal(sourceKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(sourceKey("2001:db8:1:2::5"), "2001:db8:1:2::/64");
  assert.equal(sourceKey("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(sourceKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(MIN_PASSWORD, 16);
  assert.equal(passwordOk({ OWNER_PASSWORD: "x".repeat(15) }), false);
  assert.equal(passwordOk({ OWNER_PASSWORD: "x".repeat(16) }), true);
});

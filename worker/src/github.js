// Optional GitHub integration. Everything is off unless GITHUB_REPO ("owner/name") is set plus credentials:
//  - GitHub App (recommended): GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, secret GITHUB_APP_PRIVATE_KEY (PEM,
//    PKCS#1 "BEGIN RSA PRIVATE KEY" as downloaded from GitHub, or PKCS#8; literal "\n" escapes are accepted).
//    App permissions: Pull requests: read, Checks: write. Enables the PR checks below AND the
//    "agent-board/approved" check run, which branch protection can require *from this App only*.
//  - or a plain GITHUB_TOKEN (read PRs/CI; no board check runs: a token can't prove it is the board).
// Review/release bind the current open PR head; merge requires that exact reviewed head plus fresh CI.
// GITHUB_API_BASE can point at a mock server for tests (default https://api.github.com).
// GITHUB_COMMIT_STATUS (commit statuses) was removed: any token with statuses:write can forge a status.
export const CHECK_NAME = "agent-board/approved";
const apiBase = (env) => (env.GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, "");
export const appEnabled = (env) => !!(env.GITHUB_REPO && env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY);
export const githubEnabled = (env) => !!(env.GITHUB_REPO && (env.GITHUB_TOKEN || appEnabled(env)));

export function prNumber(env, links) {
  const repo = String(env.GITHUB_REPO).toLowerCase();
  for (const u of (links && links.prs) || []) {
    const m = String(u).match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/i);
    if (m && m[1].toLowerCase() === repo) return parseInt(m[2]);
  }
  return null;
}

// ---- GitHub App auth: RS256 JWT -> installation access token (cached in memory until shortly before expiry) ----
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uStr = (s) => b64u(new TextEncoder().encode(s));
function derLen(n) { if (n < 128) return [n]; const b = []; while (n) { b.unshift(n & 255); n >>= 8; } return [0x80 | b.length, ...b]; }
function pemToPkcs8(pem) {
  pem = String(pem).replace(/\\n/g, "\n");
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  if (!pkcs1) return der;
  // Wrap PKCS#1 RSAPrivateKey in PKCS#8: SEQ { INTEGER 0, SEQ { rsaEncryption OID, NULL }, OCTET STRING { key } }
  const alg = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const oct = [0x04, ...derLen(der.length), ...der];
  const body = [0x02, 0x01, 0x00, ...alg, ...oct];
  return new Uint8Array([0x30, ...derLen(body.length), ...body]);
}
async function appJwt(env) {
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(env.GITHUB_APP_PRIVATE_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const data = b64uStr(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64uStr(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(env.GITHUB_APP_ID) }));
  return data + "." + b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data)));
}
const H = (auth) => ({ authorization: auth, accept: "application/vnd.github+json", "user-agent": "agent-board", "x-github-api-version": "2022-11-28" });
let cached = null; // { token, exp } per isolate; never persisted
export async function installationToken(env) {
  if (cached && cached.exp - 120e3 > Date.now()) return cached.token;
  const r = await fetch(`${apiBase(env)}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, { method: "POST", headers: H(`Bearer ${await appJwt(env)}`), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`GitHub App token request failed (${r.status})`);
  const j = await r.json();
  cached = { token: j.token, exp: Date.parse(j.expires_at) || Date.now() + 3000e3 };
  return cached.token;
}
const authHeader = async (env) => (appEnabled(env) ? `Bearer ${await installationToken(env)}` : `Bearer ${env.GITHUB_TOKEN}`);

export async function fetchPr(env, n) {
  const r = await fetch(`${apiBase(env)}/repos/${env.GITHUB_REPO}/pulls/${n}`, { headers: H(await authHeader(env)), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`GitHub API ${r.status} for PR #${n}`);
  const j = await r.json();
  return { head: String(j.head?.sha || "").toLowerCase(), merged: !!j.merged, state: j.state, mergeCommit: String(j.merge_commit_sha || "").toLowerCase() };
}

export async function verifyCI(env, sha) {
  if (!githubEnabled(env)) throw new Error("merge gates require GitHub binding");
  let required;
  try { required = JSON.parse(env.REQUIRED_CI_CHECKS || "null"); } catch { /* rejected below */ }
  if (!Array.isArray(required) || !required.length || required.length > 20 || required.some((c) =>
    !c || typeof c.name !== "string" || !c.name.trim() || c.name === CHECK_NAME || !Number.isSafeInteger(c.app_id) || c.app_id <= 0))
    throw new Error("REQUIRED_CI_CHECKS must be a nonempty JSON array of {name, app_id}; the board check cannot count as CI");
  const headers = H(await authHeader(env)), evidence = [];
  for (const c of required) {
    const q = new URLSearchParams({ check_name: c.name, app_id: String(c.app_id), filter: "latest", per_page: "100" });
    const r = await fetch(`${apiBase(env)}/repos/${env.GITHUB_REPO}/commits/${sha}/check-runs?${q}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`GitHub API ${r.status} checking CI`);
    const j = await r.json(), runs = j.check_runs;
    if (!Array.isArray(runs) || !runs.length || j.total_count !== runs.length || runs.some((x) =>
      x.head_sha !== sha || x.name !== c.name || x.app?.id !== c.app_id || x.status !== "completed" || x.conclusion !== "success"))
      throw new Error(`CI ${c.name} from App ${c.app_id} is missing, incomplete, or not successful on ${sha}`);
    evidence.push(...runs.map((x) => ({ name: x.name, app_id: x.app.id, run_id: x.id, sha })));
  }
  return evidence;
}

// Each change creates a new check run; GitHub evaluates the most recent run of a given name on a commit.
// state: { status: "completed"|"in_progress", conclusion?: "success"|"failure" (never neutral/skipped: GitHub treats those as passing), summary }
export async function createCheckRun(env, sha, state) {
  const body = { name: CHECK_NAME, head_sha: sha, status: state.status, output: { title: state.title || CHECK_NAME, summary: state.summary || "" } };
  if (state.status === "completed") body.conclusion = state.conclusion;
  const r = await fetch(`${apiBase(env)}/repos/${env.GITHUB_REPO}/check-runs`, { method: "POST", headers: { ...H(await authHeader(env)), "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (r.status === 401) cached = null;
  if (!r.ok) throw new Error(`GitHub API ${r.status} creating check run`);
}

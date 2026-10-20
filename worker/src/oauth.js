// Minimal OAuth 2.1 authorization server for MCP clients that require OAuth (e.g. ChatGPT connectors).
// - Dynamic client registration (RFC 7591), authorization code + PKCE S256, refresh tokens.
// - Consent is gated by the board owner's password (OWNER_PASSWORD secret).
// - Every OAuth token acts as ONE configured identity (OAUTH_IDENTITY); the client can't choose.
// Tokens and codes are stored only as SHA-256 hashes.
const ACCESS_TTL = 3600e3, REFRESH_TTL = 30 * 86400e3, CODE_TTL = 120e3;
export const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const rand = (n = 32) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...h } });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function initOAuth(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS o_clients(client_id TEXT PRIMARY KEY, redirect_uris TEXT, name TEXT, created INTEGER)");
  sql.exec("CREATE TABLE IF NOT EXISTS o_codes(h TEXT PRIMARY KEY, client_id TEXT, redirect_uri TEXT, challenge TEXT, exp INTEGER)");
  sql.exec("CREATE TABLE IF NOT EXISTS o_tokens(h TEXT PRIMARY KEY, kind TEXT, client_id TEXT, exp INTEGER)");
  try { sql.exec("ALTER TABLE o_tokens ADD COLUMN family TEXT"); } catch { /* already there */ }
  sql.exec("CREATE TABLE IF NOT EXISTS auth_fail_ip(ip TEXT, t INTEGER)");
  sql.exec("CREATE INDEX IF NOT EXISTS auth_fail_ip_i ON auth_fail_ip(ip, t)");
}

// Password check with a per-source throttle (keyed by CF-Connecting-IP), so a flood of
// bad guesses from one address can't lock the owner out everywhere.
// Backoff: after FREE failures within 24 h, that source must wait 1 min, then 2, 4, ... capped at 1 h.
const FREE = 5, DAY = 86400e3, MAX_WAIT = 3600e3;
export const clientIp = (req) => req.headers.get("cf-connecting-ip") || "unknown";
export function eq(a, b) { a = String(a); b = String(b); let r = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0); return r === 0; }
export function checkPassword(self, pw, ip) {
  const t = Date.now();
  self.sql.exec("DELETE FROM auth_fail_ip WHERE t<?", t - DAY);
  const r = self.sql.exec("SELECT COUNT(*) c, MAX(t) last FROM auth_fail_ip WHERE ip=?", ip).one();
  if (r.c >= FREE && t < r.last + Math.min(60e3 * 2 ** (r.c - FREE), MAX_WAIT)) return "locked";
  const ok = !!self.env.OWNER_PASSWORD && String(self.env.OWNER_PASSWORD).length >= 12 && eq(pw || "", self.env.OWNER_PASSWORD);
  if (ok) self.sql.exec("DELETE FROM auth_fail_ip WHERE ip=?", ip);
  else self.sql.exec("INSERT INTO auth_fail_ip VALUES(?,?)", ip, t);
  return ok ? "ok" : "bad";
}

export const oauthEnabled = (cfg, env) => !!(cfg.oauthIdentity && env.OWNER_PASSWORD);

export async function oauthIdentity(self, cfg, token) {
  if (!oauthEnabled(cfg, self.env) || !token) return null;
  const r = self.sql.exec("SELECT exp FROM o_tokens WHERE h=? AND kind='access'", await sha(token)).toArray()[0];
  return r && r.exp > Date.now() ? cfg.oauthIdentity : null;
}

export function wwwAuth(base) { return `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`; }

function page(title, body) {
  return new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:420px;margin:10vh auto;padding:0 16px}input,button{font:inherit;padding:10px;width:100%;box-sizing:border-box;margin:6px 0}button{cursor:pointer}.e{color:#b3261e}</style>${body}`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*" } });
}

function validRedirect(u) {
  try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1"].includes(x.hostname)); } catch { return false; }
}

export async function handleOAuth(self, cfg, req, base) {
  const url = new URL(req.url), p = url.pathname;
  const on = oauthEnabled(cfg, self.env);
  if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp")
    return on ? json({ resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"] }) : json({ error: "oauth_disabled" }, 404);
  if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration")
    return on ? json({ issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] }) : json({ error: "oauth_disabled" }, 404);
  if (!p.startsWith("/oauth/")) return null;
  if (!on) return json({ error: "oauth_disabled" }, 404);

  if (p === "/oauth/register" && req.method === "POST") {
    let b; try { b = await req.json(); } catch { return json({ error: "invalid_client_metadata" }, 400); }
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 5 || !uris.every(validRedirect)) return json({ error: "invalid_redirect_uri" }, 400);
    if (self.sql.exec("SELECT COUNT(*) c FROM o_clients").one().c >= 200) return json({ error: "too_many_clients" }, 429);
    const id = rand(16);
    self.sql.exec("INSERT INTO o_clients VALUES(?,?,?,?)", id, JSON.stringify(uris), String(b.client_name || "client").slice(0, 80), Date.now());
    return json({ client_id: id, redirect_uris: uris, client_name: b.client_name || "client", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
  }

  if (p === "/oauth/authorize") {
    const q = req.method === "POST" ? Object.fromEntries(await req.formData()) : Object.fromEntries(url.searchParams);
    const c = self.sql.exec("SELECT * FROM o_clients WHERE client_id=?", String(q.client_id || "")).toArray()[0];
    if (!c) return page("Error", "<p class=e>Unknown client.</p>");
    const uris = JSON.parse(c.redirect_uris);
    if (!uris.includes(q.redirect_uri)) return page("Error", "<p class=e>redirect_uri not registered.</p>");
    if (q.response_type !== "code" || q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge || "")) return page("Error", "<p class=e>PKCE S256 and response_type=code are required.</p>");
    const hidden = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"].map((k) => q[k] != null ? `<input type=hidden name=${k} value="${esc(q[k])}">` : "").join("");
    const form = (err) => page("Authorize", `<h2>${esc(cfg.boardName)}</h2><p><b>${esc(c.name)}</b> wants to use the board as <b>${esc(cfg.oauthIdentity)}</b>.</p>${err ? `<p class=e>${err}</p>` : ""}<form method=post>${hidden}<input type=password name=password placeholder="Owner password" autocomplete=current-password required autofocus><button>Allow</button></form>`);
    if (req.method !== "POST") return form("");
    const r = checkPassword(self, q.password, clientIp(req));
    if (r !== "ok") return form(r === "locked" ? "Too many attempts; try again later." : "Wrong password.");
    const code = rand();
    self.sql.exec("INSERT INTO o_codes VALUES(?,?,?,?,?)", await sha(code), c.client_id, q.redirect_uri, q.code_challenge, Date.now() + CODE_TTL);
    const to = new URL(q.redirect_uri); to.searchParams.set("code", code); if (q.state) to.searchParams.set("state", q.state); to.searchParams.set("iss", base);
    return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
  }

  if (p === "/oauth/token" && req.method === "POST") {
    const f = Object.fromEntries(await req.formData());
    // Every token chain started by one authorization code is a "family" (RFC 9700 §4.14).
    const issue = async (cid, family) => {
      const at = rand(), rt = rand(), n = Date.now();
      self.sql.exec("DELETE FROM o_tokens WHERE exp<?", n);
      self.sql.exec("INSERT INTO o_tokens(h,kind,client_id,exp,family) VALUES(?,?,?,?,?)", await sha(at), "access", cid, n + ACCESS_TTL, family);
      self.sql.exec("INSERT INTO o_tokens(h,kind,client_id,exp,family) VALUES(?,?,?,?,?)", await sha(rt), "refresh", cid, n + REFRESH_TTL, family);
      return json({ access_token: at, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: rt });
    };
    if (f.grant_type === "authorization_code") {
      const rows = self.sql.exec("DELETE FROM o_codes WHERE h=? RETURNING *", await sha(String(f.code || ""))).toArray(); // single use
      const r = rows[0];
      if (!r || r.exp < Date.now() || r.client_id !== f.client_id || r.redirect_uri !== f.redirect_uri) return json({ error: "invalid_grant" }, 400);
      const ch = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(f.code_verifier || ""))));
      if (!eq(ch, r.challenge)) return json({ error: "invalid_grant", error_description: "PKCE mismatch" }, 400);
      return issue(r.client_id, rand(16));
    }
    if (f.grant_type === "refresh_token") {
      const h = await sha(String(f.refresh_token || ""));
      const r = self.sql.exec("SELECT * FROM o_tokens WHERE h=? AND kind IN ('refresh','refresh_used')", h).toArray()[0];
      if (r && r.kind === "refresh_used") {
        // Replay of an already-rotated refresh token: assume theft and revoke the whole family.
        if (r.family) self.sql.exec("DELETE FROM o_tokens WHERE family=?", r.family);
        else self.sql.exec("DELETE FROM o_tokens WHERE h=?", h);
        return json({ error: "invalid_grant", error_description: "refresh token reuse detected; session revoked" }, 400);
      }
      if (!r || r.exp < Date.now() || (f.client_id && f.client_id !== r.client_id)) return json({ error: "invalid_grant" }, 400);
      self.sql.exec("UPDATE o_tokens SET kind='refresh_used' WHERE h=?", h); // rotate; keep a tombstone to detect replay
      return issue(r.client_id, r.family || rand(16));
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }
  return json({ error: "not_found" }, 404);
}

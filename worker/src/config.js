// All deployment-specific settings come from wrangler vars / secrets. Nothing is hardcoded.
//
// vars (wrangler.toml [vars]):
//   IDENTITIES          comma list, e.g. "alice-chatgpt,claude-code,codex,local-llm"
//   BOARD_NAME          optional display name
//   APPROVERS           comma list allowed to move a task in_review -> approved
//   MERGERS             comma list allowed to move approved -> merged (empty = anyone)
//   DEFAULT_REVIEWER    reviewer when task_new omits one
//   SENSITIVE_ALLOWLIST comma list of identities allowed to own data_level=sensitive tasks
//   ALIASES             optional "alias=identity,alias2=identity2"
//   RATE_PER_MINUTE     posts per identity per minute (default 30)
//   WAKE_URLS           optional JSON {"identity":"https://..."} webhook called on new mail
// secrets (wrangler secret put):
//   KEY_<IDENTITY>      bearer key for that identity; name upper-cased, non-alnum -> "_"
//                       e.g. identity "claude-code" -> KEY_CLAUDE_CODE
//   WAKE_SECRET         optional HMAC secret used to sign wake webhooks
const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
export const keyName = (id) => "KEY_" + id.toUpperCase().replace(/[^A-Z0-9]/g, "_");

export function loadConfig(env) {
  const identities = list(env.IDENTITIES);
  if (!identities.length) throw new Error("IDENTITIES is not configured");
  const aliases = {};
  for (const id of identities) aliases[id.toLowerCase()] = id;
  for (const pair of list(env.ALIASES)) {
    const [a, b] = pair.split("=").map((x) => x.trim());
    if (a && b && identities.includes(b) && !identities.some((i) => i.toLowerCase() === a.toLowerCase())) aliases[a.toLowerCase()] = b;
  }
  let wakeUrls = {};
  try { wakeUrls = env.WAKE_URLS ? JSON.parse(env.WAKE_URLS) : {}; } catch { wakeUrls = {}; }
  return {
    boardName: env.BOARD_NAME || "agent-board",
    identities,
    aliases,
    approvers: list(env.APPROVERS),
    mergers: list(env.MERGERS),
    defaultReviewer: env.DEFAULT_REVIEWER || null,
    sensitiveAllowlist: list(env.SENSITIVE_ALLOWLIST),
    ratePerMinute: parseInt(env.RATE_PER_MINUTE) || 30,
    maxPostChars: 8000,
    wakeUrls,
  };
}

export const canon = (cfg, n) => (n == null || !String(n).trim() ? null : cfg.aliases[String(n).trim().toLowerCase()] || null);

function eq(a, b) {
  a = String(a); b = String(b);
  let r = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return r === 0;
}

// Returns the identity whose key matches, or null. Constant-time per comparison.
export function identify(cfg, env, key) {
  if (!key || key.length < 16) return null;
  let found = null;
  for (const id of cfg.identities) {
    const v = env[keyName(id)];
    if (v && eq(key, v)) found = id;
  }
  return found;
}

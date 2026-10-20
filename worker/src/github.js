// Optional real commit binding. When GITHUB_TOKEN (secret) and GITHUB_REPO ("owner/name")
// are set, approving and merging a task look up its PR (links.prs) on GitHub:
//  - approve: the PR's current head SHA must equal head_sha
//  - merge:   the PR must be merged, and its head SHA or merge_commit_sha must equal approved_sha
// Optional enforcement (GITHUB_COMMIT_STATUS = "1", token needs statuses:write / "Commit statuses: write"):
//  - approve writes a "success" commit status (context GITHUB_STATUS_CONTEXT, default agent-board/approved) on approved_sha
//  - withdrawing an approval sets it to "pending" (back to in_review) or "failure" (anything else)
//  Make that context a required status check in branch protection, and GitHub itself refuses to merge unapproved SHAs.
// GITHUB_API_BASE can point at a mock server for tests (default https://api.github.com).
export const githubEnabled = (env) => !!(env.GITHUB_TOKEN && env.GITHUB_REPO);

export function prNumber(env, links) {
  const repo = String(env.GITHUB_REPO).toLowerCase();
  for (const u of (links && links.prs) || []) {
    const m = String(u).match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/i);
    if (m && m[1].toLowerCase() === repo) return parseInt(m[2]);
  }
  return null;
}

export async function fetchPr(env, n) {
  const base = (env.GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, "");
  const r = await fetch(`${base}/repos/${env.GITHUB_REPO}/pulls/${n}`, {
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "agent-board", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status} for PR #${n}`);
  const j = await r.json();
  return { head: String(j.head?.sha || "").toLowerCase(), merged: !!j.merged, mergeCommit: String(j.merge_commit_sha || "").toLowerCase() };
}

export const statusEnabled = (env) => githubEnabled(env) && String(env.GITHUB_COMMIT_STATUS || "") === "1";
export const statusContext = (env) => env.GITHUB_STATUS_CONTEXT || "agent-board/approved";
export async function setStatus(env, sha, state, description) {
  const base = (env.GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, "");
  const r = await fetch(`${base}/repos/${env.GITHUB_REPO}/statuses/${sha}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "agent-board", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
    body: JSON.stringify({ state, context: statusContext(env), description: String(description).slice(0, 140) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status} setting commit status`);
}

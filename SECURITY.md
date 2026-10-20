# Security notes

- **Keys**: each identity has its own random bearer key (≥16 chars; use 32 random bytes). Store them as Worker secrets and as `chmod 600` files on agent hosts. Never commit them; `.gitignore` covers `*.key`, `.env`, `.dev.vars`, `wrangler.toml`.
- **Sender stamping**: the server derives `from` from the key. Compromise of one key lets an attacker act only as that identity — rotate it with `wrangler secret put KEY_<ID>`.
- **Prompt injection**: board messages are typed into agent sessions. Treat them as untrusted input. `launch.sh` pre-approves only the board tools; keep the agent's other permissions prompting, and don't run agents with blanket auto-approve on machines holding secrets.
- **Sensitive data**: `data_level=sensitive` restricts task *ownership* to `SENSITIVE_ALLOWLIST`, but the board itself is cloud-hosted. Never put the sensitive data itself on the board — only references.
- **Wake webhooks** are signed with `x-board-signature: sha256=<HMAC(WAKE_SECRET, body)>` and carry only a 500-char preview; verify the signature on the receiving side.
- **Rate limit**: posts are limited per identity per minute (`RATE_PER_MINUTE`). The limit is stored in Durable Object storage, so it survives restarts, and it also counts the board messages that `task_*` hand-offs post on your behalf.

## Known limitations

- **`touches_mainline` is self-declared.** The task creator sets it, and only approvers can clear it later. The server cannot tell whether a change really touches mainline, so the lock only protects against honest mistakes and clearing it later, not against a task that was never marked.
- **`head_sha` binds a claim unless GitHub binding is on.** Without `GITHUB_TOKEN` + `GITHUB_REPO`, the server only checks that the merger reports the same SHA the reviewer approved; it can't see what was actually merged. With them, approve and merge are checked against the PR on GitHub, but only after the fact. Add `GITHUB_COMMIT_STATUS=1` and make `agent-board/approved` a required status check in branch protection, and GitHub itself blocks merging unapproved SHAs (see README). Either way, merge the approved SHA (`git merge --ff-only <approved_sha>`), not the branch tip.
- **Merger separation.** The task owner can never set `merged` on their own task. Configure `MERGERS` as identities that don't own tasks.

- **Cross-agent prompt-injection chaining.** `launch.sh` pre-approves `board_post` (and the read tools) so agents can reply without a human click. A message that injects instructions into agent A can make A post a crafted message to agent B, which the runner types into B's session, and so on along the chain. The server stamps the true sender on every hop and enforces the task rules, but it cannot judge message content. Mitigations: keep each agent's non-board tools prompting for approval; don't give agents that read untrusted content (web, email, issues) the same pre-approval as trusted ones; watch the tmux windows; and treat board messages as data, not commands, in your agents' instructions.
- **Runner delivery is at-most-once.** The runner advances its cursor after typing a message into tmux, whether or not the agent actually processed it. A crash or a busy agent can drop a message.
- **No idle detection.** The runner types into the tmux session even if the agent is mid-task, which can interleave with its current work.

Report vulnerabilities privately via GitHub Security Advisories on this repository.

## OAuth line and web UI

- Both are off unless the `OWNER_PASSWORD` secret is set (at least 16 characters). OAuth also needs `OAUTH_IDENTITY`.
- OAuth tokens always act as `OAUTH_IDENTITY`. Access tokens last 1 h, and refresh tokens last 30 days and rotate on each use. Codes are single-use and expire after 2 min. Tokens and codes are stored only as SHA-256 hashes.
- Only `https` redirect URIs (or `http` on localhost) can be registered, and PKCE S256 is required.
- Password attempts (OAuth consent and web login) are throttled per source network (`CF-Connecting-IP`): per address for IPv4 (/32) and per /64 for IPv6. After 5 failures in 24 h, that source must wait 1 min, then 2, 4, … up to 1 h between tries. A successful login clears its counter.
- There is deliberately no board-wide ceiling: under a sustained distributed attack it would lock the owner out too. An attacker with many networks gets 5 free guesses per network per day, then backoff, so use a long random `OWNER_PASSWORD` (16+ characters). For volumetric protection, add a **Cloudflare WAF rate limiting rule** at the edge for `POST /board/login` and `/authorize` (for example, a few requests per minute per IP). Cloudflare drops that traffic before it reaches the Worker.
- A client that retries the same refresh within 10 seconds (for example after a lost response) gets the same new token pair back. After that, replaying a used refresh token revokes the whole token family for that authorization (RFC 9700). The new pair is kept in plaintext only for those 10 seconds.
- The web UI is read-only. It sends a strict CSP and `frame-ancestors 'none'`, and the login form requires the Origin header to exactly match the configured origin (`PUBLIC_BASE_URL`, else the request's own origin).
- To revoke all OAuth clients, change `OWNER_PASSWORD` and clear the `o_tokens` table, or redeploy with a new Durable Object name.

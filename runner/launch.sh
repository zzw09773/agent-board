#!/usr/bin/env bash
# launch.sh <identity>: start that identity's agent CLI, resumed on its fixed session.
# Runs inside tmux session board-<identity> (started by runner.py).
# Reads identities.tsv: identity<TAB>cli<TAB>session_id<TAB>workdir<TAB>extra
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a
CONF="${BOARD_CONFIG_DIR:-$HOME/.config/agent-board}"
CONF="${CONF/#\~/$HOME}"
id="$1"
IFS=$'\t' read -r _ cli sid wd extra < <(awk -F'\t' -v i="$id" '$1==i' "$CONF/identities.tsv")
cd "${wd:-$HOME}"
# Only let the agent call the board tools without prompting; everything else still asks.
# Hooks: tell runner.py when the agent is at a permission prompt (see README "Hooks").
# Scoped to this session (--settings / -c), not your user config. Set RUNNER_HOOKS=0 to skip.
HOOK="$HERE/hooks/board_hook.py"
hooks_json() { local c="python3 $HOOK $id"; local h='[{"hooks":[{"type":"command","command":"'"$c"'"}]}]'
  printf '{"hooks":{"Notification":%s,"PermissionRequest":%s,"UserPromptSubmit":%s,"PostToolUse":%s,"Stop":%s}}' "$h" "$h" "$h" "$h" "$h"; }
if [ "${RUNNER_HOOKS:-1}" = 1 ]; then CLAUDE_HOOKS=(--settings "$(hooks_json)"); CODEX_HOOKS=(-c "notify=[\"python3\",\"$HOOK\",\"$id\"]"); else CLAUDE_HOOKS=(); CODEX_HOOKS=(); fi
ALLOW="mcp__agent-board__board_post mcp__agent-board__board_read mcp__agent-board__board_wait mcp__agent-board__task_list mcp__agent-board__task_get"
case "$cli" in
  claude)        # Claude Code, per-identity MCP config pointing at the board with this identity's key
    exec claude --resume "$sid" "${CLAUDE_HOOKS[@]}" --strict-mcp-config --mcp-config "$CONF/$id-mcp.json" --allowedTools $ALLOW ${extra:-} ;;
  claude-local)  # Claude Code against a local OpenAI/Anthropic-compatible gateway (e.g. LiteLLM -> vLLM)
    export ANTHROPIC_BASE_URL="${LOCAL_GATEWAY_URL:?set LOCAL_GATEWAY_URL in .env}"
    exec claude --resume "$sid" "${CLAUDE_HOOKS[@]}" --strict-mcp-config --mcp-config "$CONF/$id-mcp.json" --allowedTools $ALLOW ${extra:-} ;;
  codex)         # Codex CLI; ~/.codex/config.toml reads the key from BOARD_KEY (see README)
    export BOARD_KEY="$(cat "$CONF/$id.key")"
    exec codex resume "${CODEX_HOOKS[@]}" "$sid" ${extra:-} ;;
  *)             # any other CLI: "<cli> <extra>" with SESSION substituted
    exec $cli ${extra//SESSION/$sid} ;;
esac

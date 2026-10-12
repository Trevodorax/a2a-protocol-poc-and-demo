#!/usr/bin/env bash
# Starts the whole POC locally: database, informations agent (:8001), actions agent (:8002),
# bank-client-service (:3000). Ctrl-C stops everything.
#   ./dev.sh             start
#   ./dev.sh --reset-db  recreate database/bank.db first (restores the demo data)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/bin:$PATH"

die() { echo "error: $*" >&2; exit 1; }
command -v uv >/dev/null || die "uv is required: curl -LsSf https://astral.sh/uv/install.sh | sh"
command -v node >/dev/null || die "Node.js >= 24 is required"
[[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ]] || die "Node.js >= 24 is required"

FRONT_ENV="$ROOT/bank-client-service/.env"
if [[ ! -f "$FRONT_ENV" ]]; then
  cp "$ROOT/bank-client-service/.env.example" "$FRONT_ENV"
  die "created bank-client-service/.env: set LLM_API_KEY in it, then run ./dev.sh again"
fi
env_value() { grep -E "^$1=" "$FRONT_ENV" | tail -1 | cut -d= -f2- || true; }
LLM_API_KEY="$(env_value LLM_API_KEY)"
LLM_MODEL="$(env_value LLM_MODEL)"
[[ -n "$LLM_API_KEY" ]] || die "set LLM_API_KEY in bank-client-service/.env"

# The Python agents share the front agent's key and model unless they have their own .env.
# (LangChain needs a "provider:" prefix, the AI SDK doesn't.)
share_llm_settings() {
  if [[ ! -f "$ROOT/$1/.env" ]]; then
    export LLM_API_KEY LLM_MODEL="openai:${LLM_MODEL:-gpt-5.5}"
  fi
}

if [[ "${1:-}" == "--reset-db" || ! -f "$ROOT/database/bank.db" ]]; then
  python3 "$ROOT/database/init_db.py"
fi

echo "Installing dependencies..."
(cd "$ROOT/informations-agent" && uv sync --quiet)
(cd "$ROOT/actions-agent" && uv sync --quiet)
(cd "$ROOT/bank-client-service" && { [[ -d node_modules ]] || npm install --silent; })

trap 'trap - INT TERM EXIT; kill 0 2>/dev/null' INT TERM EXIT
# Logs go through `prefix` (a pipe): keep the front agent's log colors when we print to a terminal.
[[ -t 1 ]] && export FORCE_COLOR=1
prefix() { sed -u "s/^/[$1] /"; }

(cd "$ROOT/informations-agent" && share_llm_settings informations-agent && uv run informations-agent 2>&1 | prefix informations) &
(cd "$ROOT/actions-agent" && share_llm_settings actions-agent && uv run actions-agent 2>&1 | prefix actions) &

for port in 8001 8002; do
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$port/health" >/dev/null && break
    sleep 0.5
  done
  curl -sf "http://127.0.0.1:$port/health" >/dev/null || die "the agent on port $port did not start (see logs above)"
done

(cd "$ROOT/bank-client-service" && npm run dev --silent 2>&1 | prefix front) &

echo
echo "  Chat UI:            http://localhost:3000"
echo "  Informations agent: http://127.0.0.1:8001/.well-known/agent-card.json"
echo "  Actions agent:      http://127.0.0.1:8002/.well-known/agent-card.json"
echo "  Ctrl-C to stop."
echo
wait

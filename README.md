# A2A bank POC

Three agents talking over **A2A** (Agent2Agent protocol, v1.0), sharing a tiny SQLite bank:

```
                       ┌──────────────────────────────────┐
 Browser ── REST ───▶  │ bank-client-service  (TS, :3000) │  front agent: chat UI + Vercel AI SDK
                       │  • search_knowledge_base         │
                       │  • ask_informations_agent ───────┼── A2A ──▶ informations-agent (Python, :8001)  read-only ──┐
                       │  • ask_actions_agent ────────────┼── A2A ──▶ actions-agent      (Python, :8002)  read-write ─┤
                       └──────────────────────────────────┘                                                          ▼
                                                                                                         database/bank.db
```

| Folder | What | Stack |
|---|---|---|
| [`bank-client-service/`](bank-client-service/README.md) | Front agent: chat UI, REST API, routes requests, asks the client to confirm operations | Node 24, Express, Vercel AI SDK, `@a2a-js/sdk` (client) |
| [`informations-agent/`](informations-agent/README.md) | Reads the client's accounts, transactions, cards | Python 3.12, LangChain `create_agent`, `a2a-sdk` (server) |
| [`actions-agent/`](actions-agent/README.md) | Blocks a card, transfers between own accounts, always after confirmation | Python 3.12, LangChain + human-in-the-loop, `a2a-sdk` (server) |
| [`database/`](database/README.md) | Minimal SQLite schema + fictional demo data | SQLite |

How A2A is used, end to end: [`bank-client-service/A2A.md`](bank-client-service/A2A.md).

## Launch everything

Requirements: **Node.js ≥ 24**, **uv** (`curl -LsSf https://astral.sh/uv/install.sh | sh`), `python3`, and an **OpenAI API key**.

```bash
# 1. Once: put your key in the front agent's config (the Python agents reuse it)
cp bank-client-service/.env.example bank-client-service/.env
#    then edit bank-client-service/.env: LLM_API_KEY=sk-...

# 2. Start everything (installs dependencies on the first run)
./dev.sh               # or ./dev.sh --reset-db to restore the demo data
```

`dev.sh` creates the database if needed, runs `uv sync` in each Python agent (one `.venv/` per agent) and `npm install` in the front agent. Then it starts the informations agent, the actions agent and the front agent, with logs prefixed `[informations]`, `[actions]` and `[front]`. **Ctrl-C** stops everything.

Open **http://localhost:3000**. You are the demo client **Alice Martin** (`c_001`).

The Python agents use the key and model from `bank-client-service/.env` (as `openai:<LLM_MODEL>`), unless they have their own `.env`.

## Things to try

| Ask | What happens |
|---|---|
| "What are the fees for an international transfer?" | Answered from the front agent's knowledge base (no A2A) |
| "Quel est le solde de mes comptes ?" | Delegated to the **informations agent**: 1842.50 EUR checking, 12500.00 EUR savings |
| "Show my last 3 transactions on my checking account" | Informations agent |
| "Is my card ending in 7710 active?" | Informations agent |
| "I lost my card ending in 4821, block it" | Delegated to the **actions agent**, which pauses: an **Approve / Reject** card appears. Approve → the card is blocked |
| "Move 200 EUR from my checking to my savings" → **Reject** with comment "only 50" | Nothing is moved; the assistant offers to prepare 50 EUR instead |
| Ask for a transfer, then type something else instead of clicking | The pending operation is dropped (superseded); a late click is refused |
| "Block card 1234" | That card belongs to another client (`c_002`): the actions agent can't see it, so it is never offered for confirmation |

Check the effect in the database:

```bash
sqlite3 database/bank.db "SELECT id, last4, status FROM cards; SELECT id, balance_cents FROM accounts;"
```

Inspect the A2A side directly:

```bash
curl -s localhost:8001/.well-known/agent-card.json      # informations agent's Agent Card
curl -s localhost:8002/.well-known/agent-card.json      # actions agent's Agent Card
```

Raw JSON-RPC examples (including the full confirmation round trip) are in each Python agent's README.

## Run the tests

No LLM or network calls in any test suite.

```bash
(cd bank-client-service && npm test)
(cd informations-agent && uv run pytest)
(cd actions-agent && uv run pytest)
```

## Ports

| Port | Service |
|---|---|
| 3000 | bank-client-service (chat UI + REST) |
| 8001 | informations-agent (A2A JSON-RPC + Agent Card) |
| 8002 | actions-agent (A2A JSON-RPC + Agent Card) |

## Known limitations

- **No authentication** (`TODO(auth)`): every request acts as `c_001`, and the A2A agents trust the `client_id` they receive. That's why everything listens on localhost.
- Conversations, A2A tasks and paused operations are kept in memory: restarting a service forgets them (a pending approval is then refused, never executed).
- Every agent sends data to OpenAI.

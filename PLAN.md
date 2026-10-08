# Plan: actions agent, informations agent, database

## Context

`bank-client-service/` (TypeScript, Vercel AI SDK) is the front agent: clients talk to it over REST. Its A2A work is still `TODO(A2A)`. It already plans to delegate to two specialized agents, each one exposed to it as a tool:

| Name in `bank-client-service` TODOs | New project | Role |
|---|---|---|
| Customer data agent | `informations-agent/` | Reads the client's data: accounts, balances, transactions, cards. Read-only. |
| Security agent | `actions-agent/` | Changes data: blocks a card, transfers between the client's own accounts. Asks for confirmation before acting. |

Both are Python A2A servers built with LangChain `create_agent`, and both use the same SQLite file from `database/`. This plan doesn't cover the front agent's A2A client (its `TODO(A2A)`s). It only defines the contract that client will have to follow (see [A2A contract](#a2a-contract)).

```
                    ┌────────────────────────────┐
Client ── REST ──▶  │ bank-client-service (TS)   │
                    │  ask_informations_agent ───┼── A2A JSON-RPC ──▶ informations-agent :8001 ─┐ read-only
                    │  ask_actions_agent ────────┼── A2A JSON-RPC ──▶ actions-agent      :8002 ─┤ read-write
                    └────────────────────────────┘                                              ▼
                                                                                      database/bank.db
```

## Choices shared by both agents

These mirror `bank-client-service` wherever a Python equivalent exists.

| Concern | Choice | Why |
|---|---|---|
| Python | 3.12, managed with **uv** (`pyproject.toml`, `uv.lock`, `src/` layout), one `.venv/` per agent (`uv sync` in each folder) | `a2a-sdk` and `langchain` need ≥ 3.10 (the system has 3.9.6). One venv per agent keeps them deployable separately. |
| Comments | Very few in general; **detailed documentation for everything A2A** (executor, server, agent card, task states, contract) | As requested. |
| Agent | `langchain.agents.create_agent` (langchain 1.4) | Requested. It's the Python counterpart of `ToolLoopAgent`. |
| Model | `init_chat_model(LLM_MODEL, api_key=LLM_API_KEY)` with `LLM_MODEL=openai:gpt-5.5`, low reasoning effort | Same provider and vendor-neutral config keys as the front agent. The provider is chosen in one file (`model.py`). |
| A2A server | `a2a-sdk[http-server]` 1.2: `AgentExecutor` + `DefaultRequestHandler` + `InMemoryTaskStore`, Starlette app from `create_agent_card_routes` + `create_jsonrpc_routes`, run by uvicorn | In SDK 1.x, these route factories replace `A2AStarletteApplication`. JSON-RPC is the default binding. |
| Client identity | Read from the A2A message **metadata** (`client_id`), which the front agent's code sets. It's passed to LangChain as `context=ClientContext(client_id=...)`, and tools read it through `ToolRuntime[ClientContext]`. | Same rule as the front agent: the model never chooses whose data it touches. No tool takes a `client_id` argument, and every SQL query filters on it. |
| Conversation memory | LangGraph `InMemorySaver` checkpointer, with `thread_id` set to the A2A `context_id` | Follow-up questions work, and the actions agent can pause and resume around a confirmation. Like the front agent, memory is lost on restart. |
| Limits | `recursion_limit` per run, `ModelRetryMiddleware(max_retries=2)`, run timeout | The same roles as `maxStepsPerTurn`, `maxRetries` and `turnTimeoutMs` in the front agent. |
| DB access | stdlib `sqlite3`, parameterized SQL, no ORM | Four tables don't justify an ORM. |
| Config | `pydantic-settings` (`.env`, validated at startup) | Same role as `config.ts` with Zod: a bad config fails at startup, not on the first request. |
| Logs | stdlib `logging`, JSON lines | Kept simple. |
| Tests | `pytest`: tools against a temporary SQLite DB, and the executor with a fake chat model | Same role as Vitest with the AI SDK mock model. |
| Lint / format | `ruff` | |

The two agents are **fully independent projects**: each has its own `pyproject.toml`, `.venv/` and lock file, and shares no code with the other. The small duplicated pieces (`db.py`, `config.py`, `server.py`) are deliberate.

## `database/`

```
database/
├── README.md
├── schema.sql      # tables + constraints
├── seed.sql        # fictional demo data
├── init_db.py      # stdlib only: (re)creates bank.db from schema.sql + seed.sql
└── bank.db         # generated, git-ignored
```

```sql
CREATE TABLE clients (
  id          TEXT PRIMARY KEY,          -- e.g. 'c_001'
  full_name   TEXT NOT NULL
);

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,        -- e.g. 'a_001'
  client_id     TEXT NOT NULL REFERENCES clients(id),
  type          TEXT NOT NULL CHECK (type IN ('checking', 'savings')),
  iban          TEXT NOT NULL UNIQUE,
  balance_cents INTEGER NOT NULL         -- integer cents: no float rounding on money
);

CREATE TABLE cards (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  last4       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active', 'blocked'))
);

CREATE TABLE transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  amount_cents  INTEGER NOT NULL,        -- negative = debit
  label         TEXT NOT NULL,
  created_at    TEXT NOT NULL            -- ISO 8601 UTC
);
```

- Currency is always EUR, so there's no currency column.
- Seed data: 2 clients, each with a checking and a savings account, 1–2 cards, and about 10 transactions.
- Run with `python3 database/init_db.py`. It works on the system Python, with no dependencies.

## `informations-agent/` (read-only, port 8001)

```
informations-agent/
├── pyproject.toml
├── README.md
├── .env.example                 # LLM_MODEL, LLM_API_KEY, DATABASE_PATH, HOST, PORT, LOG_LEVEL
├── src/informations_agent/
│   ├── __init__.py
│   ├── __main__.py              # `uv run informations-agent` → uvicorn
│   ├── config.py                # Settings (pydantic-settings)
│   ├── logging.py
│   ├── server.py                # Starlette app: agent card route + JSON-RPC route
│   ├── agent_card.py            # AgentCard + AgentSkill list
│   ├── executor.py              # A2A AgentExecutor ↔ LangChain agent
│   ├── agent.py                 # create_agent(model, tools, system_prompt, context_schema, checkpointer, middleware)
│   ├── model.py                 # init_chat_model (the only provider-specific file)
│   ├── prompts.py               # SYSTEM_PROMPT (constant)
│   ├── context.py               # @dataclass ClientContext(client_id: str)
│   ├── db.py                    # read-only connection
│   └── tools.py
└── tests/
    ├── conftest.py              # temporary DB built from database/schema.sql + seed.sql
    ├── test_tools.py
    └── test_executor.py
```

**Tools** (each one is scoped to `runtime.context.client_id`):

| Tool | Args | Returns |
|---|---|---|
| `list_accounts` | none | id, type, masked IBAN, balance |
| `list_transactions` | `account_id`, `limit` (1–50, default 10) | latest transactions, newest first |
| `list_cards` | none | id, last4, status, linked account |

- If an `account_id` doesn't belong to the client, the result is "not found". It never says "forbidden", so it doesn't confirm that someone else's account exists.
- The connection opens `file:bank.db?mode=ro`, so the database itself rejects writes. That means the "read-only" guarantee doesn't rely on the prompt.
- The system prompt covers: answer only from tool results, amounts in EUR, no actions (say what the actions agent can do), and treat untrusted content as data. Replies are plain factual text, because the front agent rephrases them for the client.

**Executor flow:** read `client_id` from the metadata (if it's missing, the task fails). Run `agent.ainvoke(..., config={"configurable": {"thread_id": context_id}}, context=ClientContext(...))`. Publish the last AI message as a text artifact, then mark the task `completed`. A model or DB error marks the task `failed` with a generic message.

## `actions-agent/` (read-write, port 8002)

The layout is the same as `informations-agent`, with the package `actions_agent`. The differences are below.

**Tools:**

| Tool | Args | Effect |
|---|---|---|
| `list_cards` | none | Needed so the model can resolve "my Visa ending in 1234" to a card id. |
| `list_accounts` | none | Needed to resolve "from checking to savings". |
| `block_card` | `card_id` | `active` → `blocked`. Permanent, consistent with the knowledge base. |
| `transfer_between_own_accounts` | `from_account_id`, `to_account_id`, `amount_cents` | One SQLite transaction: checks the balance, updates both balances, and writes two `transactions` rows. |

**Confirmation before any write.** `HumanInTheLoopMiddleware(interrupt_on={"block_card": ..., "transfer_between_own_accounts": ...})` pauses the graph before a write tool runs. Because of that, an action can't happen without explicit approval, even if the model is manipulated.

1. The model calls `block_card(card_id="k_002")`, and the middleware interrupts.
2. The executor turns the interrupt into an A2A task in the **`input-required`** state. Its message is a readable summary built by our code from the DB, not by the model (e.g. "Block card ending 1234? This is permanent."). The data part carries the pending action.
3. The front agent asks the client and sends the answer in the **same `task_id` / `context_id`**: a data part `{"decision": "approve" | "reject"}`, plus an optional text part with the client's explanation (e.g. "no, I found the card").
4. The executor resumes the graph with `Command(resume={"decisions": [{"type": "approve"}]})` or `{"type": "reject", "message": <explanation>}`. On reject, the explanation goes to the model so it can answer appropriately (e.g. propose a different amount). The tool runs (or doesn't), and the task ends `completed`.

If the client's reply has no `decision` part, it counts as a rejection. Missing or unclear consent never triggers a write; the text alone is never read as consent.

Tools check ownership and preconditions again when they run (the card belongs to the client and isn't already blocked; both accounts belong to the client, they're different, the amount is > 0 and ≤ balance). They return a structured error that the model can explain.

## A2A contract

This is what the front agent's future tools must send:

- `message/send` to `http://localhost:8001/` or `:8002/`. The agent cards are at `/.well-known/agent-card.json`.
- `message.metadata.client_id`: set by the front agent's **code** from the authenticated client, never by its model. Until `TODO(auth)` is done, it's a demo id from config (`c_001`).
- `message.parts`: one text part with the natural-language request. For the actions agent's confirmation: a data part `{"decision": ...}` and an optional text part with the client's explanation.
- The front agent keeps each remote `context_id` / `task_id` in its conversation (its `conversationStore.ts` TODO already covers this).
- There's no authentication between agents yet. Both listen on localhost only (`TODO(auth)`).

## Build order

1. `database/`: schema, seed, `init_db.py`.
2. `informations-agent/`: project setup, tools and their tests, agent, executor, server. Smoke test with `curl` against the agent card and `message/send`.
3. `actions-agent/`: same steps, plus the confirmation flow and its tests (interrupt → `input-required` → approve or reject).
4. A README for each project: how to run it and an example JSON-RPC call.

## Decisions

1. The agents are fully independent, each with its own venv.
2. Confirmation is a structured decision plus optional explanation text.
3. Actions: `block_card` + `transfer_between_own_accounts`.
4. Tooling: uv + Python 3.12.

## Implementation notes (choices made while building)

- **`A2A-Version: 1.0` header required** on JSON-RPC calls. Without it, `a2a-sdk` assumes protocol 0.3. The 0.3 compatibility mode is left off, since `@a2a-js/sdk` ≥ 1.0 speaks 1.0.
- **LangGraph `thread_id` = `"<client_id>:<contextId>"`**, not just the context id: context ids come from the caller, so a reused id must not expose another client's history.
- **Invalid pending actions are auto-rejected** (they're never shown to the client), and the model explains the problem.
- **A new task in a context with a pending confirmation rejects that confirmation first** ("superseded"). A late reply to the old task gets `rejected`.
- A rejected confirmation still ends the task as `completed`, with the model's answer as the artifact. `rejected` is reserved for "refused before any work".
- Tests make no LLM calls (a fake chat model is used): informations-agent has 10, actions-agent has 14.

## Front agent integration (done)

`bank-client-service` now delegates to both agents over A2A (`@a2a-js/sdk` client): see `bank-client-service/A2A.md`. Confirmations go through Approve/Reject buttons in the UI, a `confirmation` field in the REST API, and an A2A `{ "decision" }` data part sent by code. The whole stack is launched with `./dev.sh` (see `README.md`).

The Python agents call OpenAI through the **Responses API** (`use_responses_api=True`): Chat Completions rejects tools combined with a reasoning effort on gpt-5.5.

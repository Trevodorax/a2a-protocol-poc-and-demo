# Actions agent

A2A agent that performs operations for one bank client: **block a card** and **transfer money between the client's own accounts**. Every operation is paused for **explicit confirmation** before it runs.

Built with LangChain `create_agent` (OpenAI by default) and its `HumanInTheLoopMiddleware`, served over A2A 1.0 (JSON-RPC) with `a2a-sdk`.

## Run

```bash
python3 ../database/init_db.py        # once (or to reset the data): creates ../database/bank.db
uv sync                               # creates .venv/ with the locked dependencies
cp .env.example .env                  # then set LLM_API_KEY
uv run actions-agent                  # http://127.0.0.1:8002
uv run pytest                         # no LLM calls: tests use a fake chat model
```

The settings are the same as for `informations-agent` (see its README), except the default port, which is `8002`.

## Layout

```
src/actions_agent/
├── __main__.py     # entry point (uvicorn)
├── config.py
├── server.py       # A2A: Starlette app, Agent Card + JSON-RPC routes
├── agent_card.py   # A2A: Agent Card (also describes the confirmation contract)
├── executor.py     # A2A: AgentExecutor, tasks and the input-required confirmation flow
├── agent.py        # create_agent + HumanInTheLoopMiddleware on the write tools
├── model.py
├── prompts.py
├── context.py
├── db.py
├── tools.py        # list_accounts, list_cards, block_card, transfer_between_own_accounts, describe_action
├── ui.py           # A2A: UI extension, the confirmation view as an MCP Apps file part
└── ui/
    └── confirmation.html  # the Approve/Reject card (MCP App view)
```

## A2A

### Endpoints and headers

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/agent-card.json` | Agent Card: skills, interface (URL + `JSONRPC` binding), modes (`text/plain`, `application/json`) |
| `POST /` | JSON-RPC 2.0: `SendMessage`, `GetTask`, `CancelTask`... |

Send **`A2A-Version: 1.0`** on every JSON-RPC call. Without it, the SDK assumes protocol 0.3, which this server doesn't accept.

### The confirmation flow

An operation takes **two `SendMessage` calls on the same task**. Between them, the task is in the A2A **`input-required`** state: paused, not finished, waiting for the caller.

```
caller (front agent)                           actions agent
  │ 1. SendMessage "I lost my card 4821"          │
  │ ────────────────────────────────────────────▶ │ model calls block_card → paused before it runs
  │ ◀──────────────────────────────────────────── │ task: TASK_STATE_INPUT_REQUIRED
  │      show the view to the client, ask         │   + summary text + confirmation_request data
  │                                               │   + confirmation view (MCP App)
  │ 2. SendMessage (same taskId + contextId)      │
  │    {"decision": "approve"} + optional text    │
  │ ────────────────────────────────────────────▶ │ resumed → tool runs → model answers
  │ ◀──────────────────────────────────────────── │ task: TASK_STATE_COMPLETED + "answer" artifact
```

**1. The request:**

```bash
curl -s localhost:8002/ -H 'content-type: application/json' -H 'A2A-Version: 1.0' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "SendMessage",
  "params": { "message": {
    "messageId": "m1", "role": "ROLE_USER",
    "parts": [{ "text": "I lost my card ending in 4821, block it" }],
    "metadata": { "client_id": "c_001" }
  }}
}'
```

**The response is a paused task:**

```json
{ "result": { "task": {
  "id": "T", "contextId": "C",
  "status": {
    "state": "TASK_STATE_INPUT_REQUIRED",
    "message": { "role": "ROLE_AGENT", "parts": [
      { "text": "Block the card ending in 4821. Blocking is permanent and cannot be undone." },
      { "data": {
          "type": "confirmation_request",
          "actions": [{ "name": "block_card", "args": { "card_id": "k_001" },
                        "summary": "Block the card ending in 4821. Blocking is permanent and cannot be undone." }],
          "reply_with": { "decision": ["approve", "reject"], "text": "optional client explanation" }
      }},
      { "raw": "<base64 HTML>", "mediaType": "text/html;profile=mcp-app", "filename": "confirmation.html",
        "metadata": { "uri": "ui://actions-agent/confirmation", "_meta": { "ui": { "prefersBorder": true } } } }
    ]}
  }
}}}
```

- The **text part** is the summary to show the client. It is built by our code from the database, not written by the model, so the client confirms exactly what will run.
- The **data part** (an A2A `data` part: structured JSON) is for the caller's code: the pending actions and how to reply.
- The **file part** is the confirmation card itself: an [MCP Apps](https://modelcontextprotocol.io) view (`src/actions_agent/ui/confirmation.html`) that the caller renders in a sandboxed iframe and feeds with the data part as `structuredContent`. Its Approve/Reject buttons call `tools/call` `reply_to_task { decision, comment? }` on the host, which sends the reply below. The Agent Card declares this as a **required** A2A extension (`src/actions_agent/ui.py`): callers send its URI in the `A2A-Extensions` header and must render the view.

**2. The reply** uses the same `taskId` and `contextId`, the same `client_id`, a **data part** with the decision, and optionally a text part with the client's own words:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "SendMessage", "params": { "message": {
  "messageId": "m2", "role": "ROLE_USER", "taskId": "T", "contextId": "C",
  "parts": [
    { "data": { "decision": "reject" } },
    { "text": "No, I found it in my car" }
  ],
  "metadata": { "client_id": "c_001" }
}}}
```

- `approve`: the operation runs, and the task ends `TASK_STATE_COMPLETED` with an `answer` artifact describing the result.
- `reject`: nothing runs. The explanation text goes to the model, which can take it into account (e.g. "I meant 50 EUR" → it explains that it can prepare a new transfer). The task ends `TASK_STATE_COMPLETED` with the model's answer.
- **No valid `decision` data part means a rejection.** Text alone ("yes", "oui") is never taken as consent: consent must be an explicit, structured choice made by the caller's code after asking the client.

### Other rules

- **Invalid actions are never shown to the client.** If the model requests an action that can't succeed (another client's card, a card that's already blocked, insufficient funds, the same account on both sides), the executor rejects it automatically, and the model reports the problem in its answer.
- **Superseded confirmations.** If the caller sends a new task in the same context (no `taskId`) while a confirmation is pending, the pending action is rejected first. A late reply to the old task then gets `TASK_STATE_REJECTED` ("No action is waiting for confirmation…").
- **Tools check everything again when they run** (ownership, card status, balance), and the debit is a single conditional `UPDATE` inside a transaction.
- **Client identity.** `metadata.client_id` is required on every message; without it, the task is `TASK_STATE_REJECTED`. It reaches the tools as LangChain runtime context and never goes through the model. The LangGraph thread is `"<client_id>:<contextId>"`, so the reply must carry the same `client_id` to find the paused run.
- **Restart.** Tasks and paused runs are kept in memory, so both are lost together on restart. A late approval then gets "task not found" and never runs an action nobody remembers.

| Final `status.state` | Meaning |
|---|---|
| `TASK_STATE_INPUT_REQUIRED` | Paused: waiting for the decision (not final) |
| `TASK_STATE_COMPLETED` | Done (operation executed, rejected or impossible; see the `answer` artifact) |
| `TASK_STATE_REJECTED` | Refused before any work: missing `client_id`, no text, or nothing left to confirm |
| `TASK_STATE_FAILED` | Error during the work (LLM unavailable, timeout after 90 s, step limit) |
| `TASK_STATE_CANCELED` | After `CancelTask` |

### Limitations

- No authentication between agents (`TODO(auth)`): the server listens on localhost only.
- No streaming and no push notifications. The Agent Card says so.
- Two concurrent messages in the same context aren't serialized.

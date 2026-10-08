# Informations agent

A2A agent that answers questions about one bank client's own data: accounts, balances, transactions and cards. It is **read-only**: the SQLite connection is opened with `mode=ro`, so the database itself refuses writes.

Built with LangChain `create_agent` (OpenAI by default), served over A2A 1.0 (JSON-RPC) with `a2a-sdk`.

## Run

```bash
python3 ../database/init_db.py        # once: creates ../database/bank.db
uv sync                               # creates .venv/ with the locked dependencies
cp .env.example .env                  # then set LLM_API_KEY
uv run informations-agent             # http://127.0.0.1:8001
uv run pytest                         # no LLM calls: tests use a fake chat model
```

| Variable | Default | |
|---|---|---|
| `LLM_MODEL` | (required) | `provider:model`, e.g. `openai:gpt-5.5` |
| `LLM_API_KEY` | (required) | |
| `DATABASE_PATH` | `../database/bank.db` | |
| `HOST` / `PORT` | `127.0.0.1` / `8001` | localhost only until agents authenticate each other |
| `PUBLIC_URL` | `http://127.0.0.1:8001` | URL advertised in the Agent Card |

## Layout

```
src/informations_agent/
├── __main__.py     # entry point (uvicorn)
├── config.py       # settings from env / .env
├── server.py       # A2A: Starlette app, Agent Card + JSON-RPC routes
├── agent_card.py   # A2A: Agent Card
├── executor.py     # A2A: AgentExecutor, bridges A2A tasks and the LangChain agent
├── agent.py        # create_agent: model, tools, prompt, middleware, checkpointer
├── model.py        # LLM provider
├── prompts.py
├── context.py      # ClientContext (runtime context given to tools)
├── db.py
└── tools.py        # list_accounts, list_transactions, list_cards
```

## A2A

### What A2A is used for here

[A2A](https://a2a-protocol.org) (Agent2Agent) is the protocol the front agent (`bank-client-service`) uses to delegate to this agent. Two endpoints matter:

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/agent-card.json` | **Agent Card**: name, skills, supported interfaces (URL + protocol binding), input/output modes. A client reads it to discover the agent. |
| `POST /` | **JSON-RPC 2.0** endpoint for every A2A method: `SendMessage`, `GetTask`, `CancelTask`... |

Every JSON-RPC call must send the header **`A2A-Version: 1.0`**. Without it, the SDK assumes protocol 0.3, which this server doesn't accept. The JS SDK (`@a2a-js/sdk` ≥ 1.0) sends it automatically.

### Request

```bash
curl -s localhost:8001/ -H 'content-type: application/json' -H 'A2A-Version: 1.0' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "SendMessage",
  "params": { "message": {
    "messageId": "9f1c…",
    "role": "ROLE_USER",
    "parts": [{ "text": "What is my balance?" }],
    "metadata": { "client_id": "c_001" }
  }}
}'
```

- `metadata.client_id` (required): whose data to read. The **caller's code** must set it from its authenticated session, never its LLM. It goes to the tools as LangChain runtime context, never through the model, so a prompt can't change it.
- `contextId` (optional): reuse the `contextId` of a previous answer to continue the same conversation. The agent then remembers earlier questions ("and the savings account?"). Without it, a new context is created.
- Don't send `taskId` for a new question: each question is a new task. This agent never pauses a task, so there is no task to continue.

### Response

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "task": {
  "id": "…", "contextId": "…",
  "status": { "state": "TASK_STATE_COMPLETED", "timestamp": "…" },
  "artifacts": [{ "artifactId": "…", "name": "answer", "parts": [{ "text": "Checking account (**** 0185): 1842.50 EUR. …" }] }],
  "history": [ … ]
}}}
```

The answer is the text of the `answer` **artifact** (an artifact is the result of a task). It is plain, factual English: the front agent rephrases it for the client.

| Final `status.state` | Meaning | `status.message` |
|---|---|---|
| `TASK_STATE_COMPLETED` | Answered, see the artifact | none |
| `TASK_STATE_REJECTED` | Refused before any work: missing `client_id` or no text | the reason |
| `TASK_STATE_FAILED` | Error during the work (LLM unavailable, timeout after 90 s, step limit) | generic message |

Protocol errors (malformed request, unknown task, missing version header) come back as a JSON-RPC `error` instead of a `result`.

### Inside the server

1. `DefaultRequestHandler` (SDK) receives `SendMessage`, creates a task id (and a context id if none was given), and calls `InformationsAgentExecutor.execute()`.
2. The executor publishes the `Task`, checks `client_id`, moves the task to `working`, and runs the LangChain agent with `thread_id = "<client_id>:<contextId>"`. Including the client id means a reused context id can never show one client another client's conversation.
3. The agent's last message becomes the `answer` artifact, and the task is set to `completed`.
4. Tasks (`InMemoryTaskStore`) and conversation memory (`InMemorySaver`) are kept in memory and lost on restart.

### Limitations

- No authentication between agents (`TODO(auth)`): anyone who can reach the port can claim any `client_id`. That's why the server listens on localhost only.
- No streaming and no push notifications. The Agent Card says so.
- Two concurrent messages in the same context aren't serialized.

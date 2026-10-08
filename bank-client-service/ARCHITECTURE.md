# Architecture

## Overview

A Node.js REST API where bank clients talk to an LLM agent (the **front agent**). It answers general questions from a written knowledge base, and **delegates over A2A** to two specialized Python agents for anything about the client's own accounts:

```
Client app (public/index.html)
   │  POST /api/v1/chat { message, conversationId? }
   │                  or { conversationId, confirmation: { decision, comment? } }
   ▼
Express (routes/chat.routes.ts)        ← body validation (Zod), client identity (middleware/clientIdentity.ts)
   │
   ▼
BankAgent (agent/bankAgent.ts)         ← conversation, limits, confirmations, error mapping
   │        ▲
   │        │ history + A2A state (context ids, pending confirmation)
   │   ConversationStore (in memory)
   ▼
AI SDK ToolLoopAgent                   ← model ⇄ tools loop
   │
   ├── OpenAI (Responses API)          ← model from LLM_MODEL (agent/model.ts)
   │
   ├── search_knowledge_base ─────────────────────────────▶ knowledgeBase.ts
   ├── ask_informations_agent ─▶ a2a/remoteAgent.ts ── A2A ──▶ informations-agent (Python, :8001) ─┐ read-only
   └── ask_actions_agent ──────▶ a2a/remoteAgent.ts ── A2A ──▶ actions-agent      (Python, :8002) ─┤ read-write
                                                                                              database/bank.db
```

See [A2A.md](A2A.md) for a full guide to the A2A side: protocol, wire format, confirmation flow, and failure handling.

## Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 24, TypeScript (strict, ESM) |
| HTTP | Express 5 |
| Validation | Zod (request bodies, tool inputs, tool context) |
| LLM | Vercel AI SDK (`ai`): `ToolLoopAgent` + `tool()`, OpenAI provider (`@ai-sdk/openai`); model from `LLM_MODEL` |
| Agent-to-agent | A2A 1.0 over JSON-RPC with `@a2a-js/sdk` (client only) |
| Logs | pino (JSON) |
| Tests | Vitest + supertest (AI SDK mock model, fake remote agents) |

## Project layout

```
src/
├── server.ts               # wiring: config, remote agents, LLM agent, HTTP server
├── app.ts                  # Express app (testable without listening)
├── config.ts               # env vars, validated (incl. A2A agent URLs, demo client id)
├── errors.ts               # AppError → HTTP status
├── logger.ts
├── middleware/
│   ├── clientIdentity.ts   # who the client is (demo stand-in, TODO(auth))
│   └── errorHandler.ts
├── routes/chat.routes.ts   # POST /api/v1/chat (message or confirmation)
├── a2a/
│   └── remoteAgent.ts      # A2A client for one remote agent: discovery, SendMessage, task → outcome
└── agent/
    ├── bankAgent.ts        # runs one client turn, or one confirmation
    ├── systemPrompt.ts     # role, routing and rules
    ├── knowledgeBase.ts    # bank articles + search
    ├── conversationStore.ts
    ├── model.ts            # LLM provider (the only provider-specific file)
    └── tools/
        ├── index.ts        # tool set
        ├── faq.ts          # search_knowledge_base
        └── remoteAgents.ts # ask_informations_agent, ask_actions_agent (A2A delegation)
public/
└── index.html              # static chat UI with Approve/Reject buttons, served at / (no build step)
```

Only `agent/` knows about the LLM, and only `a2a/` knows about the A2A protocol. The HTTP layer depends on the `ClientServiceAgent` interface, and the tools depend on the `RemoteAgent` interface, so both can be replaced or mocked.

## Request lifecycle

**A client message** (`{ message, conversationId? }`):

1. The identity middleware sets the client id. The route validates the body and calls `agent.ask()`.
2. The agent loads the conversation, checking that it belongs to this client, or creates one with fresh A2A context ids. It marks the conversation busy; a second concurrent request on it gets a `409`.
3. The `ToolLoopAgent` calls the model with the tools, the system prompt, the history and the new message. For each tool the model requests, the agent runs it and calls the model again, up to 6 steps:
   - `search_knowledge_base`: a local search.
   - `ask_informations_agent` / `ask_actions_agent`: an A2A `SendMessage` to the remote agent. The client id and context id come from the call options set by our code, never from the model.
4. If the turn ended normally with text, the new messages are appended to the history.
   - If the actions agent paused an operation in this turn, the remote task id is stored as the pending confirmation, and the reply is `status: "confirmation_required"` with the summary.
   - Otherwise the reply is `status: "answered"`, and any earlier pending confirmation is dropped.
5. Otherwise (content filtered, step cap, truncated output), a fixed bilingual message is returned (`status: "fallback"`), and the history and pending confirmation are left unchanged.
6. LLM errors become `503` after the SDK's own retries. Remote agent errors don't fail the turn: they reach the model as tool errors.

**A confirmation** (`{ conversationId, confirmation: { decision, comment? } }`, sent by the Approve/Reject buttons):

1. The agent checks that an operation is pending (`409` otherwise).
2. Our code sends the decision to the paused A2A task: same task id, a `data` part `{ decision }`, and the comment as `text`.
3. The outcome is given to the model as a `[Bank app]` note, and the model tells the client what happened, in their language.

## Key design decisions

| Decision | Why |
|---|---|
| **Remote agents are tools** | The ToolLoopAgent already handles "delegate → wait → continue". The model decides when to delegate and rephrases the answer; the code decides for whom. |
| **Client id and A2A context ids are set by code** (`callOptionsSchema` + `prepareCall` → tool `context`) | A prompt injection can't make the model query another client's data or join another conversation. No tool input contains an id. |
| **The caller chooses the A2A context ids** (one per conversation per remote agent) | A2A allows it. Each remote agent's memory then follows our conversation, and there's nothing to learn back from responses. |
| **Consent is a UI action, not text** | Operations run only after a click on Approve, sent as a structured field and forwarded as A2A `{ decision }` by code. The model can't produce a decision, so it can't approve anything on the client's behalf. |
| **The remote task id is hidden from the model** (`toModelOutput`) | It has no use for it, and less to leak or to hallucinate. |
| **The confirmation summary comes from the actions agent's database lookup** | The client confirms what will actually run, not the model's paraphrase. |
| **Remote failures become tool errors** | The model can still help (e.g. give the emergency line for a stolen card) instead of the whole turn failing. |
| **Knowledge base behind a tool**, not in the prompt | The prompt stays small and cacheable, the base can grow, and answers can be traced to the articles retrieved. |
| **Constant system prompt and tool list** | Prompt caching works on exact prefixes (tools → system → messages). Per-request data goes through call options, never into definitions. |
| **History kept on the server, append-only** | Clients can't forge earlier turns; reasoning content and caching need an unchanged prefix. |
| **A failed turn isn't committed** | After a failure, the conversation returns to its last good state, so the client can simply retry. |
| **Low reasoning effort, 6 steps max, 120 s per turn** | Routing and rephrasing are simple. The cap stops runaway loops, and the timeout leaves room for a remote agent's own LLM loop. |

## Current limitations

- **No authentication** (`TODO(auth)`): every request acts as `DEMO_CLIENT_ID`, and the A2A agents trust the `client_id` they receive. They listen on localhost only.
- Client questions are sent to OpenAI by this service and by both Python agents: validate data processing terms with compliance before handling real client data.
- Conversations, remote tasks and paused operations are kept in memory: they are lost on restart (a late approval after a restart is refused, never executed).
- The knowledge base is static, with naive keyword search.
- No streaming: the client receives the full answer at once.

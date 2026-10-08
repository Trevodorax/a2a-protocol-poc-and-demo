# Bank client service

The **front agent** of the POC: a REST API and chat UI where bank clients talk to an LLM agent (OpenAI, via the Vercel AI SDK). It answers general questions from a knowledge base, and **delegates over A2A** to two Python agents for the client's own data and operations:

- `informations-agent`: accounts, balances, transactions, cards (read-only);
- `actions-agent`: block a card, transfer between the client's own accounts (always after the client's confirmation).

## Features

- `POST /api/v1/chat` with `{ message, conversationId? }`: ask anything; send back the returned `conversationId` to continue the conversation.
- General bank questions (fees, rates, procedures, hours, contacts) are answered from a written knowledge base.
- Questions about the client's accounts go to the informations agent over A2A.
- Card blocking and internal transfers go to the actions agent over A2A. They only run after the client clicks **Approve**: the reply has `status: "confirmation_required"` and `confirmation.summary`, and the UI sends `POST /api/v1/chat` with `{ conversationId, confirmation: { decision: "approve" | "reject", comment? } }`.
- Built-in guardrails: replies in the client's language, never asks for a PIN or secret codes, no investment, tax or legal advice, resists prompt injection. The client's identity is never chosen by the model.
- If the agent can't answer, the client gets a safe fixed message that points to a human contact. If a remote agent is down, the agent says so and offers alternatives.
- Minimal full-screen chat UI at `/` (`public/index.html`), with Approve/Reject buttons.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [A2A.md](A2A.md) for everything about A2A.

## Run

To start everything (database, both Python agents, this service), use `../dev.sh`: see the [root README](../README.md).

To run this service alone (it starts even if the Python agents are down; delegations then fail gracefully):

```bash
npm install
cp .env.example .env   # then set LLM_API_KEY (your OpenAI key), and the agents' URLs if not the defaults
npm run dev            # chat UI at http://localhost:3000
npm test               # no LLM or network calls: mock model and fake remote agents
```

| Variable | Default | |
|---|---|---|
| `LLM_MODEL` | (required) | e.g. `gpt-5.5` |
| `LLM_API_KEY` | (required) | |
| `INFORMATIONS_AGENT_URL` | `http://127.0.0.1:8001` | Base URL; the Agent Card is read from `/.well-known/agent-card.json` |
| `ACTIONS_AGENT_URL` | `http://127.0.0.1:8002` | Same |
| `DEMO_CLIENT_ID` | `c_001` | Every request acts as this client until authentication exists (`TODO(auth)`) |

```bash
curl -X POST localhost:3000/api/v1/chat -H 'content-type: application/json' \
  -d '{"message":"Quel est le solde de mes comptes ?"}'
# → { "conversationId": "…", "answer": "…", "status": "answered" | "confirmation_required" | "fallback", "confirmation"?: { "summary": "…" } }
```

## Next steps

1. **Authentication**: identify the client from a verified token, and authenticate this service to the A2A agents (`TODO(auth)`).
2. **Persistent conversations**: move the conversation store (and the A2A agents' task stores) to Redis or a database.
3. **Real knowledge base**: load the bank's actual content, and use a proper search engine or vector search.
4. **Evaluation**: build a set of real client questions to measure answer quality and routing before tuning the prompt or the effort setting.
5. **Streaming** (optional): stream answers over SSE, and use A2A streaming for long delegations.

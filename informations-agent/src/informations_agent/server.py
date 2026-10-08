"""HTTP server exposing the agent over A2A.

Since a2a-sdk 1.0 there is no ready-made application class (`A2AStarletteApplication` was removed):
the SDK provides route factories that we mount on our own Starlette app.

- `create_agent_card_routes(card)`: `GET /.well-known/agent-card.json`, the discovery document.
- `create_jsonrpc_routes(handler, rpc_url="/")`: `POST /`, the JSON-RPC 2.0 endpoint for every A2A
  method (`SendMessage`, `GetTask`, `CancelTask`, ...). Its URL must match the one advertised in the
  Agent Card's `supported_interfaces`.

`DefaultRequestHandler` implements those methods on top of our `AgentExecutor`:
- it creates or loads the task, runs `execute()`, consumes the events it publishes and keeps the
  task up to date;
- `InMemoryTaskStore` keeps tasks in memory, so `GetTask` works for tasks created since the last
  restart. Our conversation memory (LangGraph checkpointer) is in memory too, so both are lost
  together on restart, which keeps them consistent.
"""

import contextlib
import sqlite3

from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from langgraph.checkpoint.memory import InMemorySaver
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from informations_agent.agent import build_agent
from informations_agent.agent_card import build_agent_card
from informations_agent.config import Settings
from informations_agent.db import connect_read_only
from informations_agent.executor import InformationsAgentExecutor
from informations_agent.model import create_chat_model


def create_app(settings: Settings, *, conn: sqlite3.Connection | None = None, model=None) -> Starlette:
    conn = conn or connect_read_only(settings.database_path)
    agent = build_agent(model or create_chat_model(settings), conn, InMemorySaver())

    agent_card = build_agent_card(settings.public_url)
    handler = DefaultRequestHandler(
        agent_executor=InformationsAgentExecutor(agent),
        task_store=InMemoryTaskStore(),
        agent_card=agent_card,
    )

    @contextlib.asynccontextmanager
    async def lifespan(_app: Starlette):
        yield
        conn.close()

    return Starlette(
        routes=[
            Route("/health", lambda _request: JSONResponse({"status": "ok"})),
            *create_agent_card_routes(agent_card),
            *create_jsonrpc_routes(handler, rpc_url="/"),
        ],
        lifespan=lifespan,
    )

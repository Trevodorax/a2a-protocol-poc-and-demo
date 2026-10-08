import sqlite3
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, BaseMessage

from actions_agent.config import Settings
from actions_agent.db import connect
from actions_agent.server import create_app

DATABASE_DIR = Path(__file__).parents[2] / "database"


class FakeToolModel(GenericFakeChatModel):
    calls: list[list[BaseMessage]] = []

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, *args, **kwargs):
        self.calls.append(list(messages))
        return super()._generate(messages, *args, **kwargs)


def tool_call(name: str, args: dict | None = None, call_id: str = "call_1") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args or {}, "id": call_id}])


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    path = tmp_path / "bank.db"
    with sqlite3.connect(path) as setup:
        setup.executescript((DATABASE_DIR / "schema.sql").read_text())
        setup.executescript((DATABASE_DIR / "seed.sql").read_text())
    conn = connect(path)
    yield conn
    conn.close()


@pytest.fixture
def make_client(conn: sqlite3.Connection, tmp_path: Path):
    def _make(model: FakeToolModel) -> httpx.AsyncClient:
        settings = Settings(llm_model="openai:test", llm_api_key="test", database_path=tmp_path / "bank.db")
        app = create_app(settings, conn=conn, model=model)
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test", headers={"A2A-Version": "1.0"}
        )

    return _make


def fake_model(*responses: AIMessage) -> FakeToolModel:
    return FakeToolModel(messages=iter(responses), calls=[])


def send_message(
    text: str | None = None,
    *,
    data: dict | None = None,
    client_id: str | None = "c_001",
    task: dict | None = None,
    context_id: str | None = None,
) -> dict:
    parts: list[dict] = []
    if text:
        parts.append({"text": text})
    if data:
        parts.append({"data": data})
    message: dict = {"messageId": f"m-{id(parts)}", "role": "ROLE_USER", "parts": parts}
    if client_id:
        message["metadata"] = {"client_id": client_id}
    if task:
        message["taskId"] = task["id"]
        message["contextId"] = task["contextId"]
    if context_id:
        message["contextId"] = context_id
    return {"jsonrpc": "2.0", "id": 1, "method": "SendMessage", "params": {"message": message}}


async def post(client: httpx.AsyncClient, body: dict) -> dict:
    response = (await client.post("/", json=body)).json()
    assert "result" in response, response
    return response["result"]["task"]

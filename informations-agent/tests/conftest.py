import sqlite3
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from informations_agent.config import Settings
from informations_agent.db import connect_read_only
from informations_agent.server import create_app

DATABASE_DIR = Path(__file__).parents[2] / "database"


class FakeToolModel(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def tool_call(name: str, args: dict | None = None, call_id: str = "call_1") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args or {}, "id": call_id}])


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    path = tmp_path / "bank.db"
    with sqlite3.connect(path) as conn:
        conn.executescript((DATABASE_DIR / "schema.sql").read_text())
        conn.executescript((DATABASE_DIR / "seed.sql").read_text())
    return path


@pytest.fixture
def conn(db_path: Path) -> Iterator[sqlite3.Connection]:
    conn = connect_read_only(db_path)
    yield conn
    conn.close()


@pytest.fixture
def make_client(db_path: Path, conn: sqlite3.Connection):
    def _make(responses: list[AIMessage]) -> httpx.AsyncClient:
        settings = Settings(llm_model="openai:test", llm_api_key="test", database_path=db_path)
        app = create_app(settings, conn=conn, model=FakeToolModel(messages=iter(responses)))
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test", headers={"A2A-Version": "1.0"}
        )

    return _make


def send_message(text: str, *, client_id: str | None = "c_001", context_id: str | None = None) -> dict:
    message: dict = {"messageId": "m1", "role": "ROLE_USER", "parts": [{"text": text}]}
    if client_id:
        message["metadata"] = {"client_id": client_id}
    if context_id:
        message["contextId"] = context_id
    return {"jsonrpc": "2.0", "id": 1, "method": "SendMessage", "params": {"message": message}}

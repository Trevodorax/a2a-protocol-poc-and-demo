import json
import sqlite3

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver

from informations_agent.agent import build_agent
from informations_agent.context import ClientContext
from tests.conftest import FakeToolModel, tool_call


async def run_tool(conn, name: str, args: dict | None = None, client_id: str = "c_001") -> dict:
    model = FakeToolModel(messages=iter([tool_call(name, args), AIMessage(content="done")]))
    agent = build_agent(model, conn, InMemorySaver())
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "?"}]},
        config={"configurable": {"thread_id": "t"}},
        context=ClientContext(client_id=client_id),
    )
    tool_message = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    return json.loads(tool_message.content)


async def test_list_accounts_returns_only_the_clients_accounts(conn):
    result = await run_tool(conn, "list_accounts")
    assert [a["account_id"] for a in result["accounts"]] == ["a_001", "a_002"]
    assert result["accounts"][0] == {
        "account_id": "a_001",
        "type": "checking",
        "iban": "**** 0185",
        "balance": "1842.50 EUR",
    }


async def test_list_transactions_newest_first_with_limit(conn):
    result = await run_tool(conn, "list_transactions", {"account_id": "a_001", "limit": 2})
    assert result["status"] == "ok"
    assert [t["label"] for t in result["transactions"]] == ["Transfer to savings", "Restaurant"]
    assert result["transactions"][0]["amount"] == "-642.31 EUR"


async def test_list_transactions_of_another_clients_account_is_not_found(conn):
    result = await run_tool(conn, "list_transactions", {"account_id": "a_003"})
    assert result == {"status": "not_found", "account_id": "a_003"}


async def test_list_cards(conn):
    result = await run_tool(conn, "list_cards", client_id="c_002")
    assert result["cards"] == [
        {"card_id": "k_003", "last4": "1234", "status": "active", "account_id": "a_003"}
    ]


def test_connection_is_read_only(conn):
    with pytest.raises(sqlite3.OperationalError, match="readonly"):
        conn.execute("UPDATE cards SET status = 'blocked'")

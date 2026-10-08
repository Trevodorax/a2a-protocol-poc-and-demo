from langchain_core.messages import AIMessage, ToolMessage

from tests.conftest import fake_model, post, send_message, tool_call


def card_status(conn, card_id: str) -> str:
    return conn.execute("SELECT status FROM cards WHERE id = ?", (card_id,)).fetchone()["status"]


def balance(conn, account_id: str) -> int:
    return conn.execute("SELECT balance_cents FROM accounts WHERE id = ?", (account_id,)).fetchone()[
        "balance_cents"
    ]


async def test_block_card_waits_for_approval_then_runs(make_client, conn):
    model = fake_model(
        tool_call("block_card", {"card_id": "k_001"}), AIMessage(content="Card 4821 is blocked.")
    )
    async with make_client(model) as client:
        task = await post(client, send_message("I lost my card ending in 4821"))

        assert task["status"]["state"] == "TASK_STATE_INPUT_REQUIRED"
        text_part, data_part = task["status"]["message"]["parts"]
        assert "ending in 4821" in text_part["text"]
        assert data_part["data"]["actions"][0]["name"] == "block_card"
        assert card_status(conn, "k_001") == "active"

        task = await post(client, send_message(data={"decision": "approve"}, task=task))

    assert task["status"]["state"] == "TASK_STATE_COMPLETED"
    assert task["artifacts"][0]["parts"][0]["text"] == "Card 4821 is blocked."
    assert card_status(conn, "k_001") == "blocked"


async def test_transfer_approved_moves_money_and_records_transactions(make_client, conn):
    args = {"from_account_id": "a_001", "to_account_id": "a_002", "amount_cents": 10000}
    model = fake_model(tool_call("transfer_between_own_accounts", args), AIMessage(content="Done."))
    async with make_client(model) as client:
        task = await post(client, send_message("Move 100 EUR to my savings"))
        assert (
            "Transfer 100.00 EUR from the checking account" in task["status"]["message"]["parts"][0]["text"]
        )
        task = await post(client, send_message(data={"decision": "approve"}, task=task))

    assert task["status"]["state"] == "TASK_STATE_COMPLETED"
    assert (balance(conn, "a_001"), balance(conn, "a_002")) == (174250, 1260000)
    assert (
        conn.execute("SELECT COUNT(*) FROM transactions WHERE label LIKE 'Internal transfer%'").fetchone()[0]
        == 2
    )


async def test_rejection_with_explanation_is_passed_to_the_model(make_client, conn):
    args = {"from_account_id": "a_001", "to_account_id": "a_002", "amount_cents": 10000}
    model = fake_model(tool_call("transfer_between_own_accounts", args), AIMessage(content="Cancelled."))
    async with make_client(model) as client:
        task = await post(client, send_message("Move 100 EUR to my savings"))
        task = await post(client, send_message("I meant 50 EUR", data={"decision": "reject"}, task=task))

    assert task["status"]["state"] == "TASK_STATE_COMPLETED"
    assert balance(conn, "a_001") == 184250
    tool_result = next(m for m in model.calls[-1] if isinstance(m, ToolMessage))
    assert "declined" in tool_result.text and "I meant 50 EUR" in tool_result.text


async def test_free_text_yes_is_not_consent(make_client, conn):
    model = fake_model(tool_call("block_card", {"card_id": "k_001"}), AIMessage(content="Not blocked."))
    async with make_client(model) as client:
        task = await post(client, send_message("Block card 4821"))
        task = await post(client, send_message("yes", task=task))

    assert task["status"]["state"] == "TASK_STATE_COMPLETED"
    assert card_status(conn, "k_001") == "active"


async def test_invalid_action_is_rejected_without_asking_the_client(make_client, conn):
    model = fake_model(
        tool_call("block_card", {"card_id": "k_003"}),
        AIMessage(content="I couldn't find that card."),
    )
    async with make_client(model) as client:
        task = await post(client, send_message("Block card 1234"))

    assert task["status"]["state"] == "TASK_STATE_COMPLETED"
    assert card_status(conn, "k_003") == "active"


async def test_new_request_supersedes_a_pending_confirmation(make_client, conn):
    model = fake_model(
        tool_call("block_card", {"card_id": "k_001"}),
        AIMessage(content="Not blocked."),
        AIMessage(content="Hello."),
    )
    async with make_client(model) as client:
        pending = await post(client, send_message("Block card 4821"))
        task = await post(client, send_message("Actually, never mind", context_id=pending["contextId"]))
        late_approval = await post(client, send_message(data={"decision": "approve"}, task=pending))

    assert task["status"]["state"] == "TASK_STATE_COMPLETED"
    assert task["artifacts"][0]["parts"][0]["text"] == "Hello."
    assert late_approval["status"]["state"] == "TASK_STATE_REJECTED"
    assert card_status(conn, "k_001") == "active"


async def test_message_without_client_id_is_rejected(make_client):
    async with make_client(fake_model()) as client:
        task = await post(client, send_message("Block my card", client_id=None))

    assert task["status"]["state"] == "TASK_STATE_REJECTED"

from langchain_core.messages import AIMessage

from tests.conftest import send_message, tool_call


async def test_agent_card_is_served(make_client):
    async with make_client([]) as client:
        card = (await client.get("/.well-known/agent-card.json")).json()
    assert card["name"] == "Atlas Bank informations agent"
    assert card["supportedInterfaces"][0]["protocolBinding"] == "JSONRPC"


async def test_send_message_completes_with_an_answer_artifact(make_client):
    responses = [tool_call("list_accounts"), AIMessage(content="Checking: 1842.50 EUR.")]
    async with make_client(responses) as client:
        response = (await client.post("/", json=send_message("What is my balance?"))).json()

    task = response["result"]["task"]
    assert task["status"]["state"] == "TASK_STATE_COMPLETED"
    assert task["artifacts"][0]["parts"][0]["text"] == "Checking: 1842.50 EUR."


async def test_follow_up_continues_the_same_context(make_client):
    responses = [AIMessage(content="Hello."), AIMessage(content="Still here.")]
    async with make_client(responses) as client:
        first = (await client.post("/", json=send_message("Hi"))).json()["result"]["task"]
        second = (await client.post("/", json=send_message("Again", context_id=first["contextId"]))).json()

    assert second["result"]["task"]["contextId"] == first["contextId"]
    assert second["result"]["task"]["artifacts"][0]["parts"][0]["text"] == "Still here."


async def test_message_without_client_id_is_rejected(make_client):
    async with make_client([]) as client:
        response = (await client.post("/", json=send_message("Balance?", client_id=None))).json()

    status = response["result"]["task"]["status"]
    assert status["state"] == "TASK_STATE_REJECTED"
    assert "client_id" in status["message"]["parts"][0]["text"]


async def test_model_error_fails_the_task(make_client):
    async with make_client([]) as client:
        response = (await client.post("/", json=send_message("Balance?"))).json()

    assert response["result"]["task"]["status"]["state"] == "TASK_STATE_FAILED"

"""A2A Agent Card of the informations agent.

The Agent Card is the agent's public "business card" in the A2A protocol. It is served as JSON at
`/.well-known/agent-card.json` (see server.py), and a client agent reads it to discover:

- who the agent is (`name`, `description`, `version`);
- where and how to talk to it (`supported_interfaces`): since A2A 1.0, the endpoint URL lives in an
  `AgentInterface` together with its protocol binding (JSONRPC, HTTP+JSON or GRPC). This agent only
  exposes JSON-RPC, on the root path of `public_url`;
- what it supports (`capabilities`): no streaming (answers are short and the front agent waits for
  the full answer anyway), no push notifications (every request is answered synchronously);
- which content types it accepts and returns (`default_input_modes` / `default_output_modes`);
- what it can do (`skills`): free-text descriptions with examples. They are meant for the calling
  agent's LLM (or developer) to decide when to delegate here. They are documentation, not routing:
  the agent receives a plain message, never a skill id.

The card advertises no `security_schemes` yet: there is no authentication between agents
(TODO(auth)), which is why the server only listens on localhost by default.
"""

from a2a.types import AgentCapabilities, AgentCard, AgentInterface, AgentSkill
from a2a.utils.constants import PROTOCOL_VERSION_1_0, TransportProtocol


def build_agent_card(public_url: str) -> AgentCard:
    return AgentCard(
        name="Atlas Bank informations agent",
        description=(
            "Read-only access to one bank client's data: accounts, balances, transactions and cards. "
            "The client is identified by `client_id` in the message metadata, set by the calling agent."
        ),
        version="0.1.0",
        supported_interfaces=[
            AgentInterface(
                url=public_url,
                protocol_binding=TransportProtocol.JSONRPC.value,
                protocol_version=PROTOCOL_VERSION_1_0,
            )
        ],
        capabilities=AgentCapabilities(streaming=False, push_notifications=False),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        skills=[
            AgentSkill(
                id="accounts_and_balances",
                name="Accounts and balances",
                description="Lists the client's accounts (checking, savings) with masked IBAN and balance.",
                tags=["accounts", "balance"],
                examples=["What is my current balance?", "How much is on my savings account?"],
            ),
            AgentSkill(
                id="transactions",
                name="Transactions",
                description="Lists the latest transactions of one of the client's accounts.",
                tags=["transactions", "history"],
                examples=["What were my last 5 payments?", "Did my salary arrive?"],
            ),
            AgentSkill(
                id="cards",
                name="Cards",
                description="Lists the client's cards with their last 4 digits and status (active or blocked).",
                tags=["cards"],
                examples=["Is my card ending in 4821 blocked?"],
            ),
        ],
    )

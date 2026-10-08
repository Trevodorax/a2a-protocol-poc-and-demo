"""A2A Agent Card of the actions agent.

The Agent Card is the agent's public "business card" in the A2A protocol. It is served as JSON at
`/.well-known/agent-card.json` (see server.py), and a client agent reads it to discover:

- who the agent is (`name`, `description`, `version`);
- where and how to talk to it (`supported_interfaces`): since A2A 1.0, the endpoint URL lives in an
  `AgentInterface` together with its protocol binding (JSONRPC, HTTP+JSON or GRPC). This agent only
  exposes JSON-RPC, on the root path of `public_url`;
- what it supports (`capabilities`): no streaming, no push notifications. A confirmation round trip
  is handled with the `input-required` task state over plain request/response calls;
- which content types it accepts and returns: text, plus `application/json` for the structured
  confirmation request and the caller's decision (A2A data parts);
- what it can do (`skills`): descriptions with examples, meant for the calling agent to decide when
  to delegate here. They are documentation, not routing: the agent receives a plain message.

The confirmation contract is also described in the card's description, so a caller that only reads
the card knows that write actions pause the task until it sends `{"decision": "approve" | "reject"}`.

The card advertises no `security_schemes` yet: there is no authentication between agents
(TODO(auth)), which is why the server only listens on localhost by default.
"""

from a2a.types import AgentCapabilities, AgentCard, AgentInterface, AgentSkill
from a2a.utils.constants import PROTOCOL_VERSION_1_0, TransportProtocol


def build_agent_card(public_url: str) -> AgentCard:
    return AgentCard(
        name="Atlas Bank actions agent",
        description=(
            "Performs operations for one bank client: block a card, transfer between the client's own accounts. "
            "The client is identified by `client_id` in the message metadata, set by the calling agent. "
            "Every operation pauses the task in `input-required` with a summary to show the client; reply on the "
            'same task with a data part {"decision": "approve" | "reject"} and an optional text explanation.'
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
        default_input_modes=["text/plain", "application/json"],
        default_output_modes=["text/plain", "application/json"],
        skills=[
            AgentSkill(
                id="block_card",
                name="Block a card",
                description="Permanently blocks one of the client's cards (lost, stolen, suspected fraud). Requires confirmation.",
                tags=["cards", "security", "fraud"],
                examples=["I lost my card ending in 4821, block it.", "Someone used my card, block it now."],
            ),
            AgentSkill(
                id="internal_transfer",
                name="Transfer between own accounts",
                description="Moves money between two accounts of the same client. Requires confirmation.",
                tags=["transfer", "accounts"],
                examples=["Move 200 EUR from my checking to my savings account."],
            ),
        ],
    )

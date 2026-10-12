"""Bridge between the A2A protocol and the LangChain agent, including the confirmation flow.

How an A2A request reaches this code
------------------------------------
1. The calling agent sends a JSON-RPC `SendMessage` request to the endpoint advertised in the Agent
   Card. Its body is a `Message`: a role (`user`), `parts` (text and/or structured data), optional
   `metadata`, and optionally the `context_id` / `task_id` of an earlier exchange.
2. The SDK's `DefaultRequestHandler` (see server.py) loads the existing task from the `TaskStore`
   when `task_id` is given, builds a `RequestContext`, and calls `execute()` with an `EventQueue`.
3. `execute()` publishes events (the `Task`, status updates, artifacts) instead of returning a
   value. The handler applies them to the task and answers the HTTP request with the task as it
   stands when `execute()` returns.

A2A vocabulary used here
------------------------
- Task: one unit of work. Its status moves `submitted` -> `working` -> a terminal state
  (`completed`, `failed`, `rejected`, `canceled`) or an *interrupted* state. The SDK requires the
  first event of a new task to be the `Task` object itself.
- `input-required`: the interrupted state used here. The task is paused, not finished: the caller
  must answer with a new message carrying the **same `task_id`** (and `context_id`), and the SDK
  then calls `execute()` again on that task.
- Context (`context_id`): groups the tasks of one conversation. It is used (with the client id) as
  the LangGraph `thread_id`, so the agent's memory and paused runs are scoped to one conversation of
  one client: a context id reused with another client_id never sees the first client's state.
- Artifact: the result of a task (here, one text part with the agent's answer). The status message
  explains the state (the confirmation request, or why the task failed or was rejected).
- Extension: an addition to the protocol, advertised in the Agent Card and requested by the caller in
  the `A2A-Extensions` header. This agent's UI extension is required: every confirmation request
  carries the confirmation card as an MCP Apps HTML view (see ui.py).

Confirmation flow (write actions only)
--------------------------------------
LangChain's `HumanInTheLoopMiddleware` (agent.py) pauses the run *before* `block_card` or
`transfer_between_own_accounts` executes: the LangGraph run stops on an interrupt, saved by the
checkpointer. A write can only happen after an explicit approval, whatever the model says.

    caller                                    actions agent
      | SendMessage "block my card 4821"        |
      | --------------------------------------> | model calls block_card -> run interrupted
      | task: input-required                    |
      |   text: "Block the card ending in 4821. |
      |          Blocking is permanent..."      |
      |   data: {"type": "confirmation_request",|
      |          "actions": [...]}              |
      |   file: confirmation view (MCP App)     |
      | <-------------------------------------- |
      | SendMessage (same task_id)              |
      |   data: {"decision": "approve"}         |
      |   text: optional client explanation     |
      | --------------------------------------> | run resumed -> tool runs -> model answers
      | task: completed, artifact: answer       |
      | <-------------------------------------- |

- The summary shown to the client is built by our code from the database (`describe_action`), not
  written by the model, so the client confirms what will actually run.
- A pending action that can't succeed (unknown card, insufficient funds...) is rejected
  automatically and sent back to the model, so the client is never asked to confirm it.
- The reply's `decision` must be a data part. Text alone is never read as consent: "yes" in free text
  could come from a misunderstanding or a prompt injection upstream. A reply without a valid
  decision counts as a rejection. The optional text is passed to the model as the client's
  explanation (e.g. "no, transfer 100 instead").
- One decision applies to every action of the pending step (the model may request several tool
  calls at once; the summary lists them all).
- If the caller starts a new task in the same context while a confirmation is still pending, the
  pending action is rejected ("superseded") first: an old, unanswered confirmation must never be
  approved by accident later.

Who the client is
-----------------
`message.metadata.client_id`, set by the calling agent's *code* from its authenticated session, never
by its LLM. It is passed to LangChain as runtime context (not model input), and every tool reads it
from `ToolRuntime.context`. A message without it is `rejected` (refused before any work), which is
different from `failed` (an error during the work). On a confirmation reply, the client_id must
match the one that started the task, since the thread id is derived from it.

TODO(auth): nothing authenticates the calling agent yet, so anyone who can reach the port can claim
any client_id. The server listens on localhost only until then.
"""

import asyncio
import logging
from typing import Any

from a2a.helpers import get_data_parts, get_text_parts, new_data_part, new_task, new_text_part
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.tasks import TaskUpdater
from a2a.types import Message, TaskState
from google.protobuf.json_format import MessageToDict
from langgraph.types import Command

from actions_agent.context import ClientContext
from actions_agent.tools import describe_action
from actions_agent.ui import confirmation_ui_part

logger = logging.getLogger(__name__)

RUN_TIMEOUT_S = 90
RECURSION_LIMIT = 16
MAX_AUTO_REJECTIONS = 3
FAILURE_TEXT = (
    "The actions agent could not process this request. Nothing was changed unless stated otherwise."
)
INVALID_ACTION = (
    "Not executed: this action can't succeed for this client (unknown id, card already blocked, "
    "same account or insufficient funds). Check with list_cards / list_accounts before retrying."
)
SUPERSEDED = "Not executed: the client sent a new request instead of confirming."
NOTHING_PENDING = (
    "No action is waiting for confirmation on this task anymore (superseded by a newer request)."
)


class ActionsAgentExecutor(AgentExecutor):
    def __init__(self, agent: Any, conn: Any) -> None:
        self._agent = agent
        self._conn = conn

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        assert context.message is not None and context.task_id and context.context_id

        if context.current_task is None:
            await event_queue.enqueue_event(
                new_task(
                    task_id=context.task_id,
                    context_id=context.context_id,
                    state=TaskState.TASK_STATE_SUBMITTED,
                    history=[context.message],
                )
            )
        updater = TaskUpdater(event_queue, context.task_id, context.context_id)

        client_id = _client_id(context.message)
        if client_id is None:
            await updater.reject(updater.new_agent_message([new_text_part("Missing metadata.client_id.")]))
            return

        config = {
            "configurable": {"thread_id": f"{client_id}:{context.context_id}"},
            "recursion_limit": RECURSION_LIMIT,
        }
        run_context = ClientContext(client_id=client_id)
        text = "\n".join(get_text_parts(context.message.parts)).strip()
        is_confirmation_reply = (
            context.current_task is not None
            and context.current_task.status.state == TaskState.TASK_STATE_INPUT_REQUIRED
        )
        pending = await self._pending_actions(config)

        if is_confirmation_reply and not pending:
            await updater.reject(updater.new_agent_message([new_text_part(NOTHING_PENDING)]))
            return
        if not is_confirmation_reply and not text:
            await updater.reject(updater.new_agent_message([new_text_part("The message has no text part.")]))
            return

        await updater.start_work()
        try:
            async with asyncio.timeout(RUN_TIMEOUT_S):
                if is_confirmation_reply:
                    decision = _decision(context.message, text)
                    payload: Any = Command(resume={"decisions": [decision] * len(pending)})
                else:
                    if pending:
                        await self._agent.ainvoke(
                            Command(resume=_reject_all(pending, SUPERSEDED)),
                            config=config,
                            context=run_context,
                        )
                    payload = {"messages": [{"role": "user", "content": text}]}
                result, pending = await self._run(payload, config, run_context)
        except Exception:
            logger.exception("agent run failed", extra={"task_id": context.task_id})
            await updater.failed(updater.new_agent_message([new_text_part(FAILURE_TEXT)]))
            return

        if pending:
            await updater.requires_input(self._confirmation_request(updater, client_id, pending))
            return

        answer = result["messages"][-1].text.strip()
        if not answer:
            await updater.failed(updater.new_agent_message([new_text_part(FAILURE_TEXT)]))
            return
        await updater.add_artifact([new_text_part(answer)], name="answer")
        await updater.complete()

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        """Called by the SDK on a `CancelTask` request, after it has cancelled the asyncio task running
        `execute()`. A paused confirmation is simply left unanswered: the next new task in the same
        context rejects it as superseded."""
        assert context.task_id and context.context_id
        await TaskUpdater(event_queue, context.task_id, context.context_id).cancel()

    async def _run(self, payload: Any, config: dict, run_context: ClientContext) -> tuple[dict, list[dict]]:
        for _ in range(MAX_AUTO_REJECTIONS + 1):
            result = await self._agent.ainvoke(payload, config=config, context=run_context)
            pending = await self._pending_actions(config)
            if not pending or all(
                describe_action(self._conn, run_context.client_id, a["name"], a["args"]) for a in pending
            ):
                return result, pending
            payload = Command(resume=_reject_all(pending, INVALID_ACTION))
        raise RuntimeError("Too many invalid actions requested by the model")

    async def _pending_actions(self, config: dict) -> list[dict]:
        state = await self._agent.aget_state(config)
        return [action for interrupt in state.interrupts for action in interrupt.value["action_requests"]]

    def _confirmation_request(self, updater: TaskUpdater, client_id: str, pending: list[dict]) -> Message:
        actions = [
            {
                "name": a["name"],
                "args": a["args"],
                "summary": describe_action(self._conn, client_id, a["name"], a["args"]),
            }
            for a in pending
        ]
        text = " ".join(a["summary"] for a in actions)
        return updater.new_agent_message(
            [
                new_text_part(text),
                new_data_part(
                    {
                        "type": "confirmation_request",
                        "actions": actions,
                        "reply_with": {
                            "decision": ["approve", "reject"],
                            "text": "optional client explanation",
                        },
                    }
                ),
                # The HTML view that renders the data part above, MCP Apps style (see ui.py).
                confirmation_ui_part(),
            ]
        )


def _client_id(message: Message) -> str | None:
    client_id = MessageToDict(message.metadata).get("client_id")
    return client_id if isinstance(client_id, str) and client_id else None


def _decision(message: Message, explanation: str) -> dict:
    decisions = [d.get("decision") for d in get_data_parts(message.parts) if isinstance(d, dict)]
    if "approve" in decisions and "reject" not in decisions:
        return {"type": "approve"}
    reason = "The client declined." if "reject" in decisions else "The client did not confirm."
    if explanation:
        reason += f" Client's explanation: {explanation}"
    return {"type": "reject", "message": reason}


def _reject_all(pending: list[dict], reason: str) -> dict:
    return {"decisions": [{"type": "reject", "message": reason}] * len(pending)}

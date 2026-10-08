"""Bridge between the A2A protocol and the LangChain agent.

How an A2A request reaches this code
------------------------------------
1. The calling agent sends a JSON-RPC `SendMessage` request (`message/send` in A2A 0.3) to the
   endpoint advertised in the Agent Card. Its body is a `Message`: a role (`user`), `parts` (text,
   structured data, files...), optional `metadata`, and optionally the `context_id` / `task_id` of an
   earlier exchange.
2. The SDK's `DefaultRequestHandler` (see server.py) validates it, loads the existing task from the
   `TaskStore` if `task_id` was given, builds a `RequestContext` and calls `execute()` below with an
   `EventQueue`.
3. `execute()` never returns a value: it *publishes events* to the queue. The handler applies them
   to the task, saves the task in the `TaskStore`, and answers the HTTP request with the final task.

A2A vocabulary used here
------------------------
- Task: the unit of work, with an id and a status (`submitted` -> `working` -> a terminal state:
  `completed`, `failed`, `rejected`, `canceled`; or an interrupted state: `input-required`,
  `auth-required`). The SDK requires the first event of a new task to be the `Task` object itself;
  status updates and artifacts can only follow.
- Context (`context_id`): groups the tasks of one conversation. The calling agent reuses the same
  `context_id` for follow-up questions. We use it as the LangGraph `thread_id`, so the LLM sees the
  earlier exchanges of the same conversation (memory is kept by the checkpointer in agent.py).
- Artifact: the *result* of a task (here, one text part with the answer). Status messages, on the
  other hand, explain the task's state (e.g. why it failed).
- `TaskUpdater`: SDK helper that builds and enqueues `TaskStatusUpdateEvent` and
  `TaskArtifactUpdateEvent` objects for one task, and refuses updates after a terminal state.

Who the client is
-----------------
The client's identity is read from `message.metadata.client_id`. The calling agent's *code* sets it
from its authenticated session; its LLM never chooses it. It is passed to the LangChain agent as
runtime context, never as model input, so the model can't change it: every tool reads it from
`ToolRuntime.context`. A message without it is `rejected` (refused before any work started), which is
different from `failed` (an error during the work).

The LangGraph thread id is `client_id:context_id`, not just `context_id`: context ids are chosen by
the caller, so a context id reused with another client_id must not expose the first client's
conversation history.

TODO(auth): nothing authenticates the calling agent yet. Until then, anyone who can reach the port
can claim any client_id, which is why the server listens on localhost only.
"""

import asyncio
import logging
from typing import Any

from a2a.helpers import new_task, new_text_part
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.tasks import TaskUpdater
from a2a.types import Message, TaskState
from google.protobuf.json_format import MessageToDict

from informations_agent.context import ClientContext

logger = logging.getLogger(__name__)

RUN_TIMEOUT_S = 90
RECURSION_LIMIT = 12
FAILURE_TEXT = "The informations agent could not process this request. Please try again later."


class InformationsAgentExecutor(AgentExecutor):
    def __init__(self, agent: Any) -> None:
        self._agent = agent

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        assert context.message is not None and context.task_id and context.context_id

        # A new task must be announced with a full `Task` event before any status update. For a
        # follow-up message on an existing task, the SDK already loaded it into `current_task`.
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
        question = context.get_user_input().strip()
        if client_id is None or not question:
            reason = "Missing metadata.client_id." if client_id is None else "The message has no text part."
            await updater.reject(updater.new_agent_message([new_text_part(reason)]))
            return

        await updater.start_work()
        try:
            async with asyncio.timeout(RUN_TIMEOUT_S):
                result = await self._agent.ainvoke(
                    {"messages": [{"role": "user", "content": question}]},
                    config={
                        "configurable": {"thread_id": f"{client_id}:{context.context_id}"},
                        "recursion_limit": RECURSION_LIMIT,
                    },
                    context=ClientContext(client_id=client_id),
                )
        except Exception:
            logger.exception("agent run failed", extra={"task_id": context.task_id})
            await updater.failed(updater.new_agent_message([new_text_part(FAILURE_TEXT)]))
            return

        answer = result["messages"][-1].text.strip()
        if not answer:
            await updater.failed(updater.new_agent_message([new_text_part(FAILURE_TEXT)]))
            return
        await updater.add_artifact([new_text_part(answer)], name="answer")
        await updater.complete()

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        """Called by the SDK on a `CancelTask` request, after it has cancelled the asyncio task
        running `execute()`. Our only job is to publish the `canceled` terminal state."""
        assert context.task_id and context.context_id
        await TaskUpdater(event_queue, context.task_id, context.context_id).cancel()


def _client_id(message: Message) -> str | None:
    client_id = MessageToDict(message.metadata).get("client_id")
    return client_id if isinstance(client_id, str) and client_id else None

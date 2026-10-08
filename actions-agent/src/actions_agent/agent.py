import sqlite3

from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware, ModelRetryMiddleware
from langchain_core.language_models import BaseChatModel
from langgraph.checkpoint.base import BaseCheckpointSaver

from actions_agent.context import ClientContext
from actions_agent.prompts import SYSTEM_PROMPT
from actions_agent.tools import WRITE_TOOLS, build_tools


def build_agent(model: BaseChatModel, conn: sqlite3.Connection, checkpointer: BaseCheckpointSaver):
    return create_agent(
        model,
        tools=build_tools(conn),
        system_prompt=SYSTEM_PROMPT,
        context_schema=ClientContext,
        checkpointer=checkpointer,
        middleware=[
            ModelRetryMiddleware(max_retries=2, on_failure="error"),
            HumanInTheLoopMiddleware(
                interrupt_on={name: {"allowed_decisions": ["approve", "reject"]} for name in WRITE_TOOLS}
            ),
        ],
        name="actions_agent",
    )

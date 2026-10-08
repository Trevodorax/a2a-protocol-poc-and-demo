import sqlite3

from langchain.agents import create_agent
from langchain.agents.middleware import ModelRetryMiddleware
from langchain_core.language_models import BaseChatModel
from langgraph.checkpoint.base import BaseCheckpointSaver

from informations_agent.context import ClientContext
from informations_agent.prompts import SYSTEM_PROMPT
from informations_agent.tools import build_tools


def build_agent(model: BaseChatModel, conn: sqlite3.Connection, checkpointer: BaseCheckpointSaver):
    return create_agent(
        model,
        tools=build_tools(conn),
        system_prompt=SYSTEM_PROMPT,
        context_schema=ClientContext,
        checkpointer=checkpointer,
        middleware=[ModelRetryMiddleware(max_retries=2, on_failure="error")],
        name="informations_agent",
    )

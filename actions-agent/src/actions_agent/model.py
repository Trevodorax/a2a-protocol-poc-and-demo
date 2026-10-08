from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel

from actions_agent.config import Settings


def create_chat_model(settings: Settings) -> BaseChatModel:
    provider_options = {}
    if settings.llm_model.startswith("openai:"):
        # Chat Completions rejects tools combined with a reasoning effort on recent models.
        provider_options = {"use_responses_api": True, "reasoning": {"effort": "low"}}
    return init_chat_model(
        settings.llm_model,
        api_key=settings.llm_api_key.get_secret_value(),
        max_tokens=16_000,
        **provider_options,
    )

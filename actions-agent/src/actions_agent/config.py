from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    llm_model: str = Field(default="openai:gpt-5.5", pattern=r"^[\w-]+:[\w.:-]+$")
    llm_api_key: SecretStr
    database_path: Path = Path("../database/bank.db")
    host: str = "127.0.0.1"
    port: int = 8002
    public_url: str = "http://127.0.0.1:8002"
    log_level: str = "INFO"

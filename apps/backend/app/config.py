from functools import lru_cache
from pathlib import Path
from typing import Optional
from pydantic import BaseModel, SecretStr, computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


class LLMSettings(BaseModel):
    api_key: Optional[SecretStr] = None
    base_url: str = "https://api.minimax.chat/v1"
    model_name: str = "MiniMax-M2.7"
    temperature: float = 0.7
    context_window: int = 4096


class DatabaseSettings(BaseModel):
    user: str = "root"
    password: SecretStr = SecretStr("k8s_insight_secret")
    host: str = "localhost"
    port: int = 3306
    db_name: str = "k8s_insight"

    @computed_field
    def sqlalchemy_database_uri(self) -> str:
        # Note: Using get_secret_value() to avoid '*******' in the connection string
        return f"mysql+pymysql://{self.user}:{self.password.get_secret_value()}@{self.host}:{self.port}/{self.db_name}"

class AppSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        env_nested_delimiter="__",
        env_prefix="APP_",
        extra="ignore"
    )

    debug_mode: bool = False
    log_level: str = "INFO"
    go_server_path: str = "../mcp-server/mcp-server"
    encryption_key: SecretStr = SecretStr("k8s-insight-default-encryption-key-32b")
    
    llm: LLMSettings = LLMSettings()
    db: DatabaseSettings = DatabaseSettings()

@lru_cache()
def get_settings() -> AppSettings:
    return AppSettings()

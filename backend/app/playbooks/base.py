from abc import ABC, abstractmethod
from typing import Any, Dict, Optional, Type
from pydantic import BaseModel, Field

class PlaybookResponse(BaseModel):
    """Standardized response from any playbook execution."""
    success: bool
    message: str
    data: Optional[Any] = None
    report: Optional[str] = None  # Markdown report for UI

class BasePlaybook(ABC):
    """
    Optional abstract base class for more complex playbooks 
    that prefer class-based structure over simple decorated functions.
    """
    @abstractmethod
    async def execute(self, inputs: BaseModel) -> PlaybookResponse:
        pass

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from ..types import HarnessRunResult, ModelConfig, ScenarioDefinition


class HarnessAdapter(ABC):
    name: str

    def __init__(self, repo_root: Path):
        self.repo_root = repo_root

    @abstractmethod
    def run(self, scenario: ScenarioDefinition, model_config: ModelConfig) -> HarnessRunResult:
        raise NotImplementedError

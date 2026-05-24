from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class ScenarioExpectations:
    root_cause_keywords: list[str] = field(default_factory=list)
    root_cause_min_hits: int = 1
    evidence_keywords: list[str] = field(default_factory=list)
    evidence_min_hits: int = 0
    trace_keywords: list[str] = field(default_factory=list)
    trace_min_hits: int = 0
    forbidden_trace_routes: list[str] = field(default_factory=list)
    require_non_health_trace: bool = False
    required_tools: list[str] = field(default_factory=list)
    forbidden_tools: list[str] = field(default_factory=list)
    required_sections: list[str] = field(default_factory=lambda: ["当前症状", "证据链", "根因判断", "修复建议"])


@dataclass
class ModelConfig:
    model_name: str
    base_url: str
    api_key: str
    temperature: float = 0.2
    label: str = ""


@dataclass
class ScenarioDefinition:
    name: str
    label: str
    description: str
    namespace: str
    service_entry: str
    request_params: dict[str, Any]
    prompt_override: str = ""
    tags: list[str] = field(default_factory=list)
    expectations: ScenarioExpectations = field(default_factory=ScenarioExpectations)


@dataclass
class HarnessRunResult:
    adapter: str
    scenario: str
    model: dict[str, Any]
    started_at: str
    duration_seconds: float
    summary: str
    sections: dict[str, str]
    tool_calls: list[dict[str, Any]]
    raw_markdown: str
    trace_evidence: list[Any] = field(default_factory=list)
    db_evidence: list[Any] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    evaluation: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

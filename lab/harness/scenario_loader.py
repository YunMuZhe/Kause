from __future__ import annotations

from pathlib import Path

from .types import ScenarioDefinition, ScenarioExpectations


def load_scenarios(scenarios_dir: Path) -> list[ScenarioDefinition]:
    try:
        import yaml
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "PyYAML is required for harness scenarios. "
            "Run the harness from the backend Python environment, or install apps/backend/requirements.txt."
        ) from exc

    scenarios: list[ScenarioDefinition] = []
    for path in sorted(scenarios_dir.glob("*.yaml")):
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        expectations = raw.get("expectations") or {}
        scenario = ScenarioDefinition(
            name=raw.get("name") or path.stem,
            label=raw.get("label") or raw.get("name") or path.stem,
            description=raw.get("description") or "",
            namespace=raw.get("namespace") or "kube-copilot-lab",
            service_entry=raw.get("service_entry") or "order-java-fault",
            request_params=raw.get("request_params") or {},
            prompt_override=raw.get("prompt_override") or "",
            tags=raw.get("tags") or [],
            expectations=ScenarioExpectations(
                root_cause_keywords=expectations.get("root_cause_keywords") or [],
                root_cause_min_hits=int(expectations.get("root_cause_min_hits", 1)),
                evidence_keywords=expectations.get("evidence_keywords") or [],
                evidence_min_hits=int(expectations.get("evidence_min_hits", 0)),
                trace_keywords=expectations.get("trace_keywords") or [],
                trace_min_hits=int(expectations.get("trace_min_hits", 0)),
                forbidden_trace_routes=expectations.get("forbidden_trace_routes") or [],
                require_non_health_trace=bool(expectations.get("require_non_health_trace", False)),
                required_tools=expectations.get("required_tools") or [],
                forbidden_tools=expectations.get("forbidden_tools") or [],
                required_sections=expectations.get("required_sections") or ["当前症状", "证据链", "根因判断", "修复建议"],
            ),
        )
        scenarios.append(scenario)
    return scenarios


def select_scenarios(all_scenarios: list[ScenarioDefinition], names: list[str]) -> list[ScenarioDefinition]:
    if not names:
        return all_scenarios
    wanted = {name.strip() for item in names for name in item.split(",") if name.strip()}
    selected = [scenario for scenario in all_scenarios if scenario.name in wanted]
    missing = sorted(wanted - {scenario.name for scenario in selected})
    if missing:
        raise ValueError(f"Unknown scenarios: {', '.join(missing)}")
    return selected

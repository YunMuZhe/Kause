from __future__ import annotations

import json

from .types import HarnessRunResult, ScenarioDefinition
from .utils import canonical_tool_name, normalize_text


HEALTH_ROUTES = {"/healthz", "/readyz", "/livez", "/metrics"}


def _trace_rows(result: HarnessRunResult) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for trace_block in result.trace_evidence or []:
        if isinstance(trace_block, dict):
            block_rows = trace_block.get("rows") or []
            if isinstance(block_rows, list):
                rows.extend([row for row in block_rows if isinstance(row, dict)])
    return rows


def _trace_row_text(row: dict[str, object]) -> str:
    try:
        return normalize_text(json.dumps(row, ensure_ascii=False, sort_keys=True))
    except Exception:
        return normalize_text(str(row))


def evaluate_run(result: HarnessRunResult, scenario: ScenarioDefinition) -> dict[str, object]:
    final_text = normalize_text("\n".join([result.raw_markdown, *result.sections.values()]))
    tool_names = [canonical_tool_name(call.get("toolName", "")) for call in result.tool_calls]
    trace_rows = _trace_rows(result)
    non_health_trace_rows = [
        row for row in trace_rows
        if str(row.get("http_route") or "").strip() not in HEALTH_ROUTES
    ]

    expectations = scenario.expectations
    root_hits = [keyword for keyword in expectations.root_cause_keywords if normalize_text(keyword) in final_text]
    evidence_hits = [keyword for keyword in expectations.evidence_keywords if normalize_text(keyword) in final_text]
    trace_hits = []
    for keyword in expectations.trace_keywords:
        target = normalize_text(keyword)
        if any(target in _trace_row_text(row) for row in trace_rows):
            trace_hits.append(keyword)
    required_tools_hit = [tool for tool in expectations.required_tools if tool in tool_names]
    forbidden_tools_hit = [tool for tool in expectations.forbidden_tools if tool in tool_names]
    forbidden_trace_hits = [
        str(row.get("http_route") or "")
        for row in trace_rows
        if str(row.get("http_route") or "") in expectations.forbidden_trace_routes
    ]
    missing_sections = [section for section in expectations.required_sections if not (result.sections.get(section) or "").strip()]

    root_target = max(expectations.root_cause_min_hits, 1)
    evidence_target = max(expectations.evidence_min_hits, 1) if expectations.evidence_min_hits > 0 else 0
    trace_target = max(expectations.trace_min_hits, 1) if expectations.trace_min_hits > 0 else 0

    root_score = min(len(root_hits) / root_target, 1.0) if expectations.root_cause_keywords else 1.0
    evidence_score = (
        min(len(evidence_hits) / evidence_target, 1.0)
        if expectations.evidence_keywords and evidence_target
        else 1.0
    )
    trace_score = (
        min(len(trace_hits) / trace_target, 1.0)
        if expectations.trace_keywords and trace_target
        else 1.0
    )
    if expectations.require_non_health_trace:
        trace_score = min(trace_score, 1.0 if non_health_trace_rows else 0.0)
    required_tools_score = (
        len(required_tools_hit) / len(expectations.required_tools)
        if expectations.required_tools
        else 1.0
    )
    forbidden_tools_score = (
        max(0.0, 1.0 - len(forbidden_tools_hit) / len(expectations.forbidden_tools))
        if expectations.forbidden_tools
        else 1.0
    )
    sections_score = (
        max(0.0, 1.0 - len(missing_sections) / len(expectations.required_sections))
        if expectations.required_sections
        else 1.0
    )

    overall_score = (
        root_score * 0.3
        + evidence_score * 0.15
        + trace_score * 0.2
        + required_tools_score * 0.15
        + forbidden_tools_score * 0.1
        + sections_score * 0.1
    )

    # `passed` answers "did the run correctly solve the incident with enough evidence?"
    # Extra / suboptimal tools should lower score, but not automatically turn a correct
    # diagnosis into a hard failure.
    passed = (
        len(root_hits) >= expectations.root_cause_min_hits
        and len(evidence_hits) >= expectations.evidence_min_hits
        and not forbidden_trace_hits
        and not missing_sections
    )
    if expectations.trace_keywords:
        passed = passed and len(trace_hits) >= expectations.trace_min_hits
    if expectations.require_non_health_trace:
        passed = passed and bool(non_health_trace_rows)
    if expectations.required_tools:
        passed = passed and len(required_tools_hit) == len(expectations.required_tools)

    return {
        "passed": passed,
        "score": round(overall_score * 100, 1),
        "rootCauseHits": root_hits,
        "evidenceHits": evidence_hits,
        "traceHits": trace_hits,
        "requiredToolsHit": required_tools_hit,
        "requiredToolsMissed": [tool for tool in expectations.required_tools if tool not in required_tools_hit],
        "forbiddenToolsHit": forbidden_tools_hit,
        "forbiddenTraceRoutesHit": forbidden_trace_hits,
        "missingSections": missing_sections,
        "toolNames": tool_names,
        "traceStats": {
            "traceRowCount": len(trace_rows),
            "nonHealthTraceRowCount": len(non_health_trace_rows),
        },
    }

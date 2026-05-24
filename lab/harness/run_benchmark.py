from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from .evaluators import evaluate_run
from .scenario_loader import load_scenarios, select_scenarios
from .types import HarnessRunResult, ModelConfig
from .utils import discover_repo_root, slugify, utc_timestamp


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run repeatable harness benchmarks against lab scenarios.")
    parser.add_argument("--scenario", action="append", default=[], help="Scenario name, repeatable or comma-separated")
    parser.add_argument(
        "--adapter",
        action="append",
        default=[],
        help="Adapter name, repeatable. Supported: openai-tools, qwen-agent",
    )
    parser.add_argument("--list-scenarios", action="store_true", help="List available scenarios and exit")
    parser.add_argument("--output-dir", default="lab/harness/output", help="Directory for benchmark artifacts")
    parser.add_argument("--model-config", default="", help="Path to a YAML or JSON file with one or more model definitions")
    parser.add_argument("--model-name", default="", help="Model name override")
    parser.add_argument("--base-url", default="", help="Base URL override")
    parser.add_argument("--api-key", default="", help="API key override")
    parser.add_argument("--temperature", type=float, default=0.2, help="Temperature override")
    return parser.parse_args()


def load_model_config(repo_root: Path, args: argparse.Namespace) -> ModelConfig:
    from dotenv import load_dotenv

    env_file = repo_root / "apps" / "backend" / ".env"
    load_dotenv(env_file, override=False)

    model_name = args.model_name or os.getenv("APP_LLM__MODEL_NAME") or os.getenv("QWEN_AGENT_MODEL") or "qwen-max"
    base_url = args.base_url or os.getenv("APP_LLM__BASE_URL") or os.getenv("QWEN_AGENT_BASE_URL") or ""
    api_key = args.api_key or os.getenv("APP_LLM__API_KEY") or os.getenv("QWEN_AGENT_API_KEY") or ""

    if not base_url:
        raise RuntimeError("No model base URL found. Set APP_LLM__BASE_URL in apps/backend/.env or pass --base-url.")
    if not api_key:
        raise RuntimeError("No model API key found. Set APP_LLM__API_KEY in apps/backend/.env or pass --api-key.")

    return ModelConfig(
        model_name=model_name,
        base_url=base_url,
        api_key=api_key,
        temperature=args.temperature,
        label=args.model_name or model_name,
    )


def load_model_matrix(repo_root: Path, args: argparse.Namespace) -> list[ModelConfig]:
    if not args.model_config:
        return [load_model_config(repo_root, args)]

    from dotenv import load_dotenv
    import yaml

    env_file = repo_root / "apps" / "backend" / ".env"
    load_dotenv(env_file, override=False)

    model_config_path = (repo_root / args.model_config).resolve() if not Path(args.model_config).is_absolute() else Path(args.model_config)
    raw = yaml.safe_load(model_config_path.read_text(encoding="utf-8")) or {}
    items = raw.get("models") if isinstance(raw, dict) else raw
    if not isinstance(items, list) or not items:
        raise RuntimeError(f"No models found in {model_config_path}")

    models: list[ModelConfig] = []
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise RuntimeError(f"Invalid model entry #{index} in {model_config_path}")
        api_key = str(item.get("api_key") or "").strip()
        api_key_env = str(item.get("api_key_env") or "").strip()
        if not api_key and api_key_env:
            api_key = os.getenv(api_key_env, "").strip()

        model_name = str(item.get("model_name") or "").strip()
        base_url = str(item.get("base_url") or "").strip()
        if not model_name or not base_url:
            raise RuntimeError(f"Model entry #{index} must include model_name and base_url in {model_config_path}")

        label = str(item.get("label") or model_name).strip()
        if not api_key:
            print(
                f"[harness] skipping model={label} from {model_config_path}: missing API key"
                + (f" in env {api_key_env}" if api_key_env else "")
            )
            continue
        temperature = float(item.get("temperature", args.temperature))
        models.append(
            ModelConfig(
                model_name=model_name,
                base_url=base_url,
                api_key=api_key,
                temperature=temperature,
                label=label,
            )
        )
    if not models:
        raise RuntimeError(f"No runnable models found in {model_config_path}")
    return models


def build_adapters(repo_root: Path, adapter_names: list[str]):
    from .adapters import OpenAIToolsAdapter, QwenAgentAdapter

    requested = adapter_names or ["openai-tools"]
    expanded = [name.strip() for item in requested for name in item.split(",") if name.strip()]
    adapters = []
    for name in expanded:
        if name == "openai-tools":
            adapters.append(OpenAIToolsAdapter(repo_root))
        elif name == "qwen-agent":
            adapters.append(QwenAgentAdapter(repo_root))
        else:
            raise ValueError(f"Unsupported adapter: {name}")
    return adapters


def write_outputs(output_dir: Path, aggregate: dict[str, object]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report.json").write_text(json.dumps(aggregate, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# Harness Report",
        "",
        f"- models: `{len(aggregate['models'])}`",
        f"- scenarios: `{len(aggregate['scenarios'])}`",
        f"- adapters: `{len(aggregate['adapters'])}`",
        "",
        "| model | adapter | scenario | passed | score | duration_s | summary |",
        "| --- | --- | --- | --- | ---: | ---: | --- |",
    ]
    for run in aggregate["runs"]:
        evaluation = run.get("evaluation", {})
        summary = (run.get("summary") or "").replace("\n", " ").strip()
        lines.append(
            f"| `{run['model'].get('label') or run['model'].get('modelName')}` | `{run['adapter']}` | `{run['scenario']}` | `{evaluation.get('passed', False)}` | "
            f"{evaluation.get('score', 0)} | {run.get('duration_seconds', 0)} | {summary[:120]} |"
        )

        artifact_name = (
            f"{slugify(str(run['model'].get('label') or run['model'].get('modelName')))}__"
            f"{slugify(str(run['adapter']))}__{slugify(str(run['scenario']))}.json"
        )
        (output_dir / artifact_name).write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding="utf-8")

    (output_dir / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_failed_run(*, adapter_name: str, scenario_name: str, scenario_label: str, model_config: ModelConfig, started_at: str, duration_seconds: float, error: Exception) -> HarnessRunResult:
    message = str(error).strip() or error.__class__.__name__
    summary = f"Run failed: {error.__class__.__name__}: {message}"
    sections = {
        "当前症状": summary,
        "工具调用": "无完整结果，运行在模型或基础设施阶段失败。",
        "证据链": message,
        "根因判断": f"Harness 运行失败，未完成有效排查。错误类型：{error.__class__.__name__}",
        "修复建议": "检查模型 API 可用性、额度、网络和认证配置后重试。",
    }
    result = HarnessRunResult(
        adapter=adapter_name,
        scenario=scenario_name,
        model={
            "label": model_config.label or model_config.model_name,
            "modelName": model_config.model_name,
            "baseUrl": model_config.base_url,
            "temperature": model_config.temperature,
        },
        started_at=started_at,
        duration_seconds=round(duration_seconds, 3),
        summary=summary,
        sections=sections,
        tool_calls=[],
        raw_markdown="",
        metadata={
            "errorType": error.__class__.__name__,
            "errorMessage": message,
            "scenarioLabel": scenario_label,
        },
        evaluation={
            "passed": False,
            "score": 0.0,
            "rootCauseHits": [],
            "evidenceHits": [],
            "traceHits": [],
            "requiredToolsHit": [],
            "requiredToolsMissed": [],
            "forbiddenToolsHit": [],
            "forbiddenTraceRoutesHit": [],
            "missingSections": [],
            "toolNames": [],
            "traceStats": {"traceRowCount": 0, "nonHealthTraceRowCount": 0},
            "runError": message,
        },
    )
    return result


def main() -> None:
    args = parse_args()
    repo_root = discover_repo_root(Path(__file__))
    scenarios_dir = repo_root / "lab" / "scenarios"
    scenarios = load_scenarios(scenarios_dir)

    if args.list_scenarios:
        for scenario in scenarios:
            print(f"{scenario.name}: {scenario.description}")
        return

    selected_scenarios = select_scenarios(scenarios, args.scenario)
    model_configs = load_model_matrix(repo_root, args)
    adapters = build_adapters(repo_root, args.adapter)

    output_dir = repo_root / args.output_dir
    run_bucket = output_dir / slugify(
        f"{utc_timestamp()}-{model_configs[0].label if len(model_configs) == 1 else 'matrix'}-"
        f"{selected_scenarios[0].name if len(selected_scenarios) == 1 else 'batch'}"
    )

    aggregate_runs = []
    for model_config in model_configs:
        for adapter in adapters:
            for scenario in selected_scenarios:
                print(
                    f"[harness] running model={model_config.label or model_config.model_name} "
                    f"adapter={adapter.name} scenario={scenario.name}"
                )
                started_at = utc_timestamp()
                started = time.perf_counter()
                try:
                    result = adapter.run(scenario, model_config)
                    result.evaluation = evaluate_run(result, scenario)
                except Exception as exc:
                    result = build_failed_run(
                        adapter_name=adapter.name,
                        scenario_name=scenario.name,
                        scenario_label=scenario.label,
                        model_config=model_config,
                        started_at=started_at,
                        duration_seconds=time.perf_counter() - started,
                        error=exc,
                    )
                aggregate_runs.append(result.to_dict())

    aggregate = {
        "models": [
            {
                "label": model_config.label,
                "modelName": model_config.model_name,
                "baseUrl": model_config.base_url,
                "temperature": model_config.temperature,
            }
            for model_config in model_configs
        ],
        "scenarios": [scenario.name for scenario in selected_scenarios],
        "adapters": [adapter.name for adapter in adapters],
        "runs": aggregate_runs,
    }
    write_outputs(run_bucket, aggregate)

    for run in aggregate_runs:
        evaluation = run["evaluation"]
        print(
            f"[harness] {run['model'].get('label') or run['model'].get('modelName')} / {run['adapter']} / {run['scenario']} -> "
            f"passed={evaluation['passed']} score={evaluation['score']} duration={run['duration_seconds']}s"
        )
    print(f"[harness] report written to {run_bucket}")


if __name__ == "__main__":
    main()

import argparse
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv


SECTION_TITLES = ["当前症状", "工具调用", "证据链", "根因判断", "修复建议"]


@dataclass
class InvestigationConfig:
    repo_root: Path
    namespace: str
    prompt: str


def build_llm_config() -> dict:
    model = os.getenv("QWEN_AGENT_MODEL", "qwen-max").strip()
    base_url = os.getenv("QWEN_AGENT_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1").strip()
    api_key = os.getenv("QWEN_AGENT_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("QWEN_AGENT_API_KEY is required")

    if base_url.startswith("http"):
        return {
            "model": model,
            "model_server": base_url,
            "api_key": api_key,
            "generate_cfg": {
                "temperature": 0.2,
            },
        }

    return {
        "model": model,
        "api_key": api_key,
        "generate_cfg": {
            "temperature": 0.2,
        },
    }


def build_mcp_config(repo_root: Path) -> dict:
    kubeconfig = os.getenv("KUBECONFIG", str(Path.home() / ".kube" / "config"))
    mcp_dir = repo_root / "apps" / "mcp-server"
    mcp_main = mcp_dir / "main.go"
    if not mcp_main.exists():
        raise RuntimeError(f"MCP entry not found: {mcp_main}")

    return {
        "mcpServers": {
            "kause": {
                "command": "/bin/sh",
                "args": ["-lc", f"cd {json.dumps(str(mcp_dir))} && go run ./main.go"],
                "env": {
                    "KUBECONFIG": kubeconfig,
                },
            }
        }
    }


def build_system_message(namespace: str) -> str:
    return f"""
你是一个 Kubernetes 故障排查助手。
你的排查目标命名空间默认是 `{namespace}`。

排查规则：
1. 先获取真实 pod/deployment 状态，绝不允许编造 pod 名称或使用 `<pod-id>` 这类占位符。
2. 如果表面上 Pod/Deployment 正常，也不能直接下结论；你必须主动探测接口来复现问题。
3. 当前实验里，优先探测以下接口：
   - `order-java-fault` 的 `/api/orders/checkout-preview?fault=slow-sql&downstreamFault=none&fanout=1&userId=42&tier=gold`
   - `order-java-fault` 的 `/api/orders/checkout-preview?fault=null-pointer&downstreamFault=none&fanout=1&userId=42&tier=gold`
   - `order-java-fault` 的 `/api/orders/checkout-preview?fault=none&downstreamFault=db-timeout&fanout=1&userId=42&tier=gold`
   - `catalog-fault` 的 `/api/catalog/items?fault=cache-stampede&fanout=5&tier=gold`
   - `payment-fault` 的 `/internal/pricing?fault=db-timeout&tier=gold`
4. 主动探测后，必须查询一次最近的 SigNoz traces，并优先检查 error spans。
5. 如果 traces 或日志里出现 `slowOrdersByCustomerCast`、`db.query.template`、`db.query.label`、`slow sql`，必须进一步调用 `list_mysql_tables`、`describe_mysql_table`、`explain_mysql_query`。
6. 如果出现 `NullPointerException`，优先查看 `order-java-fault` 的日志和异常 span。
7. 根因判断必须同时参考接口探测结果、Kubernetes 证据、日志、traces 和数据库诊断；如果某类证据缺失，要明确说明。
8. 如果工具返回了真实 pod 名称，后续日志查询必须使用那个真实名称。
9. 如果已经拿到明确的接口报错和 trace/SQL 证据，就直接收敛到结论，不要继续猜测不存在的基础设施资源。
10. 输出时不要跳结论，必须带证据链，并优先给出最小风险修复动作。
""".strip()


def build_default_prompt(namespace: str) -> str:
    return f"""
请排查命名空间 `{namespace}` 中的故障实验服务：
- order-java-fault
- catalog-fault
- payment-fault

请执行一次真实排查，不要只看 Deployment 是否 Running。

强制要求：
1. 先查看真实 Pod 列表。
2. 主动发起接口探测来复现故障，优先从 `order-java-fault` 开始。
3. 至少查询一次最近 20 分钟内 `order-java-fault,catalog-fault,payment-fault` 的 trace，优先看 errors。
4. 如果获取日志，必须使用真实 pod 名称。
5. 如果发现慢 SQL 证据，必须继续调用 `list_mysql_tables(database=order_lab)`、`describe_mysql_table(database=order_lab, table_name=orders)`、`explain_mysql_query(database=order_lab, sql=<真实慢 SQL>)`。
5. 最终输出必须严格使用以下 Markdown 标题：
### 当前症状
### 工具调用
### 证据链
### 根因判断
### 修复建议
""".strip()


def normalize_message(message: Any) -> dict:
    if hasattr(message, "model_dump"):
        return message.model_dump()
    if isinstance(message, dict):
        return message
    raise TypeError(f"Unsupported message type: {type(message)!r}")


def safe_json_loads(raw: str) -> Any:
    try:
        return json.loads(raw)
    except Exception:
        return None


def extract_sections(markdown_text: str) -> dict[str, str]:
    sections: dict[str, str] = {title: "" for title in SECTION_TITLES}
    pattern = re.compile(r"^###\s+(.+?)\s*$", re.MULTILINE)
    matches = list(pattern.finditer(markdown_text or ""))
    for index, match in enumerate(matches):
        title = match.group(1).strip()
        if title not in sections:
            continue
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown_text)
        sections[title] = markdown_text[start:end].strip()
    return sections


def collect_tool_calls(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pending: dict[str, dict[str, Any]] = {}
    ordered: list[dict[str, Any]] = []

    for message in messages:
        extra = message.get("extra") or {}
        function_id = str(extra.get("function_id", "")).strip()

        if message.get("function_call"):
            function_call = message["function_call"]
            entry = {
                "function_id": function_id or str(len(ordered) + 1),
                "tool_name": function_call.get("name", ""),
                "arguments_raw": function_call.get("arguments", ""),
                "arguments": safe_json_loads(function_call.get("arguments", "")),
                "result_raw": "",
                "result": None,
            }
            pending[entry["function_id"]] = entry
            ordered.append(entry)
            continue

        if message.get("role") == "function":
            entry = pending.get(function_id)
            if not entry:
                entry = {
                    "function_id": function_id or str(len(ordered) + 1),
                    "tool_name": message.get("name", ""),
                    "arguments_raw": "",
                    "arguments": None,
                    "result_raw": message.get("content", ""),
                    "result": safe_json_loads(message.get("content", "")),
                }
                ordered.append(entry)
                continue

            entry["result_raw"] = message.get("content", "")
            entry["result"] = safe_json_loads(message.get("content", ""))

    return ordered


def build_config(prompt: str | None = None, namespace: str | None = None) -> InvestigationConfig:
    load_dotenv()
    repo_root = next(
        (parent for parent in Path(__file__).resolve().parents if (parent / "apps" / "mcp-server").exists()),
        Path(__file__).resolve().parents[3],
    )
    target_namespace = (namespace or os.getenv("QWEN_AGENT_NAMESPACE", "kube-copilot-lab")).strip()
    target_prompt = (prompt or build_default_prompt(target_namespace)).strip()
    return InvestigationConfig(repo_root=repo_root, namespace=target_namespace, prompt=target_prompt)


def run_investigation(prompt: str | None = None, namespace: str | None = None) -> dict[str, Any]:
    config = build_config(prompt=prompt, namespace=namespace)

    from qwen_agent.agents import Assistant

    llm_cfg = build_llm_config()
    mcp_cfg = build_mcp_config(config.repo_root)
    bot = Assistant(
        llm=llm_cfg,
        function_list=[mcp_cfg],
        system_message=build_system_message(config.namespace),
        name="kause-qwen-agent",
        description="Investigates Kubernetes faults using the local Kause MCP server.",
    )

    raw_responses = [normalize_message(message) for message in bot.run_nonstream(messages=[{"role": "user", "content": config.prompt}])]
    final_message = next(
        (
            message
            for message in reversed(raw_responses)
            if message.get("role") == "assistant" and message.get("content") and not message.get("function_call")
        ),
        {},
    )
    final_text = final_message.get("content", "")

    return {
        "namespace": config.namespace,
        "prompt": config.prompt,
        "system_message": build_system_message(config.namespace),
        "raw_messages": raw_responses,
        "tool_calls": collect_tool_calls(raw_responses),
        "final_markdown": final_text,
        "sections": extract_sections(final_text),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the legacy Qwen-Agent investigation flow.")
    parser.add_argument("--namespace", default=None, help="Namespace override")
    parser.add_argument("--prompt-file", default="", help="Path to a UTF-8 prompt file")
    parser.add_argument("--prompt-text", default="", help="Inline prompt override")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    prompt = None
    if args.prompt_text:
        prompt = args.prompt_text
    elif args.prompt_file:
        prompt = Path(args.prompt_file).read_text(encoding="utf-8")

    result = run_investigation(prompt=prompt, namespace=args.namespace)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

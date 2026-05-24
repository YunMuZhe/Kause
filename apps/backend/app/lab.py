import asyncio
import json
import re
from typing import Any, Optional
from urllib.parse import urlencode

from mcp import ClientSession
from openai import OpenAI
from pydantic import BaseModel, Field


SECTION_TITLES = ["当前症状", "工具调用", "证据链", "根因判断", "修复建议"]
READ_PREFIXES = ("get_", "list_", "describe_", "query_", "explain_", "probe_")


class LabInvestigationRequest(BaseModel):
    namespace: str = "kube-copilot-lab"
    serviceEntry: str = "order-java-fault"
    promptOverride: Optional[str] = None
    requestPreset: Optional[str] = None
    requestParams: dict[str, Any] = Field(default_factory=dict)
    clusterId: Optional[int] = None


def build_lab_presets() -> list[dict[str, Any]]:
    return [
        {
            "name": "baseline",
            "label": "正常链路",
            "description": "Java -> catalog -> payment 全链路正常返回",
            "serviceEntry": "order-java-fault",
            "requestParams": {"fault": "none", "downstreamFault": "none", "fanout": 1, "userId": 42, "tier": "gold"},
        },
        {
            "name": "slow-sql",
            "label": "慢 SQL",
            "description": "Java 服务触发慢 SQL，并要求 agent 自动做表结构和 EXPLAIN 分析",
            "serviceEntry": "order-java-fault",
            "requestParams": {"fault": "slow-sql", "downstreamFault": "none", "fanout": 1, "userId": 42, "tier": "gold"},
        },
        {
            "name": "null-pointer",
            "label": "空指针异常",
            "description": "Java 服务先完成下游调用，再在本地触发 NullPointerException",
            "serviceEntry": "order-java-fault",
            "requestParams": {"fault": "null-pointer", "downstreamFault": "none", "fanout": 1, "userId": 42, "tier": "gold"},
        },
        {
            "name": "db-timeout",
            "label": "下游 DB 超时",
            "description": "通过 Java -> catalog -> payment 链路触发 payment-fault 的 DB timeout",
            "serviceEntry": "order-java-fault",
            "requestParams": {"fault": "none", "downstreamFault": "db-timeout", "fanout": 1, "userId": 42, "tier": "gold"},
        },
        {
            "name": "cache-stampede",
            "label": "缓存击穿",
            "description": "通过 Java 入口触发多次回源，观察跨服务延迟和 trace fan-out",
            "serviceEntry": "order-java-fault",
            "requestParams": {"fault": "none", "downstreamFault": "cache-stampede", "fanout": 5, "userId": 42, "tier": "gold"},
        },
    ]


def is_read_tool(tool_name: str) -> bool:
    return tool_name.startswith(READ_PREFIXES) or "log" in tool_name or "event" in tool_name


def select_preset(request_preset: Optional[str]) -> Optional[dict[str, Any]]:
    for preset in build_lab_presets():
        if preset["name"] == request_preset:
            return preset
    return None


def merge_request_params(request: LabInvestigationRequest) -> tuple[str, dict[str, Any]]:
    preset = select_preset(request.requestPreset)
    service_entry = request.serviceEntry
    params = dict(request.requestParams)
    if preset:
        service_entry = preset["serviceEntry"]
        merged = dict(preset["requestParams"])
        merged.update(params)
        params = merged
    return service_entry, params


def build_service_path(service_entry: str, request_params: dict[str, Any]) -> str:
    base_path = {
        "order-java-fault": "/api/orders/checkout-preview",
        "catalog-fault": "/api/catalog/items",
        "payment-fault": "/internal/pricing",
    }.get(service_entry, "/api/orders/checkout-preview")
    if not request_params:
        return base_path
    return f"{base_path}?{urlencode(request_params, doseq=True)}"


def build_lab_prompt(request: LabInvestigationRequest) -> tuple[str, str, dict[str, Any]]:
    service_entry, request_params = merge_request_params(request)
    entry_path = build_service_path(service_entry, request_params)
    business_route = entry_path.split("?", 1)[0]
    current_fault = str(request_params.get("fault") or "none")
    downstream_fault = str(request_params.get("downstreamFault") or "none")
    scenario_hints: list[str] = [
        "补探测时只允许使用这些真实路径，不要编造不存在的接口：",
        "- `order-java-fault` -> `/api/orders/checkout-preview`",
        "- `catalog-fault` -> `/api/catalog/items`",
        "- `payment-fault` -> `/internal/pricing`",
        "如果日志或 traces 的 `fault_mode` 与本次请求参数不一致，那属于历史残留，不能作为本次主根因。",
    ]
    if current_fault == "slow-sql":
        scenario_hints.extend([
            "本次是慢 SQL 场景，允许并鼓励继续做 MySQL 表结构和 EXPLAIN 分析。",
            "如果日志里同时出现历史 `NullPointerException`，但当前请求是 HTTP 200 且 `queryLabel=slowOrdersByCustomerCast`，应优先收敛到慢 SQL，而不是历史 NPE。",
        ])
    else:
        scenario_hints.extend([
            "本次不是 SQL 主场景。除非当前请求的 HTTP 响应、当前 traces、或当前 pod logs 明确出现 SQL 慢/SQL 错误证据，否则不要调用 `list_mysql_tables`、`describe_mysql_table`、`explain_mysql_query`。",
        ])
    if downstream_fault == "db-timeout":
        scenario_hints.extend([
            "本次优先沿 `order-java-fault -> catalog-fault -> payment-fault` 的错误链定位超时来源。",
            "如果入口返回 503，且错误消息包含 `pricing dependency failed` 或 `dependency returned status 500`，优先判断为下游 `payment-fault` 的数据库超时向上游传播。",
        ])
    if downstream_fault == "cache-stampede":
        scenario_hints.extend([
            "本次优先关注 fanout、重复下游调用、跨服务延迟放大，不要被历史错误日志带偏。",
        ])
    baseline_prompt = f"""
你是一个 Kubernetes + APM + SQL 联合排障助手。
本次排查命名空间默认是 `{request.namespace}`。
本次入口服务是 `{service_entry}`，入口路径是 `{entry_path}`。
本次实验数据库固定为 `order_lab`，服务集合固定为 `order-java-fault,catalog-fault,payment-fault`。

强制排查顺序：
1. 必须先探测入口服务 `{service_entry}` 的 `{entry_path}`。
2. 再按需要补探测 `catalog-fault` 和 `payment-fault` 的相关接口。
3. 查询最近 20 分钟的 SigNoz traces，先看 errors，再看关键链路 spans。
   - 查询 traces 时，优先排除健康检查噪音：`exclude_http_routes="/healthz,/readyz,/livez,/metrics"`
   - 对当前入口优先带上：`http_route_contains="{business_route}"`
   - 如果 probe 响应里出现 `queryLabel`，继续把它作为 `db_query_label_contains` 带入 trace 查询
   - 如果 `db_query_label_contains + http_route_contains` 联合过滤结果为空，必须去掉 `http_route_contains` 再查一次，避免把真实 SQL span 过滤掉
4. 如果 traces 或日志里出现 `slowOrdersByCustomerCast`、`db.query.template`、`db.query.label`、`slow sql`，必须继续调用：
   - `list_mysql_tables(database=order_lab)`
   - `describe_mysql_table(database=order_lab, table_name=orders)`
   - `describe_mysql_table(database=order_lab, table_name=order_items)`（如果 explain 需要）
   - `explain_mysql_query(database=order_lab, sql=<真实慢 SQL 模板>)`
5. 如果出现 `NullPointerException`，必须优先查看 `order-java-fault` pod logs 和 traces 中的异常 span。
6. 绝不允许编造 pod 名称或占位符。
7. 已经拿到 HTTP、trace、SQL/日志证据后直接收敛，不继续盲猜不存在的基础设施问题。

场景约束：
{chr(10).join(f"- {hint}" for hint in scenario_hints)}

最终输出必须严格使用以下 Markdown 标题：
### 当前症状
### 工具调用
### 证据链
### 根因判断
### 修复建议

本次请求参数：
```json
{json.dumps(request_params, ensure_ascii=False, indent=2)}
```
""".strip()
    if request.promptOverride:
        baseline_prompt = baseline_prompt + "\n\n附加要求：\n" + request.promptOverride.strip()
    return baseline_prompt, service_entry, request_params


def extract_sections(markdown_text: str) -> dict[str, str]:
    sections = {title: "" for title in SECTION_TITLES}
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


def parse_json_if_possible(value: str) -> Any:
    try:
        return json.loads(value)
    except Exception:
        return None


def summarize_sections(sections: dict[str, str]) -> str:
    root_cause = sections.get("根因判断", "").strip()
    symptoms = sections.get("当前症状", "").strip()
    summary = root_cause or symptoms
    if not summary:
        return "本次排查没有提取到稳定结论。"
    lines = [line.strip("- ").strip() for line in summary.splitlines() if line.strip()]
    return " ".join(lines[:2])


async def run_lab_investigation(
    *,
    client: OpenAI,
    model_name: str,
    temperature: float,
    mcp_session: ClientSession,
    request: LabInvestigationRequest,
) -> dict[str, Any]:
    prompt, service_entry, request_params = build_lab_prompt(request)
    tools_response = await mcp_session.list_tools()
    read_tools = [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.inputSchema,
            },
        }
        for tool in tools_response.tools
        if is_read_tool(tool.name)
    ]

    llm_messages: list[dict[str, Any]] = [
        {"role": "system", "content": "你是一个证据优先的故障排查助手，只能依据工具返回的数据下结论。"},
        {"role": "user", "content": prompt},
    ]
    tool_calls: list[dict[str, Any]] = []
    raw_markdown = ""

    async def call_tool_with_retry(tool_name: str, arguments: dict[str, Any]) -> tuple[str, Any]:
        result_text = ""
        parsed_result: Any = None
        query_attempts: list[dict[str, Any]] = [dict(arguments)]
        if tool_name == "query_signoz_traces" and arguments.get("http_route_contains"):
            relaxed = dict(arguments)
            relaxed.pop("http_route_contains", None)
            query_attempts.append(relaxed)

        for attempt, current_args in enumerate(query_attempts):
            result = await mcp_session.call_tool(tool_name, current_args)
            result_text = "\n".join([item.text for item in result.content if hasattr(item, "text")])
            parsed_result = parse_json_if_possible(result_text)
            if tool_name != "query_signoz_traces":
                break
            if not isinstance(parsed_result, dict):
                break
            rows = parsed_result.get("rows")
            if rows:
                break
            if attempt < len(query_attempts) - 1:
                await asyncio.sleep(2)
        return result_text, parsed_result

    for _ in range(12):
        response = client.chat.completions.create(
            model=model_name,
            temperature=temperature,
            messages=llm_messages,
            tools=read_tools or None,
            tool_choice="auto" if read_tools else None,
        )
        message = response.choices[0].message
        content = message.content or ""
        assistant_message: dict[str, Any] = {"role": "assistant", "content": content}
        if message.tool_calls:
            assistant_message["tool_calls"] = [
                {
                    "id": tool_call.id,
                    "type": "function",
                    "function": {
                        "name": tool_call.function.name,
                        "arguments": tool_call.function.arguments,
                    },
                }
                for tool_call in message.tool_calls
            ]
        llm_messages.append(assistant_message)

        if not message.tool_calls:
            raw_markdown = content
            break

        for tool_call in message.tool_calls:
            arguments = parse_json_if_possible(tool_call.function.arguments or "{}") or {}
            result_text, parsed_result = await call_tool_with_retry(tool_call.function.name, arguments)
            tool_calls.append({
                "toolName": tool_call.function.name,
                "arguments": arguments,
                "resultRaw": result_text,
                "result": parsed_result,
            })
            llm_messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result_text,
            })

    if not raw_markdown:
        llm_messages.append({
            "role": "user",
            "content": (
                "现在停止继续调用工具。请仅根据已经拿到的证据，严格输出最终 Markdown。"
                "即使证据不足，也必须填写全部 5 个标题，并明确写出已确认事实、最可能根因、以及剩余不确定性。"
            ),
        })
        response = client.chat.completions.create(
            model=model_name,
            temperature=temperature,
            messages=llm_messages,
        )
        raw_markdown = response.choices[0].message.content or ""

    sections = extract_sections(raw_markdown)
    trace_evidence = [call["result"] for call in tool_calls if call["toolName"] == "query_signoz_traces" and call["result"]]
    db_evidence = [call["result"] for call in tool_calls if call["toolName"] in {"list_mysql_tables", "describe_mysql_table", "explain_mysql_query"} and call["result"]]

    return {
        "summary": summarize_sections(sections),
        "sections": sections,
        "toolCalls": tool_calls,
        "traceEvidence": trace_evidence,
        "dbEvidence": db_evidence,
        "rawMarkdown": raw_markdown,
        "serviceEntry": service_entry,
        "requestParams": request_params,
        "namespace": request.namespace,
    }

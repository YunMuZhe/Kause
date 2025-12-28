import os
import asyncio
import json
from contextlib import asynccontextmanager
from typing import Optional, Dict, Any, List

import uvicorn
from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from pydantic import BaseModel
from openai import OpenAI
from dotenv import load_dotenv

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from sqlmodel import Session, select

from . import models, database
from .playbook_engine import PlaybookEngine
from .database import create_db_and_tables, get_session
from .config import get_settings
from .playbooks.registry import registry

settings = get_settings()

load_dotenv()

# Configuration
GO_SERVER_PATH = os.path.abspath(settings.go_server_path)
# Playbooks are now in the same directory as main.py
PLAYBOOKS_DIR = os.path.join(os.path.dirname(__file__), "playbooks")

if not os.path.exists(PLAYBOOKS_DIR):
    os.makedirs(PLAYBOOKS_DIR)

client = OpenAI(
    api_key=settings.llm.api_key.get_secret_value() if settings.llm.api_key else None,
    base_url=settings.llm.base_url
)

# Global state for MCP session and Playbook Engine
mcp_session: Optional[ClientSession] = None
playbook_engine: Optional[PlaybookEngine] = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global mcp_session, playbook_engine
    
    # Initialize DB
    create_db_and_tables()
    
    # Start Go MCP server
    server_params = StdioServerParameters(
        command=GO_SERVER_PATH,
        args=[],
        env=os.environ.copy()
    )
    
    print(f"Starting MCP server at {GO_SERVER_PATH}...")
    
    # Initialize stdio client
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            mcp_session = session
            print("MCP server initialized and session established.")
            
            # Initialize Playbook Engine
            playbook_engine = PlaybookEngine(
                playbook_dir=PLAYBOOKS_DIR,
                mcp_session=mcp_session,
                openai_client=client,
                model_name=settings.llm.model_name
            )
            
            yield
            print("Shutting down...")

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    message: str
    conversation_id: Optional[int] = None
    include_history: bool = True  # Context Control: whether to include history in LLM inference

class PlaybookExecuteRequest(BaseModel):
    playbook_id: str
    params: Dict[str, Any]


# === Two-Pass Architecture: Librarian Agent ===
async def run_librarian_agent(user_message: str, diagnosis: str, playbooks_data: list) -> Optional[dict]:
    """
    Pass 2: Librarian Agent - Matches diagnosis to playbooks silently.
    Returns widget data if a playbook should be proposed, None otherwise.
    """
    if not playbooks_data:
        return None

    playbook_ids = [pb['id'] for pb in playbooks_data]
    summaries = []
    for pb in playbooks_data:
        inputs_info = ""
        if "inputs" in pb: # Legacy YAML
            inputs_info = ", ".join([f"{i['key']} ({i.get('label', '')})" for i in pb["inputs"]])
        elif "args_model" in pb: # New Modular
            props = pb["args_model"].get("properties", {})
            required = pb["args_model"].get("required", [])
            inputs_info = ", ".join([f"{k} {'(required)' if k in required else ''}" for k in props.keys()])
        
        summaries.append(f"- ID: `{pb['id']}`\n  Title: {pb['title']}\n  Summary: {pb['summary']}\n  Required Inputs: {inputs_info}")
    
    playbooks_summary = "\n".join(summaries)

    librarian_prompt = f"""你是一个 Playbook 匹配专家。你的唯一任务是根据用户问题和诊断结论，判断是否需要推荐一个自动化诊断剧本。

## 可用 Playbooks
{playbooks_summary}

## 匹配规则
1. **只有当诊断明确指向某个具体问题时才推荐** - 例如：Pod 重启、网络不通、资源不足等
2. **纯查询请求不需要推荐** - 如果用户只是问"有哪些 pods"、"列出 services"等，不要推荐
3. **诊断结论中没有发现问题时不推荐** - 如果一切正常，不需要运行 playbook
4. **使用 propose_playbook 工具来推荐** - 如果决定推荐，必须调用此工具

## 重要
- 如果不需要推荐任何 Playbook，直接回复"无需推荐"，不要调用工具
- 只有在确实需要深度诊断时才推荐 Playbook"""

    propose_playbook_tool = {
        "type": "function",
        "function": {
            "name": "propose_playbook",
            "description": "Propose a diagnostic playbook to the user for execution.",
            "parameters": {
                "type": "object",
                "properties": {
                    "playbook_id": {
                        "type": "string",
                        "description": f"The unique ID of the playbook to propose.",
                        "enum": playbook_ids
                    },
                    "rationale": {
                        "type": "string",
                        "description": "A brief explanation (1-2 sentences) of why this playbook is recommended."
                    },
                    "risk_level": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "Risk level: 'low' for read-only, 'medium' for safe modifications, 'high' for potentially disruptive."
                    },
                    "suggested_inputs": {
                        "type": "object",
                        "description": "Pre-filled input values for the playbook based on the context."
                    }
                },
                "required": ["playbook_id", "rationale", "risk_level"]
            }
        }
    }

    try:
        print(f"--- Librarian Agent: Matching playbooks for diagnosis ---")
        response = client.chat.completions.create(
            model=settings.llm.model_name,
            messages=[
                {"role": "system", "content": librarian_prompt},
                {"role": "user", "content": f"用户问题: {user_message}\n\n诊断结论:\n{diagnosis}"}
            ],
            tools=[propose_playbook_tool],
            tool_choice="auto"
        )

        response_message = response.choices[0].message
        tool_calls = response_message.tool_calls

        if tool_calls:
            for tool_call in tool_calls:
                if tool_call.function.name == "propose_playbook":
                    args = json.loads(tool_call.function.arguments)
                    print(f"--- Librarian matched playbook: {args.get('playbook_id')} ---")
                    return {
                        "playbook_id": args.get("playbook_id", ""),
                        "rationale": args.get("rationale", ""),
                        "risk_level": args.get("risk_level", "low"),
                        "initial_inputs": args.get("suggested_inputs", {})
                    }

        print(f"--- Librarian: No playbook recommended ---")
        return None

    except Exception as e:
        print(f"--- Librarian Agent Error: {e} ---")
        return None

@app.post("/chat")
async def chat(request: ChatRequest, db: Session = Depends(get_session)):
    if not mcp_session or not playbook_engine:
        raise HTTPException(status_code=503, detail="Server not ready")

    # 0. Handle Conversation Persistence (before streaming)
    if request.conversation_id:
        conversation = db.get(models.Conversation, request.conversation_id)
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")
    else:
        title = request.message[:20] + "..." if len(request.message) > 20 else request.message
        conversation = models.Conversation(title=title)
        db.add(conversation)
        db.commit()
        db.refresh(conversation)

    conversation_id = conversation.id

    # Save user message
    user_msg = models.Message(
        conversation_id=conversation_id,
        role="user",
        content=request.message,
        type="text"
    )
    db.add(user_msg)
    db.commit()

    # Load history from DB
    messages_db = db.exec(select(models.Message).where(models.Message.conversation_id == conversation_id).order_by(models.Message.created_at)).all()

    # Get available tools and playbooks
    tools_list = await mcp_session.list_tools()
    openai_tools = []
    for tool in tools_list.tools:
        openai_tools.append({
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.inputSchema
            }
        })

    # Get playbooks data for Librarian Agent (Pass 2)
    playbooks_data = playbook_engine.list_playbooks() + registry.list_playbooks()

    # Detective Agent system prompt (NO playbook knowledge)
    tools_desc = "\n".join([f"- `{t.name}`: {t.description}" for t in tools_list.tools])

    system_prompt = f"""你是一个专业的 Kubernetes 排障专家。
你有权限调用实时 K8S 集群查询工具来诊断问题。

# CRITICAL: 零幻觉原则 (Zero Hallucination Policy)

**你绝对不能编造任何 Kubernetes 资源信息。**
- 当用户询问集群中的资源（如 Pods、Deployments、Services、Ingresses 等）时，你 **必须** 调用相应的工具获取真实数据。
- **禁止** 在没有调用工具的情况下返回任何资源名称、状态或数量。
- 如果你不确定该用哪个工具，先调用工具查询，再回答。

# ⚠️ 重要：忽略历史对话中的资源数据

**历史对话中出现的任何资源名称（如 Pod 名、Deployment 名、Service 名等）可能已经过时或不准确。**
- 每次用户询问资源信息时，你 **必须重新调用工具** 获取最新数据。
- **绝对禁止** 直接引用历史对话中的资源名称或状态。
- 工具返回的数据才是 **唯一可信来源**。

# 可用工具列表 (Available Tools)

{tools_desc}

# 工作流程 (Workflow)

### 1. 资源查询 (Query Mode)
- **触发条件**: 用户询问集群资源信息（如 "有哪些 pods", "列出 deployments", "查看 ingress"）
- **动作**: 调用对应的工具（如 `list_pods`, `list_deployments`, `get_ingresses`）
- **输出**: 将工具返回的 **真实数据** 以 markdown 格式展示给用户

### 2. 问题诊断 (Diagnosis Mode)
- **触发条件**: 用户描述问题需要诊断（如 "为什么 pod 一直重启", "服务访问不通", "ingress 配置有问题吗"）
- **动作**:
  1. 调用相关工具收集数据
  2. 分析数据，找出问题根因
  3. 给出诊断结论和建议的排查方向

### 3. 数据展示 (Output Fidelity)
- 使用工具获取数据后，**必须** 在回复中包含工具返回的原始数据（使用 markdown 代码块）
- 不要只做总结，用户需要看到实际内容

# 安全规则 (Safety Rules)
- **零幻觉**: 绝对不要编造资源名称、状态或任何集群数据
- **工具优先**: 任何涉及集群状态的问题都要先调用工具
"""

    print(f"--- Chat Request: {request.message} ---")
    print(f"--- Context Control: include_history={request.include_history} ---")
    llm_messages = [{"role": "system", "content": system_prompt}]

    # Context Control: Conditionally load history
    # Always persist to DB (handled above), but only include in LLM context if flag is ON
    if request.include_history:
        # Add history but only user messages to avoid hallucination contamination
        # Assistant responses may contain hallucinated data that could influence future responses
        print(f"--- Loading {len(messages_db)} history messages (filtering to user messages only) ---")
        for m in messages_db:
            if m.role == "user":
                llm_messages.append({"role": m.role, "content": m.content})
                print(f"  [user]: {m.content[:100]}..." if len(m.content) > 100 else f"  [user]: {m.content}")
            else:
                print(f"  [SKIPPED {m.role}]: {m.content[:50]}..." if len(m.content) > 50 else f"  [SKIPPED {m.role}]: {m.content}")
    else:
        print(f"--- FRESH START MODE: Skipping {len(messages_db)} history messages ---")
        # Only add the current user message (already in messages_db as the last item)
        llm_messages.append({"role": "user", "content": request.message})

    async def event_generator():
        nonlocal llm_messages
        full_content = ""

        try:
            # === PASS 1: Detective Agent ===
            # Send thinking event
            yield {"data": json.dumps({"type": "thinking", "message": "正在分析您的问题..."})}

            # First LLM call (non-streaming to get tool calls)
            response = client.chat.completions.create(
                model=settings.llm.model_name,
                messages=llm_messages,
                tools=openai_tools,
                tool_choice="auto"
            )

            response_message = response.choices[0].message
            content = response_message.content or ""
            tool_calls = response_message.tool_calls
            print(f"--- Detective Response: content='{content[:200] if content else ''}...', tool_calls={len(tool_calls) if tool_calls else 0} ---")

            # Handle MCP tool calls
            if tool_calls:
                tool_results_text = []

                for tool_call in tool_calls:
                    function_name = tool_call.function.name
                    function_args = json.loads(tool_call.function.arguments)

                    # Send tool_call event
                    yield {"data": json.dumps({
                        "type": "tool_call",
                        "tool": function_name,
                        "args": function_args
                    })}

                    print(f"Calling tool: {function_name} with {function_args}")
                    tool_result = await mcp_session.call_tool(function_name, function_args)

                    result_text = "".join([item.text for item in tool_result.content if hasattr(item, "text")])
                    print(f"Tool Result ({function_name}): {result_text[:500]}...")

                    # Generate summary for tool result
                    try:
                        result_data = json.loads(result_text)
                        if isinstance(result_data, list):
                            summary = f"获取到 {len(result_data)} 条记录"
                        else:
                            summary = f"获取到数据"
                    except:
                        summary = f"获取到 {len(result_text)} 字符数据"

                    # Send tool_result event
                    yield {"data": json.dumps({
                        "type": "tool_result",
                        "tool": function_name,
                        "summary": summary
                    })}

                    # Collect tool result for later
                    tool_results_text.append(f"工具 {function_name} 返回的数据:\n```json\n{result_text}\n```")

                # Add tool results to messages
                llm_messages.append({
                    "role": "user",
                    "content": f"""以下是工具调用返回的真实数据，请基于这些数据回答用户的问题。

{chr(10).join(tool_results_text)}

【重要提醒】
- 上面的数据是从 Kubernetes 集群实时查询的真实数据
- 你必须基于这些真实数据来回答
- 禁止编造任何资源名称、状态或数据
- 必须原样引用工具返回的内容"""
                })

                # Final LLM call with streaming
                yield {"data": json.dumps({"type": "thinking", "message": "正在生成诊断结论..."})}

                try:
                    final_response = client.chat.completions.create(
                        model=settings.llm.model_name,
                        messages=llm_messages,
                        stream=True
                    )

                    print("--- Detective streaming response started ---")
                    for chunk in final_response:
                        if chunk.choices and chunk.choices[0].delta.content:
                            delta = chunk.choices[0].delta.content
                            full_content += delta
                            yield {"data": json.dumps({"type": "content", "delta": delta})}

                    print(f"--- Detective streaming complete, total content length: {len(full_content)} ---")
                except Exception as stream_error:
                    print(f"--- Detective streaming error: {stream_error} ---")
                    yield {"data": json.dumps({"type": "error", "message": f"流式生成失败: {str(stream_error)}"})}
                    return

            else:
                # No tool calls, stream the content directly
                if content:
                    for char in content:
                        full_content += char
                        yield {"data": json.dumps({"type": "content", "delta": char})}
                        await asyncio.sleep(0.01)

            # === PASS 2: Librarian Agent ===
            # Only run if we have diagnosis content
            if full_content:
                yield {"data": json.dumps({"type": "thinking", "message": "正在匹配诊断剧本..."})}

                librarian_result = await run_librarian_agent(
                    user_message=request.message,
                    diagnosis=full_content,
                    playbooks_data=playbooks_data
                )

                if librarian_result:
                    print(f"--- Librarian matched playbook: {librarian_result.get('playbook_id')} ---")

                    # Emit widget event
                    yield {"data": json.dumps({"type": "widget", "data": librarian_result})}

                    # Save widget to DB
                    widget_result = {
                        "type": "widget",
                        "widgets": [librarian_result],
                        "playbook_id": librarian_result["playbook_id"],
                        "initial_inputs": librarian_result.get("initial_inputs", {}),
                        "rationale": librarian_result.get("rationale", ""),
                        "risk_level": librarian_result.get("risk_level", "low"),
                        "reply": full_content,
                        "conversation_id": conversation_id
                    }
                    with next(database.get_session()) as save_db:
                        assistant_msg = models.Message(
                            conversation_id=conversation_id,
                            role="assistant",
                            content=json.dumps(widget_result),
                            type="widget"
                        )
                        save_db.add(assistant_msg)
                        save_db.commit()
                else:
                    # No playbook matched, save text response to DB
                    with next(database.get_session()) as save_db:
                        assistant_msg = models.Message(
                            conversation_id=conversation_id,
                            role="assistant",
                            content=full_content,
                            type="text"
                        )
                        save_db.add(assistant_msg)
                        save_db.commit()
            else:
                # Empty response, save anyway
                with next(database.get_session()) as save_db:
                    assistant_msg = models.Message(
                        conversation_id=conversation_id,
                        role="assistant",
                        content=content or "",
                        type="text"
                    )
                    save_db.add(assistant_msg)
                    save_db.commit()

            yield {"data": json.dumps({"type": "done", "conversation_id": conversation_id})}

        except Exception as e:
            print(f"Error in chat stream: {e}")
            yield {"data": json.dumps({"type": "error", "message": str(e)})}

    return EventSourceResponse(event_generator())

# Conversation Management Endpoints
@app.get("/api/conversations")
async def list_conversations(db: Session = Depends(get_session)):
    conversations = db.exec(select(models.Conversation).order_by(models.Conversation.created_at.desc())).all()
    return conversations

@app.get("/api/conversations/{conversation_id}")
async def get_conversation_history(conversation_id: int, db: Session = Depends(get_session)):
    messages = db.exec(select(models.Message).where(models.Message.conversation_id == conversation_id).order_by(models.Message.created_at)).all()
    
    # Parse widget contents if necessary
    parsed_messages = []
    for m in messages:
        content = m.content
        if m.type == "widget":
            try:
                content = json.loads(m.content)
            except:
                pass
        parsed_messages.append({
            "role": m.role,
            "content": content,
            "type": m.type,
            "created_at": m.created_at
        })
    return parsed_messages

# Playbook Endpoints (Legacy or just kept for compatibility)
@app.get("/api/playbooks")
async def get_playbooks():
    print("GET /playbooks requested")
    if not playbook_engine:
        print("Error: playbook_engine not initialized")
        raise HTTPException(status_code=503, detail="Playbook engine not ready")
    pbs = playbook_engine.list_playbooks()
    # Merge with registry-based playbooks
    registry_pbs = registry.list_playbooks()
    
    print(f"Found {len(pbs)} YAML playbooks and {len(registry_pbs)} modular playbooks")
    return pbs + registry_pbs

@app.post("/api/playbooks/{playbook_id}/run")
async def run_playbook(playbook_id: str, user_inputs: dict):
    print(f"POST /playbooks/{playbook_id}/run requested with inputs: {user_inputs}")
    if not playbook_engine:
        print("Error: playbook_engine not initialized")
        raise HTTPException(status_code=503, detail="Playbook engine not ready")
    
    async def event_generator():
        print(f"Starting execution of playbook: {playbook_id}")
        async for event in playbook_engine.execute_playbook(playbook_id, user_inputs):
            yield {"data": json.dumps(event)}
        print(f"Finished execution of playbook: {playbook_id}")

    return EventSourceResponse(event_generator())

@app.post("/api/playbooks/execute")
async def execute_playbook_v2(request: PlaybookExecuteRequest):
    """
    Modular Playbook Execution API with SSE.
    Supports both new modular playbooks and legacy YAML playbooks.
    """
    # 1. Try finding in modular registry first
    playbook = registry.get_playbook(request.playbook_id)
    
    if playbook:
        # Validate inputs early
        try:
            playbook["metadata"].args_model.model_validate(request.params)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid parameters: {str(e)}")

        async def modular_generator():
            async for event in registry.execute_streaming(request.playbook_id, request.params):
                yield {
                    "event": event.get("event", "message"),
                    "data": json.dumps(event.get("data", ""))
                }
        return EventSourceResponse(modular_generator())

    # 2. Try finding in legacy YAML engine
    if playbook_engine:
        # Check if the YAML file exists
        yaml_path = os.path.join(PLAYBOOKS_DIR, f"{request.playbook_id}.yaml")
        if os.path.exists(yaml_path):
            async def legacy_generator():
                async for chunk in playbook_engine.execute_playbook(request.playbook_id, request.params):
                    # Translate legacy types to SSE events
                    msg_type = chunk.get("type", "info")
                    if msg_type == "report":
                        # Standardize YAML report to PlaybookResponse structure
                        result = {
                            "success": True,
                            "message": "执行完成",
                            "report": chunk.get("content", ""),
                            "data": {}
                        }
                        yield {"event": "result", "data": json.dumps(result)}
                    elif msg_type == "error":
                        yield {"event": "error", "data": json.dumps(chunk.get("message", "Unknown error"))}
                    elif msg_type == "info":
                        yield {"event": "log", "data": json.dumps(chunk.get("message", ""))}
                    elif msg_type == "step_start":
                        yield {"event": "status", "data": json.dumps(f"Step: {chunk.get('name', 'Executing...')}")}
                    else:
                        # Fallback for other types like step_finish
                        yield {"event": "log", "data": json.dumps(str(chunk))}
            
            return EventSourceResponse(legacy_generator())

    raise HTTPException(status_code=404, detail=f"Playbook {request.playbook_id} not found in registry or YAML engine")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)

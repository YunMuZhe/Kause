import os
import asyncio
import json
import tempfile
from contextlib import asynccontextmanager
from typing import Optional, Dict, Any, List, Tuple

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

from . import models, database, security
from .database import create_db_and_tables, get_session
from .config import get_settings

settings = get_settings()

load_dotenv()

# Configuration
GO_SERVER_PATH = os.path.abspath(settings.go_server_path)

client = OpenAI(
    api_key=settings.llm.api_key.get_secret_value() if settings.llm.api_key else None,
    base_url=settings.llm.base_url
)

# --- Multi-Cluster Session Manager ---
class ClusterSessionManager:
    def __init__(self):
        self._sessions: Dict[int, Tuple[ClientSession, Any]] = {} # id -> (session, exit_stack)
        self._lock = asyncio.Lock()

    async def get_mcp_session(self, cluster_id: int, db: Session) -> ClientSession:
        async with self._lock:
            if cluster_id in self._sessions:
                return self._sessions[cluster_id][0]
            
            # Initialize new session for cluster
            cluster = db.get(models.Cluster, cluster_id)
            if not cluster:
                raise HTTPException(status_code=404, detail="Cluster not found")
            
            kubeconfig_content = security.decrypt_data(cluster.kubeconfig)
            if not kubeconfig_content:
                raise HTTPException(status_code=500, detail="Failed to decrypt kubeconfig")
            
            # Use a temporary file for KUBECONFIG
            tmp = tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.kubeconfig')
            tmp.write(kubeconfig_content)
            tmp.close()
            
            try:
                env = os.environ.copy()
                env["KUBECONFIG"] = tmp.name
                
                server_params = StdioServerParameters(
                    command=GO_SERVER_PATH,
                    args=[],
                    env=env
                )
                
                from contextlib import AsyncExitStack
                stack = AsyncExitStack()
                
                print(f"Starting MCP server for cluster {cluster.name}...")
                client_ctx = stdio_client(server_params)
                read, write = await stack.enter_async_context(client_ctx)
                session = await stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
                
                self._sessions[cluster_id] = (session, stack)
                return session
            except Exception as e:
                if os.path.exists(tmp.name):
                    os.unlink(tmp.name)
                raise HTTPException(status_code=500, detail=f"Failed to start MCP server: {str(e)}")

    async def close_all(self):
        for cluster_id, (session, stack) in self._sessions.items():
            await stack.aclose()
        self._sessions.clear()

session_manager = ClusterSessionManager()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize DB
    create_db_and_tables()
    yield
    # Cleanup
    await session_manager.close_all()

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Cluster Management Endpoints ---
class ClusterCreateRequest(BaseModel):
    name: str
    kubeconfig: str
    description: Optional[str] = None

@app.post("/api/clusters")
async def add_cluster(request: ClusterCreateRequest, db: Session = Depends(get_session)):
    encrypted_config = security.encrypt_data(request.kubeconfig)
    cluster = models.Cluster(
        name=request.name,
        kubeconfig=encrypted_config,
        description=request.description
    )
    db.add(cluster)
    try:
        db.commit()
        db.refresh(cluster)
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=f"Cluster already exists or error: {str(e)}")
    
    return {"id": cluster.id, "name": cluster.name}

@app.get("/api/clusters")
async def list_clusters(db: Session = Depends(get_session)):
    clusters = db.exec(select(models.Cluster)).all()
    return [{"id": c.id, "name": c.name, "description": c.description} for c in clusters]

@app.delete("/api/clusters/{cluster_id}")
async def delete_cluster(cluster_id: int, db: Session = Depends(get_session)):
    cluster = db.get(models.Cluster, cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")
    db.delete(cluster)
    db.commit()
    return {"status": "deleted"}

class ChatRequest(BaseModel):
    message: str
    conversation_id: Optional[int] = None
    cluster_id: Optional[int] = None
    include_history: bool = True

# === Two-Pass Architecture: Surgeon Agent ===
async def run_surgeon_agent(user_message: str, investigation_log: str, write_tools: list) -> Optional[str]:
    """
    Pass 2: Surgeon Agent - Designs a customized remediation plan (Prescription) 
    based on the detective's investigation.
    """
    if not write_tools:
        print("--- Surgeon: No write tools available ---")
        return None

    surgeon_prompt = f"""你是一个 K8s 资深专家组件（外科医生模式）。你的任务是根据“侦探”给出的调查结论，设计并返回一个【结构化治疗方案 (Prescription)】。

## 用户请求
{user_message}

## 侦探的调查结论与工具输出
{investigation_log}

## 你可以使用的【写操作】工具库 (Remediation Tools)
{json.dumps(write_tools, indent=2)}

## 核心规则
1. **必须返回卡片**：如果侦探发现了明确的问题（如副本数不一致、Pod 异常、资源不足、配置错误），你必须选择一个合适的【写操作】工具。
2. **工具选择建议**：
   - 如果 Pod 镜像更新后崩溃 -> 尝试 `rollback_deployment`。
   - 如果只是某个 Pod 挂了但 Deployment 没问题 -> 尝试 `delete_pod` 让它自动重建。
   - 如果修改了 ConfigMap 或 Secret 需要生效 -> 尝试 `restart_deployment` 进行滚动重启。
   - 如果负载过高 -> 尝试 `scale_deployment` 扩容。
3. **严禁纯文本建议**：不要只说“你应该执行...”，必须输出下面定义的 <prescription> 标签。
4. **参数一致性**：确保参数（Namespace, Name, Replicas等）与侦探调查出的结果完全一致。

## 输出格式 (必须包含此标签)
必须返回且仅返回一个符合以下结构的 <prescription> 标签：
<prescription>
{{
  "intent": "操作的简短描述 (例如：回滚 payment-service 到上个版本)",
  "reasoning": "结合调查结果解释为什么执行此操作 (例如：侦探报告显示新镜像启动失败，回滚可快速恢复业务)",
  "tool_name": "具体要调用的 MCP 工具名称",
  "arguments": {{ ... 具体的参数，如 namespace, name 等 ... }},
  "risk_level": "LOW|MEDIUM|HIGH"
}}
</prescription>

如果你认为没有任何工具可以解决问题，或者不需要任何操作，请回复“暂无建议方案”。"""

    try:
        print(f"--- Surgeon Agent: Generating prescription ---")
        response = client.chat.completions.create(
            model=settings.llm.model_name,
            messages=[
                {"role": "system", "content": surgeon_prompt},
                {"role": "user", "content": "请基于调查结果，给出你的 <prescription> 方案。"}
            ],
            temperature=0.1
        )

        content = response.choices[0].message.content or ""
        print(f"--- Surgeon Output ---\n{content}\n----------------------")
        
        if "<prescription>" in content:
            return content
        
        return None

    except Exception as e:
        print(f"--- Surgeon Agent Error: {e} ---")
        return None

@app.post("/chat")
async def chat(request: ChatRequest, db: Session = Depends(get_session)):
    # 1. Resolve Cluster Context
    cluster_id = request.cluster_id
    if not cluster_id:
        conversation = db.get(models.Conversation, request.conversation_id) if request.conversation_id else None
        if conversation and conversation.cluster_id:
            cluster_id = conversation.cluster_id
        else:
            first_cluster = db.exec(select(models.Cluster)).first()
            if not first_cluster:
                raise HTTPException(status_code=503, detail="No clusters configured.")
            cluster_id = first_cluster.id

    # 2. Get/Create Conversation
    if not request.conversation_id:
        title = request.message[:50]
        new_conv = models.Conversation(title=title, cluster_id=cluster_id)
        db.add(new_conv)
        db.commit()
        db.refresh(new_conv)
        request.conversation_id = new_conv.id
    
    # 3. Save User Message
    user_msg = models.Message(
        conversation_id=request.conversation_id,
        role="user",
        content=request.message,
        type="text"
    )
    db.add(user_msg)
    db.commit()

    # 4. Get MCP Session
    mcp_session = await session_manager.get_mcp_session(cluster_id, db)
    
    # 5. Get available tools and categorize them
    mcp_tools = await mcp_session.list_tools()
    
    read_tools = []
    write_tools = []
    READ_PREFIXES = ["get_", "list_", "describe_", "explain_", "check_"]
    
    for tool in mcp_tools.tools:
        tool_schema = {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.inputSchema
            }
        }
        
        is_read = any(tool.name.startswith(p) for p in READ_PREFIXES) or "log" in tool.name or "event" in tool.name
        
        if is_read:
            read_tools.append(tool_schema)
        else:
            write_tools.append(tool_schema)

    system_prompt = f"""你是一个 Kure AI 排障侦探。你的任务是调查并诊断 Kubernetes 集群中的问题。

## 工作准则
1. **只负责调查**：使用 Read-only 工具（获取日志、描述资源、列出事件）查明真相。
2. **严禁修复建议**：不要在回复中提供 `kubectl` 命令、YAML 配置或任何具体的修复指令。那是“外科医生”的活。
3. **只说结论**：客观、清晰地总结你发现了什么（例如：“Pod 状态为 Ready，但副本数目前仅为1”）。
4. **简洁专业**：你的回复结束后，后续会有专门的组件根据你的调查结论生成修复方案。
"""

    llm_messages = [{"role": "system", "content": system_prompt}]
    messages_db = db.exec(select(models.Message).where(models.Message.conversation_id == request.conversation_id)).all()

    if request.include_history:
        for m in messages_db[:-1]: 
            if m.role == "user" or (m.role == "assistant" and m.type == "text"):
                llm_messages.append({"role": m.role, "content": m.content})
    
    llm_messages.append({"role": "user", "content": request.message})

    async def event_generator():
        nonlocal llm_messages
        full_content = ""

        try:
            # === PASS 1: Detective Agent (Investigation) ===
            yield {"data": json.dumps({"type": "thinking", "message": "侦查中：正在扫描集群状态..."})}

            # Investigation loop
            run_limit = 5
            for _ in range(run_limit):
                response = client.chat.completions.create(
                    model=settings.llm.model_name,
                    messages=llm_messages,
                    tools=read_tools if read_tools else None,
                    tool_choice="auto" if read_tools else None
                )

                response_message = response.choices[0].message
                content = response_message.content or ""
                tool_calls = response_message.tool_calls

                if not tool_calls:
                    if content:
                        yield {"data": json.dumps({"type": "assistant", "content": content})}
                        full_content += content
                    break

                # Support for tool calls accumulation and history preservation
                llm_messages.append({
                    "role": "assistant",
                    "content": response_message.content,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments
                            }
                        } for tc in tool_calls
                    ]
                })

                for tool_call in tool_calls:
                    f_name = tool_call.function.name
                    f_args = json.loads(tool_call.function.arguments)
                    
                    # 1. Save Tool Call to DB
                    db_tool_call = models.Message(
                        conversation_id=request.conversation_id,
                        role="assistant",
                        type="status",
                        content=json.dumps({
                            "statusType": "tool_call",
                            "toolName": f_name,
                            "arguments": f_args
                        })
                    )
                    db.add(db_tool_call)
                    db.commit()

                    yield {"data": json.dumps({
                        "type": "status", 
                        "statusType": "tool_call",
                        "toolName": f_name,
                        "arguments": f_args,
                        "content": f"侦探调用：{f_name}"
                    })}
                    
                    try:
                        result = await mcp_session.call_tool(f_name, f_args)
                        result_str = "\n".join([c.text for c in result.content if hasattr(c, 'text')])
                        
                        # 2. Save Tool Result to DB
                        db_tool_result = models.Message(
                            conversation_id=request.conversation_id,
                            role="assistant",
                            type="status",
                            content=json.dumps({
                                "statusType": "tool_result",
                                "toolName": f_name,
                                "result": result_str
                            })
                        )
                        db.add(db_tool_result)
                        db.commit()

                        yield {"data": json.dumps({
                            "type": "status",
                            "statusType": "tool_result",
                            "toolName": f_name,
                            "result": result_str,
                            "content": f"采集到 {f_name} 数据"
                        })}
                        
                        llm_messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "name": f_name,
                            "content": result_str
                        })
                    except Exception as e:
                        error_msg = f"Error calling {f_name}: {str(e)}"
                        
                        # 3. Save Error Result to DB
                        db_err_result = models.Message(
                            conversation_id=request.conversation_id,
                            role="assistant",
                            type="status",
                            content=json.dumps({
                                "statusType": "tool_result",
                                "toolName": f_name,
                                "result": error_msg,
                                "is_error": True
                            })
                        )
                        db.add(db_err_result)
                        db.commit()

                        llm_messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "name": f_name,
                            "content": error_msg
                        })

            # === PASS 2: Surgeon Agent (Remediation Design) ===
            investigation_log = ""
            for msg in llm_messages:
                role = msg.get("role") if isinstance(msg, dict) else getattr(msg, "role", "")
                content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", "")
                
                if role == "tool":
                    name = msg.get("name") if isinstance(msg, dict) else getattr(msg, "name", "")
                    investigation_log += f"\n[Tool Result: {name}]\n{content[:500]}\n"
                elif role == "assistant" and content:
                    investigation_log += f"\n[Detective Analysis]: {content}\n"
                elif role == "user":
                    investigation_log += f"\n[User Request]: {content}\n"

            prescription_raw = await run_surgeon_agent(request.message, investigation_log, write_tools)
            if prescription_raw:
                yield {"data": json.dumps({"type": "assistant", "content": prescription_raw})}
                full_content += "\n\n" + prescription_raw

            # Save Final Response
            final_msg = models.Message(
                conversation_id=request.conversation_id,
                role="assistant",
                content=full_content,
                type="text"
            )
            db.add(final_msg)
            db.commit()
            
            yield {"data": json.dumps({"type": "done", "conversation_id": request.conversation_id})}

        except Exception as e:
            print(f"Chat stream error: {e}")
            yield {"data": json.dumps({"type": "error", "message": f"Error: {str(e)}"})}

    return EventSourceResponse(event_generator())

# Conversation Management Endpoints
@app.get("/api/conversations")
async def list_conversations(db: Session = Depends(get_session)):
    conversations = db.exec(select(models.Conversation).order_by(models.Conversation.created_at.desc())).all()
    return conversations

@app.get("/api/conversations/{conversation_id}")
async def get_conversation_history(conversation_id: int, db: Session = Depends(get_session)):
    messages = db.exec(select(models.Message).where(models.Message.conversation_id == conversation_id).order_by(models.Message.created_at)).all()
    return [{"role": m.role, "content": m.content, "type": m.type, "created_at": m.created_at} for m in messages]

class RemediationExecuteRequest(BaseModel):
    conversation_id: int
    intent: str
    tool_name: str
    arguments: Dict[str, Any]
    cluster_id: int
    risk_level: str = "LOW"

@app.post("/api/remediation/execute")
async def execute_remediation(request: RemediationExecuteRequest, db: Session = Depends(get_session)):
    mcp_session = await session_manager.get_mcp_session(request.cluster_id, db)
    
    print(f"--- Executing Remediation: tool={request.tool_name} ---")
    
    try:
        result = await mcp_session.call_tool(request.tool_name, request.arguments)
        output_text = "".join([item.text for item in result.content if hasattr(item, "text")])
        is_error = result.isError if hasattr(result, "isError") else False
        
        # Save execution result to DB
        exec_msg = models.Message(
            conversation_id=request.conversation_id,
            role="assistant",
            type="remediation_result",
            content=json.dumps({
                "intent": request.intent,
                "tool_name": request.tool_name,
                "success": not is_error,
                "output": output_text
            })
        )
        db.add(exec_msg)
        db.commit()

        return {
            "success": not is_error,
            "output": output_text,
            "tool": request.tool_name
        }
    except Exception as e:
        print(f"Remediation Execution Error: {e}")
        # Save error to DB
        error_msg = models.Message(
            conversation_id=request.conversation_id,
            role="assistant",
            type="remediation_result",
            content=json.dumps({
                "intent": request.intent,
                "tool_name": request.tool_name,
                "success": False,
                "output": str(e)
            })
        )
        db.add(error_msg)
        db.commit()

@app.post("/api/remediation/dismiss")
async def dismiss_remediation(request: RemediationExecuteRequest, db: Session = Depends(get_session)):
    # Save dismissal to DB
    dismiss_msg = models.Message(
        conversation_id=request.conversation_id,
        role="assistant",
        type="remediation_result",
        content=json.dumps({
            "intent": request.intent,
            "tool_name": request.tool_name,
            "success": False,
            "dismissed": True,
            "output": "方案已被用户拒绝"
        })
    )
    db.add(dismiss_msg)
    db.commit()
    return {"success": True}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)

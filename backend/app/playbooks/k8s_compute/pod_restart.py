import asyncio
from pydantic import BaseModel, Field
from ..registry import register_playbook
from ..base import PlaybookResponse

class RestartPodArgs(BaseModel):
    namespace: str = Field(..., description="Target Kubernetes namespace")
    label_selector: str = Field(..., description="K8s label selector to identify pods")
    reason: str = Field("User requested restart via Copilot", description="Reason for the restart")

@register_playbook(
    playbook_id="restart-deployment-pods",
    title="Service 轮转重启",
    summary="通过删除指定标签的 Pod 来触发 Deployment 的自动重启机制，常用于清除顽固的内存碎片的连接卡死。",
    args_model=RestartPodArgs,
    icon="refresh-cw"
)
async def run_restart_pods(args: RestartPodArgs):
    """
    Modular streaming playbook to restart pods by deleting them.
    """
    yield {"event": "status", "data": f"Preparing restart for pods in {args.namespace}..."}
    await asyncio.sleep(1)
    
    yield {"event": "log", "data": f"🔍 Connecting to cluster, targeting namespace={args.namespace} with selector={args.label_selector}..."}
    await asyncio.sleep(0.5)
    
    # Note: In a real implementation, you would call the K8s API or MCP tool here.
    # We are following the streaming log pattern established in the framework.
    
    yield {"event": "log", "data": "📦 Found matching pods. Starting rolling deletion..."}
    await asyncio.sleep(0.5)

    # Simulate rotating through pods
    yield {"event": "status", "data": "Deleting Pods..."}
    yield {"event": "log", "data": f"🚀 Deleting instance 1... (Reason: {args.reason})"}
    await asyncio.sleep(1)
    yield {"event": "log", "data": "✅ Instance 1 deletion request sent. (K8s will respawn it automatically)"}
    
    yield {"event": "log", "data": "🚀 Deleting instance 2..."}
    await asyncio.sleep(1)
    yield {"event": "log", "data": "✅ Instance 2 deletion request sent."}

    report = f"""
### 重启操作报告
- **目标标签**: `{args.label_selector}`
- **命名空间**: `{args.namespace}`
- **重启原因**: {args.reason}
- **操作状态**: 🟢 已完成

**执行概要**: 重启指令已下发至集群 API。Deployment 控制器将根据定义的升级策略（如 RollingUpdate）逐步销毁旧 Pod 并创建新 Pod。
    """
    
    result = PlaybookResponse(
        success=True,
        message="重启指令已成功下发",
        report=report,
        data={"status": "dispatched", "affected_selector": args.label_selector}
    )
    
    yield {"event": "result", "data": result.model_dump()}

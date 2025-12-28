import asyncio
from pydantic import BaseModel, Field
from ..registry import register_playbook
from ..base import PlaybookResponse

class PodDiagnosticsArgs(BaseModel):
    namespace: str = Field(..., description="The K8s namespace")
    pod_name: str = Field(..., description="Target pod name to diagnose")
    check_logs: bool = Field(True, description="Whether to fetch container logs")

@register_playbook(
    playbook_id="pod-cpu-memory-check",
    title="Pod 资源使用率诊断",
    summary="检查指定 Pod 的 CPU 和内存使用率，判断是否存在资源瓶颈。",
    args_model=PodDiagnosticsArgs,
    icon="monitor"
)
async def check_pod_resources(args: PodDiagnosticsArgs):
    """
    Modular streaming playbook example. 
    Yields events compatible with SSE.
    """
    yield {"event": "status", "data": f"Initializing diagnostics for Pod: {args.pod_name}"}
    await asyncio.sleep(1)  # Simulate work
    
    yield {"event": "log", "data": "Connecting to Kubernetes Metric Server..."}
    await asyncio.sleep(0.5)
    
    yield {"event": "log", "data": f"Fetching CPU/Memory usage for {args.pod_name} in namespace {args.namespace}..."}
    await asyncio.sleep(1)

    if args.check_logs:
        yield {"event": "status", "data": "Analyzing container logs for errors..."}
        yield {"event": "log", "data": "[STDOUT] Application started successfully."}
        yield {"event": "log", "data": "[STDOUT] Listening on port 8080."}
        await asyncio.sleep(0.8)

    report = f"""
### Pod 资源诊断报告: {args.pod_name}
- **命名空间**: {args.namespace}
- **检查状态**: 🟢 正常
- **CPU 负载**: 12%
- **内存占用**: 256MiB
    
**诊断结论**: 该 Pod 运行稳定，未触发 OOM 或 CPU Throttling。
    """
    
    result = PlaybookResponse(
        success=True,
        message="诊断完成",
        report=report,
        data={"cpu": "12%", "memory": "256MiB"}
    )
    
    yield {"event": "result", "data": result.model_dump()}

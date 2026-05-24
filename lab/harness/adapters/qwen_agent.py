from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from dotenv import load_dotenv

from ..types import HarnessRunResult, ModelConfig, ScenarioDefinition
from ..utils import canonical_tool_name, utc_timestamp
from .base import HarnessAdapter


class QwenAgentAdapter(HarnessAdapter):
    name = "qwen-agent"

    def run(self, scenario: ScenarioDefinition, model_config: ModelConfig) -> HarnessRunResult:
        backend_dir = self.repo_root / "apps" / "backend"
        if str(backend_dir) not in sys.path:
            sys.path.insert(0, str(backend_dir))

        from app.config import ENV_FILE  # type: ignore
        from app.lab import LabInvestigationRequest, build_lab_prompt  # type: ignore

        load_dotenv(ENV_FILE, override=False)
        request = LabInvestigationRequest(
            namespace=scenario.namespace,
            serviceEntry=scenario.service_entry,
            promptOverride=scenario.prompt_override or None,
            requestParams=scenario.request_params,
        )
        prompt, service_entry, request_params = build_lab_prompt(request)

        legacy_dir = self.repo_root / "lab" / "legacy" / "qwen-agent"
        python_bin = legacy_dir / ".venv" / "bin" / "python"
        if not python_bin.exists():
            raise RuntimeError(
                f"Qwen-Agent adapter expects a dedicated virtualenv at {python_bin}. "
                "Create it inside lab/legacy/qwen-agent first."
            )

        env = os.environ.copy()
        env["QWEN_AGENT_MODEL"] = model_config.model_name
        env["QWEN_AGENT_BASE_URL"] = model_config.base_url
        env["QWEN_AGENT_API_KEY"] = model_config.api_key

        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as handle:
            handle.write(prompt)
            prompt_path = handle.name

        started_at = utc_timestamp()
        started = time.perf_counter()
        try:
            proc = subprocess.run(
                [str(python_bin), "run_qwen_agent.py", "--namespace", scenario.namespace, "--prompt-file", prompt_path],
                cwd=str(legacy_dir),
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
        finally:
            try:
                os.unlink(prompt_path)
            except OSError:
                pass

        if proc.returncode != 0:
            raise RuntimeError(
                f"Qwen-Agent run failed with exit code {proc.returncode}.\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
            )

        payload = json.loads(proc.stdout)
        duration_seconds = time.perf_counter() - started
        tool_calls = [
            {
                "toolName": canonical_tool_name(call.get("tool_name", "")),
                "arguments": call.get("arguments"),
                "resultRaw": call.get("result_raw", ""),
                "result": call.get("result"),
            }
            for call in payload.get("tool_calls", [])
        ]

        return HarnessRunResult(
            adapter=self.name,
            scenario=scenario.name,
            model={
                "label": model_config.label or model_config.model_name,
                "modelName": model_config.model_name,
                "baseUrl": model_config.base_url,
                "temperature": model_config.temperature,
            },
            started_at=started_at,
            duration_seconds=round(duration_seconds, 3),
            summary=(payload.get("sections", {}) or {}).get("根因判断", "") or (payload.get("sections", {}) or {}).get("当前症状", ""),
            sections=payload.get("sections", {}),
            tool_calls=tool_calls,
            raw_markdown=payload.get("final_markdown", ""),
            metadata={
                "serviceEntry": service_entry,
                "requestParams": request_params,
                "namespace": scenario.namespace,
            },
        )

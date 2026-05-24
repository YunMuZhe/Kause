from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

from ..types import HarnessRunResult, ModelConfig, ScenarioDefinition
from ..utils import open_mcp_session, utc_timestamp
from .base import HarnessAdapter


class OpenAIToolsAdapter(HarnessAdapter):
    name = "openai-tools"

    def run(self, scenario: ScenarioDefinition, model_config: ModelConfig) -> HarnessRunResult:
        return asyncio.run(self._run_async(scenario, model_config))

    async def _run_async(self, scenario: ScenarioDefinition, model_config: ModelConfig) -> HarnessRunResult:
        backend_dir = self.repo_root / "apps" / "backend"
        if str(backend_dir) not in sys.path:
            sys.path.insert(0, str(backend_dir))

        from app.config import ENV_FILE  # type: ignore
        from app.lab import LabInvestigationRequest, run_lab_investigation  # type: ignore

        load_dotenv(ENV_FILE, override=False)

        request = LabInvestigationRequest(
            namespace=scenario.namespace,
            serviceEntry=scenario.service_entry,
            promptOverride=scenario.prompt_override or None,
            requestParams=scenario.request_params,
        )
        client = OpenAI(
            api_key=model_config.api_key,
            base_url=model_config.base_url,
        )

        started_at = utc_timestamp()
        started = time.perf_counter()
        async with open_mcp_session(self.repo_root) as session:
            payload = await run_lab_investigation(
                client=client,
                model_name=model_config.model_name,
                temperature=model_config.temperature,
                mcp_session=session,
                request=request,
            )
        duration_seconds = time.perf_counter() - started

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
            summary=payload.get("summary", ""),
            sections=payload.get("sections", {}),
            tool_calls=payload.get("toolCalls", []),
            raw_markdown=payload.get("rawMarkdown", ""),
            trace_evidence=payload.get("traceEvidence", []),
            db_evidence=payload.get("dbEvidence", []),
            metadata={
                "serviceEntry": payload.get("serviceEntry", scenario.service_entry),
                "requestParams": payload.get("requestParams", scenario.request_params),
                "namespace": payload.get("namespace", scenario.namespace),
            },
        )

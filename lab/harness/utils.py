from __future__ import annotations

import os
import shlex
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, AsyncIterator

if TYPE_CHECKING:
    from mcp import ClientSession


def discover_repo_root(start: Path | None = None) -> Path:
    current = (start or Path(__file__)).resolve()
    for candidate in [current, *current.parents]:
        if (candidate / "apps" / "backend").exists() and (candidate / "lab").exists():
            return candidate
    raise RuntimeError("Unable to locate repository root from harness paths.")


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(value: str) -> str:
    safe = [ch.lower() if ch.isalnum() else "-" for ch in value.strip()]
    slug = "".join(safe)
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-") or "run"


def normalize_text(value: object) -> str:
    if value is None:
        return ""
    return " ".join(str(value).lower().split())


def canonical_tool_name(tool_name: str) -> str:
    if not tool_name:
        return tool_name
    if "-" in tool_name:
        _, remainder = tool_name.split("-", 1)
        if "_" in remainder:
            return remainder
    return tool_name


@asynccontextmanager
async def open_mcp_session(repo_root: Path, kubeconfig: str | None = None) -> AsyncIterator["ClientSession"]:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    env = os.environ.copy()
    resolved_kubeconfig = kubeconfig or env.get("KUBECONFIG") or str(Path.home() / ".kube" / "config")
    env["KUBECONFIG"] = resolved_kubeconfig

    server_dir = repo_root / "apps" / "mcp-server"
    server_binary = server_dir / "mcp-server"

    prefer_binary = os.environ.get("HARNESS_USE_MCP_BINARY", "").strip().lower() in {"1", "true", "yes"}

    if prefer_binary and server_binary.exists():
        server_params = StdioServerParameters(
            command=str(server_binary),
            args=[],
            env=env,
        )
    else:
        shell_command = f"cd {shlex.quote(str(server_dir))} && go run ./main.go"
        server_params = StdioServerParameters(
            command="/bin/sh",
            args=["-lc", shell_command],
            env=env,
        )

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session

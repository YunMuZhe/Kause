# Qwen-Agent Integration

This directory is now a legacy integration path. The main product UI lives in `apps/frontend` + `apps/backend`.

This folder wires your existing Kause MCP server into a local Qwen-Agent workflow.

## What it does

`run_qwen_agent.py`:

1. starts `apps/mcp-server/main.go` through stdio
2. registers all MCP tools into Qwen-Agent via `mcpServers`
3. runs a real investigation prompt against namespace `kube-copilot-lab`

## Setup

```bash
cd lab/legacy/qwen-agent
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

## Provider choices

For DashScope / Qwen:

```bash
QWEN_AGENT_MODEL=qwen-max
QWEN_AGENT_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_AGENT_API_KEY=your_dashscope_key
```

For MiniMax OpenAI-compatible endpoint:

```bash
QWEN_AGENT_MODEL=MiniMax-M1
QWEN_AGENT_BASE_URL=https://api.minimax.chat/v1
QWEN_AGENT_API_KEY=your_minimax_key
```

## Run

```bash
source .venv/bin/activate
python run_qwen_agent.py
```

The output is a structured JSON object that includes:

- `tool_calls`: every MCP tool invocation with arguments and result
- `sections`: extracted final sections such as `当前症状` and `根因判断`
- `final_markdown`: the original final answer from Qwen-Agent

## Web UI

If you want a local page to trigger an investigation and read the result more easily:

```bash
source .venv/bin/activate
python webapp.py
```

Then open [http://127.0.0.1:18080](http://127.0.0.1:18080).

If you use `qwen-agent==0.0.34`, note that some runtime dependencies are not pulled in transitively by the package itself. The pinned `requirements.txt` in this directory includes the missing packages used by this demo (`numpy`, `soundfile`, `python-dateutil`, `mcp`).

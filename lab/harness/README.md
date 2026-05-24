# Harness

Harness is the repeatable benchmark layer for the lab.

It gives you one place to:

- define incident scenarios as YAML
- run the same scenario through one or more agent adapters
- score the output against expected root cause and tool path
- save raw artifacts for later comparison

## Layout

- `run_benchmark.py`: CLI entrypoint
- `adapters/`: runner implementations
- `evaluators.py`: basic scoring logic
- `../scenarios/*.yaml`: benchmark scenarios
- `output/`: generated benchmark reports

## Adapters

Current adapters:

- `openai-tools`: uses the current `apps/backend/app/lab.py` tool-calling investigation loop
- `qwen-agent`: uses the legacy `lab/legacy/qwen-agent` runner, if its dedicated virtualenv exists

## Usage

The easiest way is to use the wrapper script. It creates a dedicated harness virtualenv and installs the shared backend dependencies automatically:

```bash
./lab/harness/run.sh --list-scenarios
```

Run one scenario:

```bash
./lab/harness/run.sh --scenario slow-sql
```

Run two adapters on the same scenario:

```bash
./lab/harness/run.sh \
  --scenario null-pointer \
  --adapter openai-tools \
  --adapter qwen-agent
```

Run a model matrix from a config file:

```bash
cp ./lab/harness/models.example.yaml ./lab/harness/models.yaml
# edit env var names or labels if needed

./lab/harness/run.sh \
  --scenario slow-sql \
  --model-config lab/harness/models.yaml
```

You can still run the Python module directly if you prefer managing the environment yourself:

```bash
python -m lab.harness.run_benchmark --list-scenarios
```

Override model settings explicitly:

```bash
python -m lab.harness.run_benchmark \
  --scenario db-timeout \
  --model-name MiniMax-M2.7 \
  --base-url https://api.minimax.chat/v1 \
  --api-key your_key
```

## First practical goal

The first harness milestone is simple:

1. the same fault scenario can be replayed repeatably
2. different agent stacks can be compared on the same evidence trail
3. every run leaves a JSON + Markdown artifact for later review

## Trace quality

The harness now expects trace evidence to look like real business traffic rather than only health checks.

The MCP trace query supports:

- `exclude_http_routes`
- `http_route_contains`
- `db_query_label_contains`

The current lab prompt nudges the agent to:

- filter out `/healthz` and `/readyz`
- focus on the current business route
- use `queryLabel` from the probe response when investigating slow SQL

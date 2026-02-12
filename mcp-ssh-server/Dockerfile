FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Standard MCP servers communicate over stdio
ENTRYPOINT ["python", "main.py"]

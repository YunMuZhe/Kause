# ☸️ Kause

![Kause Slogan](static/slogan.png)

> **K8S-cause: Find the cause, fix the pause.** Your AI-Powered SRE Teammate.

[![Go Report Card](https://goreportcard.com/badge/github.com/mark3labs/mcp-go)](https://goreportcard.com/report/github.com/mark3labs/mcp-go)
![Python](https://img.shields.io/badge/python-v3.10+-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green)
![Status](https://img.shields.io/badge/status-active-success.svg)

[🇨🇳 中文文档](README_CN.md)

---

## 😫 The Pain: Why Kause?

- **"Ever spent 2 hours debugging a `CrashLoopBackOff` only to find a typo?"**
- **"Need to fix production but terrified of copy-pasting the wrong `kubectl patch`?"**
- **"Drowning in alerts but starving for context?"**

Kubernetes is powerful, but troubleshooting it is often manual, repetitive, and error-prone. You need more than a dashboard; you need a teammate.

## 🚀 The Solution: AI Detective & Surgeon

**Kause** isn't just a chatbot; it's an **Agentic System** that interacts directly with your cluster using the Model Context Protocol (MCP).

### ✨ Key Features

#### 🕵️ AI Detective (Sherlock Mode)
Instead of asking you to paste logs, Kause **goes and looks for itself**.
- **Deep Investigation**: Automatically fetches Pod status, Logs, Events, and YAML specs.
- **Context-Aware**: Understands service dependencies and cluster topology.
- **Root Cause Analysis**: Correlates events (e.g., "OOMKilled") with logs ("Out of memory error") to tell you *why*, not just *what*.

![AI Detective Demo](static/demo-detective.png)

#### 🩺 Auto-Surgeon (Precisely Fix It)
Once the problem is found, Kause doesn't just say "fix it"; it **writes the fix for you**.
- **JSON Patch Generation**: Generates precise, RFC 6902 compliant JSON Patches to modify resources surgically.
- **Validation**: Ensures patches are syntactically correct before proposing them.

![Auto Surgeon Demo](static/demo-prescription.png)

#### 🛡️ Human-in-the-Loop (Safety First)
We believe in **AI assistance, not AI dominance**.
- **Preview Before Apply**: See exactly what will change (Git-style Diff) before any write operation happens.
- **Strict Approval**: No patch is applied without your explicit confirmation.
- **Audit Logs**: Every action is recorded.

![Safety Preview Demo](static/demo-safety-preview.png)

#### ✅ Operation Complete
The fix is applied, and Kause verifies the cluster state.

![Success Demo1](static/success.png)
![Success Demo2](static/success-pod-yaml.png)

---

## 🏗️ Architecture

Kause uses a modular architecture separating the Brain (LLM), the Body (Backend), and the Hands (MCP Server).

```mermaid
graph TD
    User["User / Frontend"] -->|Config & Commands| Backend["Python Backend (The Brain)"]
    Backend -->|LLM Context| Gemini["Alibaba Qwen / OpenAI Models"]
    Backend -->|MCP Tool Calls| MCP["Go MCP Server (The Hands)"]
    MCP -->|K8s API| K8s["Kubernetes Cluster"]
    
    subgraph "Safe Execution Boundary"
        MCP
    end
    
    style User fill:#e3f2fd,stroke:#1565c0,stroke-width:2px,color:#0d47a1
    style Backend fill:#fff3e0,stroke:#ef6c00,stroke-width:2px,color:#e65100
    style MCP fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:#1b5e20
    style K8s fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px,color:#4a148c
```

---

## ⚡ Quick Start

### Prerequisites
- Docker & Docker Compose
- A Kubernetes cluster (OrbStack, Minikube, or remote)
- `~/.kube/config` accessible

### 1. Clone & Setup
```bash
git clone https://github.com/your-username/kube-cluster-copilot.git
cd kube-cluster-copilot
```

### 2. Configure Secrets
Create a `.env` file in `backend/`:
```bash
cp backend/.env.example backend/.env
# Edit backend/.env and add your LLM API Key (e.g., Qwen/Dashscope, OpenAI)
# APP_LLM__API_KEY=sk-xxx
# APP_LLM__MODEL_NAME=qwen-max
```

### 3. Launch
```bash
docker-compose up --build
```

Access the UI at `http://localhost:5173`.

---

## 🤝 Contributing
We love PRs! Please check out our [Contributing Guide](CONTRIBUTING.md).

## 📄 License
MIT © 2024 Kube Cluster Copilot Team.

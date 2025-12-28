# 贡献指南

感谢您对 Kause 的关注！我们非常欢迎任何形式的贡献，包括提交 Bug、修复代码、改进文档或提出新功能建议。

在开始贡献之前，请花几分钟阅读以下指南。

## 🛠 开发环境搭建

本项目由三个主要部分组成：
1.  **Backend** (Python / FastAPI)
2.  **Frontend** (React / Vite)
3.  **MCP Server** (Go)

### 前置要求
*   Docker & Docker Compose
*   Node.js 18+
*   Python 3.10+
*   Go 1.21+

### 本地启动

最简单的方式是使用 Docker Compose 启动依赖服务（如 MySQL），然后在本地运行各个组件以便于调试。

1.  **启动基础服务**
    ```bash
    docker-compose up -d mysql
    ```

2.  **启动后端**
    ```bash
    cd backend
    pip install -r requirements.txt
    cp .env.example .env # 配置您的 API Key
    uvicorn app.main:app --reload
    ```

3.  **启动前端**
    ```bash
    cd frontend
    npm install
    npm run dev
    ```

4.  **编译 MCP Server**
    ```bash
    cd mcp-server
    go build -o mcp-server main.go
    # 确保后端 .env 中 APP_GO_SERVER_PATH 指向此二进制文件
    ```

## 🤝 Pull Request 流程

1.  **Fork** 本仓库到您的 GitHub 账户。
2.  **Clone** 您的 Fork 版本到本地。
3.  创建新的分支：`git checkout -b fix/your-bug-fix` 或 `git checkout -b feat/your-feature`。
4.  提交您的修改。请确保代码风格与项目保持一致。
5.  **测试**：确保您的修改没有破坏现有功能。
    *   前端：`npm run build` 确保构建成功。
    *   后端/MCP：确保服务能正常启动且无报错。
6.  提交 Pull Request (PR) 到 `main` 分支。
7.  在 PR 描述中详细说明您的修改内容和原因。

## 📝 编码规范

### Python (Backend)
*   遵循 PEP 8 规范。
*   使用 Type Hints (类型提示)。

### TypeScript (Frontend)
*   使用 Functional Components 和 Hooks。
*   确保无 ESLint 错误。

### Go (MCP Server)
*   遵循标准 Go 代码规范 (`gofmt`)。

### Commit 信息
请使用清晰的提交信息，推荐格式：
*   `feat: 添加了用户登录功能`
*   `fix: 修复了补丁生成的空指针错误`
*   `docs: 更新了 README 文档`

## 🐛 提交 Issue

如果您发现了 Bug 或有新功能建议，欢迎提交 Github Issue。请尽量提供以下信息：
*   复现步骤
*   预期行为 vs 实际行为
*   相关日志或截图
*   环境信息 (OS, K8s 版本等)

再次感谢您的贡献！🚀

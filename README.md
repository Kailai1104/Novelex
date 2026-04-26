<p align="center">
  <img src="./icon.jpg" alt="Novelex icon" width="240" />
</p>

<h1 align="center">Novelex</h1>

<p align="center">
  面向长篇网络小说创作的本地优先写作工作台
</p>

<p align="center">
  把大纲、章节细纲、正文、人审、审计、检索和状态更新组织成一条可追踪的长篇写作流水线。
</p>

<p align="center">
  <a href="https://github.com/Kailai1104/Novelex"><img src="https://img.shields.io/badge/GitHub-Kailai1104%2FNovelex-181717?logo=github" alt="GitHub"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/react-19-149ECA?logo=react&logoColor=white" alt="React 19">
  <img src="https://img.shields.io/badge/workflow-human--in--the--loop-0969da" alt="Human in the loop">
  <img src="https://img.shields.io/badge/storage-local--first-2ea44f" alt="Local first">
</p>

<p align="center">
  <a href="#特性">特性</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#使用流程">使用流程</a> ·
  <a href="#目录结构">目录结构</a> ·
  <a href="#license">License</a>
</p>

Novelex 适合需要同时管理大纲、章节状态、参考资料和人工审查节点的长篇创作场景，并把关键中间产物直接保存在本地文件系统中。

## 特性

- 多项目工作区：每个项目独立维护 `runtime` 和 `novel_state`。
- 两阶段写作流程：`Plan` 负责大纲与设定，`Write` 负责章节细纲、正文、审计与锁章。
- Human-in-the-loop：大纲草稿、最终大纲、章节细纲、章节正文都需要人工审查。
- 本地状态可追踪：运行记录、审查记录、staging 产物、章节状态和角色状态均可直接查看。
- 风格指纹：可从样文提取风格特征，并绑定到项目。
- 共享参考库：支持范文 RAG 库和“黄金开头”参考库，按项目绑定。
- 连续性护栏：已批准章节会提取 `fact_ledger`，后续章节在生成和审计时会继承这些既定事实。
- MCP 集成：支持 `web_search` 研究链路和本地 `local_rag` 工具。
- 人工干预能力：支持细纲候选重选/重生、章节手工修改、重写与删除最近锁章。

## 技术栈

- Node.js 20+
- React 19
- Vite 8
- 原生 Node HTTP 服务端
- 默认使用 OpenAI Responses API，也支持通过 `novelex.codex.toml` 配置其他模型提供方

## 快速开始

### 1. 安装依赖

```bash
npm install
cp novelex.codex.example.toml novelex.codex.toml
```

### 2. 配置模型与索引服务

编辑根目录的 `novelex.codex.toml`：

- 至少配置一个可用模型提供方的 API Key。
- 如果需要重建范文库或开头参考库，需配置 `zhipu_api_key`，或设置环境变量 `ZHIPU_API_KEY`。
- 如果需要章节研究检索，确认 `mcp.servers.web_search` 可用。

示例配置可直接参考 [novelex.codex.example.toml](./novelex.codex.example.toml)。

### 3. 构建前端并启动

```bash
npm run build:frontend
npm start
```

启动后访问 `http://127.0.0.1:3000`。

说明：`npm start` 会直接服务 `dist/frontend`，如果没有先执行 `npm run build:frontend`，服务端会返回前端未构建的提示。

## 开发模式

后端和前端分开启动：

```bash
npm run dev
npm run dev:frontend
```

- 后端默认运行在 `127.0.0.1:3000`
- 前端开发服务器默认运行在 `127.0.0.1:5173`
- Vite 已将 `/api` 代理到后端

## 配置说明

`novelex.codex.toml` 是项目的核心配置文件，主要包含以下几类信息：

- 模型提供方：`model_provider`、`model_providers.*`
- 主/副 Agent 模型槽位：`agent_models.primary`、`agent_models.secondary`
- MCP 服务：`mcp.servers.web_search`、`mcp.servers.local_rag`
- 向量化配置：`zhipu_api_key`

默认示例里已经包含：

- `OpenAI`
- `MiniMax`
- `Gemini`
- `web_search` MCP
- `local_rag` MCP

是否实际可用取决于你填写的密钥、Base URL 和本地命令环境。

## 使用流程

### 1. 创建项目

在 UI 中新建项目并填写基础信息，包括题材、设定、前提、主题、主角目标、总章节数和每章字数目标。

### 2. 绑定可选资源

按需创建并绑定以下共享资源：

- 风格指纹
- 范文 RAG 库
- 开头参考库

其中范文库和开头参考库需要先将 `.txt` / `.md` 文件放入各自的 `sources/` 目录，再执行重建索引。

### 3. 运行 Plan

`Plan` 阶段是两步式流程：

1. 首次运行 `Plan`，生成大纲草稿并进入 `plan_draft` 待审。
2. 审核通过后再次运行 `Plan`，生成最终大纲包并进入 `plan_final` 待审。
3. 最终审核通过后，内容会提交到 `novel_state` 并锁定。

### 4. 运行 Write

`Write` 阶段同样带有人审节点：

1. 先生成 2 到 5 份章节细纲候选。
2. 你可以直接采用单个候选，也可以组合多个候选中的场景。
3. 系统据此生成章节正文、审计结果和相关上下文包。
4. 审核通过后，章节会正式提交；否则可重写或手工修改。

### 5. 提交后的自动更新

章节批准后，系统会同步更新：

- `novel_state/chapters/*`
- `world_state.json`
- 角色状态文件
- `foreshadowing_registry.json`
- `fact_ledger.json`

## 目录结构

运行后，仓库的核心结构大致如下：

```text
.
├── frontend/                  # React + Vite 前端
├── src/                       # 后端、编排、检索、MCP、核心逻辑
├── projects/
│   └── <project-id>/
│       ├── runtime/
│       │   ├── project-state.json
│       │   ├── runs/
│       │   ├── reviews/
│       │   └── staging/
│       └── novel_state/
│           ├── outline.md
│           ├── structure.md
│           ├── worldbuilding.md
│           ├── style_guide.md
│           ├── world_state.json
│           ├── foreshadowing_registry.json
│           ├── fact_ledger.json
│           ├── chapters/
│           └── characters/
├── runtime/
│   ├── style_fingerprints/    # 工作区共享风格指纹
│   ├── rag_collections/       # 工作区共享范文库
│   └── opening_collections/   # 工作区共享开头参考库
└── novelex.codex.toml
```

## 测试

```bash
npm test
```

## 注意事项

- 服务端一次只允许一个写操作进行中，避免并发改写项目状态。
- 范文库和开头参考库的“重建索引”依赖智谱 embedding；未配置时不会成功建索引。
- 项目以文件系统为核心状态源，而不是数据库；建议自行接入版本控制备份 `projects/` 与 `runtime/`。

## License

本项目采用 `PolyForm Noncommercial 1.0.0`，仅允许非商业用途。详见 [LICENSE](./LICENSE)。

说明：该许可证属于 source-available 许可证，不属于 OSI 定义下的开源许可证。

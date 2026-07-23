# opencode-dashboard

AI Coding Token 用量实时看板，支持 openCode / Claude Code 等多源数据聚合。

## 快速开始

```bash
npm install
npm start        # 默认 http://localhost:3456
```

## 配置

编辑 `config.json`（首次从 `config.example.json` 复制）：

```json
{
  "port": 3456,
  "sources": {
    "opencode": "~/.local/share/opencode/opencode.db",
    "claude": "~/.claude/projects"
  }
}
```

也可用环境变量覆盖：`PORT`、`OPENCODE_DB`、`CLAUDE_DIR`。

## 目录结构

```
opencode-dashboard/
├── config.example.json   ← 配置模板
├── config.json           ← 本地配置（不纳入 git）
├── server.mjs            ← Node 服务（需 Node ≥22.5）
├── index.html            ← 前端看板
├── package.json
└── README.md
```

## 命令

| 命令 | 说明 |
|------|------|
| `node server.mjs` | 启动服务 |
| `npm start` | 同上 |

## 技术栈

- Node.js ≥22.5
- 纯前端 HTML + CSS + JS（无框架依赖）
- SQLite（通过 `better-sqlite3` 读取 opencode 数据）

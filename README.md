# Claude Bridge

Node.js 原生 Claude API 中转服务。使用官方 Anthropic SDK 维护多个 Claude 账号 session，对外暴露 Anthropic API 兼容接口。

## 特性

- 🔑 **多账号管理** - 支持 Session Key 和 OAuth Token
- 🔄 **负载均衡** - 最少连接数策略，支持粘性会话
- 🛡️ **进程隔离** - 每个账号独立子进程（child_process.fork）
- 🌐 **独立代理** - 每账号可配置 SOCKS5/HTTP 代理
- 📊 **用量统计** - 按账号/按天/按模型统计
- 💓 **自动保活** - 心跳检测 + Token 过期检测 + 自动重启
- 🎛️ **管理面板** - 精美的暗色主题 Web UI
- ⚡ **流式支持** - SSE 流式响应
- 🔒 **限速控制** - RPM / 并发数 / 请求间隔

## 快速开始

### 安装

```bash
git clone <repo-url> claude-bridge
cd claude-bridge
npm install
```

### 配置

复制配置文件：
```bash
cp config.example.json config.json
```

编辑 `config.json` 设置你的参数，或通过环境变量：

```bash
export BRIDGE_API_KEY=your-api-key        # API 认证密钥
export BRIDGE_ADMIN_TOKEN=your-admin-token # 管理面板密码
```

### 启动

```bash
# 直接启动
node src/index.js

# 使用环境变量
BRIDGE_API_KEY=sk-xxx BRIDGE_ADMIN_TOKEN=admin123 node src/index.js

# PM2 部署
pm2 start src/index.js --name claude-bridge
```

### 访问

- **管理面板**: http://localhost:3456
- **API 端点**: http://localhost:3456/v1/messages

## API 使用

完全兼容 Anthropic API 格式：

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-bridge-api-key" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### 流式请求

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-bridge-api-key" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## 管理面板

Web UI 包含 5 个页面：

| 页面 | 功能 |
|------|------|
| 概览 | 在线状态、今日统计、账号状态卡片 |
| 账号管理 | 添加/编辑/删除账号、测试连通性、启用/禁用 |
| 配置 | API Key 管理、全局限速、心跳间隔等 |
| 用量统计 | 每日请求图表、Token 消耗、按账号统计 |
| 日志 | 实时日志流（WebSocket）、级别过滤 |

## 架构

```
主进程 (Master)
├── Fastify API 网关 (port 3456)
├── 静态文件服务 (管理面板)
├── 调度器 (负载均衡)
├── 健康检查器
│
├── Worker 1 (child_process.fork)
│   ├── Anthropic SDK 实例
│   ├── 独立代理
│   └── 心跳定时器
├── Worker 2 ...
└── Worker N ...
```

## 文件结构

```
claude-bridge/
├── src/
│   ├── index.js           # 入口
│   ├── server.js          # Fastify API 网关
│   ├── scheduler.js       # 负载均衡调度器
│   ├── worker.js          # Worker 子进程
│   ├── worker-manager.js  # Worker 生命周期管理
│   ├── db.js              # SQLite 数据库
│   ├── auth.js            # 认证中间件
│   ├── usage.js           # 用量统计
│   ├── rate-limiter.js    # 限速器
│   └── logger.js          # 日志
├── public/
│   └── index.html         # 管理面板 (Vue 3 + Tailwind CSS)
├── data/
│   └── bridge.db          # SQLite 数据库文件 (自动创建)
├── config.json            # 配置文件
├── config.example.json    # 配置示例
├── package.json
└── README.md
```

## 技术栈

- **运行时**: Node.js 22+
- **框架**: Fastify 5
- **SDK**: @anthropic-ai/sdk
- **数据库**: SQLite (better-sqlite3, WAL 模式)
- **前端**: Vue 3 CDN + Tailwind CSS CDN
- **代理**: https-proxy-agent / socks-proxy-agent

## 部署

### Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3456
CMD ["node", "src/index.js"]
```

### systemd

```ini
[Unit]
Description=Claude Bridge
After=network.target

[Service]
Type=simple
User=claude
WorkingDirectory=/opt/claude-bridge
ExecStart=/usr/bin/node src/index.js
Restart=always
Environment=BRIDGE_API_KEY=xxx
Environment=BRIDGE_ADMIN_TOKEN=xxx

[Install]
WantedBy=multi-user.target
```

## License

MIT

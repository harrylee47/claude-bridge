# Claude Bridge - 项目需求文档

## 项目概述
Node.js 原生 Claude API 中转服务，使用真实的 Node.js + 官方 Anthropic SDK 维护多个 Claude 账号 session，对外暴露 Anthropic API 兼容接口。
每个账号运行在独立的子进程中，支持独立代理配置，实现完全的进程隔离。

## 核心价值
- 使用真实的 Node.js 运行时（天然的 TLS 指纹）
- 使用官方 @anthropic-ai/sdk（真实的请求头和行为特征）
- 每个账号独立子进程（隔离 + 稳定性）
- 支持每账号独立代理（IP 多样化）
- 带管理面板的完整解决方案

## 技术栈
- **后端**: Node.js 22+ / Fastify
- **前端**: 单 HTML 文件，Vue 3 CDN + Tailwind CSS CDN，暗色主题，中文界面
- **存储**: SQLite (better-sqlite3)
- **进程管理**: Node.js child_process (fork)
- **SDK**: @anthropic-ai/sdk

## 架构设计

### 进程模型
```
主进程 (Master)
├── API 网关 (Fastify, port 3456)
├── 管理面板 (静态文件)
├── 调度器 (负载均衡)
├── 健康检查器
│
├── Worker 1 (child_process.fork)
│   ├── Anthropic SDK 实例
│   ├── 独立代理 (socks5/http proxy)
│   ├── Session 管理
│   └── 心跳定时器
├── Worker 2 ...
└── Worker N ...
```

### 主进程与 Worker 通信
使用 Node.js IPC (process.send / process.on):
- Master → Worker: `{type: 'request', id, body}` 转发请求
- Worker → Master: `{type: 'response', id, data}` 返回结果
- Worker → Master: `{type: 'stream', id, chunk}` 流式数据
- Worker → Master: `{type: 'heartbeat', status}` 心跳状态
- Master → Worker: `{type: 'config', config}` 更新配置

## 功能模块

### 1. 账号管理
- 添加账号: Session Key (cookie) 或 OAuth Token
- 每个账号可配置:
  - 名称/备注
  - 代理地址 (socks5/http, 可为空=直连)
  - 每分钟请求上限 (默认 10)
  - 最大并发数 (默认 2)
  - 请求间最小间隔 (默认 3 秒)
  - 启用/禁用
  - 指纹信息 (OS, arch, node version) — 可选，不填则随机生成
- 账号状态: online / offline / rate_limited / error
- 一键测试连通性

### 2. 负载均衡调度器
- 策略: least_connections (最少连接数优先)
- 粘性会话: 可选，同一 API Key 的请求优先分配到同一 Worker
- 跳过离线/禁用/限速中的账号
- 全部不可用时返回 503

### 3. 保活机制 (每个 Worker 内部)
- 心跳: 每 5 分钟调一次 `/api/organizations`
- Session 刷新: 每 12 小时尝试刷新 token
- 健康检查: 主进程每 1 分钟 ping Worker, 无响应重启
- Token 过期检测: 401 响应时标记离线, 通知管理员

### 4. API 网关
- 路由: POST /v1/messages
- 认证: Bearer token (环境变量 BRIDGE_API_KEY 或 SQLite 存储)
- 流式支持: SSE (text/event-stream)
- 非流式支持: JSON 响应
- 请求头透传: 保留客户端的 model 等参数
- 错误处理: 超时、Worker 崩溃、上游错误

### 5. 限速与安全
- 每账号: RPM (requests per minute), 并发上限, 请求间隔
- 全局: 总 RPM 上限
- 冷却时间: 被限速后自动冷却 N 秒
- 请求队列: 超过并发时排队等待

### 6. 用量统计
- 记录每个请求: 账号ID, 时间, 模型, input_tokens, output_tokens, 耗时
- 按账号/按天/按模型 聚合统计
- SQLite 存储, 保留 30 天

### 7. 管理面板 (Web UI)

#### 7.1 概览页
- 在线账号数 / 总账号数
- 当前活跃请求数
- 今日请求数 / token 消耗
- 各账号状态卡片 (在线/离线/限速, 最后心跳时间, 今日请求数)

#### 7.2 账号管理页
- 账号列表 (表格: 名称、状态、代理、今日请求、操作)
- 添加账号 (模态框: token类型、token值、代理、限速配置、指纹)
- 编辑账号
- 启用/禁用/删除
- 测试连通性按钮
- 查看账号详细状态 (心跳记录, 最近请求)

#### 7.3 配置页
- Bridge API Key 管理
- 全局限速设置
- 心跳间隔
- 冷却时间
- 监听地址和端口
- 日志级别

#### 7.4 用量统计页
- 按天折线图 (请求数, token消耗)
- 按账号柱状图
- 最近请求列表 (时间、账号、模型、tokens、耗时)

#### 7.5 日志页
- 实时日志流 (WebSocket)
- 日志级别过滤

### 界面设计
- 暗色主题 (类似 1Panel)
- 左侧导航栏 (图标+文字)
- 右侧内容区
- 模态框用于添加/编辑
- Toast 通知
- 登录页 (Token 认证)
- 响应式 (手机端顶部标签栏)

## 文件结构
```
claude-bridge/
├── src/
│   ├── index.js              # 入口, 启动主进程
│   ├── server.js             # Fastify API 网关
│   ├── scheduler.js          # 负载均衡调度器
│   ├── worker.js             # Worker 子进程逻辑
│   ├── worker-manager.js     # Worker 生命周期管理
│   ├── db.js                 # SQLite 数据库
│   ├── auth.js               # API Key 认证中间件
│   ├── usage.js              # 用量统计
│   ├── rate-limiter.js       # 限速器
│   └── logger.js             # 日志
├── public/
│   └── index.html            # 管理面板 (单页面)
├── package.json
├── config.example.json       # 配置示例
└── README.md
```

## 配置文件 (config.json)
```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 3456
  },
  "auth": {
    "apiKey": "your-bridge-api-key"
  },
  "defaults": {
    "rpm": 10,
    "maxConcurrency": 2,
    "minInterval": 3000,
    "heartbeatInterval": 300000,
    "sessionRefreshInterval": 43200000,
    "cooldownDuration": 60000
  },
  "scheduler": {
    "strategy": "least_connections",
    "stickySession": false
  },
  "usage": {
    "retentionDays": 30
  }
}
```

## 启动方式
```bash
npm install
BRIDGE_API_KEY=your-key node src/index.js
```

## 部署
- 支持 Docker 部署
- 支持 PM2 部署
- 支持 systemd 部署

## 注意事项
- Worker 子进程使用 @anthropic-ai/sdk, 确保 TLS 指纹为真实 Node.js
- 每个 Worker 使用 https-proxy-agent / socks-proxy-agent 走独立代理
- 流式响应要正确处理 SSE 格式和背压
- SQLite 用 WAL 模式提高并发性能
- 前端单文件, 所有 JS/CSS 通过 CDN 引入

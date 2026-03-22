# Claude Bridge 技术架构方案 v2

## 研究结论

### TLS 指纹检测情况
| 域名 | Cloudflare TLS 检测 | Node.js 可直连 | curl 可通过 |
|---|---|---|---|
| api.anthropic.com | ❌ 无 | ✅ 是 | ✅ 是 |
| claude.ai | ✅ 有 | ❌ 否（403） | ⚠️ 取决于版本 |
| platform.claude.com | ✅ 有 | ❌ 否（400） | ⚠️ 取决于版本 |

### Anthropic SDK 信息
- SDK baseURL: `https://api.anthropic.com`（无 TLS 检测）
- SDK 支持两种认证：
  - `apiKey` → 发送 `x-api-key` header（用于 API key）
  - `authToken` → 发送 `Authorization: Bearer` header（用于 OAuth token）
- OAuth token 应该用 `authToken` 参数（当前代码用 `apiKey`，需要修复）

## 两种模式架构

### 模式一：OAuth（模拟 Claude Code CLI）
**登录流程：**
1. 用户在浏览器打开授权链接 → 授权 → 拿到 code
2. curl 子进程交换 token（`platform.claude.com`，一次性）
3. 之后全部走 Anthropic SDK（`api.anthropic.com`，无 TLS 问题）

**SDK 初始化：**
```javascript
const client = new Anthropic({
  authToken: oauthAccessToken,  // 不是 apiKey！
  defaultHeaders: { 'user-agent': `claude-cli/${version}`, ... }
});
```

**Token 刷新：**
- curl 子进程请求 `platform.claude.com/v1/oauth/token`
- 用 refresh_token 换新的 access_token

### 模式二：Session Key（自动转 OAuth）
**登录流程（全程 curl，不需要浏览器）：**
1. curl → `claude.ai/api/organizations`（获取 org UUID）
2. curl → `claude.ai/v1/oauth/{org}/authorize`（自动授权获取 code）
3. curl → `platform.claude.com/v1/oauth/token`（交换 token）
4. 之后全部走 Anthropic SDK（同上）

**Session Key 过期处理：**
- 如果 Step 1 返回 401 → Session Key 过期
- 标记账号为 error 状态，通知用户更新 Session Key

### 两种模式初始化后完全一样
- 都用 Anthropic SDK（`api.anthropic.com`）
- 都不需要持续绕过 Cloudflare
- curl 只在初始化和 token 刷新时使用（低频）

## 需要修复的问题

### 1. SDK 认证方式（关键）
- ❌ 当前：`new Anthropic({ apiKey: oauthToken })`
- ✅ 应该：`new Anthropic({ authToken: oauthToken })`

### 2. Token 刷新（关键）
- ❌ 当前：用 node-fetch 请求 platform.claude.com（被 Cloudflare 拦截）
- ✅ 应该：用 curl 子进程（跟初始化一样）

### 3. 心跳方式
- 当前：messages.create（消耗 token）
- 后续优化：改用更轻量的方式（暂不急）

### 4. OAuth 前端流程
- 当前：需要用户手动操作多步
- 已验证 curl 格式正确（rate_limit_error = code 过期，不是限流）

## curl 调用规范

所有 curl 调用统一使用 `execFileSync` + 参数数组：
```javascript
function curlExec(args) {
  return execFileSync('curl', args, { encoding: 'utf8', timeout: 35000 });
}
```

### 请求头规范
- 不要带 `User-Agent: axios/1.8.4`（触发 Cloudflare）
- token 交换需要 `anthropic-version: 2023-06-01` + `anthropic-beta: oauth-2025-04-20`
- claude.ai 请求需要 `Cookie: sessionKey=xxx` + `Origin: https://claude.ai`

## Docker 要求
- Alpine 镜像需安装 curl：`RUN apk add --no-cache curl`

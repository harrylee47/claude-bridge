/**
 * server.js - Fastify API 网关
 * 提供 Anthropic API 兼容接口和管理 API
 */

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, randomBytes, createHash } from 'crypto';
import nodeFetch from 'node-fetch';

import logger, { logEmitter, getLogBuffer } from './logger.js';
import { apiAuth, adminAuth } from './auth.js';
import scheduler from './scheduler.js';
import workerManager from './worker-manager.js';
import rateLimiter from './rate-limiter.js';
import {
  getAllAccounts, getAccount, addAccount, updateAccount, deleteAccount,
  getEnabledAccounts, getAllConfig, setConfig, getConfig,
  getApiKeys, addApiKey, deleteApiKey, updateApiKeyAllowedAccounts,
} from './db.js';
import { getOverviewStats, getDailyStats, getAccountStats, getRecentRequests } from './usage.js';

// ============ OAuth PKCE 工具函数 ============

// 存储 PKCE code_verifier（内存中，用 state 关联）
const oauthPendingStates = new Map();

/**
 * 生成 PKCE code_verifier（43-128 字符的随机字符串）
 */
function generateCodeVerifier() {
  return randomBytes(32).toString('base64url');
}

/**
 * 生成 PKCE code_challenge（S256）
 */
function generateCodeChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

// Claude Code 的 OAuth client_id
// 从 Claude Code 源码中提取的公开值，可通过环境变量覆盖
const OAUTH_CLIENT_ID = process.env.CLAUDE_BRIDGE_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const OAUTH_SCOPES_FULL = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers';
// OAuth scopes - 与 Claude Code 保持一致
const OAUTH_SCOPES = 'user:inference user:profile';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============ Claude Code 版本检查 ============
let latestClaudeCodeVersion = null;

async function checkClaudeCodeVersion() {
  try {
    const { execSync } = await import('child_process');
    const version = execSync('npm view @anthropic-ai/claude-code version', { timeout: 15000, encoding: 'utf-8' }).trim();
    if (version && /^\d+\.\d+\.\d+/.test(version)) {
      latestClaudeCodeVersion = version;
      logger.info({ version }, 'Claude Code 最新版本已更新');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Claude Code 版本检查失败');
  }
}

// 启动时检查一次
checkClaudeCodeVersion();
// 每 24 小时检查一次
setInterval(checkClaudeCodeVersion, 24 * 60 * 60 * 1000);

export async function createServer(config = {}) {
  const app = Fastify({
    logger: false, // 使用自定义 logger
    bodyLimit: 10 * 1024 * 1024, // 10MB
  });

  // 注册插件
  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
  });

  // ============ Anthropic API 兼容路由 ============

  /**
   * POST /v1/messages - 创建消息（Anthropic API 兼容）
   */
  app.post('/v1/messages', { preHandler: apiAuth }, async (request, reply) => {
    const body = request.body;
    const isStream = body.stream === true;
    const requestId = randomUUID();

    // 调度
    const target = scheduler.pick(request.headers.authorization);
    if (!target) {
      reply.code(503).send({
        type: 'error',
        error: { type: 'overloaded_error', message: '没有可用的 Worker，请稍后重试' },
      });
      return;
    }

    const { accountId, account } = target;

    // 获取限速令牌
    rateLimiter.acquire(accountId);

    try {
      if (isStream) {
        // 流式响应
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Account-Id': accountId,
        });

        const emitter = workerManager.sendStreamRequest(accountId, requestId, body);

        emitter.on('event', (event) => {
          reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        });

        emitter.on('end', () => {
          reply.raw.end();
          rateLimiter.release(accountId);
        });

        emitter.on('error', (err) => {
          const errorEvent = {
            type: 'error',
            error: { type: err.type || 'api_error', message: err.message },
          };
          reply.raw.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
          reply.raw.end();
          rateLimiter.release(accountId);
        });

        // 客户端断开连接
        request.raw.on('close', () => {
          rateLimiter.release(accountId);
        });
      } else {
        // 非流式响应
        try {
          const data = await workerManager.sendRequest(accountId, requestId, body);
          reply.header('X-Account-Id', accountId);
          reply.send(data);
        } catch (err) {
          const status = err.status || 500;
          reply.code(status).send({
            type: 'error',
            error: { type: err.type || 'api_error', message: err.message },
          });
        } finally {
          rateLimiter.release(accountId);
        }
      }
    } catch (err) {
      rateLimiter.release(accountId);
      logger.error({ err: err.message, requestId }, '请求处理失败');
      reply.code(500).send({
        type: 'error',
        error: { type: 'internal_error', message: '内部错误' },
      });
    }
  });

  // ============ 管理 API ============

  // --- 概览 ---
  app.get('/api/overview', { preHandler: adminAuth }, async () => {
    const accounts = getAllAccounts();
    const stats = getOverviewStats();
    const workerStatus = workerManager.getStatus();
    const schedulerStatus = scheduler.getStatus();

    const onlineCount = accounts.filter(a => a.status === 'online').length;
    let activeRequests = 0;
    for (const [, ws] of Object.entries(workerStatus)) {
      activeRequests += ws.pendingRequests || 0;
    }

    // 格式化 uptime
    const uptimeSec = Math.floor(process.uptime());
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const uptimeStr = `${days}d ${hours}h ${minutes}m`;

    return {
      version: '1.0.0',
      uptime: uptimeStr,
      latestClaudeCodeVersion: latestClaudeCodeVersion || null,
      accounts: {
        total: accounts.length,
        online: onlineCount,
        offline: accounts.length - onlineCount,
      },
      activeRequests,
      today: stats.today,
      scheduler: schedulerStatus,
      workers: workerStatus,
      accountCards: accounts.map(a => ({
        id: a.id,
        name: a.name || `账号 #${a.id}`,
        status: a.status,
        statusMessage: a.status_message,
        lastHeartbeat: a.last_heartbeat,
        enabled: !!a.enabled,
        proxy: a.proxy ? '已配置' : '直连',
        concurrent: rateLimiter.getConcurrent(a.id),
        rpm: rateLimiter.getRPM(a.id),
      })),
    };
  });

  // --- 账号管理 ---
  app.get('/api/accounts', { preHandler: adminAuth }, async () => {
    return getAllAccounts();
  });

  app.post('/api/accounts', { preHandler: adminAuth }, async (request) => {
    const account = addAccount(request.body);
    // 如果启用，启动 Worker
    if (account.enabled) {
      workerManager.startWorker(account, {
        heartbeatInterval: parseInt(getConfig('heartbeat_interval') || '300000'),
      });
    }
    return account;
  });

  app.put('/api/accounts/:id', { preHandler: adminAuth }, async (request) => {
    const { id } = request.params;
    const account = updateAccount(parseInt(id), request.body);

    // 如果启用状态变了，处理 Worker
    if (request.body.enabled !== undefined) {
      if (request.body.enabled) {
        workerManager.startWorker(account, {
          heartbeatInterval: parseInt(getConfig('heartbeat_interval') || '300000'),
        });
      } else {
        workerManager.stopWorker(parseInt(id));
      }
    }

    return account;
  });

  app.delete('/api/accounts/:id', { preHandler: adminAuth }, async (request) => {
    const { id } = request.params;
    workerManager.stopWorker(parseInt(id));
    deleteAccount(parseInt(id));
    return { success: true };
  });

  app.post('/api/accounts/:id/test', { preHandler: adminAuth }, async (request) => {
    const { id } = request.params;
    const requestId = randomUUID();
    try {
      const result = await workerManager.testWorker(parseInt(id), requestId);
      return result;
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  app.post('/api/accounts/:id/restart', { preHandler: adminAuth }, async (request) => {
    const { id } = request.params;
    workerManager.restartWorker(parseInt(id), {
      heartbeatInterval: parseInt(getConfig('heartbeat_interval') || '300000'),
    });
    return { success: true };
  });

  // --- 配置 ---
  app.get('/api/config', { preHandler: adminAuth }, async () => {
    return getAllConfig();
  });

  app.put('/api/config', { preHandler: adminAuth }, async (request) => {
    const data = request.body;
    for (const [key, value] of Object.entries(data)) {
      setConfig(key, String(value));
    }

    // 应用部分配置
    if (data.log_level) {
      logger.level = data.log_level;
    }

    return getAllConfig();
  });

  // --- API Keys ---
  app.get('/api/keys', { preHandler: adminAuth }, async () => {
    return getApiKeys();
  });

  app.post('/api/keys', { preHandler: adminAuth }, async (request) => {
    const { name } = request.body;
    if (!name) {
      return { error: '请提供 Key 名称' };
    }
    const newKey = addApiKey(name);
    return newKey;
  });

  app.delete('/api/keys/:id', { preHandler: adminAuth }, async (request) => {
    const id = parseInt(request.params.id);
    const deleted = deleteApiKey(id);
    if (!deleted) {
      return { error: 'Key 不存在' };
    }
    return { success: true };
  });

  app.put('/api/keys/:id', { preHandler: adminAuth }, async (request) => {
    const id = parseInt(request.params.id);
    const { allowed_accounts } = request.body;
    const updated = updateApiKeyAllowedAccounts(id, allowed_accounts || '*');
    return updated;
  });

  // --- 用量统计 ---
  app.get('/api/usage/daily', { preHandler: adminAuth }, async (request) => {
    const days = parseInt(request.query.days) || 7;
    return getDailyStats(days);
  });

  app.get('/api/usage/accounts', { preHandler: adminAuth }, async (request) => {
    const days = parseInt(request.query.days) || 7;
    return getAccountStats(days);
  });

  app.get('/api/usage/recent', { preHandler: adminAuth }, async (request) => {
    const limit = parseInt(request.query.limit) || 50;
    return getRecentRequests(limit);
  });

  // --- 代理检查 ---
  app.post('/api/proxy/check', { preHandler: adminAuth }, async (request) => {
    const { proxy } = request.body || {};
    if (!proxy) {
      return { error: '请提供代理地址' };
    }

    const start = Date.now();
    try {
      const fetchOptions = {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      };

      // 根据协议选择代理 agent
      if (proxy.startsWith('socks')) {
        const { SocksProxyAgent } = await import('socks-proxy-agent');
        fetchOptions.agent = new SocksProxyAgent(proxy);
      } else {
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        fetchOptions.agent = new HttpsProxyAgent(proxy);
      }

      const res = await nodeFetch('https://ipinfo.io/json', fetchOptions);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const latency = Date.now() - start;

      return {
        ip: data.ip,
        country: data.country,
        city: data.city,
        org: data.org,
        latency,
      };
    } catch (err) {
      return { error: `连接失败: ${err.message}` };
    }
  });

  // --- OAuth 授权 ---

  /**
   * GET /api/oauth/start - 发起 OAuth 授权流程
   * 生成 PKCE 参数并返回授权 URL
   */
  app.get('/api/oauth/start', { preHandler: adminAuth }, async (request) => {
    const host = request.headers.host || `localhost:${config?.server?.port || 3456}`;
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    // 使用 platform.claude.com 的回调地址（跟真正的 Claude Code 一样）
    const redirectUri = OAUTH_REDIRECT_URI;

    const state = randomUUID();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // 获取前端传来的代理配置
    const proxy = request.query.proxy || '';

    // 存储 state -> code_verifier + 代理配置映射（5 分钟过期）
    oauthPendingStates.set(state, {
      codeVerifier,
      redirectUri,
      proxy,
      createdAt: Date.now(),
    });

    // 5 分钟后自动清理
    setTimeout(() => {
      oauthPendingStates.delete(state);
    }, 5 * 60 * 1000);

    // 按照 Claude Code / sub2api 的参数顺序构建 URL（加 code=true 让回调页显示 code）
    const encodedRedirect = encodeURIComponent(redirectUri);
    const encodedScope = OAUTH_SCOPES_FULL.replace(/ /g, '+');
    const url = `${OAUTH_AUTHORIZE_URL}?code=true&client_id=${OAUTH_CLIENT_ID}&response_type=code&redirect_uri=${encodedRedirect}&scope=${encodedScope}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}`;

    logger.info({ state }, 'OAuth 授权流程已启动');

    return { url, state };
  });

  /**
   * POST /api/oauth/exchange - 手动交换 OAuth code
   * 用户复制 platform.claude.com 页面显示的 code，粘贴回来换取 token
   */
  app.post('/api/oauth/exchange', { preHandler: adminAuth }, async (request) => {
    const { code, state, proxy } = request.body || {};
    if (!code || !state) {
      return { error: '缺少 code 或 state' };
    }

    const pending = oauthPendingStates.get(state);
    if (!pending) {
      return { error: 'state 无效或已过期，请重新获取授权链接' };
    }

    // 优先用请求 body 里的代理（点添加时传来的最终代理），fallback 到生成链接时的代理
    const proxyUrl = proxy || pending.proxy || '';

    oauthPendingStates.delete(state);

    try {
      const fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: OAUTH_REDIRECT_URI,
          client_id: OAUTH_CLIENT_ID,
          code_verifier: pending.codeVerifier,
        }),
      };

      // 如果有代理配置，用代理换 token
      if (proxyUrl) {
        try {
          const ProxyAgent = proxyUrl.startsWith('socks')
            ? (await import('socks-proxy-agent')).SocksProxyAgent
            : (await import('https-proxy-agent')).HttpsProxyAgent;
          fetchOptions.agent = new ProxyAgent(proxyUrl);
          logger.info({ proxy: proxyUrl }, 'OAuth code 交换使用代理');
        } catch (e) {
          logger.warn({ err: e.message }, '代理创建失败，直连');
        }
      }

      const tokenResponse = await nodeFetch(OAUTH_TOKEN_URL, fetchOptions);

      if (!tokenResponse.ok) {
        const errBody = await tokenResponse.text();
        throw new Error(`Token 交换失败: ${tokenResponse.status} - ${errBody}`);
      }

      const tokenData = await tokenResponse.json();
      const { access_token, refresh_token, expires_in } = tokenData;

      if (!access_token) {
        throw new Error('未获取到 access_token');
      }

      logger.info('OAuth code 交换成功');

      return {
        success: true,
        token: JSON.stringify({
          access_token,
          refresh_token: refresh_token || '',
          expires_in: expires_in || 0,
        }),
      };
    } catch (err) {
      logger.error({ err: err.message }, 'OAuth code 交换失败');
      return { error: err.message };
    }
  });

  /**
   * GET /api/oauth/callback - OAuth 回调处理（保留兼容）
   * 用 authorization code 换取 access_token 和 refresh_token
   */
  app.get('/api/oauth/callback', async (request, reply) => {
    const { code, state, error, error_description } = request.query;

    if (error) {
      logger.error({ error, error_description }, 'OAuth 授权失败');
      reply.type('text/html').send(`
        <html><body>
          <h2>授权失败</h2>
          <p>${error}: ${error_description || '未知错误'}</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'oauth-error', error: '${error}' }, '*');
              setTimeout(() => window.close(), 2000);
            }
          </script>
        </body></html>
      `);
      return;
    }

    if (!code || !state) {
      reply.code(400).type('text/html').send(`
        <html><body>
          <h2>参数错误</h2><p>缺少 code 或 state 参数</p>
        </body></html>
      `);
      return;
    }

    // 验证 state 并获取 code_verifier
    const pending = oauthPendingStates.get(state);
    if (!pending) {
      reply.code(400).type('text/html').send(`
        <html><body>
          <h2>状态无效</h2><p>OAuth state 无效或已过期，请重新授权</p>
        </body></html>
      `);
      return;
    }

    oauthPendingStates.delete(state);

    try {
      // 如果有代理配置，用代理发请求
      const fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: pending.redirectUri,
          client_id: OAUTH_CLIENT_ID,
          code_verifier: pending.codeVerifier,
        }),
      };

      if (proxyUrl) {
        const { default: createProxyAgent } = proxyUrl.startsWith('socks')
          ? await import('socks-proxy-agent')
          : await import('https-proxy-agent');
        const ProxyAgent = proxyUrl.startsWith('socks') 
          ? (await import('socks-proxy-agent')).SocksProxyAgent
          : (await import('https-proxy-agent')).HttpsProxyAgent;
        fetchOptions.agent = new ProxyAgent(proxyUrl);
        logger.info({ proxy: proxyUrl }, 'OAuth token 交换使用代理');
      }

      // 用 code + code_verifier 换取 token
      const tokenResponse = await nodeFetch(OAUTH_TOKEN_URL, fetchOptions);

      if (!tokenResponse.ok) {
        const errBody = await tokenResponse.text();
        logger.error({ status: tokenResponse.status, body: errBody }, 'Token 交换失败');
        throw new Error(`Token 交换失败: ${tokenResponse.status} - ${errBody}`);
      }

      const tokenData = await tokenResponse.json();
      const { access_token, refresh_token, expires_in } = tokenData;

      if (!access_token) {
        throw new Error('未获取到 access_token');
      }

      const tokenExpiresAt = expires_in
        ? Math.floor(Date.now() / 1000) + expires_in
        : 0;

      logger.info('OAuth token 获取成功');

      // 构建要显示的 token 信息（JSON 格式，包含 access_token 和 refresh_token）
      const tokenInfo = JSON.stringify({
        access_token,
        refresh_token: refresh_token || '',
        expires_in: expires_in || 0,
      });

      // 返回页面显示 token，让用户复制回管理面板
      reply.type('text/html').send(`
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权成功</title></head>
        <body style="background:#0f1117;color:#e5e7eb;font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;">
          <div style="text-align:center;max-width:500px;width:100%;">
            <div style="font-size:48px;margin-bottom:16px;">✅</div>
            <h2 style="color:#10b981;margin-bottom:8px;">授权成功！</h2>
            <p style="color:#9ca3af;margin-bottom:20px;">请复制下方 Token，粘贴到管理面板的「添加账号」表单中：</p>
            <div style="background:#1a1b23;border:1px solid #10b981;border-radius:12px;padding:16px;margin-bottom:16px;text-align:left;">
              <textarea id="tokenBox" readonly style="width:100%;height:120px;background:transparent;border:none;color:#10b981;font-family:monospace;font-size:12px;resize:none;outline:none;">${tokenInfo.replace(/"/g, '&quot;')}</textarea>
            </div>
            <button onclick="copyToken()" style="background:#10b981;color:white;border:none;padding:12px 32px;border-radius:8px;font-size:14px;cursor:pointer;font-weight:500;">
              📋 复制 Token
            </button>
            <p id="copyMsg" style="color:#10b981;margin-top:12px;font-size:13px;display:none;">已复制！请回到管理面板粘贴。</p>
          </div>
          <script>
            function copyToken() {
              const box = document.getElementById('tokenBox');
              box.select();
              navigator.clipboard.writeText(box.value).then(() => {
                document.getElementById('copyMsg').style.display = 'block';
              });
            }
          </script>
        </body></html>
      `);
    } catch (err) {
      logger.error({ err: err.message }, 'OAuth 回调处理失败');
      reply.type('text/html').send(`
        <html><body style="background:#0f1117;color:#e5e7eb;font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
          <div style="text-align:center;max-width:400px;">
            <div style="font-size:48px;margin-bottom:16px;">❌</div>
            <h2 style="color:#f87171;margin-bottom:8px;">授权失败</h2>
            <p style="color:#9ca3af;">${err.message}</p>
          </div>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'oauth-error', error: '${err.message.replace(/'/g, "\\'")}' }, '*');
            }
          </script>
        </body></html>
      `);
    }
  });

  // --- 日志 WebSocket ---
  app.get('/api/logs/ws', { websocket: true, preHandler: adminAuth }, (socket, request) => {
    // 发送历史日志
    const buffer = getLogBuffer();
    for (const entry of buffer.slice(-100)) {
      socket.send(JSON.stringify(entry));
    }

    // 监听新日志
    const onLog = (entry) => {
      try {
        socket.send(JSON.stringify(entry));
      } catch (e) {
        // ignore
      }
    };

    logEmitter.on('log', onLog);

    socket.on('close', () => {
      logEmitter.off('log', onLog);
    });
  });

  // --- 日志 HTTP ---
  app.get('/api/logs', { preHandler: adminAuth }, async (request) => {
    const level = request.query.level;
    let logs = getLogBuffer();
    if (level) {
      logs = logs.filter(l => l.level === level);
    }
    return logs.slice(-200);
  });

  return app;
}

export default createServer;

/**
 * worker.js - Worker 子进程
 * 每个 Worker 维护一个 Anthropic SDK 实例，处理 API 请求
 * 通过 IPC 与主进程通信
 */

import Anthropic from '@anthropic-ai/sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import nodeFetch from 'node-fetch';

let client = null;
let accountConfig = null;
let heartbeatTimer = null;
let sessionRefreshTimer = null;

/**
 * 创建代理 agent
 */
function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (proxyUrl.startsWith('socks')) {
    return new SocksProxyAgent(proxyUrl);
  }
  return new HttpsProxyAgent(proxyUrl);
}

// OAuth client_id（与 server.js 保持一致）
const OAUTH_CLIENT_ID = process.env.CLAUDE_BRIDGE_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://claude.ai/oauth/token';

/**
 * 刷新 OAuth token
 */
async function refreshOAuthToken() {
  if (!accountConfig || accountConfig.authType !== 'oauth' || !accountConfig.refreshToken) {
    return false;
  }

  try {
    log('info', 'OAuth token 即将过期，正在刷新...');

    const fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: accountConfig.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    };
    // token 刷新也走代理
    if (accountConfig.proxy) {
      const agent = createProxyAgent(accountConfig.proxy);
      if (agent) fetchOpts.agent = agent;
    }
    const response = await nodeFetch(OAUTH_TOKEN_URL, fetchOpts);

    if (!response.ok) {
      const errBody = await response.text();
      log('error', `OAuth token 刷新失败: ${response.status} - ${errBody}`);
      return false;
    }

    const data = await response.json();
    const { access_token, refresh_token, expires_in } = data;

    if (!access_token) {
      log('error', 'OAuth token 刷新失败: 未获取到 access_token');
      return false;
    }

    // 更新本地配置
    accountConfig.token = access_token;
    if (refresh_token) {
      accountConfig.refreshToken = refresh_token;
    }
    accountConfig.tokenExpiresAt = expires_in
      ? Math.floor(Date.now() / 1000) + expires_in
      : 0;

    // 重新初始化 SDK 客户端（确保代理生效）
    const options = { apiKey: access_token };
    if (accountConfig.proxy) {
      const agent = createProxyAgent(accountConfig.proxy);
      if (agent) {
        options.httpAgent = agent;
        options.fetch = (url, opts) => nodeFetch(url, { ...opts, agent });
      }
    }
    client = new Anthropic(options);

    // 通知主进程更新数据库中的 token
    send({
      type: 'token_refreshed',
      token: access_token,
      refreshToken: refresh_token || accountConfig.refreshToken,
      tokenExpiresAt: accountConfig.tokenExpiresAt,
    });

    log('info', 'OAuth token 刷新成功');
    return true;
  } catch (err) {
    log('error', `OAuth token 刷新异常: ${err.message}`);
    return false;
  }
}

/**
 * 检查 OAuth token 是否需要刷新（提前 5 分钟）
 */
function shouldRefreshToken() {
  if (!accountConfig || accountConfig.authType !== 'oauth') return false;
  if (!accountConfig.tokenExpiresAt || !accountConfig.refreshToken) return false;
  const now = Math.floor(Date.now() / 1000);
  return now >= accountConfig.tokenExpiresAt - 300; // 提前 5 分钟刷新
}

/**
 * 启动 OAuth token 自动刷新定时器
 */
function startTokenRefresh() {
  if (sessionRefreshTimer) clearInterval(sessionRefreshTimer);
  if (!accountConfig || accountConfig.authType !== 'oauth') return;

  // 每 60 秒检查一次是否需要刷新
  sessionRefreshTimer = setInterval(async () => {
    if (shouldRefreshToken()) {
      await refreshOAuthToken();
    }
  }, 60000);

  // 立即检查一次
  if (shouldRefreshToken()) {
    refreshOAuthToken();
  }
}

/**
 * 初始化 Anthropic SDK 客户端
 */
function initClient(config) {
  accountConfig = config;

  const options = {
    apiKey: config.token,
  };

  // 设置代理：用 custom fetch 确保代理一定生效
  if (config.proxy) {
    const agent = createProxyAgent(config.proxy);
    if (agent) {
      options.httpAgent = agent;
      options.fetch = (url, opts) => nodeFetch(url, { ...opts, agent });
    }
  }

  client = new Anthropic(options);

  // 启动心跳
  startHeartbeat(config.heartbeatInterval || 300000);

  // 如果是 OAuth 认证，启动 token 自动刷新
  if (config.authType === 'oauth' && config.refreshToken) {
    startTokenRefresh();
  }

  send({ type: 'status', status: 'online', message: '初始化成功' });
  log('info', `Worker ${config.accountId} 初始化完成 (auth: ${config.authType || 'session_key'})`);
}

/**
 * 启动心跳定时器
 */
function startHeartbeat(interval) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  // 立即进行一次心跳
  doHeartbeat();

  heartbeatTimer = setInterval(doHeartbeat, interval);
}

/**
 * 执行心跳检测
 */
async function doHeartbeat() {
  try {
    // 使用 models list 作为心跳检测
    await client.models.list({ limit: 1 });
    send({ type: 'heartbeat', status: 'online', message: 'OK' });
  } catch (err) {
    const status = err.status === 401 ? 'error' : 'offline';
    const message = err.status === 401 ? 'Token 已失效' : `心跳失败: ${err.message}`;
    send({ type: 'heartbeat', status, message });

    if (err.status === 401) {
      log('error', `Token 已失效 (401), 停止心跳`);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }
}

/**
 * 处理 API 请求（非流式）
 */
async function handleRequest(id, body) {
  const startTime = Date.now();

  try {
    log('info', `处理请求 ${id}, model: ${body.model}`);

    const response = await client.messages.create({
      model: body.model || 'claude-sonnet-4-20250514',
      max_tokens: body.max_tokens || 4096,
      messages: body.messages,
      system: body.system,
      temperature: body.temperature,
      top_p: body.top_p,
      top_k: body.top_k,
      stop_sequences: body.stop_sequences,
      metadata: body.metadata,
      thinking: body.thinking,
      tool_choice: body.tool_choice,
      tools: body.tools,
    });

    const duration = Date.now() - startTime;

    send({
      type: 'response',
      id,
      data: response,
      usage: {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
        durationMs: duration,
        model: body.model,
      },
    });
  } catch (err) {
    const duration = Date.now() - startTime;
    log('error', `请求 ${id} 失败: ${err.message}`);

    // 429 限速
    if (err.status === 429) {
      send({ type: 'rate_limited', id });
    }

    send({
      type: 'error',
      id,
      error: {
        status: err.status || 500,
        type: err.error?.type || 'api_error',
        message: err.message,
      },
      usage: {
        durationMs: duration,
        model: body.model,
        status: 'error',
        errorMessage: err.message,
      },
    });
  }
}

/**
 * 处理流式 API 请求
 */
async function handleStreamRequest(id, body) {
  const startTime = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    log('info', `处理流式请求 ${id}, model: ${body.model}`);

    const stream = client.messages.stream({
      model: body.model || 'claude-sonnet-4-20250514',
      max_tokens: body.max_tokens || 4096,
      messages: body.messages,
      system: body.system,
      temperature: body.temperature,
      top_p: body.top_p,
      top_k: body.top_k,
      stop_sequences: body.stop_sequences,
      metadata: body.metadata,
      thinking: body.thinking,
      tool_choice: body.tool_choice,
      tools: body.tools,
    });

    stream.on('event', (event) => {
      send({ type: 'stream', id, event });

      // 提取 token 用量
      if (event.type === 'message_start' && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens || 0;
      }
      if (event.type === 'message_delta' && event.usage) {
        outputTokens = event.usage.output_tokens || 0;
      }
    });

    // 等待流结束
    await stream.finalMessage();

    const duration = Date.now() - startTime;
    send({
      type: 'stream_end',
      id,
      usage: {
        inputTokens,
        outputTokens,
        durationMs: duration,
        model: body.model,
      },
    });
  } catch (err) {
    const duration = Date.now() - startTime;
    log('error', `流式请求 ${id} 失败: ${err.message}`);

    if (err.status === 429) {
      send({ type: 'rate_limited', id });
    }

    send({
      type: 'stream_error',
      id,
      error: {
        status: err.status || 500,
        type: err.error?.type || 'api_error',
        message: err.message,
      },
      usage: {
        durationMs: duration,
        model: body.model,
        status: 'error',
        errorMessage: err.message,
      },
    });
  }
}

/**
 * 测试连通性
 */
async function testConnection(id) {
  try {
    await client.models.list({ limit: 1 });
    send({ type: 'test_result', id, success: true, message: '连接正常' });
  } catch (err) {
    send({
      type: 'test_result', id, success: false,
      message: `连接失败: ${err.message} (status: ${err.status || 'unknown'})`,
    });
  }
}

/**
 * 发送 IPC 消息到主进程
 */
function send(msg) {
  if (process.send) {
    process.send(msg);
  }
}

/**
 * 日志输出
 */
function log(level, msg) {
  send({ type: 'log', level, msg: `[Worker ${accountConfig?.accountId}] ${msg}` });
}

/**
 * 监听主进程消息
 */
process.on('message', (msg) => {
  switch (msg.type) {
    case 'init':
      initClient(msg.config);
      break;
    case 'request':
      handleRequest(msg.id, msg.body);
      break;
    case 'stream_request':
      handleStreamRequest(msg.id, msg.body);
      break;
    case 'test':
      testConnection(msg.id);
      break;
    case 'ping':
      send({ type: 'pong' });
      break;
    case 'config':
      // 更新配置
      if (msg.config) {
        accountConfig = { ...accountConfig, ...msg.config };
        if (msg.config.heartbeatInterval) {
          startHeartbeat(msg.config.heartbeatInterval);
        }
      }
      break;
    case 'shutdown':
      cleanup();
      process.exit(0);
      break;
  }
});

/**
 * 清理定时器
 */
function cleanup() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (sessionRefreshTimer) clearInterval(sessionRefreshTimer);
}

// 进程退出时清理
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('uncaughtException', (err) => {
  send({ type: 'log', level: 'error', msg: `未捕获异常: ${err.message}` });
  send({ type: 'heartbeat', status: 'error', message: err.message });
});

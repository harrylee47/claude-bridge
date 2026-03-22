/**
 * worker.js - Worker 子进程
 * 每个 Worker 维护一个 Anthropic SDK 实例，处理 API 请求
 * 通过 IPC 与主进程通信
 */

import Anthropic from '@anthropic-ai/sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import nodeFetch from 'node-fetch';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

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
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

/**
 * 刷新 OAuth token
 */
async function refreshOAuthToken() {
  if (!accountConfig || accountConfig.authType !== 'oauth' || !accountConfig.refreshToken) {
    return false;
  }

  try {
    log('info', 'OAuth token 即将过期，正在刷新...');

    // 用 curl 子进程刷新 token（绕过 Cloudflare TLS 检测）
    const refreshBody = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: accountConfig.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    });
    const curlArgs = [
      '-s', '--max-time', '30',
      '-X', 'POST', OAUTH_TOKEN_URL,
      '-H', 'Content-Type: application/json',
      '-H', 'anthropic-beta: oauth-2025-04-20',
      '-H', 'anthropic-version: 2023-06-01',
      '-d', refreshBody,
    ];
    if (accountConfig.proxy) {
      curlArgs.push('--proxy', accountConfig.proxy);
    }
    const refreshResult = execFileSync('curl', curlArgs, { encoding: 'utf8', timeout: 35000 });
    const data = JSON.parse(refreshResult);
    
    if (data.error) {
      log('error', `OAuth token 刷新失败: ${JSON.stringify(data.error)}`);
      return false;
    }
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

    // 重新初始化 SDK 客户端（确保代理和指纹生效）
    const fpR = accountConfig.fingerprint || {};
    const ccVR = fpR.ccVersion || '2.1.78';
    const options = {
      authToken: access_token,
      defaultHeaders: {
        'user-agent': `claude-cli/${ccVR} (external, cli)`,
        'x-stainless-lang': 'js',
        'x-stainless-package-version': '0.70.0',
        'x-stainless-os': fpR.os || 'macOS',
        'x-stainless-arch': fpR.arch || 'arm64',
        'x-stainless-runtime': 'node',
        'x-stainless-runtime-version': fpR.node || 'v22.14.0',
      },
    };
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

// ========== Session Key → OAuth Token 转换 ==========

/**
 * 执行 curl 子进程（同步），返回 stdout 字符串
 * 所有 HTTP 请求都通过 curl 发出，绕过 Cloudflare TLS 指纹检测
 */
function curlExec(args) {
  return execFileSync('curl', args, { encoding: 'utf8', timeout: 35000 });
}

/**
 * 从 Session Key 自动获取 OAuth Token（全程 curl，不需要浏览器）
 * 流程参考 sub2api 的 CookieAuth:
 * 1. 用 Session Key 获取 org UUID
 * 2. 生成 PKCE challenge
 * 3. 用 Session Key 自动获取 authorization code
 * 4. 用 code 换取 OAuth access_token + refresh_token
 */
function sessionKeyLogin(config) {
  const sessionKey = config.token;
  const proxyUrl = config.proxy;

  // 构建通用 curl 参数
  function baseArgs() {
    const args = ['-s', '--max-time', '30'];
    if (proxyUrl) args.push('--proxy', proxyUrl);
    return args;
  }

  // Step 1: 获取组织 UUID
  log('info', 'Session Key → OAuth: Step 1 - 获取组织信息...');
  const step1Args = [
    ...baseArgs(),
    '-H', 'Accept: application/json',
    '-H', 'Origin: https://claude.ai',
    '-H', 'Referer: https://claude.ai/new',
    '-H', 'Content-Type: application/json',
    '-H', `Cookie: sessionKey=${sessionKey}`,
    'https://claude.ai/api/organizations',
  ];

  let orgsRaw;
  try {
    orgsRaw = curlExec(step1Args);
  } catch (err) {
    throw new Error(`Step 1 curl 执行失败: ${err.message}`);
  }

  let orgs;
  try {
    orgs = JSON.parse(orgsRaw);
  } catch {
    throw new Error(`Step 1 返回无法解析的 JSON: ${orgsRaw.slice(0, 300)}`);
  }

  if (!Array.isArray(orgs) || orgs.length === 0 || !orgs[0].uuid) {
    throw new Error(`Session Key 无效或已过期: ${orgsRaw.slice(0, 300)}`);
  }

  const orgUUID = orgs[0].uuid;
  log('info', `Session Key → OAuth: 获取到 org UUID: ${orgUUID}`);

  // Step 2: 生成 PKCE 参数
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomUUID();

  // Step 3: 获取 Authorization Code
  log('info', 'Session Key → OAuth: Step 2 - 获取 authorization code...');
  const authBody = JSON.stringify({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    organization_uuid: orgUUID,
    redirect_uri: 'https://platform.claude.com/oauth/code/callback',
    scope: 'user:profile user:inference user:sessions:claude_code user:mcp_servers',
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const step2Args = [
    ...baseArgs(),
    '-X', 'POST',
    '-H', 'Accept: application/json',
    '-H', 'Accept-Language: en-US,en;q=0.9',
    '-H', 'Cache-Control: no-cache',
    '-H', 'Origin: https://claude.ai',
    '-H', 'Referer: https://claude.ai/new',
    '-H', 'Content-Type: application/json',
    '-H', `Cookie: sessionKey=${sessionKey}`,
    '-d', authBody,
    `https://claude.ai/v1/oauth/${orgUUID}/authorize`,
  ];

  let authRaw;
  try {
    authRaw = curlExec(step2Args);
  } catch (err) {
    throw new Error(`Step 2 curl 执行失败: ${err.message}`);
  }

  let authResult;
  try {
    authResult = JSON.parse(authRaw);
  } catch {
    throw new Error(`Step 2 返回无法解析的 JSON: ${authRaw.slice(0, 300)}`);
  }

  // 从 redirect_uri 中解析 code
  let authCode = null;
  if (authResult.code) {
    authCode = authResult.code;
  } else if (authResult.redirect_uri) {
    try {
      const redirectUrl = new URL(authResult.redirect_uri);
      authCode = redirectUrl.searchParams.get('code');
    } catch {
      throw new Error(`Step 2 redirect_uri 解析失败: ${authResult.redirect_uri}`);
    }
  }

  if (!authCode) {
    throw new Error(`Step 2 无法获取 authorization code: ${authRaw.slice(0, 300)}`);
  }
  log('info', 'Session Key → OAuth: 获取到 authorization code');

  // Step 3: 交换 Token
  log('info', 'Session Key → OAuth: Step 3 - 交换 token...');
  const tokenBody = JSON.stringify({
    grant_type: 'authorization_code',
    code: authCode,
    redirect_uri: 'https://platform.claude.com/oauth/code/callback',
    client_id: OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const step3Args = [
    ...baseArgs(),
    '-X', 'POST',
    '-H', 'Content-Type: application/json',
    '-H', 'anthropic-beta: oauth-2025-04-20',
    '-H', 'anthropic-version: 2023-06-01',
    '-d', tokenBody,
    OAUTH_TOKEN_URL,
  ];

  let tokenRaw;
  try {
    tokenRaw = curlExec(step3Args);
  } catch (err) {
    throw new Error(`Step 3 curl 执行失败: ${err.message}`);
  }

  let tokenData;
  try {
    tokenData = JSON.parse(tokenRaw);
  } catch {
    throw new Error(`Step 3 返回无法解析的 JSON: ${tokenRaw.slice(0, 300)}`);
  }

  if (!tokenData.access_token) {
    throw new Error(`Step 3 token 交换失败: ${JSON.stringify(tokenData).slice(0, 300)}`);
  }

  log('info', 'Session Key → OAuth: Token 交换成功！');

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || '',
    expiresIn: tokenData.expires_in || 0,
  };
}

/**
 * 初始化 Anthropic SDK 客户端
 */
async function initClient(config) {
  accountConfig = config;

  let token = config.token;

  // 如果是 session_key 认证，自动转换为 OAuth token
  if (config.authType === 'session_key') {
    try {
      log('info', '检测到 Session Key 认证，正在转换为 OAuth Token...');
      const oauthResult = sessionKeyLogin(config);

      // 更新本地配置
      token = oauthResult.accessToken;
      accountConfig.token = token;
      accountConfig.refreshToken = oauthResult.refreshToken;
      accountConfig.tokenExpiresAt = oauthResult.expiresIn
        ? Math.floor(Date.now() / 1000) + oauthResult.expiresIn
        : 0;
      accountConfig.authType = 'oauth'; // 转换后统一为 oauth

      // 通知主进程更新数据库
      send({
        type: 'token_refreshed',
        token: oauthResult.accessToken,
        refreshToken: oauthResult.refreshToken,
        tokenExpiresAt: accountConfig.tokenExpiresAt,
        authType: 'oauth', // 标记已转换为 oauth
      });

      log('info', 'Session Key → OAuth 转换成功，后续将使用 OAuth Token');
    } catch (err) {
      log('error', `Session Key → OAuth 转换失败: ${err.message}`);
      send({ type: 'status', status: 'error', message: `Session Key 转换失败: ${err.message}` });
      return;
    }
  }

  const options = {
    authToken: token,
  };

  // 应用指纹到请求头
  const fp = config.fingerprint || {};
  const ccVersion = fp.ccVersion || '2.1.78';
  options.defaultHeaders = {
    'user-agent': `claude-cli/${ccVersion} (external, cli)`,
    'x-stainless-lang': 'js',
    'x-stainless-package-version': '0.70.0',
    'x-stainless-os': fp.os || 'macOS',
    'x-stainless-arch': fp.arch || 'arm64',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': fp.node || 'v22.14.0',
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

  // 启动 token 自动刷新（session_key 转换后也变成 oauth 了）
  if (accountConfig.authType === 'oauth' && accountConfig.refreshToken) {
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
    // 用最小的 messages 请求作为心跳（消耗极少 token）
    await client.messages.create({
      model: 'claude-haiku-4-5-20241022',
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    });
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
    const testResp = await client.messages.create({
      model: 'claude-haiku-4-5-20241022',
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    });
    send({ type: 'test_result', id, success: true, message: `连接正常 (model: ${testResp.model})` });
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
      initClient(msg.config).catch((err) => {
        send({ type: 'log', level: 'error', msg: `[Worker] initClient 异常: ${err.message}` });
        send({ type: 'status', status: 'error', message: `初始化失败: ${err.message}` });
      });
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

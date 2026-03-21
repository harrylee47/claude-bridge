/**
 * auth.js - API Key 认证中间件
 * 支持环境变量和数据库存储的 API Key
 */

import { getConfig, validateApiKey } from './db.js';
import logger from './logger.js';

/**
 * API 请求认证中间件
 * 验证 Bearer token
 */
export function apiAuth(request, reply, done) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({
      type: 'error',
      error: { type: 'authentication_error', message: 'Missing or invalid API key' },
    });
    return;
  }

  const key = authHeader.slice(7);

  // 优先检查环境变量
  const envKey = process.env.BRIDGE_API_KEY;
  if (envKey && key === envKey) {
    done();
    return;
  }

  // 检查数据库
  const configKey = getConfig('api_key');
  if (configKey && key === configKey) {
    done();
    return;
  }

  // 检查 API Keys 表
  if (validateApiKey(key)) {
    done();
    return;
  }

  logger.warn({ ip: request.ip }, 'API 认证失败');
  reply.code(401).send({
    type: 'error',
    error: { type: 'authentication_error', message: 'Invalid API key' },
  });
}

/**
 * 管理面板认证中间件
 * 验证 admin token (query param 或 header)
 */
export function adminAuth(request, reply, done) {
  const token = request.headers['x-admin-token'] ||
    request.query?.token;

  if (!token) {
    reply.code(401).send({ error: '需要管理员认证' });
    return;
  }

  const adminToken = process.env.BRIDGE_ADMIN_TOKEN ||
    getConfig('admin_token');

  // 如果没设置 admin token，允许任何 token
  if (!adminToken) {
    done();
    return;
  }

  if (token !== adminToken) {
    reply.code(401).send({ error: '管理员 Token 无效' });
    return;
  }

  done();
}

export default { apiAuth, adminAuth };

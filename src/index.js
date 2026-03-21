/**
 * index.js - Claude Bridge 入口
 * 启动主进程，初始化数据库、Worker、API 网关
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import logger from './logger.js';
import { initDB, getEnabledAccounts, getConfig } from './db.js';
import workerManager from './worker-manager.js';
import scheduler from './scheduler.js';
import { cleanupOldData } from './usage.js';
import createServer from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 加载配置文件
function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  const defaultConfig = {
    server: { host: '0.0.0.0', port: 3456 },
    defaults: {
      rpm: 10, maxConcurrency: 2, minInterval: 3000,
      heartbeatInterval: 300000, sessionRefreshInterval: 43200000,
      cooldownDuration: 60000,
    },
    scheduler: { strategy: 'least_connections', stickySession: false },
    usage: { retentionDays: 30 },
  };

  if (existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      return { ...defaultConfig, ...fileConfig };
    } catch (err) {
      logger.warn({ err: err.message }, '读取配置文件失败，使用默认配置');
    }
  }

  return defaultConfig;
}

async function main() {
  logger.info('=== Claude Bridge 启动 ===');

  // 初始化数据库
  initDB();
  logger.info('数据库初始化完成');

  // 加载配置
  const config = loadConfig();
  logger.info({ port: config.server.port }, '加载配置完成');

  // 设置调度器
  scheduler.setStickySession(config.scheduler?.stickySession || false);

  // 启动所有已启用的 Worker
  const accounts = getEnabledAccounts();
  logger.info({ count: accounts.length }, '启动 Worker 进程');

  for (const account of accounts) {
    workerManager.startWorker(account, {
      heartbeatInterval: config.defaults.heartbeatInterval,
    });
  }

  // 启动健康检查
  workerManager.startHealthCheck(60000);

  // 创建并启动 API 网关
  const app = await createServer(config);
  const host = config.server.host || '0.0.0.0';
  const port = parseInt(process.env.PORT || config.server.port || 3456);

  await app.listen({ host, port });
  logger.info(`API 网关启动: http://${host}:${port}`);
  logger.info(`管理面板: http://${host}:${port}/`);

  // 定时清理旧数据（每天一次）
  setInterval(() => {
    cleanupOldData(config.usage?.retentionDays || 30);
  }, 86400000);

  // 优雅关闭
  const shutdown = async (signal) => {
    logger.info({ signal }, '收到关闭信号');
    workerManager.stopAll();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error({ err: err.message, stack: err.stack }, '未捕获异常');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, '未处理的 Promise 拒绝');
  });
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, '启动失败');
  process.exit(1);
});

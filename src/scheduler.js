/**
 * scheduler.js - 负载均衡调度器
 * 支持最少连接数策略和粘性会话
 */

import logger from './logger.js';
import workerManager from './worker-manager.js';
import rateLimiter from './rate-limiter.js';
import { getAccount } from './db.js';

class Scheduler {
  constructor() {
    // apiKey -> accountId (粘性会话映射)
    this.stickyMap = new Map();
    this.stickyEnabled = false;
  }

  /**
   * 设置是否启用粘性会话
   */
  setStickySession(enabled) {
    this.stickyEnabled = enabled;
  }

  /**
   * 选择一个 Worker 来处理请求
   * @param {string} apiKey - 请求的 API Key（用于粘性会话）
   * @returns {{ accountId: number, account: object } | null}
   */
  pick(apiKey = '') {
    const onlineIds = workerManager.getOnlineWorkerIds();

    if (onlineIds.length === 0) {
      logger.warn('没有可用的 Worker');
      return null;
    }

    // 粘性会话：优先使用之前的 Worker
    if (this.stickyEnabled && apiKey && this.stickyMap.has(apiKey)) {
      const stickyId = this.stickyMap.get(apiKey);
      if (onlineIds.includes(stickyId)) {
        const account = getAccount(stickyId);
        const check = rateLimiter.check(stickyId, {
          rpm: account.rpm,
          maxConcurrency: account.max_concurrency,
          minInterval: account.min_interval,
        });
        if (check.allowed) {
          return { accountId: stickyId, account };
        }
      }
      // 粘性 Worker 不可用，清除映射
      this.stickyMap.delete(apiKey);
    }

    // 最少连接数策略
    let bestId = null;
    let bestScore = Infinity;

    for (const id of onlineIds) {
      const account = getAccount(id);
      if (!account || !account.enabled) continue;

      // 检查限速
      const check = rateLimiter.check(id, {
        rpm: account.rpm,
        maxConcurrency: account.max_concurrency,
        minInterval: account.min_interval,
      });

      if (!check.allowed) continue;

      // 计算分数：当前并发数 / 最大并发数
      const concurrent = rateLimiter.getConcurrent(id);
      const score = concurrent / (account.max_concurrency || 2);

      if (score < bestScore) {
        bestScore = score;
        bestId = id;
      }
    }

    if (bestId === null) {
      logger.warn('所有 Worker 均已满载或限速中');
      return null;
    }

    // 更新粘性映射
    if (this.stickyEnabled && apiKey) {
      this.stickyMap.set(apiKey, bestId);
    }

    return { accountId: bestId, account: getAccount(bestId) };
  }

  /**
   * 获取调度器状态
   */
  getStatus() {
    return {
      stickyEnabled: this.stickyEnabled,
      stickyMapSize: this.stickyMap.size,
      onlineWorkers: workerManager.getOnlineWorkerIds().length,
    };
  }
}

export const scheduler = new Scheduler();
export default scheduler;

/**
 * rate-limiter.js - 限速器
 * 支持每账号 RPM、并发数、请求间隔控制
 */

import logger from './logger.js';

class RateLimiter {
  constructor() {
    // accountId -> { timestamps: [], concurrent: 0, lastRequest: 0, cooldownUntil: 0 }
    this.state = new Map();
  }

  /**
   * 获取或初始化账号限速状态
   */
  _getState(accountId) {
    if (!this.state.has(accountId)) {
      this.state.set(accountId, {
        timestamps: [],
        concurrent: 0,
        lastRequest: 0,
        cooldownUntil: 0,
      });
    }
    return this.state.get(accountId);
  }

  /**
   * 清理过期的时间戳（超过 1 分钟的）
   */
  _cleanTimestamps(state) {
    const now = Date.now();
    state.timestamps = state.timestamps.filter(t => now - t < 60000);
  }

  /**
   * 检查是否可以发送请求
   * @returns {object} { allowed: boolean, reason?: string, waitMs?: number }
   */
  check(accountId, config = {}) {
    const { rpm = 10, maxConcurrency = 2, minInterval = 3000, cooldownDuration = 60000 } = config;
    const state = this._getState(accountId);
    const now = Date.now();

    // 冷却中
    if (state.cooldownUntil > now) {
      return {
        allowed: false,
        reason: 'cooldown',
        waitMs: state.cooldownUntil - now,
      };
    }

    // 检查最小间隔
    if (now - state.lastRequest < minInterval) {
      return {
        allowed: false,
        reason: 'min_interval',
        waitMs: minInterval - (now - state.lastRequest),
      };
    }

    // 检查并发数
    if (state.concurrent >= maxConcurrency) {
      return {
        allowed: false,
        reason: 'max_concurrency',
        waitMs: 1000,
      };
    }

    // 检查 RPM
    this._cleanTimestamps(state);
    if (state.timestamps.length >= rpm) {
      const oldest = state.timestamps[0];
      return {
        allowed: false,
        reason: 'rpm_exceeded',
        waitMs: 60000 - (now - oldest),
      };
    }

    return { allowed: true };
  }

  /**
   * 记录请求开始
   */
  acquire(accountId) {
    const state = this._getState(accountId);
    state.timestamps.push(Date.now());
    state.concurrent += 1;
    state.lastRequest = Date.now();
  }

  /**
   * 记录请求结束
   */
  release(accountId) {
    const state = this._getState(accountId);
    state.concurrent = Math.max(0, state.concurrent - 1);
  }

  /**
   * 触发冷却
   */
  cooldown(accountId, duration = 60000) {
    const state = this._getState(accountId);
    state.cooldownUntil = Date.now() + duration;
    logger.warn({ accountId, duration }, '账号进入冷却期');
  }

  /**
   * 获取账号当前并发数
   */
  getConcurrent(accountId) {
    const state = this._getState(accountId);
    return state.concurrent;
  }

  /**
   * 获取账号当前分钟请求数
   */
  getRPM(accountId) {
    const state = this._getState(accountId);
    this._cleanTimestamps(state);
    return state.timestamps.length;
  }

  /**
   * 重置账号状态
   */
  reset(accountId) {
    this.state.delete(accountId);
  }
}

export const rateLimiter = new RateLimiter();
export default rateLimiter;

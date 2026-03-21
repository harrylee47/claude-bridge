/**
 * usage.js - 用量统计模块
 * 记录和查询 API 请求的用量数据
 */

import { logUsage, getUsageStats, getUsageByAccount, getRecentUsage, getTodayStats, cleanOldUsage } from './db.js';
import logger from './logger.js';

/**
 * 记录一次 API 请求
 */
export function recordUsage(data) {
  try {
    logUsage({
      account_id: data.accountId,
      model: data.model || 'unknown',
      input_tokens: data.inputTokens || 0,
      output_tokens: data.outputTokens || 0,
      duration_ms: data.durationMs || 0,
      status: data.status || 'success',
      error_message: data.errorMessage || '',
    });
  } catch (err) {
    logger.error({ err }, '记录用量失败');
  }
}

/**
 * 获取概览统计数据
 */
export function getOverviewStats() {
  const today = getTodayStats();
  const weekly = getUsageStats(7);
  return { today, weekly };
}

/**
 * 获取按天的统计数据
 */
export function getDailyStats(days = 7) {
  return getUsageStats(days);
}

/**
 * 获取按账号的统计数据
 */
export function getAccountStats(days = 7) {
  return getUsageByAccount(days);
}

/**
 * 获取最近的请求记录
 */
export function getRecentRequests(limit = 50) {
  return getRecentUsage(limit);
}

/**
 * 清理旧数据（定时任务调用）
 */
export function cleanupOldData(days = 30) {
  try {
    cleanOldUsage(days);
    logger.info(`清理了 ${days} 天前的用量数据`);
  } catch (err) {
    logger.error({ err }, '清理用量数据失败');
  }
}

export default {
  recordUsage, getOverviewStats, getDailyStats,
  getAccountStats, getRecentRequests, cleanupOldData,
};

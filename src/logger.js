/**
 * logger.js - 日志模块
 * 使用 pino 作为日志引擎，支持日志级别过滤和实时推送
 */

import pino from 'pino';
import { EventEmitter } from 'events';

// 日志事件发射器，用于实时推送到 WebSocket
export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(100);

// 日志缓冲区，保留最近 1000 条
const LOG_BUFFER_SIZE = 1000;
const logBuffer = [];

/**
 * 自定义 pino destination，同时写入 stdout 和 buffer
 */
const createLogger = (level = 'info') => {
  const logger = pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  });

  // 包装 logger 以同时推送事件
  const wrap = (originalLevel) => {
    const original = logger[originalLevel].bind(logger);
    return (...args) => {
      original(...args);
      const entry = {
        level: originalLevel,
        time: new Date().toISOString(),
        msg: typeof args[0] === 'string' ? args[0] : (args[1] || ''),
        data: typeof args[0] === 'object' ? args[0] : undefined,
      };
      logBuffer.push(entry);
      if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
      logEmitter.emit('log', entry);
    };
  };

  return {
    trace: wrap('trace'),
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    fatal: wrap('fatal'),
    child: (bindings) => logger.child(bindings),
    get level() { return logger.level; },
    set level(v) { logger.level = v; },
  };
};

export const logger = createLogger(process.env.LOG_LEVEL || 'info');

/**
 * 获取日志缓冲区
 */
export function getLogBuffer() {
  return [...logBuffer];
}

export default logger;

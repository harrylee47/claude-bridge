/**
 * worker-manager.js - Worker 生命周期管理
 * 管理所有 Worker 子进程的创建、销毁、重启和通信
 */

import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { EventEmitter } from 'events';
import logger from './logger.js';
import { updateAccountStatus, getAccount, updateAccount as dbUpdateAccount } from './db.js';
import rateLimiter from './rate-limiter.js';
import { recordUsage } from './usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'worker.js');

class WorkerManager extends EventEmitter {
  constructor() {
    super();
    // accountId -> { process, status, pendingRequests, lastPong }
    this.workers = new Map();
    this.healthCheckTimer = null;
  }

  /**
   * 启动 Worker
   */
  startWorker(account, config = {}) {
    const id = account.id;

    // 如果已存在，先停止
    if (this.workers.has(id)) {
      this.stopWorker(id);
    }

    logger.info({ accountId: id, name: account.name }, '启动 Worker');

    const child = fork(WORKER_PATH, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env },
    });

    const workerState = {
      process: child,
      accountId: id,
      status: 'starting',
      pendingRequests: new Map(), // requestId -> { resolve, reject, stream }
      lastPong: Date.now(),
      restartCount: 0,
    };

    this.workers.set(id, workerState);

    // 监听 Worker 消息
    child.on('message', (msg) => this._handleWorkerMessage(id, msg));

    // Worker 退出
    child.on('exit', (code, signal) => {
      logger.warn({ accountId: id, code, signal }, 'Worker 进程退出');
      updateAccountStatus(id, 'offline', `进程退出: code=${code}`);

      const state = this.workers.get(id);
      if (state) {
        // 拒绝所有等待中的请求
        for (const [reqId, pending] of state.pendingRequests) {
          pending.reject(new Error('Worker 进程退出'));
        }
        state.pendingRequests.clear();

        // 自动重启（最多 5 次）
        if (state.restartCount < 5) {
          state.restartCount++;
          logger.info({ accountId: id, attempt: state.restartCount }, '自动重启 Worker');
          setTimeout(() => {
            const acc = getAccount(id);
            if (acc && acc.enabled) {
              this.startWorker(acc, config);
            }
          }, 3000 * state.restartCount); // 递增延迟
        }
      }

      this.workers.delete(id);
    });

    child.on('error', (err) => {
      logger.error({ accountId: id, err: err.message }, 'Worker 进程错误');
    });

    // 发送初始化配置
    child.send({
      type: 'init',
      config: {
        accountId: id,
        token: account.token,
        tokenType: account.token_type,
        authType: account.auth_type || 'session_key',
        refreshToken: account.refresh_token || '',
        tokenExpiresAt: account.token_expires_at || 0,
        proxy: account.proxy,
        heartbeatInterval: config.heartbeatInterval || 300000,
        fingerprint: {
          os: account.fingerprint_os,
          arch: account.fingerprint_arch,
          node: account.fingerprint_node,
          ccVersion: account.fingerprint_cc_version || '2.1.78',
        },
      },
    });
  }

  /**
   * 停止 Worker
   */
  stopWorker(accountId) {
    const state = this.workers.get(accountId);
    if (!state) return;

    logger.info({ accountId }, '停止 Worker');

    try {
      state.process.send({ type: 'shutdown' });
    } catch (e) {
      // 进程可能已退出
    }

    // 2 秒后强制 kill
    setTimeout(() => {
      try {
        state.process.kill('SIGKILL');
      } catch (e) {
        // ignore
      }
    }, 2000);

    // 拒绝等待中的请求
    for (const [reqId, pending] of state.pendingRequests) {
      pending.reject(new Error('Worker 已停止'));
    }

    updateAccountStatus(accountId, 'offline', '已手动停止');
    rateLimiter.reset(accountId);
    this.workers.delete(accountId);
  }

  /**
   * 停止所有 Worker
   */
  stopAll() {
    for (const [id] of this.workers) {
      this.stopWorker(id);
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
  }

  /**
   * 重启 Worker
   */
  restartWorker(accountId, config = {}) {
    const account = getAccount(accountId);
    if (!account) return;
    this.stopWorker(accountId);
    setTimeout(() => this.startWorker(account, config), 1000);
  }

  /**
   * 发送非流式请求到 Worker
   * @returns {Promise<object>} 响应数据
   */
  sendRequest(accountId, requestId, body) {
    return new Promise((resolve, reject) => {
      const state = this.workers.get(accountId);
      if (!state || !state.process.connected) {
        reject(new Error('Worker 不可用'));
        return;
      }

      state.pendingRequests.set(requestId, { resolve, reject });

      // 30 秒超时
      const timeout = setTimeout(() => {
        state.pendingRequests.delete(requestId);
        reject(new Error('请求超时'));
      }, 300000); // 5 分钟超时，Claude 可能需要很长时间

      state.pendingRequests.get(requestId).timeout = timeout;

      state.process.send({ type: 'request', id: requestId, body });
    });
  }

  /**
   * 发送流式请求到 Worker
   * @returns {object} { events EventEmitter } 用于接收流事件
   */
  sendStreamRequest(accountId, requestId, body) {
    const state = this.workers.get(accountId);
    if (!state || !state.process.connected) {
      throw new Error('Worker 不可用');
    }

    const emitter = new EventEmitter();
    state.pendingRequests.set(requestId, { emitter });

    state.process.send({ type: 'stream_request', id: requestId, body });

    return emitter;
  }

  /**
   * 测试 Worker 连通性
   */
  testWorker(accountId, requestId) {
    return new Promise((resolve, reject) => {
      const state = this.workers.get(accountId);
      if (!state || !state.process.connected) {
        reject(new Error('Worker 不可用'));
        return;
      }

      state.pendingRequests.set(requestId, { resolve, reject });
      state.process.send({ type: 'test', id: requestId });

      setTimeout(() => {
        if (state.pendingRequests.has(requestId)) {
          state.pendingRequests.delete(requestId);
          reject(new Error('测试超时'));
        }
      }, 30000);
    });
  }

  /**
   * 处理 Worker 消息
   */
  _handleWorkerMessage(accountId, msg) {
    const state = this.workers.get(accountId);
    if (!state) return;

    switch (msg.type) {
      case 'status':
        state.status = msg.status;
        updateAccountStatus(accountId, msg.status, msg.message || '');
        break;

      case 'heartbeat':
        state.status = msg.status;
        state.lastPong = Date.now();
        updateAccountStatus(accountId, msg.status, msg.message || '');
        break;

      case 'pong':
        state.lastPong = Date.now();
        break;

      case 'response': {
        const pending = state.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          state.pendingRequests.delete(msg.id);
          pending.resolve(msg.data);
          // 记录用量
          if (msg.usage) {
            recordUsage({ accountId, ...msg.usage });
          }
        }
        break;
      }

      case 'error': {
        const pending = state.pendingRequests.get(msg.id);
        if (pending) {
          if (pending.timeout) clearTimeout(pending.timeout);
          state.pendingRequests.delete(msg.id);
          const err = new Error(msg.error.message);
          err.status = msg.error.status;
          err.type = msg.error.type;
          pending.reject(err);
          if (msg.usage) {
            recordUsage({ accountId, ...msg.usage });
          }
        }
        break;
      }

      case 'stream': {
        const pending = state.pendingRequests.get(msg.id);
        if (pending?.emitter) {
          pending.emitter.emit('event', msg.event);
        }
        break;
      }

      case 'stream_end': {
        const pending = state.pendingRequests.get(msg.id);
        if (pending?.emitter) {
          pending.emitter.emit('end');
          state.pendingRequests.delete(msg.id);
          if (msg.usage) {
            recordUsage({ accountId, ...msg.usage });
          }
        }
        break;
      }

      case 'stream_error': {
        const pending = state.pendingRequests.get(msg.id);
        if (pending?.emitter) {
          pending.emitter.emit('error', msg.error);
          state.pendingRequests.delete(msg.id);
          if (msg.usage) {
            recordUsage({ accountId, ...msg.usage });
          }
        }
        break;
      }

      case 'rate_limited':
        rateLimiter.cooldown(accountId);
        updateAccountStatus(accountId, 'rate_limited', '上游限速');
        break;

      case 'token_refreshed': {
        // Worker 刷新了 OAuth token，更新数据库
        const updateData = {
          token: msg.token,
          refresh_token: msg.refreshToken,
          token_expires_at: msg.tokenExpiresAt,
        };
        // 如果 Session Key 转换为 OAuth，更新 auth_type
        if (msg.authType) {
          updateData.auth_type = msg.authType;
        }
        dbUpdateAccount(accountId, updateData);
        logger.info({ accountId, authType: msg.authType || 'oauth' }, 'OAuth token 已刷新并更新到数据库');
        break;
      }

      case 'test_result': {
        const pending = state.pendingRequests.get(msg.id);
        if (pending) {
          state.pendingRequests.delete(msg.id);
          pending.resolve(msg);
        }
        break;
      }

      case 'log':
        if (logger[msg.level]) {
          logger[msg.level](msg.msg);
        }
        break;
    }
  }

  /**
   * 启动健康检查
   */
  startHealthCheck(interval = 60000) {
    this.healthCheckTimer = setInterval(() => {
      for (const [id, state] of this.workers) {
        // 检查上次 pong 时间
        if (Date.now() - state.lastPong > interval * 3) {
          logger.warn({ accountId: id }, 'Worker 无响应，尝试重启');
          this.restartWorker(id);
          continue;
        }

        // 发送 ping
        try {
          state.process.send({ type: 'ping' });
        } catch (e) {
          logger.warn({ accountId: id }, 'Worker ping 失败');
        }
      }
    }, interval);
  }

  /**
   * 获取所有 Worker 状态
   */
  getStatus() {
    const result = {};
    for (const [id, state] of this.workers) {
      result[id] = {
        status: state.status,
        pendingRequests: state.pendingRequests.size,
        lastPong: state.lastPong,
        connected: state.process.connected,
      };
    }
    return result;
  }

  /**
   * 获取在线 Worker 的账号 ID 列表
   */
  getOnlineWorkerIds() {
    const ids = [];
    for (const [id, state] of this.workers) {
      if (state.status === 'online' && state.process.connected) {
        ids.push(id);
      }
    }
    return ids;
  }

  /**
   * Worker 是否在线
   */
  isOnline(accountId) {
    const state = this.workers.get(accountId);
    return state && state.status === 'online' && state.process.connected;
  }
}

export const workerManager = new WorkerManager();
export default workerManager;

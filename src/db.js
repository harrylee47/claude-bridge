/**
 * db.js - SQLite 数据库模块
 * 使用 better-sqlite3，WAL 模式提高并发性能
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'bridge.db');

// 确保 data 目录存在
const dataDir = path.dirname(DB_PATH);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// 开启 WAL 模式
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

/**
 * 初始化数据库表
 */
export function initDB() {
  db.exec(`
    -- 账号表
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      token_type TEXT NOT NULL DEFAULT 'session_key',  -- session_key / oauth
      token TEXT NOT NULL,
      refresh_token TEXT DEFAULT '',
      token_expires_at INTEGER DEFAULT 0,
      auth_type TEXT NOT NULL DEFAULT 'session_key',  -- session_key / oauth
      proxy TEXT DEFAULT '',
      rpm INTEGER DEFAULT 10,
      max_concurrency INTEGER DEFAULT 2,
      min_interval INTEGER DEFAULT 3000,
      enabled INTEGER DEFAULT 1,
      status TEXT DEFAULT 'offline',  -- online / offline / rate_limited / error
      status_message TEXT DEFAULT '',
      last_heartbeat TEXT,
      fingerprint_os TEXT DEFAULT '',
      fingerprint_arch TEXT DEFAULT '',
      fingerprint_node TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- 用量记录表
    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      status TEXT DEFAULT 'success',
      error_message TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    -- 配置表
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- API Key 表
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL UNIQUE,
      allowed_accounts TEXT DEFAULT '*',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_usage_account ON usage_logs(account_id);
    CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_logs(model);
  `);

  // 迁移：为已有数据库添加 OAuth 相关字段
  const columns = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
  if (!columns.includes('refresh_token')) {
    db.exec("ALTER TABLE accounts ADD COLUMN refresh_token TEXT DEFAULT ''");
  }
  if (!columns.includes('token_expires_at')) {
    db.exec("ALTER TABLE accounts ADD COLUMN token_expires_at INTEGER DEFAULT 0");
  }
  if (!columns.includes('auth_type')) {
    db.exec("ALTER TABLE accounts ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'session_key'");
  }

  // 迁移：为 api_keys 表添加 allowed_accounts 字段
  const akColumns = db.prepare("PRAGMA table_info(api_keys)").all().map(c => c.name);
  if (!akColumns.includes('allowed_accounts')) {
    db.exec("ALTER TABLE api_keys ADD COLUMN allowed_accounts TEXT DEFAULT '*'");
  }

  // 初始化默认配置
  const defaults = {
    'global_rpm': '100',
    'heartbeat_interval': '300000',
    'cooldown_duration': '60000',
    'log_level': 'info',
    'admin_token': '',
  };

  const upsert = db.prepare(`
    INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)
  `);

  for (const [key, value] of Object.entries(defaults)) {
    upsert.run(key, value);
  }
}

// ============ 账号操作 ============

export function getAllAccounts() {
  return db.prepare('SELECT * FROM accounts ORDER BY id').all();
}

export function getAccount(id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

export function getEnabledAccounts() {
  return db.prepare('SELECT * FROM accounts WHERE enabled = 1').all();
}

export function addAccount(data) {
  const stmt = db.prepare(`
    INSERT INTO accounts (name, token_type, token, refresh_token, token_expires_at, auth_type,
      proxy, rpm, max_concurrency, min_interval, 
      enabled, fingerprint_os, fingerprint_arch, fingerprint_node)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    data.name || '', data.token_type || 'session_key', data.token,
    data.refresh_token || '', data.token_expires_at || 0, data.auth_type || 'session_key',
    data.proxy || '', data.rpm || 10, data.max_concurrency || 2,
    data.min_interval || 3000, data.enabled !== undefined ? data.enabled : 1,
    data.fingerprint_os || '', data.fingerprint_arch || '', data.fingerprint_node || ''
  );
  return getAccount(result.lastInsertRowid);
}

export function updateAccount(id, data) {
  const fields = [];
  const values = [];
  const allowed = ['name', 'token_type', 'token', 'refresh_token', 'token_expires_at', 'auth_type',
    'proxy', 'rpm', 'max_concurrency',
    'min_interval', 'enabled', 'status', 'status_message', 'last_heartbeat',
    'fingerprint_os', 'fingerprint_arch', 'fingerprint_node'];

  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(data[key]);
    }
  }
  if (fields.length === 0) return getAccount(id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getAccount(id);
}

export function deleteAccount(id) {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  db.prepare('DELETE FROM usage_logs WHERE account_id = ?').run(id);
}

export function updateAccountStatus(id, status, message = '') {
  db.prepare(`
    UPDATE accounts SET status = ?, status_message = ?, last_heartbeat = datetime('now'),
    updated_at = datetime('now') WHERE id = ?
  `).run(status, message, id);
}

// ============ 用量操作 ============

export function logUsage(data) {
  db.prepare(`
    INSERT INTO usage_logs (account_id, model, input_tokens, output_tokens, duration_ms, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.account_id, data.model || '', data.input_tokens || 0,
    data.output_tokens || 0, data.duration_ms || 0,
    data.status || 'success', data.error_message || ''
  );
}

export function getUsageStats(days = 7) {
  return db.prepare(`
    SELECT 
      date(created_at) as date,
      COUNT(*) as requests,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      AVG(duration_ms) as avg_duration
    FROM usage_logs
    WHERE created_at >= datetime('now', ?)
    GROUP BY date(created_at)
    ORDER BY date
  `).all(`-${days} days`);
}

export function getUsageByAccount(days = 7) {
  return db.prepare(`
    SELECT 
      u.account_id,
      a.name as account_name,
      COUNT(*) as requests,
      SUM(u.input_tokens) as input_tokens,
      SUM(u.output_tokens) as output_tokens
    FROM usage_logs u
    LEFT JOIN accounts a ON u.account_id = a.id
    WHERE u.created_at >= datetime('now', ?)
    GROUP BY u.account_id
    ORDER BY requests DESC
  `).all(`-${days} days`);
}

export function getRecentUsage(limit = 50) {
  return db.prepare(`
    SELECT u.*, a.name as account_name
    FROM usage_logs u
    LEFT JOIN accounts a ON u.account_id = a.id
    ORDER BY u.id DESC
    LIMIT ?
  `).all(limit);
}

export function getTodayStats() {
  return db.prepare(`
    SELECT 
      COUNT(*) as requests,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM usage_logs
    WHERE date(created_at) = date('now')
  `).get();
}

export function cleanOldUsage(days = 30) {
  db.prepare(`DELETE FROM usage_logs WHERE created_at < datetime('now', ?)`).run(`-${days} days`);
}

// ============ 配置操作 ============

export function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setConfig(key, value) {
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
}

export function getAllConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// ============ API Key 操作 ============

export function getApiKeys() {
  return db.prepare('SELECT * FROM api_keys ORDER BY id').all();
}

export function addApiKey(name) {
  const key = 'sk-bridge-' + randomBytes(16).toString('hex');
  const stmt = db.prepare('INSERT INTO api_keys (name, key) VALUES (?, ?)');
  const result = stmt.run(name, key);
  return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(result.lastInsertRowid);
}

export function deleteApiKey(id) {
  const result = db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateApiKeyAllowedAccounts(id, allowedAccounts) {
  db.prepare('UPDATE api_keys SET allowed_accounts = ? WHERE id = ?').run(allowedAccounts, id);
  return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
}

export function validateApiKey(key) {
  const row = db.prepare('SELECT * FROM api_keys WHERE key = ? AND enabled = 1').get(key);
  return !!row;
}

export { db };
export default {
  initDB, getAllAccounts, getAccount, getEnabledAccounts,
  addAccount, updateAccount, deleteAccount, updateAccountStatus,
  logUsage, getUsageStats, getUsageByAccount, getRecentUsage,
  getTodayStats, cleanOldUsage,
  getConfig, setConfig, getAllConfig,
  getApiKeys, addApiKey, deleteApiKey, updateApiKeyAllowedAccounts, validateApiKey,
};

import { randomBytes, scrypt } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { equal, fail, hash, publicUrl, readKey, secret } from './security.mjs';

const derive = promisify(scrypt);
const SESSION_DURATION = 8 * 60 * 60000;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function passwordInput(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) fail(400, 'INVALID_PASSWORD', '管理员密码须为12到128个字符');
  return value;
}
function managedUrl(value) {
  if (value === '') return '';
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error();
    const origin = publicUrl(value);
    if (!origin.startsWith('https://')) throw new Error();
    return origin;
  } catch { fail(400, 'INVALID_BASE_URL', '服务地址须为HTTPS地址，且不能包含路径、查询参数或登录凭证'); }
}
async function passwordRecord(password) {
  const salt = randomBytes(32).toString('hex');
  return { salt, hash: (await derive(password, salt, 64, SCRYPT)).toString('hex') };
}
async function matchesPassword(password, record) {
  if (typeof password !== 'string' || password.length > 128) return false;
  return equal((await derive(password, record.salt, 64, SCRYPT)).toString('hex'), record.hash);
}
function saveConfiguration(filename, value) {
  if (!filename) return;
  const temporary = `${filename}.${randomBytes(12).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, filename);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export class AdminConfiguration {
  constructor({ filename, encryptionKey, adminToken, baseUrl, now, log }) {
    this.now = now;
    this.sessions = new Map();
    this.filename = filename === ':memory:' ? null : join(dirname(filename), 'service-config.json');
    const hasEnvironment = [encryptionKey, adminToken, baseUrl].some(value => value !== undefined && value !== '');
    if (hasEnvironment) {
      if (this.filename && existsSync(this.filename)) throw new Error('Managed configuration and legacy environment configuration cannot be combined; remove the legacy variables to keep the saved encryption key');
      if (typeof adminToken !== 'string' || adminToken.length < 32) throw new Error('ADMIN_TOKEN must be at least 32 characters when legacy environment configuration is used');
      this.key = readKey(encryptionKey);
      this.mode = 'environment';
      this.adminToken = adminToken;
      this.state = { baseUrl: publicUrl(baseUrl || 'http://127.0.0.1:8787') };
      return;
    }
    this.mode = 'managed';
    if (this.filename && existsSync(this.filename)) {
      try {
        this.state = JSON.parse(readFileSync(this.filename, 'utf8'));
        const state = this.state;
        if (state.version !== 1 || typeof state.baseUrl !== 'string' || managedUrl(state.baseUrl) !== state.baseUrl ||
          (state.password === null ? !/^[\w-]{43}$/.test(state.setupCode) :
            (!state.password || !/^[a-f0-9]{64}$/.test(state.password.salt) || !/^[a-f0-9]{128}$/.test(state.password.hash) || state.setupCode !== null))) throw new Error();
        this.key = readKey(state.encryptionKey);
        chmodSync(this.filename, 0o600);
      } catch { throw new Error('Saved service configuration is invalid; restore it from backup without replacing its encryption key'); }
    } else {
      if (filename !== ':memory:' && [filename, `${filename}-wal`, `${filename}-shm`].some(existsSync)) throw new Error('Database exists without its encryption configuration; restore service-config.json or supply the original legacy environment variables');
      if (this.filename) mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
      this.state = { version: 1, encryptionKey: randomBytes(32).toString('hex'), setupCode: secret(), password: null, baseUrl: '' };
      this.key = readKey(this.state.encryptionKey);
      saveConfiguration(this.filename, this.state);
    }
    if (!this.initialized) log(`KDYZM_SETUP_CODE=${this.state.setupCode}`);
  }
  get initialized() { return this.mode === 'environment' || this.state.password !== null; }
  get baseUrl() { return this.state.baseUrl; }
  status() { return { initialized: this.initialized, mode: this.mode, minPasswordLength: 12 }; }
  requireInitialized() { if (!this.initialized) fail(409, 'SETUP_REQUIRED', '请先完成服务初始化'); }
  requireManaged() { if (this.mode !== 'managed') fail(409, 'ENVIRONMENT_READ_ONLY', '当前使用环境变量配置，请在部署配置中修改'); }
  persist(next) { saveConfiguration(this.filename, next); this.state = next; }
  async setup({ setupCode, password, baseUrl = '' }) {
    if (this.initialized || this.initializing) fail(409, 'ALREADY_INITIALIZED', '服务已初始化或正在初始化');
    if (typeof setupCode !== 'string' || setupCode.length > 128 || !equal(setupCode, this.state.setupCode)) fail(401, 'SETUP_UNAUTHORIZED', '初始化凭证无效');
    passwordInput(password);
    baseUrl = managedUrl(baseUrl);
    this.initializing = true;
    try {
      const record = await passwordRecord(password);
      this.persist({ ...this.state, password: record, setupCode: null, baseUrl });
      return { initialized: true };
    } finally { this.initializing = false; }
  }
  newSession() {
    for (const [key, expiresAt] of this.sessions) if (expiresAt <= this.now()) this.sessions.delete(key);
    if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value);
    const token = `pca_${secret()}`;
    const expiresAt = this.now() + SESSION_DURATION;
    this.sessions.set(hash(token), expiresAt);
    return { token, expiresAt };
  }
  authenticate(token) {
    this.requireInitialized();
    if (typeof token === 'string' && token.length <= 4096) {
      if (this.mode === 'environment' && equal(token, this.adminToken)) return;
      const key = hash(token);
      if (this.sessions.get(key) > this.now()) return;
      this.sessions.delete(key);
    }
    fail(401, 'ADMIN_UNAUTHORIZED', '管理员凭证无效或会话已过期，请重新登录');
  }
  async login(password) {
    this.requireInitialized();
    const record = this.state.password;
    const valid = this.mode === 'environment' ? typeof password === 'string' && password.length <= 4096 && equal(password, this.adminToken) : await matchesPassword(password, record);
    // A password changed while scrypt was running must not create a session for the old password.
    if (!valid || record !== this.state.password) fail(401, 'ADMIN_UNAUTHORIZED', '管理员密码无效');
    return this.newSession();
  }
  settings(baseUrl) {
    this.requireManaged();
    this.persist({ ...this.state, baseUrl: managedUrl(baseUrl) });
    return { configurationMode: this.mode, baseUrl: this.baseUrl };
  }
  async changePassword(token, currentPassword, password) {
    this.requireManaged();
    passwordInput(password);
    const record = this.state.password;
    if (!await matchesPassword(currentPassword, record)) fail(401, 'PASSWORD_INVALID', '当前管理员密码无效');
    const next = await passwordRecord(password);
    this.authenticate(token);
    if (record !== this.state.password) fail(401, 'ADMIN_UNAUTHORIZED', '管理员密码已更改，请重新登录');
    this.persist({ ...this.state, password: next });
    this.sessions.clear();
    return this.newSession();
  }
}

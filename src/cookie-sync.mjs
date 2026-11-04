import { createHmac, randomUUID } from 'node:crypto';
import { fail, hash, onlyKeys, secret, text } from './security.mjs';

const PAIR_LIFETIME = 10 * 60000;
const GRANT_LIFETIME = 90 * 86400000;
const CONFIRM_LIFETIME = 5 * 60000;
const accountSummary = ({ id, platform, label, familyId, familyName, credentialVersion, status }) =>
  ({ id, platform, label, familyId, familyName, credentialVersion, status });
const connectionSummary = row => ({ id: row.id, name: row.name, platform: row.platform, accountId: row.account_id,
  createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at, lastSyncAt: row.last_sync_at,
  identityBound: !!row.identity_hash, identityHint: row.identity_hint });

function cookieFields(cookie) {
  if (typeof cookie !== 'string' || !cookie || cookie !== cookie.trim() || cookie.length > 16384 || /[^\x20-\x7e]/.test(cookie)) {
    fail(400, 'INVALID_COOKIE', 'Cookie 格式不正确，请在已登录的平台网页重新读取');
  }
  const fields = new Map();
  for (const part of cookie.split(';')) {
    const match = part.trim().match(/^([!#$%&'*+.^_`|~\w-]+)=(.*)$/);
    if (!match || fields.has(match[1])) fail(400, 'INVALID_COOKIE', 'Cookie 字段缺失或重复，请重新读取');
    fields.set(match[1], match[2]);
  }
  return fields;
}

export function cookieIdentity(platform, cookie, requireLogin = true) {
  const fields = cookieFields(cookie);
  const names = { taobao: ['unb'], pdd: ['pdd_user_id', 'pdduid'], jd: ['pin', 'pt_pin'] }[platform];
  if (!names) fail(400, 'INVALID_PLATFORM', '不支持的平台');
  const values = names.filter(name => fields.has(name)).map(name => {
    let value = fields.get(name);
    if (platform === 'jd') {
      try { value = decodeURIComponent(value); } catch { fail(400, 'COOKIE_IDENTITY_REQUIRED', '平台账号标识格式不正确'); }
    }
    if (!value || value.length > 256 || /[\s\x00-\x1f\x7f;=]/u.test(value)) fail(400, 'COOKIE_IDENTITY_REQUIRED', '缺少有效的平台账号标识');
    return value;
  });
  if (!values.length) fail(400, 'COOKIE_IDENTITY_REQUIRED', '未读取到平台账号标识，请先登录');
  if (new Set(values).size !== 1) fail(400, 'COOKIE_IDENTITY_AMBIGUOUS', '浏览器包含冲突的平台账号标识，请退出其他账号后重新登录');
  const loginField = { taobao: 'cookie2', pdd: 'PDDAccessToken', jd: 'thor' }[platform];
  if (requireLogin && (!fields.get(loginField) || /\s/.test(fields.get(loginField)))) fail(400, 'COOKIE_LOGIN_REQUIRED', '缺少平台登录字段，请重新登录');
  return values[0];
}

export function createCookieSyncHandler({ store, jobs, configuration, now, rate, fixture, bodyOf, send, admin }) {
  const db = store.db;
  let closed = false;
  db.exec(`CREATE TABLE IF NOT EXISTS cookie_sync_pairing (
    code_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), family_id TEXT NOT NULL,
    credential_version INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cookie_sync_connections (
    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id),
    family_id TEXT NOT NULL, platform TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, revoked_at INTEGER, last_sync_at INTEGER NOT NULL DEFAULT 0,
    identity_hash TEXT NOT NULL DEFAULT '', identity_hint TEXT NOT NULL DEFAULT '',
    confirmation_hash TEXT NOT NULL DEFAULT '', confirmation_digest TEXT NOT NULL DEFAULT '',
    confirmation_version INTEGER NOT NULL DEFAULT 0, confirmation_expires_at INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS cookie_sync_account ON cookie_sync_connections(account_id);
    CREATE TRIGGER IF NOT EXISTS cookie_sync_family_change AFTER UPDATE OF data ON accounts
    WHEN COALESCE(json_extract(OLD.data,'$.familyId'),'') <> COALESCE(json_extract(NEW.data,'$.familyId'),'')
    BEGIN
      DELETE FROM cookie_sync_pairing WHERE account_id=NEW.id;
      UPDATE cookie_sync_connections SET revoked_at=CAST(strftime('%s','now') AS INTEGER)*1000,
        confirmation_hash='',confirmation_digest='',confirmation_expires_at=0
        WHERE account_id=NEW.id AND revoked_at IS NULL;
    END;`);
  const identityHash = (platform, identity) => createHmac('sha256', store.key).update(`cookie-sync:${platform}:${identity}`).digest('hex');
  const cleanup = () => {
    db.prepare('DELETE FROM cookie_sync_pairing WHERE expires_at<=?').run(now());
    db.prepare(`DELETE FROM cookie_sync_connections WHERE (revoked_at IS NOT NULL OR expires_at<=?) AND
      (expires_at<? OR id IN (SELECT id FROM cookie_sync_connections WHERE revoked_at IS NOT NULL OR expires_at<=?
        ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 1000))`).run(now(), now() - 30 * 86400000, now());
    db.prepare(`UPDATE cookie_sync_connections SET confirmation_hash='',confirmation_digest='',confirmation_expires_at=0
      WHERE confirmation_expires_at>0 AND confirmation_expires_at<=?`).run(now());
  };
  cleanup();
  const pairingLimit = req => {
    rate.check(`cookie-pair:${req.socket.remoteAddress}`, 10, PAIR_LIFETIME);
    rate.check('cookie-pair:global', 100, PAIR_LIFETIME);
  };
  const summary = row => ({ connection: connectionSummary(row), account: accountSummary(store.account(row.account_id)), serviceId: configuration.serviceId });
  const authenticate = req => {
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const row = token.length <= 100 && token.startsWith('csg_')
      ? db.prepare('SELECT * FROM cookie_sync_connections WHERE token_hash=?').get(hash(token)) : null;
    const account = row && store.account(row.account_id);
    if (!row || row.revoked_at !== null || row.expires_at <= now() || !account || account.familyId !== row.family_id || account.platform !== row.platform) {
      fail(401, 'COOKIE_SYNC_UNAUTHORIZED', 'Cookie 同步授权已失效，请重新配对');
    }
    return row;
  };
  const pair = code => {
    if (typeof code !== 'string' || !/^CS-[A-Za-z0-9_-]{43}$/.test(code)) fail(400, 'COOKIE_PAIRING_INVALID', '配对码无效或已过期');
    const row = db.prepare('SELECT * FROM cookie_sync_pairing WHERE code_hash=?').get(hash(code));
    const account = row && store.account(row.account_id);
    if (!row || row.expires_at <= now() || !account || row.family_id !== account.familyId || row.credential_version !== account.credentialVersion) {
      fail(400, 'COOKIE_PAIRING_INVALID', '配对码无效或已过期');
    }
    return { row, account };
  };
  const revoke = id => {
    const row = db.prepare('SELECT * FROM cookie_sync_connections WHERE id=?').get(id);
    if (!row) fail(404, 'NOT_FOUND', 'Cookie 同步连接不存在');
    db.prepare(`UPDATE cookie_sync_connections SET revoked_at=COALESCE(revoked_at,?),
      confirmation_hash='',confirmation_digest='',confirmation_expires_at=0 WHERE id=?`).run(now(), id);
    return { revoked: true };
  };
  const validateIdentity = (row, cookie) => {
    const identity = cookieIdentity(row.platform, cookie);
    const digest = identityHash(row.platform, identity);
    let existing;
    try { existing = cookieIdentity(row.platform, store.cookie(row.account_id), false); }
    catch (error) {
      // Legacy credentials without an identity may be paired only by explicit first confirmation.
      if (error.code !== 'COOKIE_IDENTITY_REQUIRED') fail(409, 'COOKIE_BACKEND_IDENTITY_INVALID', '后台登录信息包含无效或冲突的账号标识，请管理员先核对');
    }
    if ((row.identity_hash && row.identity_hash !== digest) || (existing && identityHash(row.platform, existing) !== digest)
      || (row.identity_hash && !existing)) fail(409, 'COOKIE_IDENTITY_MISMATCH', '浏览器与已授权账号身份不一致，请核对后台账号并重新配对');
    const characters = [...identity];
    return { digest, hint: `••••${characters.slice(-(characters.length > 4 ? 4 : 1)).join('')}` };
  };

  const handler = async (req, res, url) => {
    const path = url.pathname;
    if (!path.startsWith('/v1/cookie-sync/') && !path.startsWith('/v1/admin/cookie-sync/')) return false;
    cleanup();
    if (path.startsWith('/v1/admin/')) {
      admin(req);
      if (path === '/v1/admin/cookie-sync/pairing' && req.method === 'POST') {
        const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']); onlyKeys(body, ['accountId']);
        const account = store.account(text(body.accountId, '账号ID', 128));
        if (!account) fail(404, 'NOT_FOUND', '账号不存在');
        if (!configuration.baseUrl) fail(409, 'BASE_URL_REQUIRED', '请先配置服务地址');
        rate.check(`cookie-pair-create:${account.id}`, 10, PAIR_LIFETIME);
        const code = `CS-${secret()}`, expiresAt = now() + PAIR_LIFETIME;
        store.transaction(() => {
          db.prepare('DELETE FROM cookie_sync_pairing WHERE account_id=?').run(account.id);
          if (db.prepare('SELECT count(*) AS count FROM cookie_sync_pairing').get().count >= 1000) fail(429, 'RATE_LIMITED', '等待配对的账号过多，请稍后重试');
          db.prepare('INSERT INTO cookie_sync_pairing VALUES(?,?,?,?,?,?)').run(hash(code), account.id, account.familyId, account.credentialVersion, now(), expiresAt);
        });
        send(res, 201, { code, expiresAt, baseUrl: configuration.baseUrl }); return true;
      }
      if (path === '/v1/admin/cookie-sync/connections' && req.method === 'GET') {
        const id = text(url.searchParams.get('accountId'), '账号ID', 128);
        if (!store.account(id)) fail(404, 'NOT_FOUND', '账号不存在');
        send(res, 200, { connections: db.prepare('SELECT * FROM cookie_sync_connections WHERE account_id=? ORDER BY created_at DESC,rowid DESC').all(id).map(connectionSummary) }); return true;
      }
      const target = path.match(/^\/v1\/admin\/cookie-sync\/connections\/([^/]+)$/);
      if (target && req.method === 'DELETE') { send(res, 200, revoke(target[1])); return true; }
      fail(404, 'NOT_FOUND', 'Cookie 同步接口不存在');
    }
    if (path === '/v1/cookie-sync/pairing/preview' && req.method === 'POST') {
      pairingLimit(req); const body = await bodyOf(req); onlyKeys(body, ['code']);
      const { row, account } = pair(body.code);
      send(res, 200, { account: accountSummary(account), expiresAt: row.expires_at, serviceId: configuration.serviceId }); return true;
    }
    if (path === '/v1/cookie-sync/connections' && req.method === 'POST') {
      pairingLimit(req); const body = await bodyOf(req); onlyKeys(body, ['code', 'name']);
      const name = text(body.name, '浏览器名称', 80), token = `csg_${secret()}`, id = randomUUID();
      const result = store.transaction(() => {
        const { account } = pair(body.code);
        if (db.prepare('SELECT count(*) AS count FROM cookie_sync_connections').get().count >= 5000) fail(429, 'RATE_LIMITED', '连接数量已达上限，请联系管理员');
        db.prepare('DELETE FROM cookie_sync_pairing WHERE code_hash=?').run(hash(body.code));
        db.prepare(`UPDATE cookie_sync_connections SET revoked_at=?,confirmation_hash='',confirmation_digest='',confirmation_expires_at=0
          WHERE account_id=? AND revoked_at IS NULL`).run(now(), account.id);
        db.prepare(`INSERT INTO cookie_sync_connections(id,token_hash,account_id,family_id,platform,name,created_at,expires_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(id, hash(token), account.id, account.familyId, account.platform, name, now(), now() + GRANT_LIFETIME);
        return summary(db.prepare('SELECT * FROM cookie_sync_connections WHERE id=?').get(id));
      });
      send(res, 201, { token, ...result }); return true;
    }
    const initial = authenticate(req);
    rate.check(`cookie-sync:${initial.id}`, 120);
    if (path === '/v1/cookie-sync/current' && req.method === 'GET') { send(res, 200, summary(initial)); return true; }
    if (path === '/v1/cookie-sync/current' && req.method === 'DELETE') { send(res, 200, revoke(initial.id)); return true; }
    if (path === '/v1/cookie-sync/current/preview' && req.method === 'POST') {
      const body = await bodyOf(req); const row = authenticate(req); onlyKeys(body, ['cookie']);
      rate.check(`cookie-preview:${row.id}`, 20);
      const identity = validateIdentity(row, body.cookie), account = store.account(row.account_id);
      const confirmationToken = secret(), expiresAt = now() + CONFIRM_LIFETIME;
      db.prepare(`UPDATE cookie_sync_connections SET confirmation_hash=?,confirmation_digest=?,confirmation_version=?,confirmation_expires_at=? WHERE id=?`)
        .run(hash(confirmationToken), hash(body.cookie), account.credentialVersion, expiresAt, row.id);
      send(res, 200, { confirmationToken, identityHint: identity.hint, account: accountSummary(account), expiresAt }); return true;
    }
    if (path === '/v1/cookie-sync/current/cookie' && req.method === 'POST') {
      const body = await bodyOf(req); const row = authenticate(req); onlyKeys(body, ['cookie', 'expectedCredentialVersion', 'confirmationToken']);
      const account = store.account(row.account_id);
      if (!Number.isSafeInteger(body.expectedCredentialVersion) || body.expectedCredentialVersion < 1) fail(400, 'CREDENTIAL_VERSION_REQUIRED', '请先读取账号当前版本');
      if (account.credentialVersion !== body.expectedCredentialVersion) fail(409, 'COOKIE_CREDENTIAL_CONFLICT', '后台账号已更新，请重新读取后再同步');
      const identity = validateIdentity(row, body.cookie);
      if (!row.identity_hash && (typeof body.confirmationToken !== 'string' || body.confirmationToken.length > 100
        || hash(body.confirmationToken) !== row.confirmation_hash || row.confirmation_digest !== hash(body.cookie)
        || row.confirmation_version !== account.credentialVersion || row.confirmation_expires_at <= now())) {
        fail(409, 'COOKIE_CONFIRMATION_REQUIRED', '首次同步请预览并确认角色与平台账号');
      }
      const changed = store.cookie(account.id) !== body.cookie;
      if (changed) rate.check(`cookie-write:${row.id}`, 6, 60000);
      if (changed) {
        store.saveAccount({ cookie: body.cookie }, account.id, fixture, { preserveSyncSchedule: true });
      }
      db.prepare(`UPDATE cookie_sync_connections SET identity_hash=?,identity_hint=?,last_sync_at=?,
        confirmation_hash='',confirmation_digest='',confirmation_expires_at=0 WHERE id=?`).run(identity.digest, identity.hint, now(), row.id);
      let job;
      if (changed) {
        const running = jobs.running.get(account.id), version = store.account(account.id).credentialVersion;
        if (running) {
          // The old collector must finish before requesting work with the replacement credential.
          void running.then(() => {
            if (closed || store.account(account.id)?.credentialVersion !== version) return;
            try { authenticate(req); jobs.request(account.id); } catch { /* Revocation or shutdown cancels the deferred request. */ }
          }).catch(() => {});
        } else job = jobs.request(account.id).job;
      }
      send(res, 200, { changed, ...summary(db.prepare('SELECT * FROM cookie_sync_connections WHERE id=?').get(row.id)), ...(job ? { job } : {}) }); return true;
    }
    fail(404, 'NOT_FOUND', 'Cookie 同步接口不存在');
  };
  handler.close = () => { closed = true; };
  return handler;
}

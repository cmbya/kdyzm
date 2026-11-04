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
const familyConnectionSummary = row => ({ id: row.id, name: row.name, familyId: row.family_id,
  createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at });

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
  const loginFields = { taobao: ['cookie2'], pdd: ['PDDAccessToken'], jd: ['thor', 'light_key'] }[platform];
  if (requireLogin && !loginFields.some(name => fields.get(name) && !/\s/.test(fields.get(name)))) fail(400, 'COOKIE_LOGIN_REQUIRED', '缺少平台登录字段，请重新登录');
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
  db.exec(`CREATE TABLE IF NOT EXISTS cookie_sync_family_pairing (
    code_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cookie_sync_family_connections (
    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, family_id TEXT NOT NULL REFERENCES families(id),
    name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE INDEX IF NOT EXISTS cookie_sync_family ON cookie_sync_family_connections(family_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS cookie_sync_family_requests (
    id TEXT PRIMARY KEY, code_hash TEXT UNIQUE NOT NULL, poll_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    platforms TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    family_id TEXT REFERENCES families(id));
    CREATE TABLE IF NOT EXISTS cookie_sync_family_creation (
    family_connection_id TEXT NOT NULL REFERENCES cookie_sync_family_connections(id) ON DELETE CASCADE,
    platform TEXT NOT NULL, confirmation_hash TEXT NOT NULL, cookie_digest TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(family_connection_id,platform));
    CREATE TRIGGER IF NOT EXISTS cookie_sync_family_creation_revoke AFTER UPDATE OF revoked_at ON cookie_sync_family_connections
    WHEN NEW.revoked_at IS NOT NULL
    BEGIN DELETE FROM cookie_sync_family_creation WHERE family_connection_id=NEW.id; END;`);
  if (!db.prepare('PRAGMA table_info(cookie_sync_connections)').all().some(column => column.name === 'family_connection_id')) {
    db.exec('ALTER TABLE cookie_sync_connections ADD COLUMN family_connection_id TEXT REFERENCES cookie_sync_family_connections(id) ON DELETE CASCADE');
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS cookie_sync_family_child ON cookie_sync_connections(family_connection_id,account_id)
    WHERE family_connection_id IS NOT NULL AND revoked_at IS NULL;
    CREATE TRIGGER IF NOT EXISTS cookie_sync_family_revoke AFTER UPDATE OF revoked_at ON cookie_sync_family_connections
    WHEN NEW.revoked_at IS NOT NULL
    BEGIN
      UPDATE cookie_sync_connections SET revoked_at=COALESCE(revoked_at,NEW.revoked_at),
        confirmation_hash='',confirmation_digest='',confirmation_expires_at=0 WHERE family_connection_id=NEW.id;
    END;`);
  const identityHash = (platform, identity) => createHmac('sha256', store.key).update(`cookie-sync:${platform}:${identity}`).digest('hex');
  const cleanup = () => {
    db.prepare('DELETE FROM cookie_sync_pairing WHERE expires_at<=?').run(now());
    db.prepare('DELETE FROM cookie_sync_family_pairing WHERE expires_at<=?').run(now());
    db.prepare('DELETE FROM cookie_sync_family_requests WHERE expires_at<=?').run(now());
    db.prepare('DELETE FROM cookie_sync_family_creation WHERE expires_at<=?').run(now());
    db.prepare(`DELETE FROM cookie_sync_family_connections WHERE (revoked_at IS NOT NULL OR expires_at<=?) AND
      (expires_at<? OR id IN (SELECT id FROM cookie_sync_family_connections WHERE revoked_at IS NOT NULL OR expires_at<=?
        ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 1000))`).run(now(), now() - 30 * 86400000, now());
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
    if (!row || row.family_connection_id !== null || row.revoked_at !== null || row.expires_at <= now() || !account || account.familyId !== row.family_id || account.platform !== row.platform) {
      fail(401, 'COOKIE_SYNC_UNAUTHORIZED', 'Cookie 同步授权已失效，请重新配对');
    }
    return row;
  };
  const authenticateFamily = req => {
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const row = token.length <= 100 && token.startsWith('cfg_')
      ? db.prepare('SELECT * FROM cookie_sync_family_connections WHERE token_hash=?').get(hash(token)) : null;
    if (!row || row.revoked_at !== null || row.expires_at <= now() || !store.family(row.family_id)) {
      fail(401, 'COOKIE_SYNC_UNAUTHORIZED', '角色 Cookie 同步授权已失效，请重新配对');
    }
    return row;
  };
  const familyChild = (parent, accountId) => db.prepare(`SELECT * FROM cookie_sync_connections
    WHERE family_connection_id=? AND account_id=? AND family_id=? AND revoked_at IS NULL AND expires_at>?`)
    .get(parent.id, accountId, parent.family_id, now());
  const familyAccounts = (familyId, parent) => store.accounts().filter(account => account.familyId === familyId
    && ['taobao', 'pdd', 'jd'].includes(account.platform)).map(account => {
    const child = parent && familyChild(parent, account.id);
    return { account: accountSummary(account), connection: child ? connectionSummary(child) : null };
  });
  const familySummary = parent => ({ connection: familyConnectionSummary(parent), family: store.family(parent.family_id),
    accounts: familyAccounts(parent.family_id, parent), serviceId: configuration.serviceId });
  const issueFamilyGrant = (familyId, name) => {
    if (!store.family(familyId)) fail(404, 'NOT_FOUND', '角色不存在');
    if (db.prepare('SELECT count(*) AS count FROM cookie_sync_family_connections').get().count >= 5000) fail(429, 'RATE_LIMITED', '角色连接数量已达上限，请联系管理员');
    const token = `cfg_${secret()}`, id = randomUUID();
    db.prepare('UPDATE cookie_sync_family_connections SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL').run(now(), familyId);
    db.prepare('INSERT INTO cookie_sync_family_connections VALUES(?,?,?,?,?,?,NULL)').run(id, hash(token), familyId, name, now(), now() + GRANT_LIFETIME);
    return { token, ...familySummary(db.prepare('SELECT * FROM cookie_sync_family_connections WHERE id=?').get(id)) };
  };
  const createFamilyChild = (parent, account) => {
    if (db.prepare('SELECT count(*) AS count FROM cookie_sync_connections').get().count >= 5000) fail(429, 'RATE_LIMITED', '连接数量已达上限，请联系管理员');
    const id = randomUUID();
    db.prepare(`INSERT INTO cookie_sync_connections(id,token_hash,account_id,family_id,platform,name,created_at,expires_at,family_connection_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, hash(secret()), account.id, parent.family_id, account.platform, parent.name, now(), parent.expires_at, parent.id);
    return db.prepare('SELECT * FROM cookie_sync_connections WHERE id=?').get(id);
  };
  const missingPlatform = (parent, platform) => {
    if (!['taobao', 'pdd', 'jd'].includes(platform)) fail(400, 'INVALID_PLATFORM', '不支持的平台');
    if (store.accounts().some(account => account.familyId === parent.family_id && account.platform === platform)) {
      fail(409, 'COOKIE_PLATFORM_EXISTS', '此角色已有该平台账号，请选择已有账号后重新预览');
    }
  };
  const familySelection = (req, accountId) => {
    const parent = authenticateFamily(req), account = store.account(accountId);
    if (!account || account.familyId !== parent.family_id || !['taobao', 'pdd', 'jd'].includes(account.platform)) {
      fail(403, 'SCOPE_FORBIDDEN', '账号不在此角色授权范围内');
    }
    return { parent, account, child: familyChild(parent, accountId) };
  };
  const sameFamilySelection = (req, initial, checkVersion = true) => {
    const current = familySelection(req, initial.account.id);
    if (current.parent.id !== initial.parent.id || (current.child?.id || null) !== (initial.child?.id || null)) {
      fail(401, 'COOKIE_SYNC_UNAUTHORIZED', '账号同步授权已变化，请重新确认');
    }
    if (checkVersion && current.account.credentialVersion !== initial.account.credentialVersion) {
      fail(409, 'COOKIE_CREDENTIAL_CONFLICT', '后台账号已更新，请重新读取后再同步');
    }
    return current;
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
  const familyPair = code => {
    if (typeof code !== 'string' || !/^CF-[A-Za-z0-9_-]{43}$/.test(code)) fail(400, 'COOKIE_PAIRING_INVALID', '配对码无效或已过期');
    const row = db.prepare('SELECT * FROM cookie_sync_family_pairing WHERE code_hash=?').get(hash(code));
    const family = row && store.family(row.family_id);
    if (!row || row.expires_at <= now() || !family) fail(400, 'COOKIE_PAIRING_INVALID', '配对码无效或已过期');
    return { row, family };
  };
  const familyRequest = code => {
    if (typeof code !== 'string' || !/^CR-[A-Za-z0-9_-]{43}$/.test(code)) fail(400, 'COOKIE_REQUEST_INVALID', '授权申请无效或已过期');
    const row = db.prepare('SELECT * FROM cookie_sync_family_requests WHERE code_hash=?').get(hash(code));
    if (!row || row.expires_at <= now()) fail(400, 'COOKIE_REQUEST_INVALID', '授权申请无效或已过期');
    return row;
  };
  const revoke = id => {
    const row = db.prepare('SELECT * FROM cookie_sync_connections WHERE id=?').get(id);
    if (!row) fail(404, 'NOT_FOUND', 'Cookie 同步连接不存在');
    db.prepare(`UPDATE cookie_sync_connections SET revoked_at=COALESCE(revoked_at,?),
      confirmation_hash='',confirmation_digest='',confirmation_expires_at=0 WHERE id=?`).run(now(), id);
    return { revoked: true };
  };
  const revokeFamily = id => {
    if (!db.prepare('SELECT id FROM cookie_sync_family_connections WHERE id=?').get(id)) fail(404, 'NOT_FOUND', '角色 Cookie 同步连接不存在');
    db.prepare('UPDATE cookie_sync_family_connections SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(now(), id);
    return { revoked: true };
  };
  const identityEvidence = (platform, cookie) => {
    const identity = cookieIdentity(platform, cookie), characters = [...identity];
    return { digest: identityHash(platform, identity), hint: `••••${characters.slice(-(characters.length > 4 ? 4 : 1)).join('')}` };
  };
  const validateIdentity = (row, cookie) => {
    const identity = identityEvidence(row.platform, cookie), digest = identity.digest;
    let existing;
    try { existing = cookieIdentity(row.platform, store.cookie(row.account_id), false); }
    catch (error) {
      // Legacy credentials without an identity may be paired only by explicit first confirmation.
      if (error.code !== 'COOKIE_IDENTITY_REQUIRED') fail(409, 'COOKIE_BACKEND_IDENTITY_INVALID', '后台登录信息包含无效或冲突的账号标识，请管理员先核对');
    }
    if ((row.identity_hash && row.identity_hash !== digest) || (existing && identityHash(row.platform, existing) !== digest)
      || (row.identity_hash && !existing)) fail(409, 'COOKIE_IDENTITY_MISMATCH', '浏览器与已授权账号身份不一致，请核对后台账号并重新配对');
    return identity;
  };
  const previewCookie = (row, body, rateKey = row.id) => {
    onlyKeys(body, ['cookie']); rate.check(`cookie-preview:${rateKey}`, 20);
    const identity = validateIdentity(row, body.cookie), account = store.account(row.account_id);
    const confirmationToken = secret(), expiresAt = now() + CONFIRM_LIFETIME;
    db.prepare(`UPDATE cookie_sync_connections SET confirmation_hash=?,confirmation_digest=?,confirmation_version=?,confirmation_expires_at=? WHERE id=?`)
      .run(hash(confirmationToken), hash(body.cookie), account.credentialVersion, expiresAt, row.id);
    return { confirmationToken, identityHint: identity.hint, account: accountSummary(account), expiresAt };
  };
  const bindIdentity = (row, identity) => {
    db.prepare(`UPDATE cookie_sync_connections SET identity_hash=?,identity_hint=?,last_sync_at=?,
      confirmation_hash='',confirmation_digest='',confirmation_expires_at=0 WHERE id=?`).run(identity.digest, identity.hint, now(), row.id);
  };
  const syncResult = (row, changed, authorize) => {
    const account = store.account(row.account_id);
    let job;
    if (changed) {
      const running = jobs.running.get(account.id), version = store.account(account.id).credentialVersion;
      if (running) {
        // Recheck the original grant after the replaced collector finishes; accepted shared jobs remain scheduler-owned.
        void running.then(() => {
          if (closed || store.account(account.id)?.credentialVersion !== version) return;
          try { authorize(); jobs.request(account.id); } catch { /* Revocation or shutdown cancels the deferred request. */ }
        }).catch(() => {});
      } else job = jobs.request(account.id).job;
    }
    return { changed, ...summary(db.prepare('SELECT * FROM cookie_sync_connections WHERE id=?').get(row.id)), ...(job ? { job } : {}) };
  };
  const saveCookie = (row, body, authorize, rateKey = row.id) => {
    onlyKeys(body, ['cookie', 'expectedCredentialVersion', 'confirmationToken']);
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
    if (changed) rate.check(`cookie-write:${rateKey}`, 6, 60000);
    if (changed) store.saveAccount({ cookie: body.cookie }, account.id, fixture, { preserveSyncSchedule: true });
    bindIdentity(row, identity);
    return syncResult(row, changed, authorize);
  };

  const handler = async (req, res, url) => {
    const path = url.pathname;
    if (!path.startsWith('/v1/cookie-sync/') && !path.startsWith('/v1/admin/cookie-sync/')) return false;
    cleanup();
    if (path.startsWith('/v1/admin/')) {
      admin(req);
      const requestTarget = path.match(/^\/v1\/admin\/cookie-sync\/families\/requests\/([^/]+)(\/approve)?$/);
      if (requestTarget && !requestTarget[2] && req.method === 'GET') {
        const row = familyRequest(requestTarget[1]);
        send(res, 200, { requestId: row.id, name: row.name, platforms: JSON.parse(row.platforms), expiresAt: row.expires_at,
          status: row.family_id ? 'approved' : 'pending' }); return true;
      }
      if (requestTarget?.[2] && req.method === 'POST') {
        const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']); onlyKeys(body, ['familyId']);
        const family = store.family(text(body.familyId, '角色ID', 128)), row = familyRequest(requestTarget[1]);
        if (!family) fail(404, 'NOT_FOUND', '角色不存在');
        if (row.family_id) fail(409, 'COOKIE_REQUEST_APPROVED', '此申请已授权，请勿重复操作');
        db.prepare('UPDATE cookie_sync_family_requests SET family_id=? WHERE id=?').run(family.id, row.id);
        send(res, 200, { approved: true }); return true;
      }
      if (path === '/v1/admin/cookie-sync/families/pairing' && req.method === 'POST') {
        const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']); onlyKeys(body, ['familyId']);
        const family = store.family(text(body.familyId, '角色ID', 128));
        if (!family) fail(404, 'NOT_FOUND', '角色不存在');
        if (!configuration.baseUrl) fail(409, 'BASE_URL_REQUIRED', '请先配置服务地址');
        rate.check(`cookie-family-pair-create:${family.id}`, 10, PAIR_LIFETIME);
        const code = `CF-${secret()}`, expiresAt = now() + PAIR_LIFETIME;
        store.transaction(() => {
          db.prepare('DELETE FROM cookie_sync_family_pairing WHERE family_id=?').run(family.id);
          if (db.prepare('SELECT count(*) AS count FROM cookie_sync_family_pairing').get().count >= 1000) fail(429, 'RATE_LIMITED', '等待配对的角色过多，请稍后重试');
          db.prepare('INSERT INTO cookie_sync_family_pairing VALUES(?,?,?,?)').run(hash(code), family.id, now(), expiresAt);
        });
        send(res, 201, { code, expiresAt, baseUrl: configuration.baseUrl }); return true;
      }
      if (path === '/v1/admin/cookie-sync/families/connections' && req.method === 'GET') {
        const id = text(url.searchParams.get('familyId'), '角色ID', 128);
        if (!store.family(id)) fail(404, 'NOT_FOUND', '角色不存在');
        send(res, 200, { connections: db.prepare('SELECT * FROM cookie_sync_family_connections WHERE family_id=? ORDER BY created_at DESC,rowid DESC').all(id).map(familyConnectionSummary) }); return true;
      }
      const familyTarget = path.match(/^\/v1\/admin\/cookie-sync\/families\/connections\/([^/]+)$/);
      if (familyTarget && req.method === 'DELETE') { send(res, 200, revokeFamily(familyTarget[1])); return true; }
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
    if (path === '/v1/cookie-sync/families/pairing/preview' && req.method === 'POST') {
      pairingLimit(req); const body = await bodyOf(req); onlyKeys(body, ['code']);
      const { row, family } = familyPair(body.code);
      send(res, 200, { family, accounts: familyAccounts(family.id), expiresAt: row.expires_at, serviceId: configuration.serviceId }); return true;
    }
    if (path === '/v1/cookie-sync/families/connections' && req.method === 'POST') {
      pairingLimit(req); const body = await bodyOf(req); onlyKeys(body, ['code', 'name']);
      const name = text(body.name, '浏览器名称', 80);
      const result = store.transaction(() => {
        const { family } = familyPair(body.code);
        db.prepare('DELETE FROM cookie_sync_family_pairing WHERE code_hash=?').run(hash(body.code));
        return issueFamilyGrant(family.id, name);
      });
      send(res, 201, result); return true;
    }
    if (path === '/v1/cookie-sync/families/requests' && req.method === 'POST') {
      pairingLimit(req); const body = await bodyOf(req); onlyKeys(body, ['name', 'platforms']);
      const name = text(body.name, '浏览器名称', 80), platforms = body.platforms;
      if (!Array.isArray(platforms) || !platforms.length || platforms.length > 3 || new Set(platforms).size !== platforms.length
        || platforms.some(platform => !['taobao', 'pdd', 'jd'].includes(platform))) fail(400, 'INVALID_PLATFORM', '请选择支持的平台');
      if (db.prepare('SELECT count(*) AS count FROM cookie_sync_family_requests').get().count >= 1000) fail(429, 'RATE_LIMITED', '等待授权的申请过多，请稍后重试');
      const requestId = randomUUID(), code = `CR-${secret()}`, pollToken = `cpr_${secret()}`, expiresAt = now() + PAIR_LIFETIME;
      db.prepare('INSERT INTO cookie_sync_family_requests VALUES(?,?,?,?,?,?,?,NULL)').run(requestId, hash(code), hash(pollToken), name, JSON.stringify(platforms), now(), expiresAt);
      send(res, 201, { requestId, code, pollToken, expiresAt }); return true;
    }
    if (path === '/v1/cookie-sync/families/requests/poll' && req.method === 'POST') {
      rate.check(`cookie-request-poll:${req.socket.remoteAddress}`, 120); rate.check('cookie-request-poll:global', 3000);
      const body = await bodyOf(req); onlyKeys(body, ['requestId', 'pollToken']);
      if (typeof body.requestId !== 'string' || body.requestId.length > 128 || typeof body.pollToken !== 'string'
        || !/^cpr_[A-Za-z0-9_-]{43}$/.test(body.pollToken)) fail(400, 'COOKIE_REQUEST_INVALID', '授权申请无效或已过期');
      const result = store.transaction(() => {
        const row = db.prepare('SELECT * FROM cookie_sync_family_requests WHERE id=? AND poll_hash=?').get(body.requestId, hash(body.pollToken));
        if (!row || row.expires_at <= now()) fail(400, 'COOKIE_REQUEST_INVALID', '授权申请无效或已过期');
        if (!row.family_id) return { status: 'pending', expiresAt: row.expires_at };
        db.prepare('DELETE FROM cookie_sync_family_requests WHERE id=?').run(row.id);
        return { status: 'approved', ...issueFamilyGrant(row.family_id, row.name) };
      });
      send(res, 200, result); return true;
    }
    if (path.startsWith('/v1/cookie-sync/families/')) {
      const parent = authenticateFamily(req); rate.check(`cookie-family:${parent.id}`, 240);
      if (path === '/v1/cookie-sync/families/current' && req.method === 'GET') { send(res, 200, familySummary(parent)); return true; }
      if (path === '/v1/cookie-sync/families/current' && req.method === 'DELETE') { send(res, 200, revokeFamily(parent.id)); return true; }
      const platformPath = path.match(/^\/v1\/cookie-sync\/families\/current\/platforms\/([^/]+)\/(preview|cookie)$/);
      if (platformPath && req.method === 'POST') {
        const platform = platformPath[1]; missingPlatform(parent, platform);
        const body = await bodyOf(req), current = authenticateFamily(req); missingPlatform(current, platform);
        const rateKey = `family:${current.id}:platform:${platform}`;
        if (platformPath[2] === 'preview') {
          onlyKeys(body, ['cookie']); rate.check(`cookie-preview:${rateKey}`, 20);
          const identity = identityEvidence(platform, body.cookie), confirmationToken = secret(), expiresAt = Math.min(now() + CONFIRM_LIFETIME, current.expires_at);
          if (db.prepare('SELECT count(*) AS count FROM cookie_sync_family_creation').get().count >= 15000) fail(429, 'RATE_LIMITED', '待确认的平台过多，请稍后重试');
          db.prepare(`INSERT INTO cookie_sync_family_creation VALUES(?,?,?,?,?) ON CONFLICT(family_connection_id,platform)
            DO UPDATE SET confirmation_hash=excluded.confirmation_hash,cookie_digest=excluded.cookie_digest,expires_at=excluded.expires_at`)
            .run(current.id, platform, hash(confirmationToken), hash(body.cookie), expiresAt);
          send(res, 200, { newAccount: true, platform, confirmationToken, identityHint: identity.hint, expiresAt, serviceId: configuration.serviceId }); return true;
        }
        onlyKeys(body, ['cookie', 'expectedCredentialVersion', 'confirmationToken']);
        if (body.expectedCredentialVersion !== 0) fail(400, 'CREDENTIAL_VERSION_REQUIRED', '新平台账号的预期版本必须为0');
        const identity = identityEvidence(platform, body.cookie);
        const proof = db.prepare('SELECT * FROM cookie_sync_family_creation WHERE family_connection_id=? AND platform=?').get(current.id, platform);
        if (!proof || proof.expires_at <= now() || typeof body.confirmationToken !== 'string' || body.confirmationToken.length > 100
          || hash(body.confirmationToken) !== proof.confirmation_hash || hash(body.cookie) !== proof.cookie_digest) {
          fail(409, 'COOKIE_CONFIRMATION_REQUIRED', '请先预览并确认新平台账号');
        }
        rate.check(`cookie-write:${rateKey}`, 6);
        const row = store.transaction(() => {
          const family = store.family(current.family_id), platformLabel = { taobao: '淘宝', pdd: '拼多多', jd: '京东' }[platform];
          const account = store.saveAccount({ familyId: family.id, platform, label: `${family.name.slice(0, 60)} · ${platformLabel}`, cookie: body.cookie },
            undefined, fixture, { inTransaction: true });
          const child = createFamilyChild(current, account); bindIdentity(child, identity);
          db.prepare('DELETE FROM cookie_sync_family_creation WHERE family_connection_id=? AND platform=?').run(current.id, platform);
          return child;
        });
        send(res, 200, syncResult(row, true, () => {
          if (familySelection(req, row.account_id).child?.id !== row.id) fail(401, 'COOKIE_SYNC_UNAUTHORIZED', '账号同步授权已变化');
        })); return true;
      }
      const selected = path.match(/^\/v1\/cookie-sync\/families\/current\/accounts\/([^/]+)(?:\/(preview|cookie))?$/);
      if (selected) {
        const initial = familySelection(req, selected[1]), rateKey = `family:${parent.id}:${initial.account.id}`;
        rate.check(`cookie-sync:${rateKey}`, 120);
        if (!selected[2] && req.method === 'GET') {
          send(res, 200, { account: accountSummary(initial.account), connection: initial.child ? connectionSummary(initial.child) : null, serviceId: configuration.serviceId }); return true;
        }
        if (selected[2] && req.method === 'POST') {
          const body = await bodyOf(req), current = sameFamilySelection(req, initial);
          if (selected[2] === 'preview') {
            const result = store.transaction(() => {
              let row = current.child;
              if (!row) row = createFamilyChild(parent, current.account);
              return { ...previewCookie(row, body, rateKey), connection: connectionSummary(row), serviceId: configuration.serviceId };
            });
            send(res, 200, result); return true;
          }
          if (!current.child) fail(409, 'COOKIE_CONFIRMATION_REQUIRED', '请先预览并确认此平台账号');
          send(res, 200, saveCookie(current.child, body, () => sameFamilySelection(req, current, false), rateKey)); return true;
        }
      }
      fail(404, 'NOT_FOUND', '角色 Cookie 同步接口不存在');
    }
    const initial = authenticate(req);
    rate.check(`cookie-sync:${initial.id}`, 120);
    if (path === '/v1/cookie-sync/current' && req.method === 'GET') { send(res, 200, summary(initial)); return true; }
    if (path === '/v1/cookie-sync/current' && req.method === 'DELETE') { send(res, 200, revoke(initial.id)); return true; }
    if (path === '/v1/cookie-sync/current/preview' && req.method === 'POST') {
      const body = await bodyOf(req); const row = authenticate(req);
      send(res, 200, previewCookie(row, body)); return true;
    }
    if (path === '/v1/cookie-sync/current/cookie' && req.method === 'POST') {
      const body = await bodyOf(req); const row = authenticate(req);
      send(res, 200, saveCookie(row, body, () => authenticate(req))); return true;
    }
    fail(404, 'NOT_FOUND', 'Cookie 同步接口不存在');
  };
  handler.close = () => { closed = true; };
  return handler;
}

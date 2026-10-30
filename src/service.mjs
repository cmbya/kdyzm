import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Store } from './store.mjs';
import { AdminConfiguration } from './configuration.mjs';
import { createCollector } from './collectors.mjs';
import { fail, hash, HttpError, onlyKeys, publicUrl, RateLimiter } from './security.mjs';

const PUBLIC = new URL('../public/', import.meta.url);
const STATIC = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']], ['/admin.css', ['admin.css', 'text/css; charset=utf-8']]]);

async function bodyOf(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'JSON_REQUIRED', '请使用 application/json');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > 65536) fail(413, 'BODY_TOO_LARGE', '请求过大'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'INVALID_JSON', 'JSON格式不正确'); }
}
function send(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(data === undefined ? undefined : JSON.stringify(data));
}

export function createService({ filename = ':memory:', encryptionKey, adminToken, baseUrl,
  now = Date.now, collector = createCollector({ now }), fixture = false, scheduler = true, corsOrigins = [], log = console.log } = {}) {
  const origins = new Set(corsOrigins.map(publicUrl));
  const configuration = new AdminConfiguration({ filename, encryptionKey, adminToken, baseUrl, now, log });
  const store = new Store({ filename, key: configuration.key, now });
  const rate = new RateLimiter(now);
  const running = new Map();
  const allowed = (device, id) => { if (!device.accountIds.includes(id)) fail(403, 'SCOPE_FORBIDDEN', '账号不在授权范围内'); };
  const admin = req => {
    rate.check(`admin:${req.socket.remoteAddress}`, 120);
    configuration.authenticate(req.headers['x-admin-token']);
  };
  const credentialLimit = req => {
    rate.check(`credentials:${req.socket.remoteAddress}`, 10, 10 * 60000);
    rate.check('credentials:global', 100, 10 * 60000);
  };
  const device = req => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.length > 300) fail(401, 'DEVICE_UNAUTHORIZED', '请绑定设备');
    const current = store.device(auth.slice(7));
    rate.check(`device:${current.id}`, 180);
    return current;
  };
  const requestSync = id => {
    if (running.has(id)) return running.get(id);
    const account = store.account(id);
    if (!account || !account.enabled || (account.lastAttemptAt && now() - account.lastAttemptAt < 5 * 60000)) return Promise.resolve();
    store.updateAccount(id, { status: 'syncing', lastAttemptAt: now(), nextSyncAt: now() + account.intervalMinutes * 60000, error: '' });
    const task = Promise.resolve().then(async () => {
      try {
        const previous = store.snapshot([id]);
        const activeOrderIds = new Set(previous.shipments.filter(s => !s.picked && !s.hidden && !s.deleted && s.status !== 'signed').map(s => s.orderId));
        const trackedOrderIds = previous.orders.filter(o => activeOrderIds.has(o.id)).map(o => o.platformOrderId);
        const result = await collector(account, store.cookie(id), { trackedOrderIds });
        // A response started with an old login must not replace newly supplied credentials or state.
        if (store.account(id).credentialVersion !== account.credentialVersion) return;
        store.importResult(id, result);
        if (result.refreshedCookie) store.refreshCookie(id, result.refreshedCookie);
      } catch (error) {
        if (store.account(id).credentialVersion !== account.credentialVersion) return;
        const expired = error.code === 'ACCOUNT_EXPIRED';
        const known = ['UPSTREAM_ERROR', 'UPSTREAM_FORMAT', 'UPSTREAM_BLOCKED', 'ACCOUNT_EXPIRED'].includes(error.code);
        store.updateAccount(id, { status: expired ? 'expired' : 'error', error: known ? error.message : '同步未完成，请检查网络与后台配置', warnings: [] });
      } finally { running.delete(id); }
    });
    running.set(id, task);
    return task;
  };
  const timer = scheduler ? setInterval(() => {
    for (const account of store.accounts()) if (account.enabled && account.nextSyncAt <= now()) void requestSync(account.id);
  }, 30000).unref() : null;

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const origin = req.headers.origin;
      let localFixtureOrigin = false;
      if (fixture && origin) {
        try { const source = new URL(origin); localFixtureOrigin = source.origin === origin && source.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname); } catch { /* Invalid Origin is rejected below. */ }
      }
      const corsAllowed = origins.has(origin) || localFixtureOrigin;
      let sameHost = false;
      if (origin && req.headers.host) {
        try {
          const source = new URL(origin);
          sameHost = source.origin === origin && ['http:', 'https:'].includes(source.protocol) && source.host === new URL(`${source.protocol}//${req.headers.host}`).host;
        } catch { /* Invalid Origin or Host is rejected below. */ }
      }
      if (origin && origin !== configuration.baseUrl && !sameHost && !corsAllowed) fail(403, 'ORIGIN_FORBIDDEN', '来源不允许');
      if (origin && corsAllowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Expose-Headers', 'ETag');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match, X-Admin-Token', 'Access-Control-Max-Age': '600' });
        res.end(); return;
      }
      const url = new URL(req.url, configuration.baseUrl || 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && STATIC.has(path)) {
        const [file, type] = STATIC.get(path);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(await readFile(new URL(file, PUBLIC))); return;
      }
      if (path === '/health' && req.method === 'GET') { send(res, 200, { ok: true }); return; }
      if (!path.startsWith('/v1/')) fail(404, 'NOT_FOUND', '接口不存在');

      if (path === '/v1/setup' && req.method === 'GET') { send(res, 200, configuration.status()); return; }
      if (path === '/v1/setup' && req.method === 'POST') {
        if (configuration.initialized) fail(409, 'ALREADY_INITIALIZED', '服务已初始化');
        credentialLimit(req);
        const body = await bodyOf(req); onlyKeys(body, ['setupCode', 'password', 'baseUrl']);
        send(res, 200, await configuration.setup(body)); return;
      }
      configuration.requireInitialized();
      if (path === '/v1/admin/login' && req.method === 'POST') {
        credentialLimit(req);
        const body = await bodyOf(req); onlyKeys(body, ['password']);
        send(res, 200, await configuration.login(body.password)); return;
      }

      if (path === '/v1/devices' && req.method === 'POST') {
        // Never trust a client-provided X-Forwarded-For to partition guessing limits.
        rate.check(`pair:${req.socket.remoteAddress}`, 10, 10 * 60000);
        rate.check('pair:global', 100, 10 * 60000);
        const body = await bodyOf(req);
        onlyKeys(body, ['code', 'deviceName']);
        send(res, 201, store.redeem(body.code, body.deviceName)); return;
      }
      if (path === '/v1/pairing-codes' && req.method === 'POST') {
        admin(req);
        const body = await bodyOf(req);
        configuration.authenticate(req.headers['x-admin-token']);
        onlyKeys(body, ['accountIds']);
        const baseUrl = configuration.baseUrl;
        if (!baseUrl) fail(409, 'BASE_URL_REQUIRED', '请先在设置中填写HTTPS服务地址，再生成绑定码');
        const pair = store.createPairing(body.accountIds);
        const qrPayload = JSON.stringify({ schemaVersion: 1, baseUrl, code: pair.code });
        const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 256, margin: 2, errorCorrectionLevel: 'M' });
        configuration.authenticate(req.headers['x-admin-token']);
        send(res, 201, { ...pair, baseUrl, qrPayload, qrDataUrl }); return;
      }
      if (path.startsWith('/v1/admin/')) {
        admin(req);
        if (path === '/v1/admin/status' && req.method === 'GET') { send(res, 200, { fixture, baseUrl: configuration.baseUrl, configurationMode: configuration.mode }); return; }
        if (path === '/v1/admin/settings' && req.method === 'PATCH') {
          const body = await bodyOf(req); onlyKeys(body, ['baseUrl']);
          configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, configuration.settings(body.baseUrl)); return;
        }
        if (path === '/v1/admin/password' && req.method === 'POST') {
          credentialLimit(req);
          const body = await bodyOf(req); onlyKeys(body, ['currentPassword', 'password']);
          configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, await configuration.changePassword(req.headers['x-admin-token'], body.currentPassword, body.password)); return;
        }
        if (path === '/v1/admin/accounts' && req.method === 'GET') { send(res, 200, { accounts: store.accounts() }); return; }
        if (path === '/v1/admin/accounts' && req.method === 'POST') {
          const body = await bodyOf(req);
          configuration.authenticate(req.headers['x-admin-token']);
          send(res, 201, { account: store.saveAccount(body, undefined, fixture) }); return;
        }
        if (path === '/v1/admin/devices' && req.method === 'GET') { send(res, 200, { devices: store.devices() }); return; }
        const accountPath = path.match(/^\/v1\/admin\/accounts\/([^/]+)(\/sync)?$/);
        if (accountPath) {
          if (!store.account(accountPath[1])) fail(404, 'NOT_FOUND', '账号不存在');
          if (!accountPath[2] && req.method === 'PATCH') {
            const body = await bodyOf(req);
            configuration.authenticate(req.headers['x-admin-token']);
            send(res, 200, { account: store.saveAccount(body, accountPath[1], fixture) }); return;
          }
          if (accountPath[2] && req.method === 'POST') {
            const body = await bodyOf(req);
            configuration.authenticate(req.headers['x-admin-token']);
            onlyKeys(body, []); void requestSync(accountPath[1]); send(res, 202, { accepted: true }); return;
          }
        }
        fail(404, 'NOT_FOUND', '管理接口不存在');
      }
      const revokePath = path.match(/^\/v1\/devices\/([^/]+)$/);
      if (revokePath && revokePath[1] !== 'current' && req.method === 'DELETE') {
        admin(req); send(res, 200, store.revoke(revokePath[1])); return;
      }
      const current = device(req);
      if (path === '/v1/devices/current' && req.method === 'DELETE') { send(res, 200, store.revoke(current.id)); return; }
      if (path === '/v1/accounts' && req.method === 'GET') { send(res, 200, { accounts: store.accounts(current.accountIds) }); return; }
      if (path === '/v1/accounts/sync' && req.method === 'POST') {
        onlyKeys(await bodyOf(req), []);
        current.accountIds.forEach(id => { void requestSync(id); });
        send(res, 202, { accepted: true }); return;
      }
      const syncPath = path.match(/^\/v1\/accounts\/([^/]+)\/sync$/);
      if (syncPath && req.method === 'POST') {
        allowed(current, syncPath[1]); onlyKeys(await bodyOf(req), []);
        void requestSync(syncPath[1]); send(res, 202, { accepted: true }); return;
      }
      if (path === '/v1/snapshot' && req.method === 'GET') {
        const requested = url.searchParams.getAll('accountId');
        requested.forEach(id => allowed(current, id));
        const snapshot = store.snapshot(requested.length ? requested : current.accountIds);
        const etag = `"${hash(JSON.stringify(snapshot))}"`;
        const matches = (req.headers['if-none-match'] || '').split(',').map(t => t.trim().replace(/^W\//, '')).includes(etag);
        send(res, matches ? 304 : 200, matches ? undefined : snapshot, { ETag: etag }); return;
      }
      if (path === '/v1/operations' && req.method === 'POST') {
        const body = await bodyOf(req); onlyKeys(body, ['operations']);
        send(res, 200, store.applyOperations(current, body.operations)); return;
      }
      const operationPath = path.match(/^\/v1\/operations\/([^/]+)$/);
      if (operationPath && req.method === 'GET') { send(res, 200, store.operation(current, decodeURIComponent(operationPath[1]))); return; }
      fail(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      if (!res.headersSent) send(res, error instanceof HttpError ? error.status : 500, { error: { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR', message: error instanceof HttpError ? error.message : '服务暂不可用' } });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxHeadersCount = 60;
  return { server, store, requestSync, fixture, running,
    async close() {
      if (timer) clearInterval(timer);
      await new Promise(resolve => server.close(resolve));
      await Promise.all([...running.values()]);
      store.close();
    } };
}

export const serviceDirectory = fileURLToPath(new URL('../', import.meta.url));

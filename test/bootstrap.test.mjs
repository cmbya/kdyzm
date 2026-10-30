import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../src/service.mjs';

const PASSWORD = 'my-first-admin-password';
const NEXT_PASSWORD = 'my-updated-admin-password';
const ADMIN = 'legacy-admin-token-with-at-least-32-characters';
const KEY = 'cd'.repeat(32);
const TIME = 1793350000000;

async function harness(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'kdyzm-bootstrap-'));
  const filename = join(directory, 'pickcode.db');
  const configPath = join(directory, 'service-config.json');
  let current = TIME;
  let service;
  let base;
  const logs = [];
  const stop = async () => { if (service) { await service.close(); service = null; } };
  t.after(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  const start = async () => {
    service = createService({ filename, scheduler: false, now: () => current, log: message => logs.push(message), ...options });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${service.server.address().port}`;
  };
  const request = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'X-Admin-Token': token } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    return { status: response.status, data: raw ? JSON.parse(raw) : null, raw };
  };
  const setup = (body = {}) => request('/v1/setup', { method: 'POST', body: { setupCode: logs[0]?.split('=')[1], password: PASSWORD, baseUrl: '', ...body } });
  const login = (password = PASSWORD) => request('/v1/admin/login', { method: 'POST', body: { password } });
  await start();
  return { filename, configPath, logs, start, stop, request, setup, login,
    config: () => JSON.parse(readFileSync(configPath, 'utf8')),
    service: () => service, base: () => base, advance: ms => { current += ms; } };
}

test('first access exposes status only, rejects cross-origin and invalid setup, and consumes the setup code once under concurrency', async t => {
  const h = await harness(t, { encryptionKey: '', adminToken: '', baseUrl: '' });
  const status = await h.request('/v1/setup');
  assert.deepEqual(status.data, { initialized: false, mode: 'managed', minPasswordLength: 12 });
  assert.match(h.logs[0], /^KDYZM_SETUP_CODE=[\w-]{43}$/);
  const firstConfig = h.config();
  assert.ok(!status.raw.includes(firstConfig.encryptionKey));
  assert.ok(!status.raw.includes(firstConfig.setupCode));
  for (const path of ['/v1/accounts', '/v1/snapshot', '/v1/admin/accounts', '/v1/admin/status']) assert.equal((await h.request(path)).data.error.code, 'SETUP_REQUIRED');
  assert.equal((await h.request('/v1/devices', { method: 'POST', body: { code: 'wrong', deviceName: 'test' } })).status, 409);
  assert.equal((await h.login()).status, 409);
  assert.equal((await h.request('/v1/setup', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await h.request('/v1/setup', { headers: { Origin: h.base() } })).status, 200);
  assert.equal((await h.setup({ setupCode: 'wrong' })).status, 401);
  assert.equal((await h.setup({ password: 'too-short' })).status, 400);
  assert.equal((await h.setup({ baseUrl: 'http://127.0.0.1:8787' })).status, 400);
  const attempts = await Promise.all([h.setup(), h.setup()]);
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
  assert.equal((await h.setup()).status, 409);
  assert.deepEqual((await h.request('/v1/setup')).data, { initialized: true, mode: 'managed', minPasswordLength: 12 });
  const saved = h.config();
  assert.equal(saved.encryptionKey, firstConfig.encryptionKey);
  assert.equal(saved.setupCode, null);
  assert.match(saved.password.salt, /^[a-f0-9]{64}$/);
  assert.match(saved.password.hash, /^[a-f0-9]{128}$/);
  assert.ok(!readFileSync(h.configPath, 'utf8').includes(PASSWORD));
  if (process.platform !== 'win32') assert.equal(statSync(h.configPath).mode & 0o777, 0o600);
});

test('setup and login guessing share bounded limits that forwarded client IPs cannot bypass', async t => {
  const h = await harness(t);
  for (let n = 0; n < 10; n++) {
    const response = await h.request('/v1/setup', { method: 'POST', body: { setupCode: 'wrong', password: PASSWORD }, headers: { 'X-Forwarded-For': `192.0.2.${n}` } });
    assert.equal(response.status, 401);
  }
  assert.equal((await h.setup()).status, 429);
  h.advance(10 * 60000);
  assert.equal((await h.setup()).status, 200);
  for (let n = 0; n < 9; n++) assert.equal((await h.login('wrong-password')).status, 401);
  assert.equal((await h.login()).status, 429);
});

test('settings require an admin session; password changes revoke sessions while preserving device tokens and encryption', async t => {
  const h = await harness(t);
  assert.equal((await h.setup()).status, 200);
  const first = (await h.login()).data;
  const second = (await h.login()).data;
  assert.equal(first.expiresAt, TIME + 8 * 60 * 60000);
  assert.notEqual(first.token, second.token);
  const status = await h.request('/v1/admin/status', { token: first.token });
  assert.deepEqual(status.data, { fixture: false, baseUrl: '', configurationMode: 'managed' });
  const account = await h.request('/v1/admin/accounts', { method: 'POST', token: first.token, body: { platform: 'taobao', label: '我的淘宝', cookie: 'private-cookie-value' } });
  assert.equal(account.status, 201);
  const pairing = { method: 'POST', token: first.token, body: { accountIds: [account.data.account.id] } };
  assert.equal((await h.request('/v1/pairing-codes', pairing)).data.error.code, 'BASE_URL_REQUIRED');
  assert.equal((await h.request('/v1/admin/settings', { method: 'PATCH', body: { baseUrl: 'https://pickup.example' } })).status, 401);
  assert.equal((await h.request('/v1/admin/settings', { method: 'PATCH', token: first.token, body: { baseUrl: 'https://pickup.example/path' } })).status, 400);
  assert.equal((await h.request('/v1/admin/settings', { method: 'PATCH', token: first.token, body: { baseUrl: 'https://pickup.example' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  const updated = await h.request('/v1/admin/settings', { method: 'PATCH', token: first.token, body: { baseUrl: 'https://pickup.example' }, headers: { Origin: h.base() } });
  assert.deepEqual(updated.data, { configurationMode: 'managed', baseUrl: 'https://pickup.example' });
  const pair = await h.request('/v1/pairing-codes', pairing);
  assert.equal(JSON.parse(pair.data.qrPayload).baseUrl, 'https://pickup.example');
  const device = await h.request('/v1/devices', { method: 'POST', body: { code: pair.data.code, deviceName: '手机' } });
  const originalKey = h.config().encryptionKey;
  const wrongPassword = await h.request('/v1/admin/password', { method: 'POST', token: first.token, body: { currentPassword: 'wrong', password: NEXT_PASSWORD } });
  assert.equal(wrongPassword.data.error.code, 'PASSWORD_INVALID');
  assert.equal((await h.request('/v1/admin/status', { token: first.token })).status, 200);
  const changed = await h.request('/v1/admin/password', { method: 'POST', token: first.token, body: { currentPassword: PASSWORD, password: NEXT_PASSWORD } });
  assert.equal(changed.status, 200);
  for (const token of [first.token, second.token]) assert.equal((await h.request('/v1/admin/status', { token })).data.error.code, 'ADMIN_UNAUTHORIZED');
  assert.equal((await h.request('/v1/admin/status', { token: changed.data.token })).status, 200);
  assert.equal((await h.login()).status, 401);
  assert.equal((await h.login(NEXT_PASSWORD)).status, 200);
  assert.equal(h.config().encryptionKey, originalKey);
  assert.equal(h.service().store.cookie(account.data.account.id), 'private-cookie-value');
  assert.equal((await h.request('/v1/accounts', { headers: { Authorization: `Bearer ${device.data.token}` } })).status, 200);
  h.advance(8 * 60 * 60000);
  assert.equal((await h.request('/v1/admin/status', { token: changed.data.token })).status, 401);
});

test('restart retains setup code before initialization and retains settings, password and decryptable cookies afterward', async t => {
  const h = await harness(t);
  const initial = h.config();
  await h.stop(); await h.start();
  assert.equal(h.logs[0], h.logs[1]);
  assert.deepEqual(h.config(), initial);
  assert.equal((await h.setup({ baseUrl: 'https://pickup.example' })).status, 200);
  const login = await h.login();
  const account = h.service().store.saveAccount({ platform: 'taobao', label: '保留账号', cookie: 'persisted-cookie-secret' });
  const changed = await h.request('/v1/admin/password', { method: 'POST', token: login.data.token, body: { currentPassword: PASSWORD, password: NEXT_PASSWORD } });
  assert.equal(changed.status, 200);
  await h.stop(); await h.start();
  assert.equal(h.logs.length, 2);
  assert.equal(h.config().encryptionKey, initial.encryptionKey);
  assert.equal(h.service().store.cookie(account.id), 'persisted-cookie-secret');
  assert.equal((await h.request('/v1/admin/status', { token: changed.data.token })).status, 401);
  const renewed = await h.login(NEXT_PASSWORD);
  assert.equal(renewed.status, 200);
  assert.equal((await h.request('/v1/admin/status', { token: renewed.data.token })).data.baseUrl, 'https://pickup.example');
  assert.equal((await h.login()).status, 401);
});

test('missing or corrupt encryption configuration fails closed without modifying the database or generating a new key', async t => {
  const h = await harness(t);
  await h.stop();
  const saved = readFileSync(h.configPath, 'utf8');
  const database = readFileSync(h.filename);
  rmSync(h.configPath);
  assert.throws(() => createService({ filename: h.filename }), /Database exists without its encryption configuration/);
  assert.deepEqual(readFileSync(h.filename), database);
  writeFileSync(h.configPath, '{broken', 'utf8');
  assert.throws(() => createService({ filename: h.filename }), /Saved service configuration is invalid/);
  assert.equal(readFileSync(h.configPath, 'utf8'), '{broken');
  const missingKey = JSON.parse(saved); delete missingKey.encryptionKey;
  writeFileSync(h.configPath, JSON.stringify(missingKey), 'utf8');
  assert.throws(() => createService({ filename: h.filename }), /Saved service configuration is invalid/);
  assert.deepEqual(readFileSync(h.filename), database);
});

test('legacy environment mode retains direct tokens and supports login with read-only settings; partial and mixed configuration fail', async t => {
  const h = await harness(t, { encryptionKey: KEY, adminToken: ADMIN, baseUrl: 'https://legacy.example' });
  assert.deepEqual((await h.request('/v1/setup')).data, { initialized: true, mode: 'environment', minPasswordLength: 12 });
  assert.equal(h.logs.length, 0);
  assert.equal((await h.request('/v1/admin/status', { token: ADMIN })).data.configurationMode, 'environment');
  const login = await h.login(ADMIN);
  assert.equal(login.status, 200);
  assert.equal((await h.request('/v1/admin/status', { token: login.data.token })).status, 200);
  assert.equal((await h.request('/v1/admin/settings', { method: 'PATCH', token: login.data.token, body: { baseUrl: 'https://new.example' } })).data.error.code, 'ENVIRONMENT_READ_ONLY');
  assert.equal((await h.request('/v1/admin/password', { method: 'POST', token: login.data.token, body: { currentPassword: ADMIN, password: NEXT_PASSWORD } })).data.error.code, 'ENVIRONMENT_READ_ONLY');
  assert.equal((await h.setup()).status, 409);
  assert.throws(() => createService({ encryptionKey: KEY, adminToken: '' }), /ADMIN_TOKEN/);
  assert.throws(() => createService({ adminToken: ADMIN, encryptionKey: '' }), /COOKIE_ENCRYPTION_KEY/);
  assert.throws(() => createService({ baseUrl: 'https://partial.example' }), /ADMIN_TOKEN/);
  const managed = await harness(t);
  await managed.stop();
  assert.throws(() => createService({ filename: managed.filename, encryptionKey: KEY, adminToken: ADMIN }), /cannot be combined/);
});

test('racing login and password changes leave no session authenticated with the superseded password', async t => {
  const h = await harness(t);
  await h.setup();
  const first = await h.login();
  const results = await Promise.all([
    h.login(),
    h.request('/v1/admin/password', { method: 'POST', token: first.data.token, body: { currentPassword: PASSWORD, password: NEXT_PASSWORD } }),
    h.request('/v1/admin/password', { method: 'POST', token: first.data.token, body: { currentPassword: PASSWORD, password: 'other-updated-password' } })
  ]);
  assert.deepEqual(results.slice(1).map(r => r.status).sort(), [200, 401]);
  if (results[0].status === 200) assert.equal((await h.request('/v1/admin/status', { token: results[0].data.token })).status, 401);
  const winner = results.slice(1).find(r => r.status === 200);
  assert.equal((await h.request('/v1/admin/status', { token: winner.data.token })).status, 200);
});

test('production entrypoint rejects partial legacy environment before creating data or encryption configuration', t => {
  const directory = mkdtempSync(join(tmpdir(), 'kdyzm-partial-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url))], {
    env: { ...process.env, DATA_DIR: directory, COOKIE_ENCRYPTION_KEY: KEY, ADMIN_TOKEN: ADMIN, PUBLIC_BASE_URL: '' }, encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires PUBLIC_BASE_URL, ADMIN_TOKEN and COOKIE_ENCRYPTION_KEY together/);
  assert.equal(existsSync(join(directory, 'pickcode.db')), false);
  assert.equal(existsSync(join(directory, 'service-config.json')), false);
});

test('password change rejects every admin mutation whose body started under the revoked session', async t => {
  let collections = 0;
  const h = await harness(t, { collector: async () => { collections++; return { orders: [], shipments: [], warnings: [] }; } });
  await h.setup({ baseUrl: 'https://pickup.example' });
  const { token } = (await h.login()).data;
  const account = h.service().store.saveAccount({ platform: 'taobao', label: 'original', cookie: 'original-cookie' });
  const mutations = [
    ['/v1/admin/accounts', 'POST', { platform: 'taobao', label: 'unauthorized-new-account', cookie: 'new-cookie' }],
    [`/v1/admin/accounts/${account.id}`, 'PATCH', { label: 'unauthorized-label', cookie: 'changed-cookie' }],
    [`/v1/admin/accounts/${account.id}/sync`, 'POST', {}],
    ['/v1/pairing-codes', 'POST', { accountIds: [account.id] }],
    ['/v1/admin/settings', 'PATCH', { baseUrl: 'https://unauthorized.example' }],
    ['/v1/admin/password', 'POST', { currentPassword: NEXT_PASSWORD, password: 'unauthorized-next-password' }]
  ];
  const pending = [];
  try {
    for (const [path, method, body] of mutations) {
      const raw = JSON.stringify(body);
      const received = new Promise(resolve => h.service().server.once('request', req => req.once('data', resolve)));
      let request;
      const response = new Promise((resolve, reject) => {
        request = httpRequest(h.base() + path, { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), 'X-Admin-Token': token } }, res => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
          res.on('error', reject);
        });
        request.on('error', reject);
      });
      // Leave each request authenticated and suspended inside bodyOf until the password changes.
      request.write(raw.slice(0, 1));
      pending.push({ request, response, remaining: raw.slice(1) });
      await received;
    }
    const changed = await h.request('/v1/admin/password', { method: 'POST', token, body: { currentPassword: PASSWORD, password: NEXT_PASSWORD } });
    assert.equal(changed.status, 200);
    assert.equal((await h.request('/v1/admin/status', { token })).status, 401);
    pending.forEach(({ request, remaining }) => request.end(remaining));
    for (const response of await Promise.all(pending.map(item => item.response))) {
      assert.equal(response.status, 401);
      assert.equal(response.data.error.code, 'ADMIN_UNAUTHORIZED');
    }
    assert.deepEqual(h.service().store.accounts(), [account]);
    assert.equal(h.service().store.cookie(account.id), 'original-cookie');
    assert.equal(h.service().store.db.prepare('SELECT COUNT(*) AS total FROM pairing').get().total, 0);
    assert.equal(collections, 0);
    assert.equal(h.config().baseUrl, 'https://pickup.example');
    assert.equal((await h.request('/v1/admin/status', { token: changed.data.token })).status, 200);
  } finally { pending.forEach(({ request }) => request.destroy()); }
});

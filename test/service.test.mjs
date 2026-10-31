import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';
import { decryptCookie, encryptCookie, readKey, publicUrl } from '../src/security.mjs';

const ADMIN = 'admin-test-secret-with-at-least-32-characters';
const KEY = 'ab'.repeat(32);
const TIME = 1793350000000;
const data = (code = 'A-1234') => ({ orders: [{ platformOrderId: 'same-order', title: '测试订单', amount: null, orderDate: TIME - 86400000, orderStatus: '运输中', refundStatus: '' }],
  shipments: [
    { platformOrderId: 'same-order', waybillNo: 'FIRST001', carrier: '中通快递', status: 'arrived', pickupCode: code, station: '测试驿站', arrivalAt: TIME - 3600000, updatedAt: TIME },
    { platformOrderId: 'same-order', waybillNo: 'SECOND002', carrier: '中通快递', status: 'transit', pickupCode: '', station: '', arrivalAt: 0, updatedAt: TIME }
  ], warnings: [] });

async function setup(t, options = {}) {
  let current = TIME;
  const service = createService({ encryptionKey: KEY, adminToken: ADMIN, now: () => current, scheduler: false,
    collector: async () => data(), ...options });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  t.after(() => service.close());
  const request = async (path, { method = 'GET', body, token, admin = false, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(admin ? { 'x-admin-token': ADMIN } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    return { status: response.status, headers: response.headers, raw, data: raw ? JSON.parse(raw) : null };
  };
  const account = async (label = '账号A') => {
    const result = await request('/v1/admin/accounts', { method: 'POST', admin: true, body: { platform: 'taobao', label, cookie: `_m_h5_tk=secret_${label}; cookie-secret-only=never-send-to-devices` } });
    assert.equal(result.status, 201); return result.data.account;
  };
  const pair = async ids => {
    const result = await request('/v1/pairing-codes', { method: 'POST', admin: true, body: { accountIds: ids } });
    assert.equal(result.status, 201); return result.data;
  };
  const bind = async ids => {
    const pairing = await pair(ids);
    const result = await request('/v1/devices', { method: 'POST', body: { code: pairing.code, deviceName: '测试设备' } });
    assert.equal(result.status, 201); return result.data;
  };
  return { service, request, account, pair, bind, advance: ms => { current += ms; }, now: () => current };
}

test('normal startup is empty; every parcel endpoint authenticates and admin/device roles are isolated', async t => {
  const { service, request, account, bind } = await setup(t);
  assert.equal(service.store.accounts().length, 0);
  for (const path of ['/v1/snapshot', '/v1/accounts', '/v1/operations/unknown']) assert.equal((await request(path)).status, 401);
  assert.equal((await request('/v1/operations', { method: 'POST', body: { operations: [] } })).status, 401);
  assert.equal((await request('/v1/pairing-codes', { method: 'POST', body: { accountIds: [] } })).status, 401);
  const a = await account(); const device = await bind([a.id]);
  assert.equal((await request('/v1/admin/accounts', { token: device.token })).status, 401);
  assert.equal((await request('/v1/pairing-codes', { method: 'POST', token: device.token, body: { accountIds: [a.id] } })).status, 401);
  assert.equal((await request('/v1/snapshot', { admin: true })).status, 401);
  for (const path of ['/v1/accounts', '/v1/snapshot', '/v1/admin/accounts', '/v1/admin/devices']) {
    const response = await request(path, { admin: path.includes('admin'), token: device.token });
    assert.equal(response.status, 200); assert.ok(!response.raw.includes('cookie-secret-only')); assert.ok(!response.raw.includes(device.token));
  }
});

test('pairing is one use, ten minutes, atomic under replay, scope-controlled and hashed', async t => {
  const { service, request, account, pair, advance } = await setup(t);
  const a = await account();
  const pairing = await pair([a.id]);
  assert.equal(pairing.expiresAt, TIME + 600000); assert.match(pairing.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(JSON.parse(pairing.qrPayload).baseUrl, 'http://127.0.0.1:8787');
  const attempts = await Promise.all([1, 2].map(() => request('/v1/devices', { method: 'POST', body: { code: pairing.code, deviceName: 'phone' } })));
  assert.deepEqual(attempts.map(a => a.status).sort(), [201, 400]);
  const row = service.store.db.prepare('SELECT * FROM pairing').get(); assert.notEqual(row.code_hash, pairing.code); assert.ok(row.used_at);
  const created = attempts.find(a => a.status === 201).data;
  const stored = service.store.db.prepare('SELECT * FROM devices').get(); assert.notEqual(stored.token_hash, created.token); assert.ok(!JSON.stringify(stored).includes(created.token));
  const expires = await pair([a.id]); advance(600000);
  assert.equal((await request('/v1/devices', { method: 'POST', body: { code: expires.code, deviceName: 'late' } })).status, 400);
  assert.equal((await request('/v1/pairing-codes', { method: 'POST', admin: true, body: { accountIds: ['missing'] } })).status, 400);
});

test('pairing guesses are rate-limited and forwarded IP cannot bypass the limiter', async t => {
  const { request } = await setup(t);
  for (let n = 0; n < 10; n++) assert.equal((await request('/v1/devices', { method: 'POST', body: { code: 'WRONG', deviceName: 'guesser' }, headers: { 'X-Forwarded-For': `192.0.2.${n}` } })).status, 400);
  assert.equal((await request('/v1/devices', { method: 'POST', body: { code: 'WRONG', deviceName: 'guesser' }, headers: { 'X-Forwarded-For': '203.0.113.1' } })).status, 429);
});

test('account scopes isolate identical order IDs and split shipments; filters only narrow access', async t => {
  const { service, request, account, bind } = await setup(t);
  const a = await account('A'), b = await account('B');
  service.store.importResult(a.id, data()); service.store.importResult(b.id, data());
  const device = await bind([a.id]);
  const snapshot = (await request('/v1/snapshot', { token: device.token })).data;
  assert.equal(snapshot.orders.length, 1); assert.equal(snapshot.shipments.length, 2); assert.ok(snapshot.shipments.every(s => s.accountId === a.id));
  const all = service.store.snapshot([a.id, b.id]); assert.equal(new Set(all.orders.map(o => o.id)).size, 2); assert.equal(new Set(all.shipments.map(s => s.id)).size, 4);
  assert.equal((await request(`/v1/snapshot?accountId=${b.id}`, { token: device.token })).status, 403);
  assert.equal((await request(`/v1/accounts/${b.id}/sync`, { token: device.token, method: 'POST', body: {} })).status, 403);
  assert.equal((await request('/v1/accounts/sync', { token: device.token, method: 'POST', body: { accountIds: [b.id] } })).status, 400);
  const outsider = all.shipments.find(s => s.accountId === b.id);
  assert.equal((await request('/v1/operations', { token: device.token, method: 'POST', body: { operations: [{ id: 'attack', shipmentId: outsider.id, action: 'pick', occurredAt: TIME }] } })).status, 403);
});

test('ETag returns 304, keeps dates/manual states through partial collections, and carries explicit hide markers', async t => {
  const { service, request, account, bind, advance } = await setup(t);
  const a = await account(); service.store.importResult(a.id, data());
  const device = await bind([a.id]);
  const first = await request('/v1/snapshot', { token: device.token }); const etag = first.headers.get('etag');
  assert.equal((await request('/v1/snapshot', { token: device.token, headers: { 'If-None-Match': etag } })).status, 304);
  const shipment = first.data.shipments.find(s => s.waybillNo === 'FIRST001');
  const ops = [{ id: 'pick-one', shipmentId: shipment.id, action: 'pick', occurredAt: TIME }, { id: 'hide-one', shipmentId: shipment.id, action: 'hide', occurredAt: TIME }];
  assert.deepEqual((await request('/v1/operations', { token: device.token, method: 'POST', body: { operations: ops } })).data.appliedIds, ['pick-one', 'hide-one']);
  advance(50000);
  service.store.importResult(a.id, { orders: [], shipments: [], warnings: ['分页不完整'] });
  const source = data(); source.orders[0].orderDate = TIME + 50000; source.orders[0].orderStatus = '交易完成'; source.orders[0].refundStatus = '已退款'; source.shipments[0].status = 'signed'; source.shipments[0].arrivalAt = TIME + 50000;
  service.store.importResult(a.id, source);
  const after = await request('/v1/snapshot', { token: device.token, headers: { 'If-None-Match': etag } });
  assert.equal(after.status, 200); assert.notEqual(after.headers.get('etag'), etag);
  assert.equal(after.data.orders[0].orderDate, first.data.orders[0].orderDate);
  assert.equal(after.data.shipments.length, 2);
  const updated = after.data.shipments.find(s => s.id === shipment.id);
  assert.equal(updated.arrivalAt, shipment.arrivalAt); assert.equal(updated.picked, true); assert.equal(updated.hidden, true);
  assert.equal(after.data.shipments.find(s => s.id !== shipment.id).picked, false);
  assert.deepEqual(after.data.hiddenIds, [shipment.id]); assert.deepEqual(after.data.deletedIds, []);
  assert.equal(after.data.events[0].id, first.data.events[0].id);
});

test('operation replay is idempotent, conflicting reuse rejects, and unauthorized batch rolls back', async t => {
  const { service, request, account, bind } = await setup(t);
  const a = await account(); service.store.importResult(a.id, data());
  const device = await bind([a.id]); const otherDevice = await bind([a.id]);
  const shipmentId = service.store.snapshot([a.id]).shipments[0].id;
  const operation = { id: 'offline-op-1', shipmentId, action: 'pick', occurredAt: TIME };
  const submit = operations => request('/v1/operations', { method: 'POST', token: device.token, body: { operations } });
  assert.equal((await submit([operation])).status, 200);
  const revision = service.store.snapshot([a.id]).serverRevision;
  assert.equal((await submit([operation])).status, 200); assert.equal(service.store.snapshot([a.id]).serverRevision, revision);
  assert.equal((await submit([{ ...operation, action: 'restore' }])).status, 409);
  assert.equal((await request('/v1/operations/offline-op-1', { token: device.token })).data.status, 'applied');
  assert.equal((await request('/v1/operations/offline-op-1', { token: otherDevice.token })).status, 404);
  assert.equal((await submit([{ id: 'restore', shipmentId, action: 'restore', occurredAt: TIME }, { id: 'outsider', shipmentId: 'unknown', action: 'pick', occurredAt: TIME }])).status, 403);
  assert.equal(service.store.snapshot([a.id]).shipments.find(s => s.id === shipmentId).picked, true);
  assert.equal((await submit([{ id: 'bad', shipmentId, action: 'setCookie', occurredAt: TIME }])).status, 400);
  assert.equal((await submit([{ ...operation, body: 'SMS stays local' }])).status, 400);
  assert.equal((await submit([{ ...operation, id: 'restore-good', action: 'restore' }])).status, 200);
  assert.equal(service.store.snapshot([a.id]).shipments.find(s => s.id === shipmentId).picked, false);
});

test('admin revocation and self-revocation block all later access', async t => {
  const { request, account, bind } = await setup(t);
  const a = await account(), first = await bind([a.id]), second = await bind([a.id]);
  assert.equal((await request(`/v1/devices/${second.deviceId}`, { method: 'DELETE', token: first.token })).status, 401);
  assert.equal((await request('/v1/devices/current', { method: 'DELETE', token: first.token })).status, 200);
  assert.equal((await request('/v1/snapshot', { token: first.token })).status, 401);
  assert.equal((await request(`/v1/devices/${second.deviceId}`, { method: 'DELETE', admin: true })).status, 200);
  assert.equal((await request('/v1/accounts', { token: second.token })).status, 401);
});

test('manual sync coalesces requests, rate-limits platform collection and separates expired account from device', async t => {
  let calls = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, request, account, bind, advance } = await setup(t, { collector: async () => { calls++; await gate; const error = new Error('平台登录态已失效，请在后台更新 Cookie'); error.code = 'ACCOUNT_EXPIRED'; throw error; } });
  const a = await account(); service.store.importResult(a.id, data()); const device = await bind([a.id]);
  const pending = service.requestSync(a.id); const repeat = service.requestSync(a.id); assert.equal(pending, repeat);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); release(); await pending;
  const queued = service.requestSync(a.id); assert.equal(calls, 1);
  const snapshot = await request('/v1/snapshot', { token: device.token }); assert.equal(snapshot.status, 200); assert.equal(snapshot.data.accounts[0].status, 'expired'); assert.equal(snapshot.data.shipments.length, 2);
  advance(5 * 60000); service.jobs.pump(a.id); await queued; assert.equal(calls, 2);
});

test('admin account status exposes the latest full collection without leaking credentials or granting device access', async t => {
  const { service, request, account, bind } = await setup(t);
  const a = await account(), device = await bind([a.id]);
  let status = await request('/v1/admin/accounts', { admin: true });
  assert.equal(status.data.accounts[0].syncJob, null);
  const started = await request(`/v1/admin/accounts/${a.id}/sync`, { admin: true, method: 'POST', body: {} });
  await Promise.all([...service.running.values()]);
  status = await request('/v1/admin/accounts', { admin: true });
  assert.equal(status.data.serverTime, TIME);
  assert.equal(status.data.accounts[0].syncJob.id, started.data.jobs[0].id);
  assert.equal(status.data.accounts[0].syncJob.state, 'completed');
  assert.equal(status.data.accounts[0].syncJob.finishedAt, TIME);
  assert.ok(!status.raw.includes('cookie-secret-only'));
  assert.equal((await request('/v1/admin/accounts', { token: device.token })).status, 401);
  const queued = await request(`/v1/admin/accounts/${a.id}/sync`, { admin: true, method: 'POST', body: {} });
  status = await request('/v1/admin/accounts', { admin: true });
  assert.equal(status.data.accounts[0].syncJob.id, queued.data.jobs[0].id);
  assert.equal(status.data.accounts[0].syncJob.state, 'queued');
  assert.equal(status.data.accounts[0].syncJob.retryAt, TIME + 300000);
});

test('cookies use authenticated encryption bound to account, persist ciphertext only, and tampering fails', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-server-test-'));
  const { service, account } = await setup(t, { filename: join(directory, 'test.db') });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const a = await account();
  const encrypted = service.store.db.prepare('SELECT credential FROM accounts WHERE id=?').get(a.id).credential;
  assert.match(encrypted, /^v1\./); assert.ok(!encrypted.includes('never-send-to-devices'));
  assert.ok(service.store.cookie(a.id).includes('never-send-to-devices'));
  for (const file of readdirSync(directory)) assert.ok(!readFileSync(join(directory, file)).includes(Buffer.from('never-send-to-devices')));
  assert.throws(() => decryptCookie(encrypted, readKey(KEY), 'other-account'));
  assert.throws(() => decryptCookie(encrypted, randomBytes(32), a.id));
  assert.notEqual(encryptCookie('same', readKey(KEY), a.id), encryptCookie('same', readKey(KEY), a.id));
});

test('untrusted origins and unsupported input are rejected; public service addresses require HTTPS', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/v1/admin/accounts', { admin: true, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/v1/admin/accounts', { method: 'POST', admin: true, body: { platform: 'taobao', label: 'x', cookie: 'x', injected: true } })).status, 400);
  assert.throws(() => publicUrl('http://192.168.1.10:8787')); assert.throws(() => publicUrl('https://user:pass@example.com'));
  assert.equal(publicUrl('https://pickup.example.com'), 'https://pickup.example.com');
  assert.throws(() => createService({ encryptionKey: KEY, adminToken: '' }));
});

test('carrier labels can improve without duplicating shipments, distinct carriers remain separate', async t => {
  const { service, account } = await setup(t); const a = await account();
  const initial = data(); initial.shipments[0].carrier = ''; service.store.importResult(a.id, initial);
  const id = service.store.snapshot([a.id]).shipments.find(s => s.waybillNo === 'FIRST001').id;
  service.store.importResult(a.id, data());
  assert.equal(service.store.snapshot([a.id]).shipments.length, 2);
  assert.equal(service.store.snapshot([a.id]).shipments.find(s => s.waybillNo === 'FIRST001').id, id);
  const alias = data(); alias.shipments[0].carrier = '中通'; service.store.importResult(a.id, alias);
  assert.equal(service.store.snapshot([a.id]).shipments.length, 2);
  const different = data(); different.shipments[0].carrier = '顺丰'; service.store.importResult(a.id, different);
  assert.equal(service.store.snapshot([a.id]).shipments.length, 3);
});

test('an in-flight collection cannot overwrite a newly updated Cookie', async t => {
  let finish; const deferred = new Promise(resolve => { finish = resolve; });
  const { service, account } = await setup(t, { collector: async () => { await deferred; return { ...data(), refreshedCookie: 'old-platform-refreshed-cookie' }; } });
  const a = await account(); const pending = service.requestSync(a.id);
  await new Promise(resolve => setImmediate(resolve));
  service.store.saveAccount({ cookie: 'new-secret-cookie' }, a.id);
  finish(); await pending;
  assert.equal(service.store.cookie(a.id), 'new-secret-cookie');
  assert.equal(service.store.account(a.id).status, 'configured');
  assert.equal(service.store.snapshot([a.id]).orders.length, 0);
});

test('fixture CORS allows loopback ports for H5 and never lookalike external origins', async t => {
  const { request, account, bind } = await setup(t, { fixture: true });
  const a = await account(); const device = await bind([a.id]);
  const allowed = await request('/v1/snapshot', { token: device.token, headers: { Origin: 'http://127.0.0.1:5177' } });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5177');
  assert.equal(allowed.headers.get('access-control-expose-headers'), 'ETag');
  const preflight = await request('/v1/devices', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5176', 'Access-Control-Request-Headers': 'authorization,content-type,if-none-match' } });
  assert.equal(preflight.status, 204); assert.match(preflight.headers.get('access-control-allow-headers'), /If-None-Match/);
  assert.equal((await request('/v1/snapshot', { token: device.token, headers: { Origin: 'http://127.0.0.1.evil.example:5177' } })).status, 403);
});

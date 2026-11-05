import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.mjs';

const ADMIN = 'completion-admin-secret-with-over-32-characters';
const NOW = 1800000000000;
async function setup(t) {
  const service = createService({ encryptionKey: 'ab'.repeat(32), adminToken: ADMIN, now: () => NOW, scheduler: false });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve)); t.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const store = service.store;
  store.saveAccount({ platform: 'taobao', label: '测试', cookie: 'FIXTURE' }, 'a', true);
  const bound = store.redeem(store.createPairing(['a']).code, '测试');
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: 'TEST', status: 'signed',
    logisticsState: 'ok', logisticsEvents: [{ time: NOW - 1000, description: '本人已签收' }] }] });
  const request = async (path, { method = 'GET', body, admin = false, device = false, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(admin ? { 'x-admin-token': ADMIN } : {}), ...(device ? { Authorization: `Bearer ${bound.token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, etag: response.headers.get('etag'), data: response.status === 304 ? null : await response.json() };
  };
  return { service, request };
}

test('admin-only config is read-only to devices and metadata changes participate in snapshot ETag', async t => {
  const { request, service } = await setup(t);
  const settings = await request('/v1/admin/pickup-completion', { admin: true });
  assert.equal(settings.status, 200); assert.equal(settings.data.config.enabled, true); assert.equal(settings.data.config.aiEnabled, true);
  assert.ok(Array.isArray(settings.data.recent));
  const before = await request('/v1/snapshot', { device: true });
  assert.equal(before.data.shipments[0].picked, true);
  assert.equal((await request('/v1/snapshot', { device: true, headers: { 'if-none-match': before.etag } })).status, 304);
  assert.equal((await request('/v1/admin/pickup-completion', { method: 'PUT', body: { enabled: false }, device: true })).status, 401);
  assert.equal(service.pickupCompletion.config().enabled, true);
  assert.equal((await request('/v1/admin/pickup-completion', { method: 'PUT', body: { enabled: false, aiEnabled: false }, admin: true })).status, 200);
  const after = await request('/v1/snapshot', { device: true, headers: { 'if-none-match': before.etag } });
  assert.equal(after.status, 200); assert.notEqual(after.etag, before.etag);
  assert.deepEqual(after.data.pickupCompletion, { version: 1, enabled: false, aiEnabled: false });
  assert.equal(after.data.shipments[0].picked, true);
  assert.equal((await request('/v1/admin/pickup-completion', { method: 'PUT', body: { enabled: 'false' }, admin: true })).status, 400);
  assert.equal((await request('/v1/admin/pickup-completion', { method: 'PUT', body: { rules: [] }, admin: true })).status, 400);
  assert.equal((await request('/v1/admin/pickup-completion/history', { admin: true })).status, 200);
});

test('legacy operations and resume-auto are scoped, idempotent and retain manual restore across snapshots', async t => {
  const { request } = await setup(t);
  const snapshot = await request('/v1/snapshot', { device: true }), shipmentId = snapshot.data.shipments[0].id;
  const restore = { id: 'restore', shipmentId, action: 'restore', occurredAt: NOW - 1 };
  const send = operation => request('/v1/operations', { method: 'POST', device: true, body: { operations: [operation] } });
  assert.equal((await send(restore)).status, 200); assert.equal((await send(restore)).status, 200);
  const restored = (await request('/v1/snapshot', { device: true })).data.shipments[0];
  assert.equal(restored.picked, false); assert.equal(restored.pickupCompletion.autoPicked, true); assert.equal(restored.pickupCompletion.manualOverride, 'pending');
  assert.equal((await send({ id: 'resume', shipmentId, action: 'resumeAutoPickup', occurredAt: NOW })).status, 200);
  assert.equal((await request('/v1/snapshot', { device: true })).data.shipments[0].picked, true);
  assert.equal((await send({ id: 'foreign', shipmentId: 'not-authorized', action: 'resumeAutoPickup', occurredAt: NOW })).status, 403);
});

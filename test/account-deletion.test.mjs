import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';

const ADMIN = 'account-deletion-test-admin-at-least-32-characters';
const KEY = 'da'.repeat(32), TIME = 1793350000000;
const COOKIE = 'unb=12345678; cookie2=SYNTHETIC-LOGIN';
const parcel = id => ({ orders: [{ platformOrderId: id, title: id, orderDate: TIME }],
  shipments: [{ platformOrderId: id, waybillNo: `TRACK-${id}`, carrier: '中通', status: 'arrived', pickupCode: 'A-1234', arrivalAt: TIME }] });

async function setup(t, options = {}) {
  let now = TIME, closed = false;
  const service = createService({ encryptionKey: KEY, adminToken: ADMIN, baseUrl: 'https://pickup.example',
    now: () => now, scheduler: false, collector: async () => parcel('collected'), ...options });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const close = async () => { if (!closed) { closed = true; await service.close(); } };
  t.after(close);
  const request = async (path, { method = 'GET', body, token, admin = false } = {}) => {
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method,
      headers: { ...(admin ? { 'X-Admin-Token': ADMIN } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const account = (familyId = '') => service.store.saveAccount({ platform: 'taobao', label: '我的淘宝', cookie: COOKIE, familyId });
  const remove = id => request(`/v1/admin/accounts/${id}`, { method: 'DELETE', admin: true });
  return { service, request, account, remove, close, advance: ms => { now += ms; } };
}

test('admin deletion erases credentials while retaining history, original scopes and manual pickup operations', async t => {
  const s = await setup(t), store = s.service.store;
  const family = store.saveFamily({ name: '自己' }), otherFamily = store.saveFamily({ name: '其他家人' });
  const a = s.account(family.id), other = s.account(otherFamily.id);
  store.importResult(a.id, parcel('history')); store.importResult(other.id, parcel('other'));
  const familyDevice = store.redeem(store.createPairing({ familyIds: [family.id] }).code, '家人设备');
  const legacy = store.redeem(store.createPairing([a.id]).code, '原有单账号设备');
  const foreign = store.redeem(store.createPairing([other.id]).code, '其他设备');
  const mixed = store.redeem(store.createPairing([a.id, other.id]).code, '多账号设备');
  const pending = store.createPairing([a.id]), before = store.snapshot([a.id]);
  const path = `/v1/admin/accounts/${a.id}`;
  assert.equal((await s.request(path, { method: 'DELETE' })).status, 401);
  assert.equal((await s.request(path, { method: 'DELETE', token: legacy.token })).status, 401);
  assert.equal((await s.request(path, { method: 'DELETE', token: foreign.token })).status, 401);
  assert.deepEqual(await s.remove(a.id), { status: 200, data: { deleted: true, historyPreserved: true } });
  assert.equal(store.account(a.id), undefined); assert.equal(store.cookie(a.id), undefined);
  assert.equal(store.db.prepare('SELECT credential FROM accounts WHERE id=?').get(a.id).credential, '');
  assert.deepEqual((await s.request('/v1/admin/accounts', { admin: true })).data.accounts.map(a => a.id), [other.id]);
  assert.equal(store.cookie(other.id), COOKIE);
  for (const device of [familyDevice, legacy]) {
    const snapshot = (await s.request('/v1/snapshot', { token: device.token })).data;
    assert.deepEqual(snapshot.accounts, []);
    assert.deepEqual(snapshot.orders, before.orders); assert.deepEqual(snapshot.shipments, before.shipments);
    assert.deepEqual((await s.request('/v1/accounts', { token: device.token })).data.accounts, []);
    assert.deepEqual((await s.request('/v1/accounts/sync', { method: 'POST', token: device.token, body: {} })).data.jobs, []);
  }
  const mixedSync = await s.request('/v1/accounts/sync', { method: 'POST', token: mixed.token, body: {} });
  assert.equal(mixedSync.status, 202); assert.deepEqual(mixedSync.data.jobs.map(job => job.accountId), [other.id]);
  assert.equal((await s.request(`/v1/orders/${before.orders[0].id}/refresh`, { method: 'POST', token: legacy.token, body: {} })).status, 404);
  const pick = { operations: [{ id: 'pick-after-delete', shipmentId: before.shipments[0].id, action: 'pick', occurredAt: TIME }] };
  assert.equal((await s.request('/v1/operations', { method: 'POST', token: foreign.token, body: pick })).status, 403);
  assert.equal((await s.request('/v1/operations', { method: 'POST', token: legacy.token, body: pick })).status, 200);
  assert.equal(store.snapshot([a.id]).shipments[0].picked, true);
  assert.throws(() => store.redeem(pending.code, 'late'), { code: 'INVALID_PAIRING_CODE' });
  assert.throws(() => store.saveAccount({ cookie: COOKIE }, a.id), { code: 'NOT_FOUND' });
  assert.throws(() => store.refreshCookie(a.id, COOKIE), { code: 'NOT_FOUND' });
  assert.throws(() => store.importResult(a.id, parcel('late')), { code: 'NOT_FOUND' });
  assert.equal((await s.remove(a.id)).status, 404);
  assert.equal((await s.request(path, { method: 'PATCH', admin: true, body: { enabled: true } })).status, 404);
  assert.equal((await s.request(`${path}/sync`, { method: 'POST', admin: true, body: {} })).status, 404);
  const replacement = s.account(family.id);
  assert.notEqual(replacement.id, a.id);
  assert.equal(store.snapshot(store.device(familyDevice.token)).orders.length, 1);
  assert.equal(store.snapshot([replacement.id]).orders.length, 0);
});

test('deletion survives restart and keeps historical records accessible', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'account-delete-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'state.db'), s = await setup(t, { filename }), a = s.account();
  s.service.store.importResult(a.id, parcel('persistent'));
  const device = s.service.store.redeem(s.service.store.createPairing([a.id]).code, 'phone');
  await s.remove(a.id); await s.close();
  const reopened = await setup(t, { filename });
  try {
    assert.deepEqual(reopened.service.store.accounts(), []);
    assert.equal(reopened.service.store.cookie(a.id), undefined);
    const snapshot = (await reopened.request('/v1/snapshot', { token: device.token })).data;
    assert.equal(snapshot.orders[0].platformOrderId, 'persistent'); assert.equal(snapshot.shipments.length, 1);
    assert.equal(reopened.service.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.deepEqual(reopened.service.jobs.runDue(), []);
  } finally { await reopened.close(); }
});

test('deletion cancels queued work and rejects late collector results and cookie rotation', async t => {
  let release, started, calls = 0, callbacks;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
  const s = await setup(t, { collector: async (_account, _cookie, options) => {
    calls++; callbacks = options; started(); await gate; return parcel('late');
  } });
  const a = s.account(), running = s.service.jobs.request(a.id);
  await ready;
  try {
    await s.remove(a.id);
    assert.equal((await running.done).state, 'disabled');
    assert.throws(() => callbacks.onProgress(parcel('late-stream')));
    assert.throws(() => callbacks.onCookieRefresh(COOKIE));
  } finally { release(); }
  await Promise.all(s.service.jobs.running.values());
  assert.equal(s.service.store.snapshot([a.id]).orders.length, 0);
  assert.equal(s.service.store.cookie(a.id), undefined);
  const queuedAccount = s.account();
  s.service.store.updateAccount(queuedAccount.id, { lastAttemptAt: TIME });
  const queued = s.service.jobs.request(queuedAccount.id);
  assert.equal(queued.job.state, 'queued');
  await s.remove(queuedAccount.id);
  assert.equal((await queued.done).state, 'disabled');
  s.advance(3600000); s.service.jobs.runDue(); s.service.jobs.pump(queuedAccount.id);
  assert.equal(calls, 1);
  assert.equal(s.service.store.db.prepare('SELECT count(*) AS n FROM sync_job_summaries WHERE active=1').get().n, 0);
});

test('deletion revokes account browser grants and stale pairing proofs without revoking other platform grants', async t => {
  const s = await setup(t), store = s.service.store, family = store.saveFamily({ name: '自己' });
  const a = s.account(family.id);
  const post = (path, body, token, admin = false) => s.request(path, { method: 'POST', body, token, admin });
  const pair = (await post('/v1/admin/cookie-sync/pairing', { accountId: a.id }, undefined, true)).data;
  const single = (await post('/v1/cookie-sync/connections', { code: pair.code, name: 'single' })).data;
  const pending = (await post('/v1/admin/cookie-sync/pairing', { accountId: a.id }, undefined, true)).data;
  const groupPair = (await post('/v1/admin/cookie-sync/families/pairing', { familyId: family.id }, undefined, true)).data;
  const group = (await post('/v1/cookie-sync/families/connections', { code: groupPair.code, name: 'family' })).data;
  const prefix = '/v1/cookie-sync/families/current';
  const preview = await post(`${prefix}/accounts/${a.id}/preview`, { cookie: COOKIE }, group.token);
  assert.equal(preview.status, 200);
  await s.remove(a.id);
  assert.equal((await s.request('/v1/cookie-sync/current', { token: single.token })).status, 401);
  assert.equal((await post('/v1/cookie-sync/connections', { code: pending.code, name: 'late' })).status, 400);
  assert.equal((await post(`${prefix}/accounts/${a.id}/cookie`, { cookie: COOKIE, expectedCredentialVersion: a.credentialVersion,
    confirmationToken: preview.data.confirmationToken }, group.token)).status, 403);
  const current = await s.request(prefix, { token: group.token });
  assert.equal(current.status, 200); assert.deepEqual(current.data.accounts, []);
  // A fresh explicit preview is required to add this platform again; old writes cannot recreate it.
  assert.equal((await post(`${prefix}/platforms/taobao/cookie`, { cookie: COOKIE, expectedCredentialVersion: 0,
    confirmationToken: preview.data.confirmationToken }, group.token)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM cookie_sync_connections WHERE account_id=? AND revoked_at IS NULL').get(a.id).n, 0);
  const jd = store.saveAccount({ familyId: family.id, platform: 'jd', label: '京东', cookie: 'pin=test; thor=SYNTHETIC-JD' });
  assert.equal((await post(`${prefix}/accounts/${jd.id}/preview`, { cookie: store.cookie(jd.id) }, group.token)).status, 200);
  const newPreview = (await post(`${prefix}/platforms/taobao/preview`, { cookie: COOKIE }, group.token)).data;
  const temporary = s.account(family.id);
  await s.remove(temporary.id);
  assert.equal((await post(`${prefix}/platforms/taobao/cookie`, { cookie: COOKIE, expectedCredentialVersion: 0,
    confirmationToken: newPreview.confirmationToken }, group.token)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
});

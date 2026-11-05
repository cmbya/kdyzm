import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createService } from '../src/service.mjs';

const ADMIN = randomBytes(24).toString('hex');
const name = '远洋风景4卡菜鸟驿站', description = `已交付给${name}`;
const response = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const config = { channelName: '合成调优渠道', baseUrl: 'https://api.example.com/v1', model: 'synthetic-model', apiKey: randomBytes(24).toString('hex'), enabled: true, autoApply: true, logisticsEnabled: true };
async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('automatic optimization did not finish');
}
async function fixture(t) {
  const now = Date.now(), calls = [];
  const service = createService({ encryptionKey: randomBytes(32).toString('hex'), adminToken: ADMIN, fixture: true, now: () => now,
    aiRequest: async request => {
      const input = JSON.parse(JSON.parse(request.body).messages[1].content); calls.push(input);
      return response(input.expectedStation ? { kind: 'arrival', starts: ['已交付给'], ends: [], keywords: [input.expectedStation], expectedStation: input.expectedStation, evidence: [input.fragment] }
        : { kind: 'locker', targetStationId: 'station-a', alias: input.fragment, subLocation: '2号柜', evidence: [input.fragment] });
    } });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve)); t.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, { method = 'GET', body, admin = true, token, etag } = {}) => {
    const result = await fetch(base + path, { method, headers: { ...(admin ? { 'x-admin-token': ADMIN } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(etag ? { 'If-None-Match': etag } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await result.text(); return { status: result.status, headers: result.headers, data: raw ? JSON.parse(raw) : null };
  };
  const account = service.store.saveAccount({ platform: 'pdd', label: '合成账号', cookie: 'SYNTHETIC' }, undefined, true);
  const device = service.store.redeem(service.store.createPairing({ accountIds: [account.id] }).code, '合成设备');
  service.stations.saveStation('station-a', { name });
  return { service, request, account, device, calls, now };
}

test('enabling automatic optimization discovers cached failures and publishes revised evidence and rollback without an analyze click', async t => {
  const { service, request, account, device, calls, now } = await fixture(t), arrival = now - 60000;
  service.store.importResult(account.id, { orders: [{ platformOrderId: 'order', title: '合成包裹', orderDate: now - 86400000 }], shipments: [
    { platformOrderId: 'order', waybillNo: 'SYNTHETIC12345678', carrier: '中通', status: 'transit', logisticsState: 'ok', logisticsCheckedAt: now,
      logisticsEvents: [{ time: arrival, timePrecision: 'second', description: `${description}，联系电话13800138000，张三先生取件码357591` }] }], warnings: [] });
  const initial = await request('/v1/snapshot', { admin: false, token: device.token });
  assert.equal(initial.data.shipments[0].arrivalAt, 0);
  assert.equal((await request('/v1/admin/station-ai', { method: 'PATCH', body: config })).status, 200);
  await until(() => service.logisticsAi.candidates().some(candidate => candidate.status === 'applied'));
  const updated = await request('/v1/snapshot', { admin: false, token: device.token, etag: initial.headers.get('etag') });
  assert.equal(updated.status, 200); assert.ok(updated.data.serverRevision > initial.data.serverRevision);
  assert.equal(updated.data.shipments[0].station, name); assert.equal(updated.data.shipments[0].arrivalAt, arrival);
  assert.equal(calls.length, 1); assert.ok(!JSON.stringify(calls).match(/13800138000|张三|357591|SYNTHETIC12345678/));
  const history = await request('/v1/admin/ai-optimization/history'), change = history.data.changes.find(item => item.kind === 'logistics_rule');
  assert.equal(change.canRollback, true);
  const rollback = await request(`/v1/admin/ai-optimization/history/${change.kind}/${change.id}/rollback`, { method: 'POST', body: {} });
  assert.equal(rollback.status, 200); assert.equal(rollback.data.change.status, 'rolled_back');
  const restored = await request('/v1/snapshot', { admin: false, token: device.token });
  assert.equal(restored.data.shipments[0].arrivalAt, 0); assert.ok(restored.data.serverRevision > updated.data.serverRevision);
});

test('automatic station alias revision reaches device snapshots and history rollback is administrator-only', async t => {
  const { service, request, device } = await fixture(t), alias = `${name}2号柜`;
  await request('/v1/admin/station-ai', { method: 'PATCH', body: { ...config, logisticsEnabled: false } });
  const upload = await request('/v1/station-candidates', { method: 'POST', admin: false, token: device.token, body: { items: [{ id: 'alias', stationName: alias, fragment: alias, source: 'sms' }] } });
  assert.equal(upload.status, 200);
  await until(() => service.stations.candidates()[0]?.status === 'approved');
  const [change] = (await request('/v1/admin/ai-optimization/history')).data.changes;
  const path = `/v1/admin/ai-optimization/history/station_alias/${change.id}/rollback`;
  assert.equal((await request(path, { method: 'POST', body: {}, admin: false, token: device.token })).status, 401);
  for (const route of ['/v1/admin/logistics-ai', '/v1/admin/ai-optimization/history']) assert.equal((await request(route, { admin: false, token: device.token })).status, 401);
  const before = (await request('/v1/snapshot', { admin: false, token: device.token })).data.stationRulesVersion;
  assert.equal((await request(path, { method: 'POST', body: {} })).status, 200);
  assert.ok((await request('/v1/snapshot', { admin: false, token: device.token })).data.stationRulesVersion > before);
});

test('failed projection hook rolls rule and cached shipment changes back together', async t => {
  const { service, account, now } = await fixture(t), initial = service.logisticsRules.read(), original = service.logisticsRules.onRulesChanged;
  service.store.importResult(account.id, { orders: [{ platformOrderId: 'atomic', title: '合成包裹' }], shipments: [{ platformOrderId: 'atomic', waybillNo: 'ATOMIC', status: 'transit', logisticsState: 'ok', logisticsEvents: [{ time: now - 60000, description }] }], warnings: [] });
  const before = service.store.snapshot([account.id]);
  const rule = { id: 'atomic', name: '合成规则', enabled: true, kind: 'arrival', starts: ['已交付给'], end: '', keywords: [name], sample: description, expectedStation: name, origin: 'manual' };
  service.logisticsRules.onRulesChanged = rules => { original(rules); throw new Error('synthetic projection write failure'); };
  assert.throws(() => service.logisticsRules.save({ revision: initial.revision, rules: [rule, ...initial.rules] }), /synthetic projection write failure/);
  assert.deepEqual(service.logisticsRules.read(), initial);
  assert.deepEqual(service.store.snapshot([account.id]), before);
});

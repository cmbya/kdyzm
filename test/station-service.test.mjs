import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.mjs';

const NOW = Date.parse('2026-11-03T12:00:00+08:00');
const ADMIN = 'synthetic-admin-token-at-least-32-characters';
const KEY = '34'.repeat(32);
const API_KEY = 'test-key';
const aiConfig = { channelName: '测试渠道', baseUrl: 'https://api.example.com/v1', model: 'configured-test-model', apiKey: API_KEY, enabled: true };
const response = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const collection = () => ({ orders: [{ platformOrderId: 'synthetic-order', title: '测试包裹', orderDate: NOW - 86400000 }], shipments: [
  { platformOrderId: 'synthetic-order', waybillNo: 'SYNTHETIC-WAYBILL', carrier: '圆通', status: 'arrived', station: '4卡2号柜', stationSource: 'platform_event',
    arrivalAt: NOW - 3600000, arrivalAtSource: 'platform_event', arrivalAtPrecision: 'second', updatedAt: NOW }], warnings: [] });

async function fixture(t, options = {}) {
  let time = NOW;
  const service = createService({ encryptionKey: KEY, adminToken: ADMIN, scheduler: false, fixture: true, now: () => time, collector: async () => collection(),
    aiRequest: async () => response({ ok: true }), ...options });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, { method = 'GET', body, admin = false, token, headers = {} } = {}) => {
    const result = await fetch(base + path, { method, headers: { ...(admin ? { 'x-admin-token': ADMIN } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await result.text();
    return { status: result.status, headers: result.headers, raw, data: raw ? JSON.parse(raw) : null };
  };
  const account = service.store.saveAccount({ platform: 'taobao', label: '合成账号', cookie: 'SYNTHETIC_COOKIE' }, undefined, true);
  const device = service.store.redeem(service.store.createPairing({ accountIds: [account.id] }).code, '合成测试设备');
  return { service, request, account, device, advance: duration => { time += duration; } };
}

test('station HTTP endpoints isolate anonymous, device and administrator roles', async t => {
  const { request, device } = await fixture(t);
  for (const path of ['/v1/admin/stations', '/v1/admin/station-candidates', '/v1/admin/station-ai']) {
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, { token: device.token })).status, 401);
    assert.equal((await request(path, { headers: { 'x-admin-token': device.token } })).status, 401);
    assert.equal((await request(path, { admin: true })).status, 200);
  }
  for (const path of ['/v1/station-candidates', '/v1/station-proposals']) {
    assert.equal((await request(path, { method: 'POST', body: {} })).status, 401);
    assert.equal((await request(path, { method: 'POST', admin: true, body: {} })).status, 401);
  }
  const upload = await request('/v1/station-candidates', { method: 'POST', token: device.token, body: { items: [{ id: 'client-1', stationName: '4卡2号柜', fragment: '4卡2号柜', source: 'sms' }] } });
  assert.equal(upload.status, 200); assert.deepEqual(upload.data.acceptedIds, ['client-1']);
  const candidateId = (await request('/v1/admin/station-candidates', { admin: true })).data.candidates[0].id;
  assert.equal((await request(`/v1/admin/station-candidates/${candidateId}/approve`, { method: 'POST', token: device.token, body: {} })).status, 401);
  assert.equal((await request(`/v1/admin/station-candidates/${candidateId}/ignore`, { method: 'POST', token: device.token, body: {} })).status, 401);
});

test('manual run HTTP responses explain rejection and permit configured AI while automatic analysis is off', async t => {
  const { service, request, device } = await fixture(t, { aiRequest: async () => response({ kind: 'unknown', evidence: [] }) });
  const run = () => request('/v1/admin/station-ai/run', { method: 'POST', admin: true, body: {} });
  assert.equal((await run()).data.code, 'AI_NOT_CONFIGURED');
  const saved = await request('/v1/admin/station-ai', { method: 'PATCH', admin: true, body: { ...aiConfig, enabled: false, dailyLimit: 60 } });
  assert.equal(saved.status, 200); assert.equal(saved.data.config.dailyLimit, 60);
  assert.equal((await run()).data.code, 'AI_NO_PENDING');
  await request('/v1/station-candidates', { method: 'POST', token: device.token, body: { items: [{ id: 'manual-1', stationName: '4卡2号柜', fragment: '4卡2号柜', source: 'sms' }] } });
  const started = await run(); assert.equal(started.status, 202); assert.equal(started.data.accepted, true); assert.equal(started.data.code, 'AI_ACCEPTED'); assert.ok(started.data.message);
  await service.stationAi.running;
  const candidates = (await request('/v1/admin/station-candidates', { admin: true })).data.candidates;
  assert.equal(candidates[0].analysis.result.kind, 'unknown'); assert.equal(candidates[0].analysis.input.fragment, '4卡2号柜');
  const denied = await request('/v1/admin/station-candidates', { token: device.token }); assert.equal(denied.status, 401);
  const snapshot = await request('/v1/snapshot', { token: device.token }); assert.equal(snapshot.data.analysis, undefined); assert.ok(!snapshot.raw.includes('knownStations'));
});

test('AI settings encrypt the backend key and never expose it in HTTP settings, snapshots or errors', async t => {
  let sent;
  const { service, request, device } = await fixture(t, { aiRequest: async value => { sent = value; const input = JSON.parse(JSON.parse(value.body).messages[1].content);
    return response(input.fragment ? { kind: 'locker', suggestedName: '合成驿站', alias: input.fragment, subLocation: '2号柜', evidence: [input.fragment] }
      : { name: '合成模板', signature: '合成快递', keywords: ['取件码'], kind: 'pickup', rules: { code: { start: '取件码', end: '，' }, express: { start: '', end: '' }, address: { start: '已到', end: '，' } } }); } });
  const saved = await request('/v1/admin/station-ai', { method: 'PATCH', admin: true, body: aiConfig });
  assert.equal(saved.status, 200); assert.equal(saved.data.config.hasApiKey, true);
  for (const result of [saved, await request('/v1/admin/station-ai', { admin: true }), await request('/v1/snapshot', { token: device.token })]) {
    assert.ok(!result.raw.includes(API_KEY)); assert.ok(!result.raw.includes('SYNTHETIC_COOKIE'));
  }
  const stored = JSON.stringify(service.store.db.prepare('SELECT * FROM station_ai_settings').get());
  assert.ok(!stored.includes(API_KEY)); assert.ok(stored.includes('v1.'));
  const tested = await request('/v1/admin/station-ai/test', { method: 'POST', admin: true, body: {} });
  assert.equal(tested.data.ok, true); assert.equal(sent.headers.Authorization, `Bearer ${API_KEY}`);
  assert.ok(!sent.body.includes('4卡')); assert.ok(!tested.raw.includes(API_KEY));
  const denied = await request('/v1/admin/station-ai', { method: 'PATCH', token: device.token, body: { apiKey: 'REPLACEMENT' } });
  assert.equal(denied.status, 401); assert.equal(service.stations.aiCredentials().apiKey, API_KEY);
  await request('/v1/admin/station-ai', { method: 'PATCH', admin: true, body: { apiKey: '' } });
  assert.equal(service.stations.aiCredentials().apiKey, API_KEY);
});

test('device station relationship proposals require separate administrator confirmations', async t => {
  const { service, request, device } = await fixture(t);
  const created = await request('/v1/admin/stations', { method: 'POST', admin: true, body: { name: '四卡驿站', region: '合成地区' } });
  const station = created.data.station;
  const proposal = await request('/v1/station-proposals', { method: 'POST', token: device.token,
    body: { stationName: '四卡驿站', otherStationName: '4卡2号柜', subLocation: '2号柜' } });
  assert.equal(proposal.status, 202); assert.equal(proposal.data.accepted, 2);
  const candidates = (await request('/v1/admin/station-candidates', { admin: true })).data.candidates;
  assert.equal(candidates.length, 2); assert.ok(candidates.every(c => c.status === 'pending' && c.source === 'manual'));
  assert.equal(service.stations.station(station.id).aliases.length, 0);
  const candidate = candidates.find(c => c.stationName === '4卡2号柜');
  const approved = await request(`/v1/admin/station-candidates/${candidate.id}/approve`, { method: 'POST', admin: true, body: { stationId: station.id, alias: '4卡2号柜', subLocation: '2号柜' } });
  assert.equal(approved.status, 200); assert.equal(approved.data.candidate.status, 'approved');
  assert.equal(approved.data.station.aliases[0].subLocation, '2号柜');
  assert.equal(service.stations.candidates().filter(c => c.status === 'pending').length, 1);
});

test('station rule edits invalidate snapshot ETags and disabled stations disappear without leaking candidate evidence', async t => {
  const { service, request, account, device } = await fixture(t);
  const other = service.store.saveAccount({ platform: 'taobao', label: '另一账号', cookie: 'SYNTHETIC_OTHER_COOKIE' }, undefined, true);
  service.store.importResult(account.id, collection()); service.store.importResult(other.id, collection());
  const initial = await request('/v1/snapshot', { token: device.token });
  const firstTag = initial.headers.get('etag');
  assert.equal(initial.data.orders.length, 1); assert.equal(initial.data.shipments.length, 1);
  assert.equal((await request(`/v1/snapshot?accountId=${other.id}`, { token: device.token })).status, 403);
  assert.equal((await request('/v1/snapshot', { token: device.token, headers: { 'If-None-Match': firstTag } })).status, 304);
  const created = await request('/v1/admin/stations', { method: 'POST', admin: true, body: { name: '四卡驿站', aliases: [{ name: '4卡2号柜', subLocation: '2号柜' }] } });
  assert.equal(created.status, 201);
  service.stations.enqueue([{ id: 'private-review', stationName: '需核对站名', fragment: '只供后台核对的站点片段', source: 'sms' }], { deviceId: device.deviceId });
  const changed = await request('/v1/snapshot', { token: device.token, headers: { 'If-None-Match': firstTag } });
  assert.equal(changed.status, 200); assert.notEqual(changed.headers.get('etag'), firstTag);
  assert.equal(changed.data.stationRulesVersion, 1); assert.equal(changed.data.stationRules[0].aliases[0].name, '4卡2号柜');
  assert.ok(!changed.raw.includes('只供后台核对的站点片段')); assert.equal(changed.data.candidates, undefined);
  const disabled = await request(`/v1/admin/stations/${created.data.station.id}`, { method: 'PATCH', admin: true, body: { enabled: false } });
  assert.equal(disabled.status, 200);
  const after = await request('/v1/snapshot', { token: device.token, headers: { 'If-None-Match': changed.headers.get('etag') } });
  assert.equal(after.status, 200); assert.equal(after.data.stationRulesVersion, 2); assert.deepEqual(after.data.stationRules, []);
  assert.equal(after.data.orders.length, 1); assert.ok(after.data.orders.every(o => o.accountId === account.id));
});

test('successful collection queues verified station names once and AI work never blocks or writes parcel data', async t => {
  let finish, outbound;
  const { service, request, account, device, advance } = await fixture(t, { aiRequest: value => { outbound = value; return new Promise(resolve => { finish = resolve; }); } });
  const station = (await request('/v1/admin/stations', { method: 'POST', admin: true, body: { name: '四卡驿站' } })).data.station;
  const job = await service.requestSync(account.id);
  assert.equal(job.state, 'completed');
  assert.equal(service.stations.candidates().length, 1); assert.equal(service.stations.candidates()[0].source, 'platform');
  assert.equal(service.stations.candidates()[0].fragment, '4卡2号柜');
  advance(5 * 60000); await service.requestSync(account.id);
  assert.equal(service.stations.candidates()[0].occurrences, 1);
  await request('/v1/admin/station-ai', { method: 'PATCH', admin: true, body: aiConfig });
  const started = await request('/v1/admin/station-ai/run', { method: 'POST', admin: true, body: {} });
  assert.equal(started.status, 202); assert.equal(started.data.accepted, true); assert.ok(service.stationAi.running);
  assert.ok(!outbound.body.includes('SYNTHETIC-WAYBILL')); assert.ok(!outbound.body.includes('SYNTHETIC_COOKIE'));
  const snapshot = await request('/v1/snapshot', { token: device.token }); assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.shipments.length, 1);
  const operation = await request('/v1/operations', { method: 'POST', token: device.token,
    body: { operations: [{ id: 'pick-during-ai', shipmentId: snapshot.data.shipments[0].id, action: 'pick', occurredAt: NOW }] } });
  assert.equal(operation.status, 200);
  advance(5 * 60000); const duringAi = await service.requestSync(account.id); assert.equal(duringAi.state, 'completed');
  const beforeAi = service.store.snapshot([account.id]);
  finish(response({ kind: 'locker', targetStationId: station.id, suggestedName: '', alias: '4卡2号柜', subLocation: '2号柜', evidence: ['4卡2号柜'] }));
  await service.stationAi.running;
  assert.deepEqual(service.store.snapshot([account.id]), beforeAi);
  assert.equal(service.stations.candidates()[0].status, 'review');
  assert.equal(service.stations.station(station.id).aliases.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createService } from '../src/service.mjs';
import { MatchingFeedbackStore } from '../src/matching-feedback.mjs';

const NOW = Date.parse('2026-11-06T12:00:00+08:00');
const ADMIN = 'synthetic-admin-token-at-least-32-characters';
const response = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
async function fixture(t, { aiRequest } = {}) {
  let time = NOW, calls = [];
  const service = createService({ encryptionKey: 'ab'.repeat(32), adminToken: ADMIN, fixture: true, scheduler: false, now: () => time,
    aiRequest: async request => { calls.push(request); const input = JSON.parse(JSON.parse(request.body).messages[1].content);
      return aiRequest ? aiRequest(input) : response({ kind: 'locker', targetStationId: 'target', alias: input.fragment, subLocation: '2号柜', evidence: [input.fragment] }); } });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const account = service.store.saveAccount({ platform: 'taobao', label: '合成账号', cookie: 'SYNTHETIC_COOKIE' }, undefined, true);
  const pair = () => service.store.redeem(service.store.createPairing({ accountIds: [account.id] }).code, '合成设备');
  const credential = pair(), device = service.store.device(credential.token);
  service.store.importResult(account.id, { orders: [{ platformOrderId: 'order-1', title: '合成包裹', orderDate: NOW - 86400000 }], shipments: [
    { platformOrderId: 'order-1', waybillNo: 'SYNTHETIC-WAYBILL', carrier: '圆通', status: 'arrived', station: '海棠小区驿站', stationSource: 'platform_event',
      arrivalAt: NOW - 3600000, arrivalAtSource: 'platform_event', arrivalAtPrecision: 'second', updatedAt: NOW }], warnings: [] });
  const shipment = service.store.snapshot(device).shipments[0];
  service.stations.saveStation('target', { name: '海棠小区驿站' });
  const sample = extra => ({ id: 'sample-1', revision: 1, action: 'upsert', kind: 'station_correction', stationName: '海棠兔喜2号柜',
    otherStationName: '', targetStationId: 'target', subLocation: '2号柜', reason: 'station_correction', ...extra });
  const submit = (item, owner = device) => service.matchingFeedback.submit(owner, { items: Array.isArray(item) ? item : [item] });
  const request = async (path, { method = 'GET', body, token = credential.token, admin = false, etag } = {}) => {
    const result = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(admin ? { 'x-admin-token': ADMIN } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(etag ? { 'If-None-Match': etag } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const raw = await result.text(); return { status: result.status, etag: result.headers.get('etag'), raw, data: raw ? JSON.parse(raw) : null };
  };
  const configured = () => service.stations.saveAiConfig({ channelName: '合成默认渠道', baseUrl: 'https://api.example.com/v1', model: 'synthetic-model', apiKey: randomUUID(), enabled: true, autoApply: true });
  const run = async () => { service.stationAi.request(); await service.stationAi.running; };
  return { service, device, credential, pair, account, shipment, sample, submit, request, calls, configured, run, advance: duration => { time += duration; } };
}

test('feedback API requires device auth, scopes receipts, advertises capability and invalidates snapshots', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/matching-feedback', { token: '' })).status, 401);
  assert.equal((await f.request('/v1/matching-feedback', { token: '', admin: true })).status, 401);
  const before = await f.request('/v1/snapshot');
  assert.ok(before.data.capabilities.includes('matching_feedback_v1'));
  const posted = await f.request('/v1/matching-feedback', { method: 'POST', body: { items: [f.sample()] } });
  assert.deepEqual(posted.data.accepted, [{ id: 'sample-1', revision: 1 }]);
  assert.equal(posted.data.items[0].status, 'pending');
  assert.equal(posted.data.configured, false);
  assert.equal((await f.request('/v1/snapshot', { etag: before.etag })).status, 200);
  const snapshot = await f.request('/v1/snapshot');
  assert.deepEqual(snapshot.data.matchingFeedback, (await f.request('/v1/matching-feedback')).data);
  assert.ok(!snapshot.raw.includes('海棠兔喜2号柜'));
  const second = f.pair();
  assert.deepEqual((await f.request('/v1/matching-feedback', { token: second.token })).data.items, []);
  assert.equal((await f.request('/v1/matching-feedback', { method: 'POST', body: { items: Array(21).fill(f.sample()) } })).status, 400);
});

test('feedback is durable, idempotent by revision, and withdrawal wins over reordered upserts', async t => {
  const f = await fixture(t), first = f.submit(f.sample());
  const id = first.items[0].candidateId;
  assert.deepEqual(f.submit(f.sample()).accepted, first.accepted);
  assert.equal(f.service.stations.candidate(id).occurrences, 1);
  assert.equal(f.submit(f.sample({ stationName: '其他柜' })).items[0].error, 'FEEDBACK_CONFLICT');
  const reloaded = new MatchingFeedbackStore({ store: f.service.store, stations: f.service.stations, now: () => NOW });
  assert.deepEqual(reloaded.summary(f.device), f.service.matchingFeedback.summary(f.device));
  f.submit({ id: 'sample-1', revision: 2, action: 'withdraw' });
  for (const revision of [1, 2]) assert.equal(f.submit(f.sample({ revision })).items[0].status, 'withdrawn');
  assert.equal(f.service.stations.candidate(id).status, 'withdrawn');
  const next = f.submit(f.sample({ revision: 3 }));
  assert.equal(next.items[0].status, 'pending'); assert.notEqual(next.items[0].candidateId, id);
});

test('snapshot carries every retained receipt so offline clients can settle more than one hundred samples', async t => {
  const f=await fixture(t);
  for(let start=0;start<120;start+=20)f.submit(Array.from({length:20},(_,i)=>f.sample({id:'receipt-'+(start+i)})));
  f.submit({id:'receipt-0',revision:2,action:'withdraw'});
  const snapshot=await f.request('/v1/snapshot');
  assert.equal(snapshot.data.matchingFeedback.items.length,120);
  assert.equal(snapshot.data.matchingFeedback.items.find(item=>item.id==='receipt-0').status,'withdrawn');
  assert.deepEqual(snapshot.data.matchingFeedback,(await f.request('/v1/matching-feedback')).data);
});

test('manual matching validates the actual shipment scope and canonical logistics target', async t => {
  const f = await fixture(t), other = f.service.store.saveAccount({ platform: 'taobao', label: '另一个账号', cookie: 'OTHER_COOKIE' }, undefined, true);
  const outsider = f.service.store.device(f.service.store.redeem(f.service.store.createPairing({ accountIds: [other.id] }).code, '其他设备').token);
  const sample = f.sample({ kind: 'manual_match', reason: 'manual_match', shipmentId: f.shipment.id, otherStationName: '海棠小区驿站' });
  const denied = f.submit(sample, outsider);
  assert.deepEqual(denied.accepted, []); assert.equal(denied.items[0].error, 'SCOPE_FORBIDDEN');
  assert.equal(f.service.matchingFeedback.rows().length, 0);
  assert.equal(f.submit(sample).items[0].status, 'pending');
  const forged = f.submit({ ...sample, id: 'forged', otherStationName: '伪造物流站' });
  assert.equal(forged.items[0].status, 'review');
  const candidate = f.service.stations.candidate(forged.items[0].candidateId);
  assert.equal(candidate.feedback.otherStationName, '海棠小区驿站'); assert.equal(candidate.feedback.verified, false);
  f.service.stations.saveStation('different', { name: '杏花小区驿站' });
  const wrongTarget = f.submit({ ...sample, id: 'wrong-target', targetStationId: 'different' });
  assert.equal(wrongTarget.items.find(item => item.id === 'wrong-target').status, 'review');
});

test('missing source or unmatched logistics is retained for review without an AI call', async t => {
  const f = await fixture(t); f.configured();
  f.submit(f.sample({ stationName: '' }));
  f.submit(f.sample({ id: 'empty-manual', kind: 'manual_match', shipmentId: f.shipment.id, stationName: '', targetStationId: '', reason: 'manual_match' }));
  f.submit(f.sample({ id: 'already-known', kind: 'manual_match', shipmentId: f.shipment.id, stationName: '海棠小区驿站', targetStationId: '', reason: 'manual_match', subLocation: '' }));
  assert.ok(f.service.matchingFeedback.summary(f.device).items.every(item => item.status === 'review' && item.error));
  await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.service.stations.station('target').aliases.length, 0);
});

test('AI receives separate sanitized mapping, preserves cabinet evidence and applies an audited alias', async t => {
  const f = await fixture(t); f.configured();
  const sample = f.sample({ shipmentId: f.shipment.id, stationName: '海棠兔喜2号柜 电话13812345678 取件码12-3456' });
  const result = f.submit(sample), id = result.items[0].candidateId;
  const before = f.service.store.snapshot(f.device);
  await f.run();
  assert.equal(f.calls.length, 1); assert.equal(f.service.stations.aiConfig().usageToday, 1);
  const outbound = f.calls[0].body, input = JSON.parse(JSON.parse(outbound).messages[1].content);
  for (const secret of [f.shipment.id, 'SYNTHETIC-WAYBILL', '13812345678', '12-3456', 'SYNTHETIC_COOKIE']) assert.ok(!outbound.includes(secret));
  assert.ok(!input.fragment.includes('海棠小区驿站'));
  assert.equal(input.confirmedMapping.targetStationId, 'target'); assert.ok(input.fragment.includes('2号柜'));
  assert.equal(f.service.matchingFeedback.summary(f.device).items[0].status, 'applied');
  assert.equal(f.service.stations.automationHistory()[0].canRollback, true);
  assert.deepEqual(f.service.store.snapshot(f.device), before);
  f.service.stations.rollbackAutomaticAlias(id);
  assert.equal(f.service.matchingFeedback.summary(f.device).items[0].status, 'review');
  assert.equal(f.service.stations.station('target').aliases.length, 0);
});

test('shared evidence survives one owner withdrawing and final withdrawal rolls back only its alias', async t => {
  const f = await fixture(t); f.configured();
  const second = f.service.store.device(f.pair().token);
  const first = f.submit(f.sample()), id = first.items[0].candidateId;
  assert.equal(f.submit(f.sample(), second).items[0].candidateId, id);
  assert.equal(f.service.stations.candidate(id).occurrences, 2);
  await f.run(); assert.equal(f.calls.length, 1);
  f.submit({ id: 'sample-1', revision: 2, action: 'withdraw' });
  assert.equal(f.service.stations.station('target').aliases.length, 1);
  assert.equal(f.service.matchingFeedback.summary(second).items[0].status, 'applied');
  f.service.stations.saveStation('target', { aliases: [...f.service.stations.station('target').aliases, { name: '海棠独立入口', source: 'manual' }] });
  f.submit({ id: 'sample-1', revision: 2, action: 'withdraw' }, second);
  assert.deepEqual(f.service.stations.station('target').aliases.map(alias => alias.name), ['海棠独立入口']);
  assert.equal(f.service.stations.automationHistory()[0].status, 'rolled_back');
});

test('pickup completion keeps confirmed feedback and an in-flight withdrawal prevents application', async t => {
  let finish;
  const f = await fixture(t, { aiRequest: () => new Promise(resolve => { finish = resolve; }) }); f.configured();
  f.submit(f.sample());
  f.service.store.applyOperations(f.device, [{ id: 'pick', shipmentId: f.shipment.id, action: 'pick', occurredAt: NOW }]);
  assert.equal(f.service.matchingFeedback.summary(f.device).items[0].status, 'pending');
  f.service.stationAi.request(); await new Promise(resolve => setImmediate(resolve));
  f.submit({ id: 'sample-1', revision: 2, action: 'withdraw' });
  finish(response({ kind: 'locker', targetStationId: 'target', alias: '海棠兔喜2号柜', subLocation: '2号柜', evidence: ['海棠兔喜2号柜'] }));
  await f.service.stationAi.running;
  assert.equal(f.service.matchingFeedback.summary(f.device).items[0].status, 'withdrawn');
  assert.equal(f.service.stations.station('target').aliases.length, 0);
});

test('independent candidates sharing an applied alias keep ownership until the final withdrawal', async t => {
  const f = await fixture(t); f.configured();
  const first = f.submit(f.sample()).items[0].candidateId;
  await f.run();
  const second = f.submit(f.sample({ id: 'second', otherStationName: '海棠小区驿站' })).items.find(item => item.id === 'second').candidateId;
  assert.notEqual(first, second); await f.run();
  assert.ok(f.service.matchingFeedback.summary(f.device).items.every(item => item.status === 'applied'));
  f.submit({ id: 'sample-1', revision: 2, action: 'withdraw' });
  assert.equal(f.service.stations.station('target').aliases.length, 1);
  f.submit({ id: 'second', revision: 2, action: 'withdraw' });
  assert.equal(f.service.stations.station('target').aliases.length, 0);
  assert.ok(f.service.matchingFeedback.summary(f.device).items.every(item => item.status === 'withdrawn'));
  assert.equal(f.service.stations.candidate(first).application.rolledBackAt, NOW);
});

test('withdrawal preserves later manual alias edits and reports that rollback requires review', async t => {
  const f = await fixture(t); f.configured(); f.submit(f.sample()); await f.run();
  const station = f.service.stations.station('target');
  f.service.stations.saveStation('target', { aliases: station.aliases.map(alias => ({ ...alias, source: 'manual' })) });
  const result = f.submit({ id: 'sample-1', revision: 2, action: 'withdraw' });
  assert.equal(result.items[0].status, 'withdrawn'); assert.match(result.items[0].error, /人工修改/);
  assert.equal(f.service.stations.station('target').aliases[0].source, 'manual');
});

test('conflicting cabinet, unrelated AI target and unknown results never auto apply', async t => {
  for (const scenario of ['cabinet', 'target', 'unknown', 'existing']) await t.test(scenario, async child => {
    const f = await fixture(child, { aiRequest: input => response(scenario === 'unknown' ? { kind: 'unknown', evidence: [] }
      : { kind: 'locker', targetStationId: scenario === 'target' ? 'different' : 'target', alias: input.fragment, subLocation: '2号柜', evidence: [input.fragment] }) });
    f.service.stations.saveStation('different', { name: '杏花小区驿站' }); f.configured();
    if (scenario === 'cabinet') f.service.stations.saveStation('target', { name: '海棠3号柜' });
    if (scenario === 'existing') f.service.stations.saveStation('target', { aliases: [{ name: '海棠兔喜2号柜', subLocation: '3号柜' }] });
    const revision = f.service.stations.revision;
    f.submit(f.sample()); await f.run();
    const item = f.service.matchingFeedback.summary(f.device).items[0];
    assert.equal(item.status, 'review'); assert.ok(item.error);
    assert.equal(f.service.stations.revision, revision);
  });
});

test('AI uses the shared quota and provider failures retain safe retry state', async t => {
  const f = await fixture(t, { aiRequest: () => { throw Object.assign(new Error('PRIVATE_PROVIDER_ECHO'), { retryable: true }); } }); f.configured();
  f.submit(f.sample()); await f.run();
  const state = f.service.matchingFeedback.summary(f.device).items[0];
  assert.equal(state.status, 'failed'); assert.ok(!state.error.includes('PRIVATE_PROVIDER_ECHO'));
  assert.equal(f.service.stations.candidate(state.candidateId).retryAt, NOW + 360 * 60000);
  for (let i = 1; i < 20; i++) assert.equal(f.service.stations.reserveAiCall(), true);
  f.advance(360 * 60000); await f.run(); assert.equal(f.calls.length, 1);
  assert.equal(f.service.stations.aiConfig().usageToday, 20);
});

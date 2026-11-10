import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.mjs';

const ADMIN = 'recognition-test-admin-01234567890123456789';
const TIME = Date.parse('2026-11-10T10:00:00+08:00');
const data = () => ({ orders: [{ platformOrderId: 'active', title: '未收测试包裹', orderStatus: '待收货', orderDate: TIME - 86400000 }],
  shipments: [{ platformOrderId: 'active', waybillNo: 'TRACK001', carrier: '中通', status: 'arrived', station: '测试驿站', arrivalAt: 0, logisticsState: 'empty', updatedAt: TIME }], warnings: [] });

async function setup(t) {
  let now = TIME, calls = 0;
  const service = createService({ encryptionKey: 'ab'.repeat(32), adminToken: ADMIN, scheduler: false, now: () => now,
    collector: async () => { calls++; return data(); } });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const request = async (path, { token, admin, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method: body ? 'POST' : 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(admin ? { 'x-admin-token': ADMIN } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const account = service.store.saveAccount({ platform: 'taobao', label: 'A', cookie: '_m_h5_tk=fixture', enabled: true });
  const bind = ids => service.store.redeem(service.store.createPairing({ accountIds: ids }).code, '测试设备');
  await service.requestSync(account.id);
  const shipment = service.store.snapshot([account.id]).shipments[0];
  const device = bind([account.id]);
  const report = (id = 'failure1') => ({ id, revision: 1, kind: 'unmatched_pickup', state: 'unresolved', sourceId: 'sms1', observedAt: now,
    source: { station: '示例花园4卡5号柜兔喜快递柜', carrier: '', waybillNo: '', pickupCode: '', occurredAt: null, fragment: '示例花园4卡5号柜兔喜快递柜' },
    candidateShipmentIds: [shipment.id], reasonCodes: ['station_mismatch'] });
  return { service, request, account, shipment, device, bind, report, advance: minutes => { now += minutes * 60000; }, calls: () => calls };
}

test('reports and snapshots isolate devices, reject foreign candidates and acknowledge idempotently', async t => {
  const { service, request, account, shipment, device, bind, report } = await setup(t);
  assert.equal((await request('/v1/recognition-issues', { body: { schemaVersion: 1, items: [report()] } })).status, 401);
  const submit = body => request('/v1/recognition-issues', { token: device.token, body });
  const first = await submit({ schemaVersion: 1, items: [report()] });
  assert.equal(first.status, 200); assert.deepEqual(first.data.accepted, [{ id: 'failure1', revision: 1 }]);
  assert.equal(first.data.issues[0].retryCount, 0);
  assert.deepEqual((await submit({ schemaVersion: 1, items: [report()] })).data, first.data);
  const snapshot = (await request('/v1/snapshot', { token: device.token })).data;
  assert.ok(snapshot.capabilities.includes('recognition_workflow_v1'));
  assert.equal(snapshot.recognitionIssues[0].id, 'failure1');
  const otherDevice = bind([account.id]);
  assert.deepEqual((await request('/v1/snapshot', { token: otherDevice.token })).data.recognitionIssues, []);
  const otherAccount = service.store.saveAccount({ platform: 'taobao', label: 'B', cookie: '_m_h5_tk=another_fixture', enabled: true });
  service.store.importResult(otherAccount.id, data());
  const foreign = service.store.snapshot([otherAccount.id]).shipments[0];
  assert.equal((await submit({ schemaVersion: 1, items: [{ ...report(), candidateShipmentIds: [foreign.id] }] })).status, 403);
  assert.equal((await request('/v1/admin/recognition-review', { token: device.token })).status, 401);
  const resolved = await submit({ schemaVersion: 1, items: [{ ...report(), revision: 2, state: 'resolved' }] });
  assert.equal(resolved.data.issues[0].status, 'resolved');
  assert.equal((await submit({ schemaVersion: 1, items: [{ ...report('unknown'), state: 'resolved' }] })).status, 409);
  service.store.db.prepare("UPDATE shipments SET data=json_set(data,'$.picked',1) WHERE id=?").run(shipment.id);
  assert.equal((await submit({ schemaVersion: 1, items: [report('ended')] })).status, 409);
});

test('one invalid report rolls back the batch; admin review is bounded and excludes completed samples', async t => {
  const { service, request, shipment, device, report } = await setup(t);
  const result = await request('/v1/recognition-issues', { token: device.token, body: { schemaVersion: 1,
    items: [report(), { ...report('bad'), source: { ...report().source, station: 'x'.repeat(121) } }] } });
  assert.equal(result.status, 400);
  assert.deepEqual((await request('/v1/snapshot', { token: device.token })).data.recognitionIssues, []);
  const review = await request('/v1/admin/recognition-review?limit=1', { admin: true });
  assert.equal(review.status, 200); assert.equal(review.data.samples.length, 1);
  assert.equal(review.data.workflow.policy.maxRetries, 3);
  assert.ok(!JSON.stringify(review.data).includes('_m_h5_tk'));
  assert.equal((await request('/v1/admin/recognition-review?limit=1000', { admin: true })).status, 400);
  service.store.db.prepare("UPDATE shipments SET data=json_set(data,'$.picked',1) WHERE id=?").run(shipment.id);
  assert.equal((await request('/v1/admin/recognition-review', { admin: true })).data.samples.length, 0);
});

test('service retries real per-order collections three times, coalesces problems, then waits for configured AI', async t => {
  const { service, advance, calls } = await setup(t);
  assert.equal(calls(), 1); assert.ok(service.recognition.tasks().length >= 1);
  for (const minutes of [5, 10, 15]) {
    advance(minutes); service.recognition.runDue(); await service.recognition.running;
  }
  assert.equal(calls(), 4);
  for (const task of service.recognition.tasks()) assert.equal(task.retryCount, 3);
  service.recognition.runDue(); await service.recognition.running;
  assert.ok(service.recognition.tasks().every(task => task.status === 'ai_pending' && task.aiAttempts === 0));
  assert.equal(service.recognition.dailyRun().status, 'complete');
});

test('withdrawal stops queued work, survives scope loss and wins against a delayed initial upload', async t => {
  const { service, request, device, report, advance, calls } = await setup(t);
  const post = items => request('/v1/recognition-issues', { token: device.token, body: { schemaVersion: 1, items } });
  const withdraw = id => ({ ...report(id), revision: 2, state: 'withdrawn', candidateShipmentIds: [], reasonCodes: ['source_withdrawn'] });
  assert.equal((await post([withdraw('late')])).status, 200);
  const late = await post([report('late')]);
  assert.equal(late.status, 200); assert.equal(late.data.issues[0].status, 'ignored');
  assert.equal(late.data.issues[0].revision, 2);
  assert.equal((await post([report()])).status, 200);
  service.store.updateDevice(device.deviceId, { accountIds: [] });
  assert.equal((await post([withdraw('failure1')])).status, 200);
  for (const task of service.recognition.tasks().filter(task => !task.deviceId)) service.recognition.save({ ...task, status: 'resolved' });
  const before = calls(); advance(60); service.recognition.runDue(); await service.recognition.running;
  assert.equal(calls(), before);
  assert.ok(service.recognition.tasks().filter(task => task.deviceId).every(task => task.status === 'ignored' && task.retryCount === 0 && task.aiAttempts === 0));
});

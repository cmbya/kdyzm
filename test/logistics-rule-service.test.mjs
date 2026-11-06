import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogisticsRuleStore } from '../src/logistics-rule-store.mjs';
import { createService } from '../src/service.mjs';
import { createCollector } from '../src/collectors.mjs';

const ADMIN = 'synthetic-admin-token-at-least-32-characters';
const NOW = Date.parse('2026-11-03T12:00:00+08:00');
const custom = { id: 'custom', name: '交付站点', enabled: true, kind: 'arrival', starts: ['交付给'], end: '', keywords: [],
  sample: '交付给幸福菜鸟驿站', expectedStation: '幸福菜鸟驿站', origin: 'manual' };

async function fixture(t) {
  const service = createService({ encryptionKey: '34'.repeat(32), adminToken: ADMIN, scheduler: false, fixture: true, now: () => NOW });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const url = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, { method = 'GET', body, token, admin = false } = {}) => {
    const res = await fetch(url + path, { method, headers: { ...(admin ? { 'x-admin-token': ADMIN } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const account = service.store.saveAccount({ platform: 'pdd', label: '测试', cookie: 'SYNTHETIC' }, undefined, true);
  const device = service.store.redeem(service.store.createPairing({ accountIds: [account.id] }).code, '测试设备');
  return { service, request, account, device };
}

test('logistics settings persist independently, seed defaults once, and reject stale versions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-logistics-rules-'));
  const filename = join(directory, 'settings.sqlite');
  let db = new DatabaseSync(filename);
  t.after(() => { db.close(); assert.ok(directory.startsWith(join(tmpdir(), 'pickcode-logistics-rules-'))); rmSync(directory, { recursive: true, force: true }); });
  let store = new LogisticsRuleStore(db, () => NOW);
  const initial = store.read(); assert.ok(initial.rules.length > 0); assert.deepEqual(initial.rules, initial.defaults);
  const saved = store.save({ revision: initial.revision, rules: [custom] }); assert.equal(saved.revision, initial.revision + 1);
  assert.throws(() => store.save({ revision: initial.revision, rules: [] }), error => error.status === 409);
  db.close(); db = new DatabaseSync(filename); store = new LogisticsRuleStore(db, () => NOW + 1);
  assert.deepEqual(store.read().rules, [custom]); assert.equal(store.read().revision, saved.revision);
  assert.deepEqual(store.save({ revision: saved.revision, rules: [] }).rules, []);
});

test('only administrators can read, test or edit logistics rules and invalid saves leave the document unchanged', async t => {
  const { request, service, device } = await fixture(t);
  const path = '/v1/admin/logistics-rules';
  for (const options of [{}, { token: device.token }]) {
    assert.equal((await request(path, options)).status, 401);
    assert.equal((await request(path, { ...options, method: 'PATCH', body: { revision: 1, rules: [] } })).status, 401);
    assert.equal((await request(path + '/test', { ...options, method: 'POST', body: { rule: custom, sample: custom.sample } })).status, 401);
  }
  const initial = (await request(path, { admin: true })).data;
  assert.ok(initial.defaults.length); assert.equal(initial.revision, 1);
  const preview = await request(path + '/test', { admin: true, method: 'POST', body: { rule: { ...custom, enabled: false, id: '' }, sample: custom.sample } });
  assert.equal(preview.status, 200); assert.equal(preview.data.arrival, true); assert.equal(preview.data.station, custom.expectedStation);
  const saved = await request(path, { admin: true, method: 'PATCH', body: { revision: initial.revision, rules: [custom] } });
  assert.equal(saved.status, 200); assert.equal(saved.data.revision, 2);
  const conflict = await request(path, { admin: true, method: 'PATCH', body: { revision: initial.revision, rules: [] } });
  assert.equal(conflict.status, 409); assert.equal(conflict.data.error.code, 'LOGISTICS_RULE_CONFLICT');
  const invalid = await request(path, { admin: true, method: 'PATCH', body: { revision: 2, rules: [{ ...custom, regex: '.*' }] } });
  assert.equal(invalid.status, 400); assert.deepEqual(service.logisticsRules.read().rules, [custom]);
  const snapshot = (await request('/v1/snapshot', { token: device.token })).data;
  assert.equal(snapshot.logisticsRules, undefined); assert.equal(snapshot.defaults, undefined);
  assert.equal(snapshot.serverLogisticsRulesVersion, 2);
  assert.deepEqual(Object.keys(snapshot.serverLogisticsRules[0]).sort(), ['enabled', 'end', 'id', 'keywords', 'kind', 'name', 'origin', 'starts']);
  assert.equal(snapshot.serverLogisticsRules[0].sample, undefined); assert.equal(snapshot.serverLogisticsRules[0].expectedStation, undefined);
});

test('location-only rule changes reparse cached station names without manufacturing arrival times or changing manual state', async t => {
  const { service, account, device } = await fixture(t);
  const location = { ...custom, id: 'location', kind: 'location', sample: '交付给幸福菜鸟驿站' };
  service.store.importResult(account.id, { orders: [{ platformOrderId: 'o', title: '合成包裹' }], shipments: [
    { platformOrderId: 'o', waybillNo: 'A', status: 'transit', logisticsState: 'ok', logisticsEvents: [{ time: NOW - 10000, description: location.sample }] }], warnings: [] });
  const original = service.store.snapshot([account.id]).shipments[0];
  service.store.applyOperations(service.store.device(device.token), [{ id: 'picked', shipmentId: original.id, action: 'pick', occurredAt: NOW }]);
  service.logisticsRules.save({ revision: 1, rules: [location] });
  const saved = service.store.snapshot([account.id]).shipments[0];
  assert.equal(saved.station, location.expectedStation); assert.equal(saved.arrivalAt, 0); assert.equal(saved.status, 'transit'); assert.equal(saved.picked, true);
});

test('edited rules immediately reparse cached tracks, preserve locker and manual state, and snapshot reads stay read-only', async t => {
  const { service, account } = await fixture(t);
  const getRules = () => service.logisticsRules.read().rules;
  const saveRules = rules => service.logisticsRules.save({ revision: service.logisticsRules.read().revision, rules });
  let time = NOW, description = custom.sample, eventTime = '2026-11-03 11:00:00';
  const collect = createCollector({ now: () => ++time, getLogisticsRules: getRules, fetchImpl: async () => new Response(JSON.stringify({ shipping: {
    tracking_number: 'A', traces: [{ time: eventTime, info: description }] } })) });
  const order = { platformOrderId: 'o', title: '测试' };
  const refresh = async () => {
    const result = await collect({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', { targetOrder: { platformOrderId: 'o', shipments: [{ waybillNo: 'A', status: 'transit' }] } });
    result.orders = [order]; service.store.importResult(account.id, result);
    return service.store.snapshot([account.id]).shipments[0];
  };
  assert.equal((await refresh()).arrivalAt, 0);
  const beforeRevision = service.store.snapshot([account.id]).serverRevision;
  saveRules([custom]);
  const reparsed = service.store.snapshot([account.id]); assert.ok(reparsed.shipments[0].arrivalAt > 0); assert.ok(reparsed.serverRevision > beforeRevision);
  assert.equal(service.store.snapshot([account.id]).serverRevision, reparsed.serverRevision);
  const parsed = await refresh(); assert.equal(parsed.station, custom.expectedStation); assert.ok(parsed.arrivalAt > 0);
  saveRules([]); assert.equal(service.store.snapshot([account.id]).shipments[0].arrivalAt, 0);
  const cleared = await refresh(); assert.equal(cleared.arrivalAt, 0); assert.equal(cleared.station, '');
  service.store.importResult(account.id, { orders: [order], shipments: [{ platformOrderId: 'o', waybillNo: 'A', status: 'arrived', station: '幸福丰巢快递柜',
    stationSource: 'locker', arrivalAt: NOW - 3600000, arrivalAtSource: 'locker_arrival', arrivalAtPrecision: 'second', pickupCode: '123456', logisticsCheckedAt: ++time }], logisticsRules: [] });
  const stored = service.store.snapshot([account.id]).shipments[0];
  service.store.applyOperations({ accountIds: [account.id], legacyAccountIds: [account.id], familyIds: [], id: service.store.devices()[0].id },
    [{ id: 'mark-picked', shipmentId: stored.id, action: 'pick', occurredAt: NOW }]);
  const locker = await refresh(); assert.equal(locker.arrivalAtSource, 'locker_arrival'); assert.equal(locker.station, '幸福丰巢快递柜'); assert.equal(locker.picked, true);
  description = '快件退回后重新派送中'; eventTime = '2026-11-03 11:30:00';
  const returned = await refresh(); assert.equal(returned.arrivalAt, 0); assert.equal(returned.station, ''); assert.equal(returned.picked, false);
  assert.equal(returned.pickupCycleHistory.at(-1).picked, true);
});

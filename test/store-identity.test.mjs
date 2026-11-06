import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';

const NOW = 1800000000000;
const KEY = Buffer.alloc(32, 7);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'store-identity-'));
  const filename = join(directory, 'store.sqlite');
  let clock = NOW;
  const store = new Store({ filename, key: KEY, now: () => clock });
  t.after(() => { try { store.close(); } catch {} });
  store.saveAccount({ platform: 'taobao', label: '测试', cookie: 'FIXTURE' }, 'a', true);
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', platformPackageId: 'pkg-1', waybillNo: ' 001-23 ', carrier: 'ZTO', status: 'transit' }] });
  const device = store.device(store.redeem(store.createPairing(['a']).code, '测试').token);
  return { store, filename, directory, device, setTime: value => { clock = value; } };
}

test('identity tables backfill legacy shipments and reopen idempotently', t => {
  const { store, filename, directory } = fixture(t);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const before = store.snapshot(['a']).shipments[0];
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM shipment_identifiers').get().n, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM order_natural_keys').get().n, 1);
  assert.ok(before.pickupCycle?.id);
  // Simulate an older database where the cycle was already persisted but both new indexes were absent.
  store.db.exec('DELETE FROM shipment_identifiers; DELETE FROM order_natural_keys');
  store.close();
  const reopened = new Store({ filename, key: KEY, now: () => NOW });
  const after = reopened.snapshot(['a']).shipments[0];
  assert.equal(after.id, before.id);
  assert.equal(after.pickupCycle.id, before.pickupCycle.id);
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM shipment_identifiers').get().n, 1);
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM order_natural_keys').get().n, 1);
  reopened.close();
  const twice = new Store({ filename, key: KEY, now: () => NOW });
  assert.equal(twice.db.prepare('SELECT count(*) AS n FROM shipment_identifiers').get().n, 1);
  assert.equal(twice.snapshot(['a']).shipments[0].id, before.id);
  twice.close();
});

test('confirmed aliases resolve old operation targets without changing payload or leaking scope', t => {
  const { store, device, directory } = fixture(t);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: 'NEW-23', carrier: 'ZTO', status: 'transit' }] });
  const shipments = store.snapshot(['a']).shipments;
  const oldShipment = shipments.find(item => item.waybillNo.includes('001-23'));
  const target = shipments.find(item => item.waybillNo === 'NEW-23');
  store.importResult('a', { orders: [{ platformOrderId: 'other' }], shipments: [{ platformOrderId: 'other', waybillNo: 'OTHER-23', carrier: 'ZTO', status: 'transit' }] });
  const otherOrderShipment = store.snapshot(['a']).shipments.find(item => item.waybillNo === 'OTHER-23');
  assert.throws(() => store.saveShipmentAlias(oldShipment.id, otherOrderShipment.id, { reason: 'wrong order' }), error => error.status === 400);
  store.saveShipmentAlias(oldShipment.id, target.id, { reason: 'confirmed', evidence: 'same platform package' });
  const operation = { id: 'old-pick', shipmentId: oldShipment.id, action: 'pick', occurredAt: NOW };
  assert.deepEqual(store.applyOperations(device, [operation]), { appliedIds: ['old-pick'] });
  assert.equal(store.snapshot(['a']).shipments.find(item => item.id === target.id).picked, true);
  assert.throws(() => store.saveShipmentAlias(oldShipment.id, target.id, { reason: 'late' }), error => error.status === 409);
  assert.equal(store.operation(device, 'old-pick').shipmentId, oldShipment.id);
  assert.deepEqual(store.applyOperations(device, [operation]), { appliedIds: ['old-pick'] });
  assert.equal(store.shipment(oldShipment.id).picked, false);
  assert.equal(store.snapshot(['a']).shipments.some(item => item.id === oldShipment.id), false);
  assert.equal(store.snapshot(['a']).shipmentIdentifiers.filter(item => item.shipmentId === target.id && item.originalShipmentId === oldShipment.id).length, 1);

  store.saveAccount({ platform: 'taobao', label: '其他', cookie: 'FIXTURE' }, 'b', true);
  const foreign = store.device(store.redeem(store.createPairing(['b']).code, '其他').token);
  assert.throws(() => store.applyOperations(foreign, [{ ...operation, id: 'foreign-old-pick' }]), error => error.status === 403);
  const aliases = store.snapshot(['a']).shipmentAliases;
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].oldShipmentId, oldShipment.id);
});

test('legacy waybill observations update the canonical shipment after aliasing', t => {
  const { store, directory } = fixture(t);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: 'CANONICAL-23', carrier: 'ZTO', status: 'transit' }] });
  const before = store.snapshot(['a']).shipments;
  const old = before.find(item => item.waybillNo.includes('001-23'));
  const target = before.find(item => item.waybillNo === 'CANONICAL-23');
  const oldEvents = store.shipment(old.id).logisticsEvents;
  store.saveShipmentAlias(old.id, target.id, { reason: 'confirmed', evidence: 'same package' });
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: '001-23', carrier: 'ZTO', status: 'arrived', logisticsCheckedAt: NOW + 1000,
    logisticsEvents: [{ time: NOW + 500, description: '已到达代收点' }] }] });
  const canonical = store.shipment(target.id);
  assert.equal(canonical.status, 'arrived');
  assert.ok(canonical.logisticsEvents.some(event => event.description === '已到达代收点'));
  assert.deepEqual(store.shipment(old.id).logisticsEvents, oldEvents);
  assert.deepEqual(store.snapshot(['a']).shipments.map(item => item.id), [target.id]);
});

test('non-factual return requests and future reset events do not close or clear the current cycle', t => {
  const { store, directory } = fixture(t);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: '001-23', carrier: 'ZTO', status: 'arrived', pickupCode: 'CODE-1', station: '测试驿站', stationSource: 'platform_event', arrivalAt: NOW - 1000, arrivalAtSource: 'platform_event', logisticsCheckedAt: NOW }] });
  const before = store.shipment(store.snapshot(['a']).shipments[0].id);
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: '001-23', carrier: 'ZTO', status: 'transit', logisticsCheckedAt: NOW + 1000,
    logisticsEvents: [{ time: NOW + 500, description: '用户已申请退回，请等待审核' }, { time: NOW + 200000, description: '已退回商家' }] }] });
  const after = store.shipment(before.id);
  assert.equal(after.pickupCycle.id, before.pickupCycle.id);
  assert.equal(after.pickupCode, 'CODE-1');
  assert.equal(after.station, '测试驿站');
});

test('an observation without a check time or trusted newer event preserves logistics but still permits pickup commands', t => {
  const { store, device, directory } = fixture(t);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: '001-23', carrier: 'ZTO', status: 'arrived', pickupCode: 'CODE-2', station: '测试驿站', stationSource: 'platform_event', arrivalAt: NOW - 1000, arrivalAtSource: 'platform_event', logisticsCheckedAt: NOW, logisticsEvents: [{ time: NOW, description: '已到测试驿站' }] }] });
  const before = store.shipment(store.snapshot(['a']).shipments[0].id);
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: '001-23', carrier: 'ZTO', status: 'transit', logisticsEvents: [{ time: NOW - 100, description: '运输中' }] }] });
  const preserved = store.shipment(before.id);
  assert.equal(preserved.status, before.status);
  assert.equal(preserved.pickupCode, before.pickupCode);
  assert.equal(preserved.station, before.station);
  assert.deepEqual(preserved.logisticsEvents, before.logisticsEvents);
  store.applyOperations(device, [{ id: 'pick-after-stale', shipmentId: before.id, action: 'pick', occurredAt: NOW }]);
  assert.equal(store.shipment(before.id).picked, true);
});

test('new logistics evidence starts one new cycle and replay or older evidence does not add another', t => {
  const { store, setTime, directory } = fixture(t);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = store.snapshot(['a']).shipments[0];
  const firstCycle = initial.pickupCycle.id;
  setTime(NOW + 20000);
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: '001-23', carrier: 'ZTO', status: 'transit', logisticsCheckedAt: NOW + 10000,
    logisticsEvents: [{ time: NOW + 5000, description: '改派重新投递' }] }] });
  const changed = store.snapshot(['a']).shipments[0];
  assert.notEqual(changed.pickupCycle.id, firstCycle);
  assert.equal(changed.pickupCycleHistory.length, 1);
  const secondCycle = changed.pickupCycle.id;
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: '001-23', carrier: 'ZTO', status: 'transit', logisticsCheckedAt: NOW + 10000,
    logisticsEvents: [{ time: NOW + 5000, description: '改派重新投递' }] }] });
  assert.equal(store.snapshot(['a']).shipments[0].pickupCycle.id, secondCycle);
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: '001-23', carrier: 'ZTO', status: 'transit', logisticsCheckedAt: NOW + 9000,
    logisticsEvents: [{ time: NOW + 4000, description: '退回商家' }] }] });
  assert.equal(store.snapshot(['a']).shipments[0].pickupCycle.id, secondCycle);
  assert.equal(store.snapshot(['a']).shipments[0].pickupCycleHistory.length, 1);
});

test('a delayed reset event can rotate a cycle even when its timestamp predates the import clock', t => {
  const directory = mkdtempSync(join(tmpdir(), 'store-cycle-delay-'));
  const filename = join(directory, 'store.sqlite');
  let clock = NOW;
  const store = new Store({ filename, key: KEY, now: () => clock });
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  store.saveAccount({ platform: 'taobao', label: '测试', cookie: 'FIXTURE' }, 'a', true);
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: 'DELAY', carrier: 'ZTO', arrivalAt: NOW - 20000,
    logisticsCheckedAt: NOW - 10000, logisticsEvents: [{ time: NOW - 20000, description: '到达代收点' }] }] });
  const first = store.snapshot(['a']).shipments[0];
  clock = NOW + 10000;
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: 'DELAY', carrier: 'ZTO', logisticsCheckedAt: NOW + 5000,
    logisticsEvents: [{ time: NOW - 5000, description: '改派重新投递' }] }] });
  const rotated = store.snapshot(['a']).shipments[0];
  assert.notEqual(rotated.pickupCycle.id, first.pickupCycle.id);
  assert.equal(rotated.pickupCycleHistory.length, 1);
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: 'DELAY', carrier: 'ZTO', logisticsCheckedAt: NOW - 1,
    logisticsEvents: [{ time: NOW - 5000, description: '改派重新投递' }] }] });
  assert.equal(store.snapshot(['a']).shipments[0].pickupCycle.id, rotated.pickupCycle.id);
});

test('an unknown carrier never forces a same-number merge with a known carrier', t => {
  const { store, directory } = fixture(t);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: '001-23', carrier: '', status: 'transit' }] });
  assert.equal(store.snapshot(['a']).shipments.length, 1);
  assert.match(store.account('a').warnings.at(-1), /未自动新增包裹/);
});

test('cycle-aware pickup commands reject a mismatched current cycle before recording an operation', t => {
  const { store, device, directory } = fixture(t);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const shipment = store.snapshot(['a']).shipments[0];
  assert.throws(() => store.applyOperations(device, [{ id: 'wrong-cycle', shipmentId: shipment.id, pickupCycleId: 'old-cycle', action: 'pick', occurredAt: NOW }]), error => error.status === 409 && error.code === 'PICKUP_CYCLE_CONFLICT');
  assert.throws(() => store.operation(device, 'wrong-cycle'), error => error.status === 404);
});

test('an old cycle command can cross a confirmed alias once, but not after the target rotates', t => {
  const { store, device, directory, setTime } = fixture(t);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: 'TARGET-CYCLE', carrier: 'ZTO', status: 'transit' }] });
  const shipments = store.snapshot(['a']).shipments;
  const old = shipments.find(item => item.waybillNo.includes('001-23'));
  const target = shipments.find(item => item.waybillNo === 'TARGET-CYCLE');
  store.saveShipmentAlias(old.id, target.id, { reason: 'confirmed', evidence: 'same package' });
  const oldCycleId = store.shipment(old.id).pickupCycle.id;
  const targetCycleId = store.shipment(target.id).pickupCycle.id;
  const legacy = { id: 'legacy-cycle-pick', shipmentId: old.id, pickupCycleId: oldCycleId, action: 'pick', occurredAt: NOW };
  assert.deepEqual(store.applyOperations(device, [legacy]), { appliedIds: [legacy.id] });
  assert.equal(store.shipment(target.id).picked, true);
  setTime(NOW + 20000);
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: 'TARGET-CYCLE', carrier: 'ZTO', logisticsCheckedAt: NOW + 10000,
    logisticsEvents: [{ time: NOW + 5000, description: '改派重新投递' }] }] });
  assert.notEqual(store.shipment(target.id).pickupCycle.id, targetCycleId);
  assert.throws(() => store.applyOperations(device, [{ ...legacy, id: 'legacy-cycle-pick-again' }]), error => error.status === 409 && error.code === 'PICKUP_CYCLE_CONFLICT');
  assert.equal(store.operation(device, 'legacy-cycle-pick').shipmentId, old.id);
});

test('identity writes roll back with the enclosing Store transaction', t => {
  const { store, directory } = fixture(t);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const before = store.db.prepare('SELECT count(*) AS n FROM shipment_identifiers').get().n;
  const shipment = store.snapshot(['a']).shipments[0];
  assert.throws(() => store.transaction(() => {
    store.db.prepare(`INSERT INTO shipment_identifiers(account_id,platform,shipment_id,order_id,platform_package_key,carrier_raw,carrier_key,waybill_raw,waybill_key,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('a', 'taobao', shipment.id, shipment.orderId, 'temporary', '', '', 'TEMP', 'TEMP', 'test', NOW, NOW);
    throw new Error('abort');
  }), /abort/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM shipment_identifiers').get().n, before);
});

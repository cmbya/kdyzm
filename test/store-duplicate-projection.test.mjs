import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';

const NOW = 1800000000000;
function fixture(t, options = {}) {
  const store = new Store({ key: Buffer.alloc(32, 7), now: () => NOW, ...options });
  t.after(() => { try { store.close(); } catch {} });
  store.saveAccount({ platform: 'taobao', label: '合成账号', cookie: 'FIXTURE' }, 'a', true);
  store.importResult('a', { orders: [{ platformOrderId: 'o', title: '同一包裹' }], shipments: [{ platformOrderId: 'o', waybillNo: '00123', carrier: '中通快递', status: 'arrived',
    logisticsCheckedAt: NOW, arrivalAt: NOW - 1000, arrivalAtSource: 'platform_event', station: '合成驿站', stationSource: 'platform_event', pickupCode: '3-2068' }] });
  const current = store.snapshot(['a']).shipments[0];
  const legacy = { ...current, id: 'legacy-spelling', carrier: 'ZTO Express', waybillNo: '００１２３', status: 'transit', pickupCode: '', arrivalAt: 0,
    arrivalAtSource: 'unknown', station: '', stationSource: 'unknown', logisticsCheckedAt: NOW - 60000, updatedAt: NOW - 60000,
    pickupCycle: { ...current.pickupCycle, id: 'legacy-initial-cycle' } };
  const saveLegacy = (patch = {}) => {
    const record = { ...legacy, ...patch };
    store.db.prepare('INSERT INTO shipments VALUES(?,?,?)').run(record.id, record.accountId, JSON.stringify(record));
    store.saveShipmentIdentifier(record, 'taobao', { source: 'legacy', ...(patch.identifier || {}) }, NOW - 60000);
    return record;
  };
  const refresh = () => store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: '00123', carrier: 'ZTO', status: 'arrived', logisticsCheckedAt: NOW }] });
  return { store, current, saveLegacy, refresh };
}

test('legacy normalized-identity duplicates converge to one current shipment and retain the old row and cycle alias', t => {
  const { store, current, saveLegacy, refresh } = fixture(t);
  const legacy = saveLegacy();
  assert.equal(store.snapshot(['a']).shipments.length, 2, 'fixture contains the old transit and current pickup rows');
  refresh();
  const snapshot = store.snapshot(['a']);
  assert.deepEqual(snapshot.shipments.map(item => [item.id, item.status]), [[current.id, 'arrived']]);
  const alias = snapshot.shipmentAliases.find(item => item.oldShipmentId === legacy.id);
  assert.equal(alias.targetShipmentId, current.id);
  assert.equal(alias.sourceCycleId, legacy.pickupCycle.id);
  assert.equal(alias.targetCycleId, current.pickupCycle.id);
  assert.equal(store.shipment(legacy.id).status, 'transit', 'historical row is retained without rewriting');
  refresh();
  assert.equal(store.snapshot(['a']).shipmentAliases.length, 1, 'repeat imports do not create duplicate aliases');
  assert.equal(store.account('a').warnings.length, 0, 'historical rows resolving to one canonical identity are not ambiguous');
});

test('distinct platform package keys sharing a waybill stay separate', t => {
  const { store, current, saveLegacy, refresh } = fixture(t);
  store.saveShipmentIdentifier(current, 'taobao', { platformPackageKey: 'box-a' });
  saveLegacy({ identifier: { platformPackageKey: 'box-b' } });
  refresh();
  assert.equal(store.snapshot(['a']).shipments.length, 2);
  assert.equal(store.snapshot(['a']).shipmentAliases.length, 0);
});

for (const patch of [{ picked: true }, { hidden: true }, { pickupCompletion: { manualOverride: { picked: false, occurredAt: NOW } } },
  { pickupCycle: { id: 'second-cycle', startedAt: NOW, evidenceKey: 'actual-redelivery', status: 'active' } }, { station: '其他驿站', pickupCode: '9-9999' }]) {
  test(`legacy identity reconciliation preserves explicit decisions or conflicting cycle/location: ${JSON.stringify(patch)}`, t => {
    const { store, saveLegacy, refresh } = fixture(t);
    saveLegacy(patch);
    refresh();
    assert.equal(store.snapshot(['a']).shipments.length, 2);
    assert.equal(store.snapshot(['a']).shipmentAliases.length, 0);
  });
}

test('confirmed alias rows do not make later normalized-waybill observations ambiguous', t => {
  const { store, current, saveLegacy, refresh } = fixture(t);
  const legacy = saveLegacy();
  store.saveShipmentAlias(legacy.id, current.id, { reason: 'confirmed', evidence: 'same package identifier' });
  refresh();
  assert.equal(store.account('a').warnings.length, 0);
  assert.equal(store.snapshot(['a']).shipments.length, 1);
});

test('upgrade reconciles legacy duplicate identities once and persists their different cycle bridge', t => {
  const directory = mkdtempSync(join(tmpdir(), 'store-duplicates-'));
  const filename = join(directory, 'store.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { store, current, saveLegacy } = fixture(t, { filename });
  const legacy = saveLegacy();
  store.close();
  const reopened = new Store({ filename, key: Buffer.alloc(32, 7), now: () => NOW });
  const snapshot = reopened.snapshot(['a']);
  assert.deepEqual(snapshot.shipments.map(shipment => shipment.id), [current.id]);
  assert.equal(snapshot.shipmentAliases[0].sourceCycleId, legacy.pickupCycle.id);
  assert.equal(snapshot.shipmentAliases[0].targetCycleId, current.pickupCycle.id);
  const revision = snapshot.serverRevision;
  reopened.close();
  const twice = new Store({ filename, key: Buffer.alloc(32, 7), now: () => NOW });
  assert.equal(twice.snapshot(['a']).serverRevision, revision, 'a repeated startup is idempotent');
  assert.equal(twice.snapshot(['a']).shipmentAliases.length, 1);
  twice.close();
});

test('automatic identity repair never crosses accounts, orders or unknown carrier identities', t => {
  const { store, saveLegacy, refresh } = fixture(t);
  store.saveAccount({ platform: 'taobao', label: '其他账号', cookie: 'FIXTURE' }, 'b', true);
  store.importResult('b', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: '00123', carrier: 'ZTO' }] });
  store.importResult('a', { orders: [{ platformOrderId: 'other-order' }], shipments: [{ platformOrderId: 'other-order', waybillNo: '00123', carrier: 'ZTO' }] });
  saveLegacy({ carrier: 'Unrecognized Express' });
  refresh();
  assert.equal(store.snapshot(['a', 'b']).shipments.length, 4);
  assert.equal(store.snapshot(['a', 'b']).shipmentAliases.length, 0);
});

test('an operation history prevents automatic repair even if the visible flags were cleared', t => {
  const { store, saveLegacy, refresh } = fixture(t);
  const legacy = saveLegacy();
  const device = store.device(store.redeem(store.createPairing(['a']).code, '合成设备').token);
  store.applyOperations(device, [{ id: 'legacy-hide', shipmentId: legacy.id, action: 'hide', occurredAt: NOW }]);
  store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(legacy), legacy.id);
  refresh();
  assert.equal(store.snapshot(['a']).shipments.length, 2);
  assert.equal(store.snapshot(['a']).shipmentAliases.length, 0);
});

test('equally recent conflicting logistics facts are not automatically merged', t => {
  const { store, saveLegacy, refresh } = fixture(t);
  saveLegacy({ logisticsCheckedAt: NOW });
  refresh();
  assert.equal(store.snapshot(['a']).shipments.length, 2);
  assert.equal(store.snapshot(['a']).shipmentAliases.length, 0);
});

test('confirmed platform package aliases are resolved before deciding whether an import is ambiguous', t => {
  const { store, current, saveLegacy } = fixture(t);
  store.saveShipmentIdentifier(current, 'taobao', { platformPackageKey: 'same-box' });
  const legacy = saveLegacy({ identifier: { platformPackageKey: 'same-box' } });
  store.saveShipmentAlias(legacy.id, current.id, { reason: 'confirmed', evidence: 'same package identifier' });
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', platformPackageKey: 'same-box', waybillNo: '00123', carrier: 'ZTO', status: 'signed', logisticsCheckedAt: NOW + 1000 }] });
  assert.equal(store.account('a').warnings.length, 0);
  assert.deepEqual(store.snapshot(['a']).shipments.map(shipment => [shipment.id, shipment.status]), [[current.id, 'signed']]);
});

test('automatic repair does not redirect a previously confirmed alias target', t => {
  const { store, current, saveLegacy, refresh } = fixture(t);
  const previous = saveLegacy({ id: 'previous-alias', waybillNo: 'OLD-WAYBILL' });
  store.saveShipmentAlias(previous.id, current.id, { reason: 'confirmed', evidence: 'same package, updated waybill' });
  saveLegacy();
  refresh();
  const snapshot = store.snapshot(['a']);
  assert.equal(snapshot.shipments.length, 2);
  assert.equal(snapshot.shipmentAliases.length, 1);
  assert.equal(snapshot.shipmentAliases[0].targetShipmentId, current.id);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';

const NOW = 1800000000000;
function fixture(t) {
  const store = new Store({ key: Buffer.alloc(32, 7), now: () => NOW });
  t.after(() => store.close());
  store.saveAccount({ platform: 'pdd', label: '合成账号', cookie: 'FIXTURE' }, 'a', true);
  const sync = (carrier, patch = {}) => store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{
    platformOrderId: 'o', waybillNo: 'YT-SYNTHETIC-123', carrier, status: 'transit', logisticsCheckedAt: NOW, ...patch }] });
  return { store, sync };
}

for (const generic of ['快递', '物流', '其他', 'UNKNOWN']) {
  test(`generic carrier ${generic} upgrades to a specific carrier without creating a split parcel`, t => {
    const { store, sync } = fixture(t);
    sync(generic);
    const id = store.snapshot(['a']).shipments[0].id;
    sync('圆通速递', { status: 'arrived', pickupCode: '123054', station: '合成兔喜驿站', arrivalAt: NOW - 1000, arrivalAtSource: 'platform_event' });
    sync(generic, { logisticsCheckedAt: NOW - 1000 });
    const [shipment] = store.snapshot(['a']).shipments;
    assert.equal(store.snapshot(['a']).shipments.length, 1);
    assert.equal(shipment.id, id);
    assert.equal(shipment.carrier, '圆通速递');
    assert.equal(shipment.status, 'arrived');
    assert.equal(shipment.pickupCode, '123054');
    assert.equal(store.account('a').warnings.length, 0);
  });
}

test('one known parcel accepts a generic observation but competing specific carriers remain separate', t => {
  const { store, sync } = fixture(t);
  sync('圆通速递');
  const id = store.snapshot(['a']).shipments[0].id;
  sync('快递', { status: 'signed', logisticsCheckedAt: NOW + 1000 });
  assert.deepEqual(store.snapshot(['a']).shipments.map(s => [s.id, s.carrier, s.status]), [[id, '圆通速递', 'signed']]);
  sync('中通快递');
  assert.equal(store.snapshot(['a']).shipments.length, 2);
  sync('快递');
  assert.equal(store.snapshot(['a']).shipments.length, 2);
  assert.match(store.account('a').warnings.join(''), /未自动新增包裹/);
});

test('legacy generic and specific rows converge with a verifiable alias while distinct package keys remain separate', t => {
  for (const separate of [false, true]) {
    const { store, sync } = fixture(t);
    sync('圆通速递', { status: 'arrived', pickupCode: '123054' });
    const current = store.shipment(store.snapshot(['a']).shipments[0].id);
    const legacy = { ...current, id: 'legacy-generic', carrier: '快递', status: 'transit', pickupCode: '',
      logisticsCheckedAt: NOW - 1000, pickupCycle: { ...current.pickupCycle, id: 'legacy-cycle' } };
    store.db.prepare('INSERT INTO shipments VALUES(?,?,?)').run(legacy.id, legacy.accountId, JSON.stringify(legacy));
    store.saveShipmentIdentifier(legacy, 'pdd', separate ? { platformPackageKey: 'other-box' } : {});
    if (separate) store.saveShipmentIdentifier(current, 'pdd', { platformPackageKey: 'first-box' });
    sync('圆通速递');
    const snapshot = store.snapshot(['a']);
    assert.equal(snapshot.shipments.length, separate ? 2 : 1);
    assert.equal(snapshot.shipmentAliases.length, separate ? 0 : 1);
    if (!separate) {
      assert.equal(snapshot.shipmentAliases[0].sourceCycleId, legacy.pickupCycle.id);
      assert.equal(snapshot.shipmentAliases[0].targetCycleId, current.pickupCycle.id);
      assert.equal(store.shipment(legacy.id).carrier, '快递', 'raw historical row remains available');
    }
  }
});

test('fresh explicit platform packages sharing one waybill stay separate across generic carrier updates', t => {
  const { store, sync } = fixture(t);
  sync('圆通速递', { platformPackageKey: 'box-a', pickupCode: '111111' });
  sync('快递', { platformPackageKey: 'box-b', pickupCode: '222222' });
  sync('圆通速递', { platformPackageKey: 'box-b', pickupCode: '222222' });
  const before = store.snapshot(['a']);
  assert.equal(before.shipments.length, 2);
  assert.deepEqual(before.shipments.map(s => s.pickupCode).sort(), ['111111', '222222']);
  const identifiers = before.shipmentIdentifiers.filter(row => row.platformPackageKey);
  assert.equal(new Set(identifiers.filter(row => row.platformPackageKey === 'box-a').map(row => row.shipmentId)).size, 1);
  assert.notEqual(identifiers.find(row => row.platformPackageKey === 'box-a').shipmentId, identifiers.find(row => row.platformPackageKey === 'box-b').shipmentId);
  sync('快递', { status: 'signed' });
  assert.match(store.account('a').warnings.join(''), /缺少包裹键/);
  assert.deepEqual(store.snapshot(['a']).shipments, before.shipments);
});

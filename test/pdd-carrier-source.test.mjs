import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, pddParcels } from '../src/collectors.mjs';
import { Store } from '../src/store.mjs';

const NOW = Date.parse('2026-11-07T12:00:00+08:00');
const WAYBILL = '773450188700001', OLD_WAYBILL = 'YT0723969500001';
const STATION = '兔喜快递超市代收点';
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
function collector(shipping, parcels = [{ tracking_number: WAYBILL }]) {
  return createCollector({ now: () => NOW, fetchImpl: async url => {
    const target = new URL(url);
    if (target.pathname.includes('order_list_v4')) return response({ has_more: false,
      orders: target.searchParams.get('type') === 'unreceived' ? [{ order_sn: 'o', order_status_text: '待收货', shipping_list: parcels }] : [] });
    if (target.pathname.includes('/cabinet/')) return response({ result: {
      companyName: STATION, tracking_number: WAYBILL, address: '合成自提点', code: '123456', arrival_time: NOW / 1000 - 60 } });
    return response({ shipping: { traces: [{ info: '运输中', timestamp: NOW / 1000 - 60 }], ...shipping } });
  } });
}
function fixture(t, platform = 'pdd') {
  const store = new Store({ key: Buffer.alloc(32, 7), now: () => NOW });
  t.after(() => store.close());
  const account = store.saveAccount({ platform, label: '合成账号', cookie: 'pdd_user_id=SYNTHETIC' }, 'a', true);
  const sync = (carrier, patch = {}) => store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{
    platformOrderId: 'o', waybillNo: WAYBILL, carrier, status: 'transit', logisticsCheckedAt: NOW, ...patch }] });
  return { store, account, sync };
}

test('PDD cabinet companyName is a pickup operator, never a parcel carrier', () => {
  const parcel = pddParcels({ order_sn: 'o', tracking_number: WAYBILL }, { companyName: STATION, code: '123456', address: '合成自提点' })[0];
  assert.equal(parcel.carrier, '');
  assert.equal(parcel.pickupCode, '123456');
  assert.equal(parcel.station, '合成自提点');
  for (const carrierField of ['shipping_name', 'company_name']) {
    assert.equal(pddParcels({ order_sn: 'o', tracking_number: WAYBILL, [carrierField]: '申通快递' }, { companyName: STATION })[0].carrier, '申通快递');
  }
});

for (const fields of [{ trackingNumber: WAYBILL, shippingName: '申通快递' }, { tracking_number: WAYBILL, shipping_name: '申通快递' }]) {
  test(`PDD uses ${Object.keys(fields).join('/')} for the matching waybill only`, async () => {
    const result = await collector(fields, [{ tracking_number: OLD_WAYBILL, shipping_name: '圆通速递' }, { tracking_number: WAYBILL }])(
      { platform: 'pdd' }, 'pdd_user_id=SYNTHETIC');
    assert.deepEqual(result.shipments.map(parcel => [parcel.waybillNo, parcel.carrier]), [[OLD_WAYBILL, '圆通速递'], [WAYBILL, '申通快递']]);
    assert.deepEqual(result.logisticsFailures.map(parcel => parcel.waybillNo), [OLD_WAYBILL]);
  });
}

test('PDD refresh corrects a cached pickup operator but never assigns carrier from an absent or different waybill', async () => {
  for (const trackingNumber of [WAYBILL, 'OTHER-WAYBILL', '']) {
    const result = await collector({ trackingNumber, shippingName: '申通快递' })({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', {
      targetOrder: { platformOrderId: 'o', orderStatus: '待收货', shipments: [{ waybillNo: WAYBILL, carrier: STATION, status: 'transit' }] }
    });
    assert.equal(result.shipments[0].carrier, trackingNumber === WAYBILL ? '申通快递' : STATION);
  }
});

test('PDD carrier correction preserves the existing shipment ID and distinct historical waybill', async t => {
  const { store, account, sync } = fixture(t);
  sync('圆通速递', { waybillNo: OLD_WAYBILL });
  const historical = store.snapshot(['a']).shipments[0];
  const legacy = { ...historical, id: 'legacy-pdd-cabinet-shipment', waybillNo: WAYBILL, carrier: STATION, pickupCode: '123456',
    pickupCycle: { ...historical.pickupCycle, id: 'legacy-pdd-cabinet-cycle' } };
  store.db.prepare('INSERT INTO shipments VALUES(?,?,?)').run(legacy.id, legacy.accountId, JSON.stringify(legacy));
  store.saveShipmentIdentifier(legacy, 'pdd');
  const before = store.snapshot(['a']).shipments;
  const result = await collector({ trackingNumber: WAYBILL, shippingName: '申通快递' })(account, 'pdd_user_id=SYNTHETIC');
  store.importResult('a', result);
  sync(STATION, { logisticsCheckedAt: NOW - 1000 });
  const after = store.snapshot(['a']);
  assert.equal(after.shipments.length, 2);
  assert.equal(after.shipments.find(parcel => parcel.waybillNo === WAYBILL).id, legacy.id);
  assert.equal(after.shipments.find(parcel => parcel.waybillNo === WAYBILL).carrier, '申通快递');
  assert.equal(after.shipments.find(parcel => parcel.waybillNo === WAYBILL).pickupCode, '123456');
  assert.deepEqual(after.shipments.find(parcel => parcel.waybillNo === OLD_WAYBILL), before.find(parcel => parcel.waybillNo === OLD_WAYBILL));
  assert.equal(after.shipmentAliases.length, 0);
  assert.equal(store.account('a').warnings.length, 0);
});

test('only explicit PDD pickup operator suffixes can upgrade to a carrier', t => {
  for (const label of [STATION, '合成快递超市', '合成驿站', '合成快递柜', '合成自提柜']) {
    const { store, sync } = fixture(t);
    sync(label);
    const id = store.snapshot(['a']).shipments[0].id;
    sync('申通快递');
    assert.deepEqual(store.snapshot(['a']).shipments.map(parcel => [parcel.id, parcel.carrier]), [[id, '申通快递']]);
  }
  for (const [platform, label] of [['taobao', STATION], ['jd', STATION], ['pdd', '合成快递'], ['pdd', '合成物流'], ['pdd', '圆通速递']]) {
    const { store, sync } = fixture(t, platform);
    sync(label); sync('申通快递');
    assert.equal(store.snapshot(['a']).shipments.length, 2, `${platform} ${label} must retain its separate carrier identity`);
  }
});

test('PDD pickup operator compatibility preserves explicit packages and rejects ambiguous candidates', t => {
  const { store, sync } = fixture(t);
  sync(STATION, { platformPackageKey: 'box-a' });
  sync('申通快递', { platformPackageKey: 'box-b' });
  const before = store.snapshot(['a']);
  assert.equal(before.shipments.length, 2);
  sync('申通快递');
  assert.deepEqual(store.snapshot(['a']).shipments, before.shipments);
  assert.match(store.account('a').warnings.join(''), /缺少包裹键/);
  sync('申通快递', { platformPackageKey: 'box-a' });
  assert.equal(store.snapshot(['a']).shipments.length, 2);
  assert.deepEqual(new Set(store.snapshot(['a']).shipments.map(parcel => parcel.id)), new Set(before.shipments.map(parcel => parcel.id)));
});

test('a legacy PDD pickup operator cannot pick a carrier when another same-number candidate exists', t => {
  for (const [label, carrier] of [[STATION, '申通快递'], ['中通兔喜驿站', '中通快递']]) {
    const { store, sync } = fixture(t);
    sync('圆通速递');
    const current = store.snapshot(['a']).shipments[0];
    const legacy = { ...current, id: 'legacy-cabinet', carrier: label };
    store.db.prepare('INSERT INTO shipments VALUES(?,?,?)').run(legacy.id, legacy.accountId, JSON.stringify(legacy));
    store.saveShipmentIdentifier(legacy, 'pdd');
    const before = store.snapshot(['a']).shipments;
    sync(carrier);
    assert.deepEqual(store.snapshot(['a']).shipments, before);
    assert.match(store.account('a').warnings.join(''), /未自动新增包裹/);
  }
});

test('a carrier brand in a PDD pickup operator name cannot authorize a legacy duplicate alias', t => {
  const { store, sync } = fixture(t);
  sync('中通快递');
  const current = store.snapshot(['a']).shipments[0];
  const legacy = { ...current, id: 'legacy-branded-cabinet', carrier: '中通兔喜驿站' };
  store.db.prepare('INSERT INTO shipments VALUES(?,?,?)').run(legacy.id, legacy.accountId, JSON.stringify(legacy));
  store.saveShipmentIdentifier(legacy, 'pdd');
  sync('中通快递');
  assert.equal(store.snapshot(['a']).shipments.length, 2);
  assert.equal(store.snapshot(['a']).shipmentAliases.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createCollector, jdParcels, timestamp } from '../src/collectors.mjs';
import { Store } from '../src/store.mjs';

const now = () => Date.parse('2026-11-01T12:00:00+08:00');
const response = value => new Response(JSON.stringify(value));
const order = (id, state = '待收货', extra = {}) => ({ orderId: id, orderType: 0, dateSubmit: '2026-10-30 09:00:00',
  statusInfo: { orderState: state === '已完成' ? 18 : 15, orderStateName: state },
  wareList: [{ name: '模拟商品', wareType: 0 }], itemPayInfo: { shouldPay: 14.82 }, ...extra });
const parcel = (id, status = '运输中', checkCode = null) => ({ carriageInfo: { carriageId: id, carrier: '京东快递' },
  trackGroupInfo: { checkCode, orderTrackShowList: [{ CreationTime: '2026-10-31 12:00:00', StatusName: status, Content: status }] } });
const tracking = (...packages) => ({ processTimeInfo: { submitDate: '2026-10-30 <br/> 09:00:00' }, multiPackageTrackInfoList: packages });
function network(list, details = {}, calls = []) {
  return async (url, options) => {
    const target = new URL(url), detail = target.searchParams.get('functionId') === 'pcdetail_traceMultiPackage';
    const input = JSON.parse(detail ? target.searchParams.get('body') : new URLSearchParams(options.body).get('body'));
    calls.push({ target, options, input });
    assert.equal(target.origin, 'https://api.m.jd.com'); assert.equal(target.pathname, '/api');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(target.searchParams.get('appid'), detail ? 'details-jd-com' : 'order-jd-com');
    assert.equal(target.searchParams.get('loginType'), '3');
    for (const key of ['h5st', 'uuid', 'x-api-eid-token', 'PassKey']) assert.equal(target.searchParams.has(key), false);
    if (detail) { assert.deepEqual(Object.keys(input), ['orderId']); return response(details[input.orderId] || tracking()); }
    assert.deepEqual(Object.keys(input).sort(), ['d', 'page', 's']);
    assert.equal(input.d, 1); assert.equal(input.s, 4096);
    return response({ success: true, data: typeof list === 'function' ? list(input.page) : { orderList: list, totalNum: list.length } });
  };
}

test('JD imports active physical orders with amounts in yuan, split waybills and no browser signatures', async () => {
  const calls = [];
  const result = await createCollector({ now, fetchImpl: network([
    order('waiting', '待发货'), order('moving'), order('finished', '已完成'), order('unpaid', '待付款'),
    order('service', '待使用', { orderType: 4 }), order('virtual', '待收货', { orderType: 69 }),
    order('virtual-ware', '待收货', { wareList: [{ name: '模拟虚拟商品', wareType: 1 }] }),
  ], { moving: tracking(parcel('JD-A', '待取件', '8-2-1234'), parcel('JD-B')) }, calls) })({ platform: 'jd' }, 'thor=FAKE');
  assert.deepEqual(result.orders.map(o => o.platformOrderId), ['waiting', 'moving']);
  assert.equal(result.orders[0].amount, 14.82);
  assert.equal(result.orders[0].orderDate, Date.parse('2026-10-30T09:00:00+08:00'));
  assert.equal(result.shipments.length, 2);
  assert.deepEqual(result.shipments.map(s => [s.waybillNo, s.pickupCode, s.status]), [['JD-A', '8-2-1234', 'arrived'], ['JD-B', '', 'transit']]);
  assert.ok(result.shipments.every(s => !('picked' in s) && s.logisticsState === 'ok'));
  assert.equal(calls.length, 2); assert.ok(calls.every(c => c.options.headers.Cookie === 'thor=FAKE'));
  assert.equal(result.orderUpdates.length, 5);
});

test('JD newest signed event overrides old pickup notice without copying a parent code across parcels', () => {
  const first = parcel('A', '已签收');
  first.trackGroupInfo.orderTrackShowList.unshift({ CreationTime: '2026-10-30 12:00:00', StatusName: '待取件', Content: '已存放至驿站，取件码 8-2-0000' });
  const result = jdParcels({ ...tracking(first, parcel('B')), checkCode: 'PARENT' }, 'o', now());
  assert.equal(result[0].status, 'signed'); assert.equal(result[0].pickupCode, '');
  assert.equal(result[0].logisticsEvents.length, 2); assert.equal(result[1].pickupCode, '');
  assert.equal(result[0].arrivalAt, 0);
  assert.throws(() => jdParcels({ multiPackageTrackInfoList: [{ carriageInfo: { carriageId: 'A' }, trackGroupInfo: {} }] }, 'o', now()), { code: 'UPSTREAM_FORMAT' });
});

test('JD targeted refresh uses only its order ID and obtains authoritative submit time', async () => {
  const calls = [];
  const result = await createCollector({ now, fetchImpl: network([], { target: tracking(parcel('A', '已签收')) }, calls) })(
    { platform: 'jd' }, 'thor=FAKE', { targetOrder: { platformOrderId: 'target', orderStatus: '待收货', shipments: [] } });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].input, { orderId: 'target' });
  assert.deepEqual(result.orders, []); assert.equal(result.orderUpdates[0].orderStatus, '已签收');
  assert.equal(result.orderUpdates[0].orderDateOrigin, 'detail'); assert.equal(result.orderUpdates[0].dateState, 'ok');
  assert.equal(result.shipments[0].status, 'signed');
});

test('JD rechecks missing active parcels and preserves unmatched split history', async () => {
  const result = await createCollector({ now, fetchImpl: network([], { missing: tracking(parcel('A', '已签收')) }) })({ platform: 'jd' }, 'thor=FAKE', {
    knownOrders: [{ platformOrderId: 'missing', shipments: [{ waybillNo: 'A' }, { waybillNo: 'B' }] },
      { platformOrderId: 'hidden', shipments: [{ waybillNo: 'C', hidden: true }] }],
  });
  assert.equal(result.shipments.length, 1); assert.equal(result.shipments[0].status, 'signed');
  assert.deepEqual(result.logisticsFailures.map(f => [f.platformOrderId, f.waybillNo, f.state]), [['missing', 'B', 'unavailable']]);
  assert.ok(!('deletedIds' in result));
});

test('JD empty logistics retains a valid no-code order and does not invent a waybill', async () => {
  const result = await createCollector({ now, fetchImpl: network([order('moving')]) })({ platform: 'jd' }, 'thor=FAKE');
  assert.equal(result.orders.length, 1); assert.deepEqual(result.shipments, []);
  assert.equal(result.logisticsFailures[0].state, 'unavailable');
});

test('JD an absent detail date cannot erase a valid list date and empty tracks cannot downgrade known arrival', async () => {
  const emptyParcel = parcel('A'); emptyParcel.trackGroupInfo.orderTrackShowList = [];
  const result = await createCollector({ now, fetchImpl: network([order('moving')], { moving: { multiPackageTrackInfoList: [emptyParcel] } }) })(
    { platform: 'jd' }, 'thor=FAKE', { knownOrders: [{ platformOrderId: 'moving', shipments: [{ waybillNo: 'A', status: 'arrived', pickupCode: '8-2-1234' }] }] });
  assert.equal(result.orders[0].orderDate, timestamp('2026-10-30 09:00:00'));
  assert.equal(result.orders[0].orderDateOrigin, 'list');
  assert.deepEqual(result.shipments, []);
  assert.deepEqual(result.logisticsFailures.map(f=>[f.waybillNo,f.state]), [['A','empty']]);
});

test('JD detail budget excludes manual completed parcels and rotates no-waybill orders by their last detail attempt', async () => {
  const list = Array.from({ length: 23 }, (_, i) => order('o' + i)), calls = [];
  const knownOrders = list.map((o,i)=>({platformOrderId:o.orderId,dateCheckedAt:i===20?now():0,
    shipments:i<20?[{waybillNo:'P'+i,hidden:i%2===0,picked:i%2!==0}]:[]}));
  const result = await createCollector({now,fetchImpl:network(list,{},calls)})({platform:'jd'},'thor=FAKE',{knownOrders});
  const queried=calls.filter(c=>c.target.searchParams.get('functionId')==='pcdetail_traceMultiPackage').map(c=>c.input.orderId);
  assert.deepEqual(queried,['o21','o22','o20']);
  assert.ok(result.orders.find(o=>o.platformOrderId==='o21').dateCheckedAt);
});

test('JD detects login expiry, format changes and blocking without leaking upstream content', async () => {
  for (const [fetchImpl, code] of [[async () => response({ code: 3 }), 'ACCOUNT_EXPIRED'],
    [async () => response({}), 'UPSTREAM_FORMAT'], [async () => new Response('secret', { status: 403 }), 'UPSTREAM_BLOCKED'],
    [async () => new Response('<html>private</html>'), 'UPSTREAM_FORMAT']]) {
    await assert.rejects(() => createCollector({ fetchImpl })({ platform: 'jd' }, 'thor=FAKE'), { code });
  }
  const result = await createCollector({ now, fetchImpl: async (url, options) => new URL(url).searchParams.get('functionId') === 'pcorder_center_list'
    ? network([order('moving')])(url, options) : response({ unexpected: 'private' }) })({ platform: 'jd' }, 'thor=FAKE');
  assert.equal(result.logisticsFailures[0].state, 'error'); assert.equal(result.orders.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  await assert.rejects(() => createCollector()({ platform: 'unknown' }, ''), { code: 'INVALID_PLATFORM' });
});

test('JD stops duplicate pagination, bounds detail calls and records terminal detail on the admitted order', async () => {
  const calls = [], list = Array.from({ length: 23 }, (_, i) => order('o' + i));
  const details = Object.fromEntries(list.map(o => [o.orderId, tracking(parcel('P-' + o.orderId, '已签收'))]));
  const result = await createCollector({ now, maxPages: 3, fetchImpl: network(() => ({ orderList: list, totalNum: 100 }), details, calls) })({ platform: 'jd' }, 'thor=FAKE');
  assert.equal(calls.filter(c => c.target.searchParams.get('functionId') === 'pcorder_center_list').length, 2);
  assert.equal(calls.filter(c => c.target.searchParams.get('functionId') === 'pcdetail_traceMultiPackage').length, 20);
  assert.equal(result.orders[0].orderStatus, '已签收');
  assert.ok(result.warnings.some(w => w.includes('分页重复'))); assert.ok(result.warnings.some(w => w.includes('详情补查已达上限')));
});

test('JD encrypted accounts join existing family grants and platform sync preserves manual actions', async () => {
  const store = new Store({ key: randomBytes(32), now });
  try {
    const family = store.saveFamily({ name: '模拟家人' });
    const pairing = store.createPairing({ familyIds: [family.id] });
    const device = store.redeem(pairing.code, '模拟设备');
    const account = store.saveAccount({ platform: 'jd', label: '模拟京东', familyId: family.id, cookie: 'thor=FAKE' });
    assert.ok(store.snapshot(store.device(device.token)).accounts.some(a => a.id === account.id));
    assert.doesNotMatch(JSON.stringify(store.accounts()), /thor=FAKE/);
    assert.notEqual(store.db.prepare('SELECT credential FROM accounts WHERE id=?').get(account.id).credential, 'thor=FAKE');
    assert.throws(() => store.saveAccount({ platform: 'jd', label: 'bad', cookie: 'pt_key=FAKE' }), { code: 'INVALID_COOKIE' });
    assert.throws(() => store.saveAccount({ platform: 'pdd' }, account.id), { code: 'INVALID_PLATFORM' });
    const collect = createCollector({ now, fetchImpl: network([order('moving')], { moving: tracking(parcel('A')) }) });
    store.importResult(account.id, await collect(account, store.cookie(account.id)));
    const snapshot = store.snapshot([account.id]), shipment = snapshot.shipments[0];
    const bound = store.device(device.token);
    store.applyOperations(bound, [{ id: 'pick-once', action: 'pick', shipmentId: shipment.id, occurredAt: now() }]);
    const signed = await createCollector({ now, fetchImpl: network([], { moving: tracking(parcel('A', '已签收')) }) })(account, 'thor=FAKE', {
      targetOrder: { ...snapshot.orders[0], shipments: snapshot.shipments },
    });
    store.importResult(account.id, signed);
    const after = store.snapshot([account.id]);
    assert.equal(after.shipments[0].picked, true); assert.equal(after.shipments[0].status, 'signed');
    assert.equal(after.orders[0].familyId, family.id); assert.equal(after.orders[0].orderDate, timestamp('2026-10-30 09:00:00'));
  } finally { store.close(); }
});

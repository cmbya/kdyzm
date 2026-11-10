import test from 'node:test';
import assert from 'node:assert/strict';
import '../app-source/pickcode/core/load-core.mjs';
import { Store } from '../src/store.mjs';
import { readKey } from '../src/security.mjs';
import { createCollector } from '../src/collectors.mjs';
import { parcelJourney } from '../app-source/pickcode/services/parcel-journey.js';
import { packageProgressMatches, shipmentProgress, summarizePackages } from '../app-source/pickcode/core/package-presentation.js';

const KEY = readKey('ab'.repeat(32));
const now = Date.now() - 1000;

function client() {
  let state = '';
  const run = (action = 'snapshot', payload = {}) => {
    const response = JSON.parse(globalThis.PickCodeCore.dispatch(state, JSON.stringify({ action, payload })));
    state = JSON.stringify(response.state);
    return response.result;
  };
  return run;
}

function pairFamily(store, familyId, name = 'App fixture') {
  return store.redeem(store.createPairing({ familyIds: [familyId] }).code, name);
}

function importSnapshot(run, snapshot) {
  return run('syncImport', { syncedAt: now, snapshot });
}

test('京东出库时普通同步补入单号和打印轨迹，仍待发货且发货节点未完成', async t => {
  const store = new Store({ key: KEY });
  t.after(() => store.close());
  const family = store.saveFamily({ name: '仓库阶段家人' });
  const jd = store.saveAccount({ platform: 'jd', label: '仓库京东', familyId: family.id, cookie: 'fixture' }, 'account-warehouse', true);
  const device = pairFamily(store, family.id);
  const run = client();
  let printed = false, detailCalls = 0;
  const collect = createCollector({ now: () => now, fetchImpl: async url => {
    const detail = new URL(url).searchParams.get('functionId') === 'pcdetail_traceMultiPackage';
    if (!detail) return new Response(JSON.stringify({ success: true, data: { totalNum: 1, orderList: [{
      orderId: 'synthetic-warehouse', orderType: 0, dateSubmit: '2026-11-01 10:00:00',
      statusInfo: { orderState: 15, orderStateName: '正在出库' }, wareList: [{ name: '模拟商品', wareType: 0 }],
    }] } }));
    detailCalls++;
    return new Response(JSON.stringify({ multiPackageTrackInfoList: printed ? [{
      carriageInfo: { carriageId: 'SYNTHETIC-JD-PRINT', carrier: '京东快递' },
      trackGroupInfo: { orderTrackShowList: [{ CreationTime: '2026-11-01 10:30:00', StatusName: '仓库处理中', Content: '您的订单已经打印完成' }] },
    }] : [] }));
  } });
  store.importResult(jd.id, await collect(jd, 'thor=FAKE'));
  let result = importSnapshot(run, store.snapshot(store.device(device.token)));
  assert.equal(result.packages[0].shipments.length, 0);
  printed = true;
  const previous = store.snapshot([jd.id]);
  store.importResult(jd.id, await collect(jd, 'thor=FAKE', {
    knownOrders: previous.orders.map(order => ({ ...order, shipments: previous.shipments.filter(s => s.orderId === order.id) })),
    trackedOrderIds: [],
  }));
  result = importSnapshot(run, store.snapshot(store.device(device.token)));
  const item = result.packages[0];
  assert.equal(detailCalls, 2, '没有运单的出库订单在下一轮普通同步仍会查询详情');
  assert.equal(item.orderStatus, '正在出库');
  assert.equal(item.status, 'unknown');
  assert.equal(item.shipments[0]?.waybillNo, 'SYNTHETIC-JD-PRINT');
  assert.equal(item.shipments[0].status, 'unknown');
  assert.equal(item.shipments[0].shippedAt, 0);
  assert.equal(packageProgressMatches(item, 'waiting'), true);
  assert.equal(packageProgressMatches(item, 'transit'), false);
  const journey = parcelJourney(item.shipments[0], item);
  assert.equal(journey.currentIndex, 0);
  assert.equal(journey.points[1].state, 'pending');
  assert.equal(journey.points[1].at, null);
  assert.equal(item.shipments[0].logisticsState, 'ok');
  assert.match(item.shipments[0].logisticsEvents[0].description, /仓库处理中.*订单已经打印完成/);
});

test('京东订单已发货但当前包裹明确待揽收时仍进入未收到，不借用同单其他包裹证据', t => {
  const store = new Store({ key: KEY });
  t.after(() => store.close());
  const family = store.saveFamily({ name: '待揽收家人' });
  const jd = store.saveAccount({ platform: 'jd', label: '待揽收京东', familyId: family.id, cookie: 'fixture' }, 'account-awaiting-collection', true);
  const device = pairFamily(store, family.id);
  const run = client();
  store.importResult(jd.id, {
    orders: [{ platformOrderId: 'synthetic-collection', title: '等待揽收商品', orderDate: now,
      orderStatus: '已发货', tradeStatus: 'WAIT_RECEIVE' }],
    shipments: [
      { platformOrderId: 'synthetic-collection', waybillNo: 'SYNTHETIC-WAIT', status: 'transit',
        logisticsCheckedAt: now, logisticsEvents: [{ time: now - 1000, description: '已发货：包裹正在等待揽收' }] },
      { platformOrderId: 'synthetic-collection', waybillNo: 'SYNTHETIC-UNKNOWN', status: 'unknown', logisticsEvents: [] },
    ],
  });
  const result = importSnapshot(run, store.snapshot(store.device(device.token)));
  const item = result.packages[0];
  const waiting = item.shipments.find(ship => ship.waybillNo === 'SYNTHETIC-WAIT');
  const unknown = item.shipments.find(ship => ship.waybillNo === 'SYNTHETIC-UNKNOWN');
  assert.equal(waiting.status, 'unknown');
  assert.equal(waiting.shippedAt, 0);
  assert.equal(shipmentProgress(waiting, item), 'waiting');
  assert.equal(shipmentProgress(unknown, item), 'other');
  assert.equal(packageProgressMatches(item, 'all'), true);
  assert.equal(packageProgressMatches(item, 'waiting'), true);
  assert.equal(packageProgressMatches(item, 'transit'), false);
  assert.equal(summarizePackages([item]).total, 1);
  assert.equal(summarizePackages([item]).waiting, 1);
  assert.equal(parcelJourney(waiting, item).points[1].state, 'pending');
});

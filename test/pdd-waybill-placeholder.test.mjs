import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, pddParcels } from '../src/collectors.mjs';

const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const account = { platform: 'pdd' }, cookie = 'pdd_user_id=SYNTHETIC';
const NOW = Date.parse('2026-11-07T12:00:00+08:00');

test('PDD filters exact placeholder waybills without dropping real alphanumeric numbers', () => {
  const parcels = pddParcels({ order_sn: 'n35', shipping_list: [
    { tracking_number: '待发货' }, { tracking_number: '暂无' }, { tracking_number: '无' },
    { tracking_number: '0' }, { tracking_number: 'WAITING_FOR_CARRIER' }, { tracking_number: 'YT1234567890123' },
  ] }, {}, {});
  assert.deepEqual(parcels.map(parcel => parcel.waybillNo), ['YT1234567890123']);
});

test('PDD placeholder-to-formal transition keeps the order but produces one shipment', async () => {
  const fetchImpl = async url => {
    const target = new URL(url);
    if (target.pathname.includes('order_list_v4')) {
      if (target.searchParams.get('type') === 'unshipping') {
        return response({ orders: [{ order_sn: 'n35', order_status_text: '待发货', tracking_number: 'WAITING_FOR_CARRIER',
          order_goods: [{ goods_name: '合成磁铁' }] }], has_more: false });
      }
      return response({ orders: [{ order_sn: 'n35', order_status_text: '待收货', tracking_number: 'YT1234567890123',
        shipping_name: '圆通速递' }], has_more: false });
    }
    if (target.pathname.includes('/cabinet/')) return response({ result: {} });
    return response({ shipping: { tracking_number: 'YT1234567890123', traces: [] } });
  };
  const result = await createCollector({ now: () => NOW, fetchImpl })(account, cookie);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].platformOrderId, 'n35');
  assert.deepEqual(result.shipments.map(parcel => parcel.waybillNo), ['YT1234567890123']);
});

test('PDD retains distinct real waybills from one order', () => {
  const parcels = pddParcels({ order_sn: 'split', shipping_list: [
    { tracking_number: 'YT1234567890123', shipping_name: '圆通速递' },
    { tracking_number: 'YT1234567890124', shipping_name: '圆通速递' },
  ] }, {}, {});
  assert.deepEqual(parcels.map(parcel => parcel.waybillNo), ['YT1234567890123', 'YT1234567890124']);
});

test('PDD normalizes list, detail and cabinet waybills consistently', async () => {
  const padded = ' ＹＴ１２３４５６７８９０１２３ ';
  const fetchImpl = async url => {
    const target = new URL(url);
    if (target.pathname.includes('order_list_v4')) return response({ orders: [{ order_sn: 'normalized', order_status_text: '待收货', tracking_number: padded }], has_more: false });
    if (target.pathname.includes('/cabinet/')) return response({ result: {} });
    return response({ shipping: { tracking_number: padded, traces: [{ info: '已到达合成幸福菜鸟驿站', timestamp: NOW / 1000 - 60 }] } });
  };
  const result = await createCollector({ now: () => NOW, fetchImpl })(account, cookie);
  assert.equal(result.shipments.length, 1);
  assert.equal(result.shipments[0].waybillNo, 'YT1234567890123');
  assert.equal(result.shipments[0].logisticsState, 'ok');
  assert.equal(result.shipments[0].logisticsEvents.length, 1);
  assert.equal(result.logisticsFailures.length, 0);
  const refreshed = await createCollector({ now: () => NOW, fetchImpl })(account, cookie, {
    targetOrder: { platformOrderId: 'normalized', orderStatus: '待收货', shipments: [{ waybillNo: padded }] }
  });
  assert.equal(refreshed.shipments[0].waybillNo, 'YT1234567890123');
  assert.equal(refreshed.shipments[0].logisticsState, 'ok');
  assert.equal(refreshed.logisticsFailures.length, 0);
  const parcels = pddParcels({ order_sn: 'split', shipping_list: [{ tracking_number: padded }, { tracking_number: 'YT-OTHER123' }] },
    { tracking_number: padded, code: '123054', address: '合成柜', arrival_time: NOW / 1000 - 60 }, {});
  assert.equal(parcels[1].pickupCode, '');
  assert.equal(parcels[0].pickupCode, '123054');
});

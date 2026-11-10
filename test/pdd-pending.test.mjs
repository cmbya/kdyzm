import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/collectors.mjs';

const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const account = { platform: 'pdd' }, cookie = 'pdd_user_id=SYNTHETIC';
const NOW = Date.parse('2026-10-31T12:00:00+08:00');

test('PDD pending and received ranges paginate independently, merge overlaps, and retain split parcels', async () => {
  const calls = [];
  const pages = {
    unshipping: [
      { orders: [{ order_sn: 'transition', order_status_text: '待发货', order_goods: [{ goods_name: '合成商品' }],
        order_time: 1793350000, shipping_list: [{ tracking_number: 'A', shipping_status_text: '已签收' }], offset: 'pending-offset' }] },
      { orders: [{ order_sn: 'pending', order_amount: 1234 }], has_more: false },
    ],
    unreceived: [
      { orders: [{ order_sn: 'transition', tracking_number: 'B', offset: 'received-offset' }] },
      { orders: [{ order_sn: 'moving', tracking_number: 'C' }], has_more: false },
    ],
  };
  const result = await createCollector({ now: () => NOW, fetchImpl: async (url, options) => {
    const target = new URL(url); calls.push({ target, options });
    if (target.pathname.includes('order_list_v4')) return response(pages[target.searchParams.get('type')][Number(target.searchParams.get('page')) - 1]);
    if (target.pathname.includes('/cabinet/')) return response({ result: target.pathname.endsWith('/transition') ? { tracking_number: 'B', code: '1-2-3456' } : {} });
    return response({ shipping: { tracking_number: target.pathname.includes('/transition/') ? 'B' : 'C', traces: [] } });
  } })(account, cookie);
  assert.deepEqual(calls.filter(call => call.target.pathname.includes('order_list_v4')).map(({ target, options }) => ({
    type: target.searchParams.get('type'), page: target.searchParams.get('page'), offset: target.searchParams.get('offset'), method: options.method,
  })), [
    { type: 'unshipping', page: '1', offset: null, method: 'GET' },
    { type: 'unshipping', page: '2', offset: 'pending-offset', method: 'GET' },
    { type: 'unreceived', page: '1', offset: null, method: 'GET' },
    { type: 'unreceived', page: '2', offset: 'received-offset', method: 'GET' },
  ]);
  assert.deepEqual(result.orders.map(order => [order.platformOrderId, order.orderStatus]), [
    ['transition', '待收货'], ['pending', '待发货'], ['moving', '待收货'],
  ]);
  assert.equal(result.orders[0].title, '合成商品');
  assert.equal(result.orders[0].orderDate, 1793350000000);
  assert.equal(result.orders[1].amount, 12.34);
  assert.equal(result.orders[1].orderDate, 0);
  assert.deepEqual(result.shipments.map(parcel => [parcel.waybillNo, parcel.status, parcel.pickupCode]), [
    ['A', 'signed', ''], ['B', 'arrived', '1-2-3456'], ['C', 'transit', ''],
  ]);
  assert.equal(calls.filter(call => call.target.pathname.includes('/cabinet/transition')).length, 1);
  assert.equal(calls.filter(call => call.target.pathname.includes('/order/transition/shipping')).length, 1);
  assert.ok(!calls.some(call => /\/(?:cabinet|order)\/pending(?:\/|$)/.test(call.target.pathname)));
});

test('PDD ignores explicit unrelated new orders and existing completed history', async () => {
  const skipped = [
    { order_sn: 'cancelled', order_status_text: '已取消' },
    { order_sn: 'refund', order_status_text: '待收货', refund_status: '全额退款成功' },
    { order_sn: 'paid-later', order_status_prompt: '待付款' },
    { order_sn: 'done', status_text: '交易完成' },
    { order_sn: 'numeric-cancelled', order_status: 2 },
    { order_sn: 'numeric-unpaid', pay_status: 0 },
    ...[0, 5, 10, 15].map(status => ({ order_sn: `combined-${status}`, combined_order_status: status })),
  ];
  const calls = [];
  const result = await createCollector({ fetchImpl: async url => {
    const target = new URL(url); calls.push(target);
    if (!target.pathname.includes('order_list_v4')) {
      assert.ok(target.pathname.endsWith('/order/moving/shipping'));
      return response({ shipping: { order_sn: 'moving', traces: [] } });
    }
    return response({ orders: target.searchParams.get('type') === 'unshipping'
      ? [...skipped.map(order => ({ ...order, tracking_number: 'SHOULD-NOT-IMPORT' })), { order_sn: 'pending', combined_order_status: 2 },
        { order_sn: 'unknown-number', combined_order_status: 999 }]
      : [{ order_sn: 'moving', combined_order_status: 3 }], has_more: false });
  } })(account, cookie, { knownOrders: [{ platformOrderId: 'done', shipments: [{ waybillNo: 'OLD', status: 'signed', picked: true }] }] });
  assert.equal(calls.length, 3);
  assert.deepEqual(result.orders.map(order => [order.platformOrderId, order.orderStatus]), [
    ['pending', '待发货'], ['unknown-number', '待发货'], ['moving', '待收货'],
  ]);
  assert.deepEqual(result.orderUpdates, []);
  assert.deepEqual(result.shipments, []);
  assert.ok(result.warnings.some(warning => warning.includes('订单筛选')));
  assert.ok(!('deletedIds' in result));
});

test('PDD active tabs retain station receipt, failed delivery and ambiguous receipt or refund states', async () => {
  const retained = [
    { order_sn: 'station', order_status_text: '驿站已签收，请及时取件', shipping_status: 2 },
    { order_sn: 'failed-delivery', order_status_text: '签收失败' },
    { order_sn: 'conflicting-receipt', combined_order_status: 3, shipping_status: 2 },
    { order_sn: 'receipt', combined_order_status: 4, shipping_status: 2 },
    { order_sn: 'refunding-transit', order_status_text: '运输中，退款处理中', combined_order_status: 8, pay_status: 3, shipping_status: 1 },
    { order_sn: 'partial-refund', order_status_text: '待收货', refund_status: '部分退款成功', pay_status: 4 },
    { order_sn: 'unspecified-refund', order_status_text: '待收货', refund_status: '退款成功' },
    { order_sn: 'unknown', combined_order_status: 999, order_status: 999, pay_status: 999, shipping_status: 999 },
    ...[1, 6, 7, 9, 11, 12, 13, 14].map(status => ({ order_sn: `combined-${status}`, combined_order_status: status })),
  ];
  const result = await createCollector({ now: () => NOW, fetchImpl: async url => {
    const target = new URL(url);
    if (target.pathname.includes('order_list_v4')) return response({ orders: target.searchParams.get('type') === 'unreceived'
      ? retained.map(order => ({ ...order, tracking_number: `WAYBILL-${order.order_sn}` })) : [], has_more: false });
    if (target.pathname.includes('/cabinet/')) return response({ result: {} });
    const id = target.pathname.match(/\/order\/([^/]+)\/shipping$/)[1];
    return response({ shipping: { tracking_number: `WAYBILL-${id}`, traces: id === 'station'
      ? [{ info: '驿站代收签收，请及时取件', time: '2026-10-31 10:00:00' }] : [] } });
  } })(account, cookie);
  assert.deepEqual(result.orders.map(order => order.platformOrderId), retained.map(order => order.order_sn));
  assert.equal(result.shipments.length, retained.length);
  assert.deepEqual(result.orderUpdates, []);
  assert.equal(result.orders.find(order => order.platformOrderId === 'conflicting-receipt').orderStatus, '待收货');
  assert.equal(result.shipments.find(parcel => parcel.platformOrderId === 'station').status, 'arrived');
  assert.equal(result.shipments.find(parcel => parcel.platformOrderId === 'failed-delivery').status, 'transit');
  assert.ok(result.shipments.every(parcel => !('picked' in parcel)));
});

test('PDD pending order becomes a received order on a later sync without duplicating identity', async () => {
  let shipped = false;
  const requests = [];
  const collect = createCollector({ fetchImpl: async url => {
    const target = new URL(url); requests.push(target.pathname);
    if (target.pathname.includes('order_list_v4')) {
      const matches = target.searchParams.get('type') === (shipped ? 'unreceived' : 'unshipping');
      return response({ orders: matches ? [{ order_sn: 'same-order', ...(shipped ? { tracking_number: 'NEW-WAYBILL' } : {}) }] : [], has_more: false });
    }
    if (target.pathname.includes('/cabinet/')) return response({ result: {} });
    return response({ shipping: { tracking_number: 'NEW-WAYBILL', traces: [{ info: '已发货', time: '2026-10-31 10:00:00' }] } });
  } });
  const first = await collect(account, cookie);
  assert.equal(first.orders[0].orderStatus, '待发货');
  assert.equal(requests.length, 2);
  assert.deepEqual(first.shipments, []);
  shipped = true;
  const second = await collect(account, cookie, { knownOrders: first.orders.map(order => ({ ...order, shipments: [] })) });
  assert.equal(second.orders.length, 1);
  assert.equal(second.orders[0].platformOrderId, first.orders[0].platformOrderId);
  assert.equal(second.orders[0].orderStatus, '待收货');
  assert.equal(second.shipments[0].waybillNo, 'NEW-WAYBILL');
  assert.equal(second.shipments[0].status, 'transit');
});

test('PDD repeated pages stop only their own range and do not suppress another range', async () => {
  const calls = [], details = [];
  const result = await createCollector({ maxPages: 3, fetchImpl: async url => {
    const target = new URL(url), type = target.searchParams.get('type'), page = target.searchParams.get('page');
    if (!target.pathname.includes('order_list_v4')) {
      details.push(target.pathname);
      return response({ shipping: { traces: [] } });
    }
    calls.push([type, page, target.searchParams.get('offset')]);
    return response(type === 'unshipping' ? { orders: [{ order_sn: 'repeat', offset: 'pending' }] }
      : { orders: [{ order_sn: page === '1' ? 'repeat' : 'extra', offset: 'received' }], has_more: page === '1' });
  } })(account, cookie);
  assert.deepEqual(calls, [['unshipping', '1', null], ['unshipping', '2', 'pending'], ['unreceived', '1', null], ['unreceived', '2', 'received']]);
  assert.deepEqual(details, ['/proxy/api/order/repeat/shipping', '/proxy/api/order/extra/shipping']);
  assert.deepEqual(result.orders.map(order => order.platformOrderId), ['repeat', 'extra']);
  assert.ok(result.warnings.some(warning => warning.includes('待发货分页重复')));
});

test('PDD pagination limits apply to both ranges and warn for each incomplete range', async () => {
  const calls = [];
  const result = await createCollector({ maxPages: 1, fetchImpl: async url => {
    const target = new URL(url), type = target.searchParams.get('type');
    if (!target.pathname.includes('order_list_v4')) {
      assert.ok(target.pathname.endsWith('/order/unreceived/shipping'));
      return response({ shipping: { traces: [] } });
    }
    calls.push(type);
    return response({ orders: [{ order_sn: type, offset: `${type}-next` }], has_more: true });
  } })(account, cookie);
  assert.deepEqual(calls, ['unshipping', 'unreceived']);
  assert.equal(result.orders.length, 2);
  assert.deepEqual(result.warnings, [
    '已达到待发货分页上限；缺席订单不会标记为已取或删除',
    '已达到待收货分页上限；缺席订单不会标记为已取或删除',
  ]);
});

test('PDD a later page failure does not return the earlier pages as a complete result', async () => {
  const collect = createCollector({ fetchImpl: async url => {
    const target = new URL(url);
    assert.ok(target.pathname.includes('order_list_v4'));
    return target.searchParams.get('page') === '1' ? response({ orders: [{ order_sn: 'partial', offset: 'next' }], has_more: true })
      : new Response('unavailable', { status: 503 });
  } });
  await assert.rejects(collect(account, cookie), { code: 'UPSTREAM_ERROR' });
});

for (const type of ['unshipping', 'unreceived']) {
  for (const [name, failedResponse, code] of [
    ['expired', () => response({ error_code: 40001 }), 'ACCOUNT_EXPIRED'],
    ['blocked', () => new Response('blocked', { status: 403 }), 'UPSTREAM_BLOCKED'],
    ['unavailable', () => new Response('unavailable', { status: 503 }), 'UPSTREAM_ERROR'],
    ['invalid JSON', () => new Response('<html>unavailable</html>'), 'UPSTREAM_FORMAT'],
    ['missing orders', () => response({ success: true }), 'UPSTREAM_FORMAT'],
  ]) {
    test(`PDD ${type} ${name} aborts the whole batch before logistics`, async () => {
      const collect = createCollector({ fetchImpl: async url => {
        const target = new URL(url);
        assert.ok(target.pathname.includes('order_list_v4'));
        return target.searchParams.get('type') === type ? failedResponse()
          : response({ orders: [{ order_sn: 'partial', tracking_number: 'A' }], has_more: false });
      } });
      await assert.rejects(collect(account, cookie), { code });
    });
  }
}

test('PDD targeted refresh of an active pending order checks for a newly assigned waybill', async () => {
  const calls = [];
  const result = await createCollector({ now: () => NOW, fetchImpl: async url => {
    calls.push(new URL(url)); return response({ shipping: { traces: [] } });
  } })(
    account, cookie, { targetOrder: { platformOrderId: 'pending', orderStatus: '待发货', shipments: [] } });
  assert.deepEqual(result.orders, []);
  assert.deepEqual(result.shipments, []);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].pathname.endsWith('/order/pending/shipping'));
  assert.equal(result.orderUpdates[0].dateState, 'unavailable');
});

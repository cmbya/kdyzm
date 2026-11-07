import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/collectors.mjs';
import { Store } from '../src/store.mjs';

const NOW = Date.parse('2026-11-08T12:00:00+08:00');
const cookie = 'pdd_user_id=SYNTHETIC; _m_h5_tk=SYNTHETIC_1794000000';
const reply = data => new Response(JSON.stringify(data));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ids = count => Array.from({ length: count }, (_, index) => `synthetic-${index}`);
const ssr = id => new Response(`<script>window['__ICE_SUSPENSE_LOADER__']['undefined'] = ${JSON.stringify({ result: { data: {
  newLogistics: { fields: { mailNo: `A-${id}`, multiStage: [{ title: '运输中', subtitle: '2026-11-08 10:00:00', labelDesc: { text: id } }] } },
} } })};</script>`);

function fixture(platform, { count = 6, onRequest = async () => {} } = {}) {
  const calls = [], active = new Set(), maxima = {}, sessionOverlaps = [];
  const accountIds = ids(count);
  return { calls, active, maxima, sessionOverlaps, fetchImpl: async (url, options) => {
    const target = new URL(url);
    let kind, id = '', response;
    if (platform === 'pdd') {
      if (target.pathname.includes('order_list_v4')) {
        kind = 'list'; response = reply({ orders: target.searchParams.get('type') === 'unshipping' ? [] : accountIds.map(order_sn => ({
          order_sn, order_status_text: '待收货', tracking_number: `A-${order_sn}`, order_time: 1794000000,
        })), has_more: false });
      } else if (target.pathname.includes('/cabinet/')) {
        kind = 'cabinet'; id = target.pathname.split('/').at(-1); response = reply({ result: {} });
      } else {
        kind = 'shipping'; id = target.pathname.split('/').at(-2);
        response = reply({ shipping: { tracking_number: `A-${id}`, traces: [{ info: id, timestamp: NOW / 1000 - 60 }] } });
      }
    } else if (target.hostname === 'pages-g.m.taobao.com') {
      kind = 'ssr'; id = target.searchParams.get('bizOrderId'); response = ssr(id);
    } else if (target.hostname === 'buyertrade.taobao.com') {
      kind = 'full-track'; id = target.searchParams.get('bizOrderId');
      response = reply({ expressId: `A-${id}`, address: [{ place: id, time: '2026-11-08 11:59:00' }] });
    } else if (!target.searchParams.has('sign')) {
      kind = 'token'; response = reply({ ret: ['FAIL_SYS_TOKEN_EMPTY'] });
    } else if (options.method === 'POST') {
      kind = target.pathname.includes('detailv2') ? 'date' : 'pickup-list';
      response = reply({ ret: ['SUCCESS'], data: { data: {} } });
    } else {
      kind = 'list'; const page = JSON.parse(target.searchParams.get('data')).page;
      response = reply({ ret: ['SUCCESS'], data: { result: { mainOrders: page === '1' ? accountIds.map(orderId => ({
        id: orderId, statusInfo: { text: '待收货' },
      })) : [] } } });
    }
    const sessionRequest = platform === 'taobao' && target.hostname === 'h5api.m.taobao.com';
    if (sessionRequest && active.size || [...active].some(call => call.sessionRequest)) sessionOverlaps.push(kind);
    const call = { kind, id, sessionRequest, cookie: options.headers.Cookie }; calls.push(call); active.add(call);
    maxima[kind] = Math.max(maxima[kind] || 0, [...active].filter(item => item.kind === kind).length);
    maxima.total = Math.max(maxima.total || 0, active.size);
    try {
      const override = await onRequest(call, response);
      await pause(id.endsWith('-0') ? 5 : 1);
      return override || response;
    } finally { active.delete(call); }
  } };
}

test('Taobao cookie rotation stays serial and all logistics use the latest negotiated cookie', async () => {
  let token = 'SYNTHETIC', rotations = 0;
  const mismatches = [];
  const network = fixture('taobao', { onRequest: async (call, response) => {
    if (!call.cookie.includes(`_m_h5_tk=${token}_1794000000`)) mismatches.push(call.kind);
    if (call.sessionRequest) {
      token = `ROTATED${++rotations}`;
      response.headers.append('Set-Cookie', `_m_h5_tk=${token}_1794000000; Path=/`);
    }
  } });
  const result = await createCollector({ now: () => NOW, fetchImpl: network.fetchImpl })({ platform: 'taobao' }, cookie);
  assert.ok(rotations > 2);
  assert.deepEqual(mismatches, []);
  assert.deepEqual(network.sessionOverlaps, []);
  assert.ok(result.refreshedCookie.includes(`_m_h5_tk=${token}_1794000000`));
});

for (const platform of ['pdd', 'taobao']) {
  const stages = platform === 'pdd' ? ['cabinet', 'shipping'] : ['ssr', 'full-track'];
  test(`${platform} independent logistics requests overlap at most twice and keep source ordering`, async () => {
    const network = fixture(platform);
    const result = await createCollector({ now: () => NOW, fetchImpl: network.fetchImpl })({ platform }, cookie);
    for (const stage of stages) assert.equal(network.maxima[stage], 2, stage);
    assert.equal(network.maxima.total, 2);
    assert.deepEqual(network.sessionOverlaps, []);
    assert.deepEqual(result.shipments.map(parcel => parcel.platformOrderId), ids(6));
    for (const stage of stages) assert.equal(network.calls.filter(call => call.kind === stage).length, 6);
  });

  test(`${platform} concurrent full-track requests retain the twenty-order budget and oldest-first priority`, async () => {
    const network = fixture(platform, { count: 22 });
    const knownOrders = ids(22).map((platformOrderId, index) => ({ platformOrderId, orderDateOrigin: 'detail', shipments: [{
      waybillNo: `A-${platformOrderId}`, status: 'transit', logisticsCheckedAt: 22 - index, logisticsDetailCheckedAt: 22 - index,
    }] }));
    await createCollector({ now: () => NOW, fetchImpl: network.fetchImpl })({ platform }, cookie, { knownOrders });
    const tracked = network.calls.filter(call => call.kind === stages[1]);
    assert.equal(tracked.length, 20);
    assert.deepEqual(tracked.slice(0, 2).map(call => call.id), ['synthetic-21', 'synthetic-20']);
    assert.equal(network.maxima[stages[1]], 2);
  });

  for (const stage of stages) test(`${platform} ${stage} expiry drains the in-flight peer and stops new requests`, async () => {
    const network = fixture(platform, { onRequest: async call => {
      if (call.kind !== stage) return;
      if (call.id === 'synthetic-0') return new Response('', { status: 401 });
      await pause(30);
    } });
    await assert.rejects(createCollector({ now: () => NOW, fetchImpl: network.fetchImpl })({ platform }, cookie), { code: 'ACCOUNT_EXPIRED' });
    assert.equal(network.active.size, 0);
    assert.deepEqual(network.calls.filter(call => call.kind === stage).map(call => call.id), ['synthetic-0', 'synthetic-1']);
    if (stage === stages[0]) assert.equal(network.calls.filter(call => call.kind === stages[1]).length, 0);
  });

  test(`${platform} partial failures preserve known split history and never share another order's track`, async t => {
    const store = new Store({ key: Buffer.alloc(32, 4), now: () => NOW }); t.after(() => store.close());
    const account = store.saveAccount({ platform, label: '合成并发', cookie }, 'synthetic-account', true);
    const orders = ids(3).map(platformOrderId => ({ platformOrderId, title: '合成订单', orderDate: NOW - 86400000 }));
    store.importResult(account.id, { orders, shipments: orders.flatMap(({ platformOrderId }) => ['A', 'B'].map(prefix => ({
      platformOrderId, waybillNo: `${prefix}-${platformOrderId}`, status: 'transit', logisticsCheckedAt: NOW - 1000,
      logisticsEvents: [{ time: NOW - 2000, description: `old-${prefix}-${platformOrderId}` }], logisticsState: 'ok',
    }))) });
    const saved = store.snapshot([account.id]);
    const knownOrders = saved.orders.map(order => ({ ...order, orderDateOrigin: 'detail',
      shipments: saved.shipments.filter(parcel => parcel.orderId === order.id) }));
    const network = fixture(platform, { count: 3, onRequest: async ({ kind, id }) =>
      id === 'synthetic-0' && stages.includes(kind) ? new Response('', { status: 503 }) : undefined });
    const result = await createCollector({ now: () => NOW, fetchImpl: network.fetchImpl })({ platform }, cookie, { knownOrders });
    store.importResult(account.id, result);
    const updated = store.snapshot([account.id]).shipments;
    assert.equal(updated.length, 6);
    for (const parcel of updated) {
      const id = parcel.waybillNo.slice(2);
      assert.ok(parcel.logisticsEvents.some(event => event.description === `old-${parcel.waybillNo}`));
      assert.ok(parcel.logisticsEvents.every(event => event.description.includes(id)));
      if (parcel.waybillNo.startsWith('B-')) assert.equal(parcel.logisticsEvents.length, 1);
      if (parcel.waybillNo.startsWith('A-') && id !== 'synthetic-0') assert.ok(parcel.logisticsEvents.length > 1);
    }
    assert.equal(network.active.size, 0);
  });
}

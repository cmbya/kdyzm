import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, platformRequest } from '../src/collectors.mjs';
import { Store } from '../src/store.mjs';

const NOW = Date.parse('2026-11-08T12:00:00+08:00');
const cookie = 'pdd_user_id=SYNTHETIC; _m_h5_tk=SYNTHETIC_1794000000; thor=SYNTHETIC';
const reply = data => new Response(JSON.stringify(data));
const ids = count => Array.from({ length: count }, (_, index) => `order-${index}`);

function network(platform, { count = 27, listed = true, fail } = {}) {
  const calls = [], completed = [], accountIds = ids(count);
  let active = 0, maximum = 0;
  return { calls, completed, get maximum() { return maximum; }, fetchImpl: async (url, options) => {
    const target = new URL(url);
    let id, response;
    if (platform === 'pdd') {
      if (target.pathname.includes('order_list_v4')) return reply({ orders: listed && target.searchParams.get('type') === 'unreceived'
        ? accountIds.map(order_sn => ({ order_sn, order_status_text: '待收货', tracking_number: `A-${order_sn}`, order_time: NOW / 1000 })) : [], has_more: false });
      if (target.pathname.includes('/cabinet/')) return reply({ result: {} });
      id = target.pathname.split('/').at(-2);
      response = reply({ shipping: { tracking_number: `A-${id}`, traces: [{ info: `运输中 ${id}`, timestamp: NOW / 1000 }] } });
    } else if (platform === 'taobao') {
      if (target.hostname === 'h5api.m.taobao.com') {
        if (!target.searchParams.has('sign')) return reply({ ret: ['FAIL_SYS_TOKEN_EMPTY'] });
        if (options.method === 'POST') return reply({ ret: ['SUCCESS'], data: { data: {} } });
        const page = JSON.parse(target.searchParams.get('data')).page;
        return reply({ ret: ['SUCCESS'], data: { result: { mainOrders: listed && page === '1'
          ? accountIds.map(id => ({ id, createTime: NOW, statusInfo: { text: '待收货' } })) : [] } } });
      }
      id = target.searchParams.get('bizOrderId');
      if (target.hostname === 'pages-g.m.taobao.com') return new Response(`<script>window['__ICE_SUSPENSE_LOADER__']['undefined'] = ${JSON.stringify({ result: { data: { newLogistics: { fields: { mailNo: `A-${id}` } } } } })};</script>`);
      response = reply({ expressId: `A-${id}`, address: [{ place: `运输中 ${id}`, time: '2026-11-08 12:00:00' }] });
    } else {
      if (target.searchParams.get('functionId') === 'pcorder_center_list') return reply({ success: true, data: { totalNum: listed ? count : 0,
        orderList: listed ? accountIds.map(orderId => ({ orderId, dateSubmit: NOW, statusInfo: { orderStateName: '待收货' }, wareList: [{ name: '离线合成商品' }] })) : [] } });
      id = JSON.parse(target.searchParams.get('body')).orderId;
      response = reply({ code: 0, multiPackageTrackInfoList: [{ carriageInfo: { carriageId: `A-${id}` }, trackGroupInfo: {
        orderTrackShowList: [{ CreationTime: '2026-11-08 12:00:00', Content: `运输中 ${id}` }],
      } }] });
    }
    calls.push(id); active++; maximum = Math.max(maximum, active);
    try {
      const override = await fail?.(id, calls.length);
      await new Promise(resolve => setTimeout(resolve, 1));
      completed.push(id);
      return override || response;
    } finally { active--; }
  } };
}

for (const platform of ['taobao', 'pdd', 'jd']) {
  test(`${platform} saves independent results before all 27 orders finish`, async t => {
    const store = new Store({ key: Buffer.alloc(32, 5), now: () => NOW }); t.after(() => store.close());
    const account = store.saveAccount({ platform, label: '离线续查', cookie }, 'continuation', true);
    const fixture = network(platform), deltas = [];
    let firstComplete;
    const result = await createCollector({ now: () => NOW, fetchImpl: fixture.fetchImpl })(account, cookie, {
      onProgress(delta) {
        for (const field of ['orders', 'shipments', 'orderUpdates', 'logisticsFailures', 'warnings']) assert.ok(Array.isArray(delta[field]), field);
        assert.ok(!JSON.stringify(delta).includes('SYNTHETIC'));
        store.importResult(account.id, delta); deltas.push(delta);
        if (delta.shipments.some(parcel => parcel.logisticsState === 'ok')) {
          firstComplete ??= fixture.completed.length;
          assert.ok(store.snapshot([account.id]).shipments.some(parcel => parcel.logisticsEvents.length));
          assert.equal(new Set(delta.shipments.map(parcel => parcel.platformOrderId)).size, 1);
          assert.deepEqual(delta.orders, []);
        }
      },
    });
    assert.equal(result.shipments.length, 27);
    assert.equal(new Set(fixture.calls).size, 27);
    assert.ok(firstComplete < 27);
    assert.equal(deltas.reduce((count, delta) => count + delta.orders.length, 0), 27);
    assert.equal(store.snapshot([account.id]).shipments.length, 27);
    assert.equal(fixture.maximum, platform === 'jd' ? 1 : 2);
  });

  test(`${platform} also completes all 27 active orders absent from the current lists`, async () => {
    const fixture = network(platform, { listed: false });
    const knownOrders = ids(27).map(platformOrderId => ({ platformOrderId, orderDateOrigin: 'detail',
      shipments: [{ waybillNo: `A-${platformOrderId}`, status: 'transit' }] }));
    const result = await createCollector({ now: () => NOW, fetchImpl: fixture.fetchImpl })({ platform }, cookie, { knownOrders });
    assert.equal(result.orders.length, 0);
    assert.equal(result.shipments.length, 27);
    assert.equal(new Set(fixture.calls).size, 27);
  });

  test(`${platform} checkpoint replay reapplies complete serializable deltas without refetching logistics`, async () => {
    const fixture = network(platform, { count: 3 }), cache = new Map(), replayed = [];
    const runLogistics = async (items, worker, { stage, concurrency, key, onResult }) => {
      assert.equal(concurrency, platform === 'jd' ? 1 : 2);
      const results = [];
      for (const [index, item] of items.entries()) {
        const identity = `${stage}:${key(item)}`;
        if (!cache.has(identity)) cache.set(identity, JSON.parse(JSON.stringify(await worker(item))));
        const result = structuredClone(cache.get(identity));
        await onResult(result, item, index); results.push(result);
      }
      return results;
    };
    const collect = createCollector({ now: () => NOW, fetchImpl: fixture.fetchImpl });
    const first = await collect({ platform }, cookie, { runLogistics, durableLogistics: true });
    const requestCount = fixture.calls.length;
    const second = await collect({ platform }, cookie, { runLogistics, durableLogistics: true, onProgress: delta => replayed.push(delta) });
    assert.equal(fixture.calls.length, requestCount);
    assert.deepEqual(second, first);
    assert.equal(replayed.filter(delta => delta.shipments.some(parcel => parcel.logisticsState === 'ok')).length, 3);
  });

  for (const failure of [503, 'TimeoutError']) test(`${platform} durable workers expose ${failure} for retry and recover on the next attempt`, async () => {
    let failed = false, retried = 0;
    const fixture = network(platform, { count: 1, fail: () => {
      if (failed) return;
      failed = true;
      if (typeof failure === 'number') return new Response('', { status: failure });
      throw new DOMException('Synthetic timeout', failure);
    } });
    const runLogistics = async (items, worker, { onResult }) => {
      const results = [];
      for (const [index, item] of items.entries()) {
        let result;
        try { result = await worker(item); }
        catch (error) {
          assert.equal(typeof error.code === 'string' ? error.code : error.name, failure === 503 ? 'UPSTREAM_ERROR' : failure);
          retried++; result = await worker(item);
        }
        await onResult(result, item, index); results.push(result);
      }
      return results;
    };
    const result = await createCollector({ now: () => NOW, fetchImpl: fixture.fetchImpl })({ platform }, cookie, { runLogistics, durableLogistics: true });
    assert.equal(retried, 1);
    assert.equal(result.shipments[0].logisticsState, 'ok');
  });
}

test('Taobao starts PC tracking for a ready order while a peer SSR request is still pending', async () => {
  const fixture = network('taobao', { count: 2 });
  let release, pending = false, pipelined = false;
  const blocked = new Promise(resolve => { release = resolve; });
  const fetchImpl = async (url, options) => {
    const target = new URL(url), id = target.searchParams.get('bizOrderId');
    if (target.hostname === 'pages-g.m.taobao.com' && id === 'order-1') { pending = true; await blocked; pending = false; }
    if (target.hostname === 'buyertrade.taobao.com' && id === 'order-0') { pipelined = pending; release(); }
    return fixture.fetchImpl(url, options);
  };
  await createCollector({ now: () => NOW, fetchImpl })({ platform: 'taobao' }, cookie);
  assert.equal(pipelined, true);
});

test('rate limiting retains a bounded Retry-After delay for seconds and HTTP dates', async () => {
  for (const [header, lower, upper] of [['12', 12000, 12000], ['99999', 900000, 900000], [new Date(Date.now() + 60000).toUTCString(), 58000, 60000]]) {
    await assert.rejects(platformRequest('https://api.m.jd.com/api', cookie, {
      fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': header } }),
    }), error => error.code === 'UPSTREAM_RATE_LIMITED' && error.retryAfterMs >= lower && error.retryAfterMs <= upper);
  }
});

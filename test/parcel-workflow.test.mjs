import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createService } from '../src/service.mjs';
import { createCollector } from '../src/collectors.mjs';
import { serverVersion } from '../src/version.mjs';

const NOW = Date.parse('2026-10-31T12:00:00+08:00');
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const cookie = '_m_h5_tk=synthetic_99999';
const seed = { orders: [{ platformOrderId: 'one', orderDate: NOW - 86400000, title: '原订单' }, { platformOrderId: 'two', title: '其他订单' }],
  shipments: [{ platformOrderId: 'one', waybillNo: 'A', status: 'signed', logisticsState: 'ok', logisticsEvents: [{ time: NOW - 1000, description: '已有轨迹' }], logisticsCheckedAt: NOW - 1000 }], warnings: [] };

async function setup(t, collector = async () => ({ orders: [], shipments: [] })) {
  let current = NOW;
  const service = createService({ encryptionKey: randomBytes(32).toString('hex'), adminToken: randomBytes(32).toString('base64url'),
    now: () => current, scheduler: false, fixture: true, collector });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const account = service.store.saveAccount({ platform: 'taobao', label: 'A', cookie: 'SYNTHETIC' }, 'a', true);
  const other = service.store.saveAccount({ platform: 'taobao', label: 'B', cookie: 'SYNTHETIC' }, 'b', true);
  service.store.importResult(account.id, seed); service.store.importResult(other.id, seed);
  const device = service.store.redeem(service.store.createPairing([account.id]).code, '测试设备');
  const foreign = service.store.redeem(service.store.createPairing([other.id]).code, '其他设备');
  const order = service.store.snapshot([account.id]).orders.find(o => o.platformOrderId === 'one');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, { method = 'GET', body, token = device.token } = {}) => {
    const result = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, data: await result.json() };
  };
  return { service, account, other, device, foreign, order, request, base, advance: ms => { current += ms; } };
}

test('sync jobs expose scope, terminal states, capability/version and queue during cooldown instead of false completion', async t => {
  let calls = 0;
  const { service, account, request, base, advance } = await setup(t, async () => { calls++; return { orders: [], shipments: [] }; });
  const start = await request('/v1/accounts/sync', { method: 'POST', body: {} });
  assert.equal(start.status, 202); assert.equal(start.data.accepted, true); assert.equal(start.data.jobs.length, 1);
  await Promise.all([...service.running.values()]);
  const job = (await request('/v1/sync-jobs/' + start.data.jobs[0].id)).data.job;
  assert.equal(job.state, 'completed'); assert.equal(job.accountId, account.id); assert.equal(job.orderId, '');
  const blocked = (await request('/v1/accounts/sync', { method: 'POST', body: {} })).data.jobs[0];
  assert.equal(blocked.state, 'queued'); assert.equal(blocked.retryAt, NOW + 300000); assert.equal(calls, 1);
  assert.equal((await request('/v1/accounts/sync', { method: 'POST', body: {} })).data.jobs[0].id, blocked.id);
  const snapshot = (await request('/v1/snapshot')).data;
  assert.equal(snapshot.serverVersion, serverVersion); assert.ok(snapshot.capabilities.includes('orderRefresh'));
  assert.match(await (await fetch(base)).text(), new RegExp('取件助手 ' + serverVersion.replaceAll('.', '\\.')));
  advance(300000);
  service.store.saveAccount({ enabled: false }, account.id, true);
  assert.equal((await request('/v1/accounts/sync', { method: 'POST', body: {} })).data.jobs[0].state, 'disabled');
  assert.equal(calls, 1);
});

test('target refresh joins account sync and later standalone refresh filters unrelated records', async t => {
  let release, concurrent = 0, maximum = 0;
  const gate = new Promise(resolve => { release = resolve; }), calls = [];
  const { service, account, order, advance } = await setup(t, async (_account, _cookie, options) => {
    calls.push(options); maximum = Math.max(maximum, ++concurrent);
    if (!options.targetOrder) await gate;
    concurrent--;
    return options.targetOrder ? { orders: [{ platformOrderId: 'two', title: '必须过滤' }], orderUpdates: [{ platformOrderId: 'one', dateState: 'unavailable', dateError: '没有日期', dateCheckedAt: NOW + 300000 }],
      shipments: [{ platformOrderId: 'two', waybillNo: 'UNRELATED' }], logisticsFailures: [] } : { orders: [], shipments: [] };
  });
  const full = service.jobs.request(account.id);
  const targeted = service.jobs.request(account.id, order.id);
  assert.equal(targeted.job.parentJobId, full.job.id); assert.equal(service.jobs.request(account.id, order.id), targeted);
  release(); await full.done;
  await targeted.done; assert.equal(targeted.job.state, 'completed'); assert.equal(calls.length, 1);
  advance(300000); const standalone = service.jobs.request(account.id, order.id); await standalone.done;
  assert.equal(maximum, 1); assert.equal(calls.length, 2);
  assert.equal(calls[1].knownOrders.length, 1); assert.equal(calls[1].targetOrder.id, order.id);
  assert.equal(standalone.job.state, 'completed'); assert.equal(standalone.job.dateState, 'unavailable');
  const snapshot = service.store.snapshot([account.id]);
  assert.notEqual(snapshot.orders.find(o => o.platformOrderId === 'two').title, '必须过滤');
  assert.ok(!snapshot.shipments.some(s => s.waybillNo === 'UNRELATED'));
});

test('full-sync HTTP jobs expose structured partial failures without treating filter warnings as failures or copying raw errors', async t => {
  let result = { orders: [], shipments: [], orderUpdates: [{ platformOrderId: 'one', dateCheckedAt: NOW, dateState: 'error', dateError: 'PRIVATE upstream date response' }],
    logisticsFailures: [{ platformOrderId: 'one', waybillNo: 'A', state: 'error', logisticsCheckedAt: NOW }], warnings: ['订单筛选：跳过已结束订单'] };
  const { service, request, advance } = await setup(t, async () => result);
  const sync = async () => {
    const started = await request('/v1/accounts/sync', { method: 'POST', body: {} });
    assert.equal(started.status, 202);
    await Promise.all([...service.running.values()]);
    const completed = await request('/v1/sync-jobs/' + started.data.jobs[0].id);
    assert.equal(completed.status, 200); assert.equal(completed.data.job.state, 'completed'); assert.equal(completed.data.job.orderId, '');
    assert.ok(!JSON.stringify(completed.data.job).includes('PRIVATE'));
    return completed.data.job;
  };
  let job = await sync();
  assert.equal(job.dateState, 'error'); assert.equal(job.dateError, '部分订单日期补查失败，已保留原日期');
  assert.equal(job.logisticsState, 'error'); assert.equal(job.logisticsError, '部分运单物流查询失败，已保留原轨迹');
  assert.equal((await request('/v1/snapshot')).data.shipments[0].logisticsEvents.length, 1, 'partial failure retains the previous timeline');

  advance(300000);
  result = { orders: [], orderUpdates: [{ platformOrderId: 'one', dateState: 'ok', dateError: '', dateCheckedAt: NOW + 300000 }],
    shipments: [{ platformOrderId: 'one', waybillNo: 'A', logisticsState: 'ok', logisticsError: 'PRIVATE full track failed after SSR', logisticsCheckedAt: NOW + 300000 }], warnings: [] };
  job = await sync();
  assert.equal(job.dateState, 'ok'); assert.equal(job.dateError, '');
  assert.equal(job.logisticsState, 'error', 'successful SSR nodes do not mask a failed full-track query');
  assert.equal(job.logisticsError, '部分运单物流查询失败，已保留原轨迹');

  advance(300000);
  result = { orders: [], shipments: [], orderUpdates: [{ platformOrderId: 'one', dateState: 'unavailable', dateError: 'PRIVATE unsupported detail', dateCheckedAt: NOW + 600000 }],
    logisticsFailures: [{ platformOrderId: 'one', waybillNo: 'A', state: 'empty', logisticsCheckedAt: NOW + 600000 }], warnings: [] };
  job = await sync();
  assert.equal(job.dateState, 'unavailable'); assert.ok(job.dateError);
  assert.equal(job.logisticsState, 'empty'); assert.ok(job.logisticsError);

  advance(300000);
  result = { orders: [], shipments: [], warnings: ['订单筛选：跳过已结束订单', 'PRIVATE ordinary warning'] };
  job = await sync();
  assert.equal(job.error, ''); assert.equal(job.dateError, undefined); assert.equal(job.logisticsError, undefined);
  assert.equal(job.dateState, undefined); assert.equal(job.logisticsState, undefined);
});

test('order refresh and job reads enforce device scope and errors never echo upstream secrets', async t => {
  const { service, account, order, foreign, request, advance } = await setup(t, async () => { throw Object.assign(new Error('Cookie=SENSITIVE upstream body'), { code: 'ACCOUNT_EXPIRED' }); });
  const url = `/v1/orders/${order.id}/refresh`;
  assert.equal((await request(url, { method: 'POST', body: {}, token: foreign.token })).status, 403);
  assert.equal((await request(url, { method: 'POST', body: { platformOrderId: 'injected' } })).status, 400);
  const start = await request(url, { method: 'POST', body: {} });
  await Promise.all([...service.running.values()]);
  const path = '/v1/sync-jobs/' + start.data.jobs[0].id;
  assert.equal((await request(path, { token: foreign.token })).status, 403);
  const job = (await request(path)).data.job;
  assert.equal(job.state, 'expired'); assert.ok(!JSON.stringify(job).includes('SENSITIVE'));
  advance(300000); service.store.saveAccount({ enabled: false }, account.id, true);
  assert.equal((await request(url, { method: 'POST', body: {} })).data.jobs[0].state, 'disabled');
});

test('date overrides are authorized, idempotent, calendar-valid and survive platform corrections; stale offline operations are acknowledged without rollback', async t => {
  const { service, order, request, foreign } = await setup(t);
  const operation = { id: 'date-1', orderId: order.id, action: 'setOrderDate', date: '2026-10-20', occurredAt: NOW };
  const post = operations => request('/v1/operations', { method: 'POST', body: { operations } });
  assert.equal((await request('/v1/operations', { method: 'POST', body: { operations: [operation] }, token: foreign.token })).status, 403);
  assert.equal((await post([{ ...operation, date: '2026-02-29' }])).status, 400);
  assert.equal((await post([operation])).status, 200);
  const revision = service.store.snapshot(['a']).serverRevision;
  assert.equal((await post([operation])).status, 200); assert.equal(service.store.snapshot(['a']).serverRevision, revision);
  assert.equal((await post([{ ...operation, date: null }])).status, 409);
  service.store.importResult('a', { orders: [{ platformOrderId: 'one', orderDate: NOW - 3 * 86400000, orderDateOrigin: 'detail', dateCheckedAt: NOW, dateState: 'ok', dateError: '' }], shipments: [] });
  let saved = service.store.order(order.id);
  assert.equal(saved.dateOverride, '2026-10-20'); assert.equal(saved.orderDate, NOW - 3 * 86400000);
  assert.equal((await post([{ ...operation, id: 'restore-new', date: null, occurredAt: NOW + 1000 }])).status, 200);
  const beforeStale = service.store.snapshot(['a']).serverRevision;
  assert.equal((await post([{ ...operation, id: 'stale-offline', occurredAt: NOW - 1000 }])).status, 200);
  assert.ok(service.store.snapshot(['a']).serverRevision > beforeStale, 'a new revision lets the client replace its optimistic offline date after acknowledgement');
  saved = service.store.order(order.id);
  assert.equal(saved.dateOverride, null); assert.equal(saved.dateOverrideAt, NOW + 1000);
  assert.equal((await request('/v1/operations/stale-offline')).data.status, 'superseded');
  const foreignOrder = service.store.snapshot(['b']).orders[0];
  assert.equal((await post([{ ...operation, id: 'rollback', occurredAt: NOW + 2000 }, { ...operation, id: 'denied', orderId: foreignOrder.id }])).status, 403);
  assert.equal(service.store.order(order.id).dateOverride, null);
});

test('Taobao targeted refresh bypasses date cooldown, does not read order lists and recovers PC track when SSR fails', async () => {
  const paths = [];
  const targetOrder = { platformOrderId: 'one', orderDateOrigin: 'detail', dateCheckedAt: NOW - 1,
    shipments: [{ waybillNo: 'A', status: 'signed', picked: true }] };
  const collect = createCollector({ now: () => NOW, fetchImpl: async (url, options) => {
    const target = new URL(url); paths.push(target.pathname);
    if (target.hostname === 'pages-g.m.taobao.com') return new Response('unavailable', { status: 503 });
    if (target.hostname === 'buyertrade.taobao.com') {
      assert.equal(target.searchParams.get('bizOrderId'), 'one');
      return response({ expressId: 'A', address: [{ place: '已签收', time: '2026-10-30 09:00:00' }] });
    }
    assert.ok(target.pathname.includes('query.detailv2'));
    if (!target.searchParams.has('sign')) return response({ ret: ['FAIL_SYS_TOKEN_EMPTY'] });
    assert.equal(JSON.parse(new URLSearchParams(options.body).get('data')).bizOrderId, 'one');
    return response({ ret: ['SUCCESS'], data: { data: { orderInfo: { fields: { labels: [{ name: '创建时间', value: '2026-10-20 09:00:00' }] } } } } });
  } });
  const result = await collect({ platform: 'taobao' }, cookie, { targetOrder, knownOrders: [{ platformOrderId: 'must-not-query' }] });
  assert.equal(result.orderUpdates[0].dateState, 'ok'); assert.equal(result.orderUpdates[0].orderDateOrigin, 'detail');
  assert.ok(!paths.some(path => path.includes('boughtlist'))); assert.equal(result.shipments.length, 1);
  assert.equal(result.shipments[0].logisticsState, 'ok'); assert.equal(result.shipments[0].logisticsEvents.length, 1);
  assert.equal(result.logisticsFailures.length, 0);
});

test('Taobao targeted date errors and empty creation labels remain explicit without replacing a trusted date', async () => {
  for (const [body, expected] of [[{ ret: ['FAIL_SYS_USER_VALIDATE'] }, 'error'], [{ ret: ['SUCCESS'], data: { data: {} } }, 'empty']]) {
    const result = await createCollector({ now: () => NOW, fetchImpl: async url => {
      const target = new URL(url);
      if (target.hostname === 'pages-g.m.taobao.com') return new Response('empty');
      if (target.hostname === 'buyertrade.taobao.com') return response({ expressId: '', address: [] });
      return response(body);
    } })({ platform: 'taobao' }, cookie, { targetOrder: { platformOrderId: 'one', orderDateOrigin: 'detail', orderDate: NOW - 86400000, shipments: [] } });
    assert.equal(result.orderUpdates[0].dateState, expected); assert.equal(result.orderUpdates[0].dateCheckedAt, NOW);
    assert.equal(result.orderUpdates[0].orderDate, undefined); assert.ok(result.orderUpdates[0].dateError);
  }
});

test('PDD targeted refresh queries only the stored order shipping, reports unsupported dates and retains failures for orders without waybills', async () => {
  const paths = [];
  const targetOrder = { platformOrderId: 'one', shipments: [{ waybillNo: 'A', status: 'arrived' }, { waybillNo: 'B', status: 'transit' }] };
  const result = await createCollector({ now: () => NOW, fetchImpl: async url => {
    const target = new URL(url); paths.push(target.pathname);
    assert.equal(target.searchParams.get('query_type'), '2');
    return response({ shipping: { tracking_number: 'A', traces: [{ info: '运输中', timestamp: NOW / 1000 }] } });
  } })({ platform: 'pdd' }, 'pdd_user_id=synthetic', { targetOrder });
  assert.deepEqual(paths, ['/proxy/api/order/one/shipping']);
  assert.equal(result.orderUpdates[0].dateState, 'unavailable'); assert.ok(result.orderUpdates[0].dateError);
  assert.equal(result.shipments[0].logisticsEvents.length, 1); assert.equal(result.shipments[1].logisticsEvents, undefined);
  assert.equal(result.logisticsFailures[0].waybillNo, 'B');
  const failed = await createCollector({ now: () => NOW, fetchImpl: async () => new Response('unavailable', { status: 503 }) })(
    { platform: 'pdd' }, 'pdd_user_id=synthetic', { targetOrder: { platformOrderId: 'one', shipments: [] } });
  assert.equal(failed.logisticsFailures[0].state, 'error');
});

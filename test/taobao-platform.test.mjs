import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCollector, taobaoParcels } from '../src/collectors.mjs';
import { Store } from '../src/store.mjs';

const capture = JSON.parse(readFileSync(new URL('../fixtures/taobao-collected.json', import.meta.url)));
const NOW = Date.parse('2026-11-10T01:00:00+08:00');
const COMPLETED = Date.parse('2026-11-10T00:34:30+08:00');
const ARRIVED = Date.parse('2026-11-09T17:59:37+08:00');
const target = { platformOrderId: 'synthetic-order', orderDate: Date.parse('2026-11-06T12:20:09+08:00'),
  orderDateOrigin: 'detail', orderDatePrecision: 'second', shipments: [{ waybillNo: 'SYNTHETIC-TB-86', carrier: '申通快递', status: 'arrived' }] };
const reply = data => new Response(JSON.stringify(data).replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
async function collect({ fields = capture.fields, transit = capture.transit, order = target, calls = [], full = false } = {}) {
  return createCollector({ now: () => NOW, fetchImpl: async url => {
    const u = new URL(url); calls.push(u.hostname);
    if (u.hostname === 'pages-g.m.taobao.com') return new Response(`<script>window['__ICE_SUSPENSE_LOADER__']['undefined'] = ${JSON.stringify({ result: { data: { newLogistics: { fields } } } })};</script>`);
    if (u.hostname === 'buyertrade.taobao.com') return reply(transit);
    if (u.searchParams.has('data')) return reply({ ret: ['SUCCESS'], data: { result: { mainOrders: JSON.parse(u.searchParams.get('data')).page === '1'
      ? [{ id: order.platformOrderId, statusInfo: { text: '待收货' }, createTime: '2026-11-06 12:20:09' }] : [] } } });
    return reply({ ret: ['SUCCESS'], data: { data: {} } });
  } })({ platform: 'taobao' }, '_m_h5_tk=SYNTHETIC_1794240000', full ? { knownOrders: [order] } : { targetOrder: order });
}

test('real Taobao collected stage gets a time only from its own unique full-track minute', async () => {
  const result = await collect(), parcel = result.shipments[0];
  const taken = parcel.logisticsEvents.find(e => e.description.includes('取出'));
  assert.equal(taken.time, COMPLETED);
  assert.equal(taken.timeText, '11-10 00:34');
  assert.equal(taken.timePrecision, 'minute');
  assert.equal(taken.provider, 'taobao');
  assert.equal(taken.providerStatus, 'doing');
  assert.equal(taken.providerStatusTag, '已签收');
  assert.equal(taken.providerStatusText, '包裹已从代收点取出');
  assert.equal(parcel.logisticsEvents.find(e => e.description.startsWith('待取件：')).time, ARRIVED);
});

test('refresh repairs stored undated Taobao duplicates and completes the actual shipment', async t => {
  const store = new Store({ key: Buffer.alloc(32, 8), now: () => NOW }); t.after(() => store.close());
  store.saveAccount({ platform: 'taobao', label: '合成淘宝', cookie: 'SYNTHETIC' }, 'a', true);
  const legacy = taobaoParcels(capture.fields, target.platformOrderId)[0];
  legacy.logisticsEvents = legacy.logisticsEvents.map(({ time, timeText, description, location, timePrecision }) => ({ time, timeText, description, location, timePrecision }));
  legacy.logisticsEvents.push({ time: 0, timeText: '11-09 17:59', description: '历史摘要：请及时取件' });
  store.importResult('a', { orders: [target], shipments: [{ ...legacy, arrivalAt: ARRIVED, arrivalAtSource: 'platform_event', logisticsCheckedAt: NOW - 1000 }] });
  assert.equal(store.snapshot(['a']).shipments[0].picked, false);
  store.importResult('a', await collect());
  const saved = store.snapshot(['a']).shipments[0];
  assert.equal(saved.picked, true);
  assert.equal(saved.pickupCompletion.completedAt, COMPLETED);
  assert.ok(saved.logisticsEvents.every(e => e.time > 0));
  assert.equal(saved.logisticsEvents.filter(e => e.description.includes('取出')).length, 1);
});

test('unmatched, ambiguous, future or other-waybill timestamps never date a Taobao collection', async () => {
  for (const transit of [
    { ...capture.transit, address: [] },
    { ...capture.transit, expressId: 'OTHER' },
    { ...capture.transit, address: [{ place: '派送中', time: '2026-11-10 00:34:30' }] },
    { ...capture.transit, address: [{ place: '签收', time: '2027-11-10 00:34:30' }] },
    { ...capture.transit, address: [...capture.transit.address, { place: '派送中', time: '2026-11-10 00:34:45' }] },
  ]) {
    const result = await collect({ transit });
    assert.equal(result.shipments[0].logisticsEvents.find(e => e.description.includes('取出')).time, 0);
  }
});

test('Taobao matches a year boundary from the full track without assuming the current year', async () => {
  const fields = structuredClone(capture.fields); fields.multiStage = [fields.multiStage[0]]; fields.multiStage[0].subtitle = '12-31 23:59';
  const result = await collect({ fields, order: { ...target, orderDate: Date.parse('2025-12-30T00:00:00+08:00') },
    transit: { ...capture.transit, address: [{ place: '签收', time: '2025-12-31 23:59:25' }] } });
  assert.equal(result.shipments[0].logisticsEvents.find(e => e.description.includes('取出')).time, Date.parse('2025-12-31T23:59:25+08:00'));
});

test('Taobao never resolves completion before a verified order date or across two possible years', async () => {
  const transit = { ...capture.transit, address: [{ place: '签收', time: '2025-11-10 00:34:30' }] };
  assert.equal((await collect({ transit })).shipments[0].logisticsEvents.find(e => e.description.includes('取出')).time, 0);
  assert.equal((await collect({ transit, full: true })).shipments[0].logisticsEvents.find(e => e.description.includes('取出')).time, 0);
  transit.address.push(...capture.transit.address);
  const ambiguous = await collect({ transit, order: { ...target, orderDateOrigin: 'list' } });
  assert.equal(ambiguous.shipments[0].logisticsEvents.find(e => e.description.includes('取出')).time, 0);
});

test('failed or stale Taobao refreshes keep legacy unknown-time conflicts unresolved', async t => {
  const fresh = await collect();
  for (const mode of ['failed', 'stale', 'other-platform']) {
    const store = new Store({ key: Buffer.alloc(32, 8), now: () => NOW }); t.after(() => store.close());
    store.saveAccount({ platform: mode === 'other-platform' ? 'pdd' : 'taobao', label: '合成', cookie: 'SYNTHETIC' }, 'a', true);
    store.importResult('a', { orders: [target], shipments: [{ platformOrderId: target.platformOrderId, waybillNo: 'SYNTHETIC-TB-86', carrier: '申通快递',
      status: 'arrived', logisticsCheckedAt: NOW, logisticsState: 'ok', logisticsEvents: [{ time: 0, timeText: '11-09 17:59', description: '旧摘要：请及时取件' }] }] });
    const result = structuredClone(fresh);
    result.shipments[0].logisticsCheckedAt = mode === 'stale' ? NOW - 1000 : NOW;
    if (mode === 'failed') result.shipments[0].logisticsState = 'error';
    store.importResult('a', result);
    const saved = store.snapshot(['a']).shipments[0];
    assert.equal(saved.logisticsEvents.find(e => e.description.startsWith('旧摘要')).time, 0, mode);
    assert.equal(saved.picked, false, mode);
  }
});

test('refreshing verified Taobao logistics skips redundant token and immutable order-date requests', async () => {
  const calls = []; await collect({ calls });
  assert.deepEqual(calls, ['pages-g.m.taobao.com', 'buyertrade.taobao.com']);
  const missingCalls = []; await collect({ calls: missingCalls, order: { ...target, orderDateOrigin: 'list' } });
  assert.equal(missingCalls.filter(host => host === 'h5api.m.taobao.com').length, 2);
});

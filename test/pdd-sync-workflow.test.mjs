import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { createCollector } from '../src/collectors.mjs';
import { createSyncJobs } from '../src/sync-jobs.mjs';

test('PDD pending orders reach the snapshot, become the same shipped order, and survive a later list failure', async t => {
  let clock = Date.parse('2026-10-31T12:00:00+08:00'), phase = 'pending';
  const store = new Store({ key: randomBytes(32), now: () => clock });
  const account = store.saveAccount({ platform: 'pdd', label: '模拟订单', cookie: 'pdd_user_id=fixture' }, 'a', true);
  const reply = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  const collector = createCollector({ now: () => clock, fetchImpl: async url => {
    const target = new URL(url), type = target.searchParams.get('type');
    if (target.pathname.includes('order_list_v4')) {
      if (phase === 'failure' && type === 'unreceived') return new Response('failed fixture', { status: 503 });
      const match = type === (phase === 'shipped' ? 'unreceived' : 'unshipping');
      return reply({ has_more: false, orders: match ? [{ order_sn: 'stable-order', order_time: (clock - 86400000) / 1000,
        ...(phase === 'shipped' ? { tracking_number: 'STABLE-WAYBILL' } : {}) }] : [] });
    }
    if (target.pathname.includes('/cabinet/')) return reply({ result: {} });
    return reply({ shipping: { tracking_number: 'STABLE-WAYBILL', traces: [{ info: '运输中', timestamp: clock / 1000 }] } });
  } });
  const jobs = createSyncJobs({ store, collector, now: () => clock });
  t.after(async () => { await jobs.close(); store.close(); });
  await jobs.request(account.id).done;
  const first = store.snapshot([account.id]);
  assert.equal(first.orders.length, 1); assert.equal(first.shipments.length, 0);
  assert.equal(first.orders[0].orderStatus, '待发货');
  phase = 'shipped'; clock += 300000;
  await jobs.request(account.id).done;
  const shipped = store.snapshot([account.id]);
  assert.equal(shipped.orders.length, 1); assert.equal(shipped.orders[0].id, first.orders[0].id);
  assert.equal(shipped.orders[0].orderStatus, '待收货'); assert.equal(shipped.shipments.length, 1);
  const lastSuccessAt = store.account(account.id).lastSuccessAt;
  phase = 'failure'; clock += 300000;
  const failed = await jobs.request(account.id).done;
  assert.equal(failed.state, 'error'); assert.equal(store.account(account.id).lastSuccessAt, lastSuccessAt);
  const retained = store.snapshot([account.id]);
  assert.deepEqual(retained.orders, shipped.orders); assert.deepEqual(retained.shipments, shipped.shipments);
});

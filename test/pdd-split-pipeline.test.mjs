import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { createSyncJobs } from '../src/sync-jobs.mjs';
import { createCollector } from '../src/collectors.mjs';

const NOW = 1_800_000_000_000;
const reply = data => new Response(JSON.stringify(data));
const jump = (order, waybill) => `https://mobile.yangkeduo.com/goods_express.html?order_sn=${order}&tracking_number=${waybill}&shipping_id=4`;

for (const mismatched of [false, true]) test(`verified split parcels keep separate tracks through durable import (mismatch=${mismatched})`, async t => {
  let active = 0, maximum = 0;
  const requests = [];
  const fetchImpl = async url => {
    const target = new URL(url); requests.push(target.pathname);
    if (target.pathname.includes('order_list_v4')) return reply({ orders: target.searchParams.get('type') === 'unreceived'
      ? [{ order_sn: 'fixture-order', tracking_number: 'WB111111', shipping_name: '中通快递', order_status_text: '待收货' }] : [], has_more: false });
    if (target.pathname.includes('/cabinet/')) return reply({ result: {} });
    active++; maximum = Math.max(maximum, active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      if (target.pathname.endsWith('/shipping')) return reply({ shipping: { tracking_number: 'WB111111',
        package_info_jump_url: jump('fixture-order', 'WB111111'), traces: [{ timestamp: NOW / 1000, info: '运单一运输中' }] } });
      if (target.pathname.endsWith('/split/pack')) return reply({ result: { list: ['WB111111', 'WB222222'].map(tracking_number => ({
        tracking_number, shipping_id: 4, shipping_name: '中通快递', jump_url: jump('fixture-order', tracking_number),
      })) } });
      if (target.pathname.endsWith('/shipping/track')) {
        assert.equal(target.searchParams.get('tracking_number'), 'WB222222');
        assert.equal(target.searchParams.get('query_type'), '2');
        return reply({ shipping: { tracking_number: mismatched ? 'WB111111' : 'WB222222',
          traces: [{ timestamp: NOW / 1000, info: '运单二已入库等待取件', status: 'IN_CABINET', status_tag: '待取件', sub_status: 'IN_CABINET_401' }] } });
      }
      throw new Error('Unexpected synthetic endpoint');
    } finally { active--; }
  };
  const store = new Store({ key: Buffer.alloc(32, 9), now: () => NOW });
  const account = store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'pdd_user_id=fixture' }, 'fixture', true);
  const jobs = createSyncJobs({ store, now: () => NOW, collector: createCollector({ now: () => NOW, fetchImpl }) });
  t.after(async () => { await jobs.close(); store.close(); });
  const result = await jobs.request(account.id).done;
  assert.equal(result.state, 'completed');
  const snapshot = store.snapshot([account.id]);
  assert.equal(snapshot.orders.length, 1);
  assert.equal(snapshot.shipments.length, mismatched ? 1 : 2);
  assert.match(snapshot.shipments.find(p => p.waybillNo === 'WB111111').logisticsEvents[0].description, /运单一/);
  if (!mismatched) {
    const second = snapshot.shipments.find(p => p.waybillNo === 'WB222222');
    assert.match(second.logisticsEvents[0].description, /运单二/);
    assert.equal(second.logisticsEvents[0].providerStatus, 'IN_CABINET');
    assert.equal(second.pickupCompletion.autoPicked, false);
  } else assert.equal(result.logisticsState, 'unavailable');
  assert.equal(requests.filter(path => path.endsWith('/shipping/track')).length, 1);
  assert.ok(maximum <= 2);
});

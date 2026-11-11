import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';

const NOW = 1_800_000_000_000, ADMIN = 'collection-orders-admin-secret-32-characters';
test('admin collection details retain this run across restart, isolate accounts, include split parcels and choose newest event', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'collection-details-'));
  let now = NOW, empty = false, service;
  const open = () => createService({ filename: join(dir, 'state.db'), encryptionKey: 'ab'.repeat(32),
    adminToken: ADMIN, scheduler: false, now: () => now, collector: async (_a, _c, options) => {
      if (empty) return { orders: [], shipments: [] };
      options.onProgress({ orders: ['one', 'two', 'three', 'four'].map(platformOrderId => ({ platformOrderId, title: `商品 ${platformOrderId}` })), shipments: [] });
      return { orders: [], orderUpdates: [{ platformOrderId: 'old', title: '只更新历史' }], shipments: [
        { platformOrderId: 'one', waybillNo: 'TRACK-A', carrier: '中通', logisticsState: 'ok', logisticsEvents: [
          { time: NOW - 2000, description: '旧轨迹' }, { time: NOW - 1000, description: '最新轨迹' }
        ] },
        { platformOrderId: 'one', waybillNo: 'TRACK-B', carrier: '中通', logisticsState: 'empty' }
      ] };
    } });
  const start = async () => { service = open(); await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve)); };
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  await start();
  const account = service.store.saveAccount({ platform: 'taobao', label: '测试', cookie: 'unb=12345678; cookie2=SECRET' });
  const other = service.store.saveAccount({ platform: 'taobao', label: '其他', cookie: 'unb=87654321; cookie2=OTHER' });
  service.store.importResult(account.id, { orders: [{ platformOrderId: 'old', title: '历史商品' }], shipments: [] });
  service.store.importResult(other.id, { orders: [{ platformOrderId: 'one', title: '其他账号商品' }], shipments: [] });
  const done = await service.jobs.request(account.id).done;
  assert.equal(done.state, 'completed');
  const get = async (authorized = true) => fetch(`http://127.0.0.1:${service.server.address().port}/v1/admin/accounts`, { headers: authorized ? { 'X-Admin-Token': ADMIN } : {} });
  assert.equal((await get(false)).status, 401);
  const read = async () => (await (await get()).json()).accounts.find(a => a.id === account.id).syncJob;
  const detail = await read();
  assert.equal(detail.orders.length, 4);
  assert.deepEqual(new Set(detail.orders.map(o => o.title)), new Set(['商品 one', '商品 two', '商品 three', '商品 four']));
  const parcels = detail.orders.find(o => o.platformOrderId === 'one').shipments;
  assert.equal(parcels.length, 2);
  assert.equal(parcels.find(p => p.waybillNo === 'TRACK-A').latestEvent.description, '最新轨迹');
  assert.equal(parcels.find(p => p.waybillNo === 'TRACK-B').latestEvent, null);
  assert.deepEqual(detail.orders.find(o => o.platformOrderId === 'two').shipments, []);
  assert.equal(JSON.stringify(detail).includes('SECRET'), false);
  assert.equal(service.jobs.latest(account.id).orders, undefined, 'product data is added only to the admin response');
  await service.close(); await start();
  assert.deepEqual((await read()).orders, detail.orders);
  const stored = service.store.db.prepare('SELECT id,data FROM shipments WHERE account_id=?').all(account.id);
  for (const row of stored) {
    const parcel = JSON.parse(row.data);
    parcel.status = parcel.waybillNo === 'TRACK-A' ? 'signed' : 'arrived';
    service.store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(parcel), row.id);
  }
  assert.deepEqual((await read()).orders.find(o => o.platformOrderId === 'one').shipments.map(p => p.waybillNo), ['TRACK-B'], 'split order keeps its uncollected parcel');
  for (const row of stored) {
    const parcel = JSON.parse(row.data);
    parcel.status = 'arrived';
    parcel.logisticsEvents = [{ time: NOW, description: '已签收，签收人凭取货码签收。丰巢柜【自提柜】' }];
    service.store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(parcel), row.id);
  }
  assert.equal((await read()).orders.some(o => o.platformOrderId === 'one'), false);
  assert.equal(service.store.snapshot([account.id]).shipments.length, 2, 'hidden completed parcels remain in history');
  service.store.importResult(account.id, { orders: [], shipments: [], orderUpdates: [{ platformOrderId: 'two', fulfillmentType: 'local_delivery' }] });
  assert.equal((await read()).orders.some(o => o.platformOrderId === 'two'), false);
  now += 300000; empty = true;
  await service.jobs.request(account.id).done;
  assert.deepEqual((await read()).orders, [], 'a new empty run must not show old collected products');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { createService } from '../src/service.mjs';

const now = Date.parse('2026-10-31T10:00:00+08:00');
const realDate = now - 10 * 86400000;
const input = { platformOrderId: 'fixture-order', title: '测试日用品', orderDate: 0, tradeStatus: 'WAIT_SELLER_SEND_GOODS', orderStatus: '待发货' };
function fixture(t) {
  const store = new Store({ key: Buffer.alloc(32, 1), now: () => now });
  t.after(() => store.close());
  const account = store.saveAccount({ platform: 'taobao', label: '测试账号', cookie: 'SYNTHETIC' }, 'fixture', true);
  const sync = (orders, extra = {}) => {
    store.importResult(account.id, { orders, shipments: [], ...extra });
    return store.snapshot([account.id]);
  };
  return { store, account, sync };
}

test('missing order date stays unknown, later verified date replaces it and then stays stable', t => {
  const { sync } = fixture(t);
  let order = sync([input]).orders[0];
  assert.equal(order.orderDate, 0);
  assert.equal(order.orderDateSource, 'unknown');
  assert.equal(order.firstSeenAt, now);
  order = sync([{ ...input, orderDate: realDate }]).orders[0];
  assert.equal(order.orderDate, realDate);
  assert.equal(order.orderDateSource, 'platform');
  assert.equal(sync([{ ...input, orderDate: now }]).orders[0].orderDate, realDate);
  assert.equal(sync([input]).orders[0].orderDate, realDate);
});

test('old stored dates remain recoverable but unverified until a real platform date arrives', t => {
  const { store, sync } = fixture(t);
  const old = sync([input]).orders[0];
  delete old.orderDateSource; delete old.firstSeenAt;
  old.orderDate = now;
  store.db.prepare('UPDATE orders SET data=? WHERE id=?').run(JSON.stringify(old), old.id);
  let order = sync([]).orders[0];
  assert.equal(order.orderDate, now);
  assert.equal(order.orderDateSource, 'legacy');
  assert.equal(order.firstSeenAt, 0);
  order = sync([{ ...input, orderDate: realDate }]).orders[0];
  assert.equal(order.orderDate, realDate);
  assert.equal(order.orderDateSource, 'platform');
});

test('filtered terminal orders only refresh existing history and never create or erase records', t => {
  const { sync } = fixture(t);
  const before = sync([input]);
  const terminal = { ...input, tradeStatus: 'TRADE_FINISHED', orderStatus: '交易成功' };
  const after = sync([], { orderUpdates: [terminal, { ...terminal, platformOrderId: 'unrelated-history' }] });
  assert.equal(after.orders.length, 1);
  assert.equal(after.orders[0].id, before.orders[0].id);
  assert.equal(after.orders[0].tradeStatus, 'TRADE_FINISHED');
  assert.equal(after.orders[0].orderStatus, '交易成功');
  assert.equal(sync([]).orders.length, 1);
  assert.deepEqual(after.deletedIds, []);
});

test('sync tracks only same-account active unpicked shipments for terminal logistics refresh', async t => {
  let options;
  const service = createService({ encryptionKey: randomBytes(32).toString('hex'), adminToken: randomBytes(32).toString('hex'),
    now: () => now, scheduler: false, collector: async (_account, _cookie, context) => {
      options = context; return { orders: [], shipments: [] };
    } });
  t.after(() => service.close());
  const a = service.store.saveAccount({ platform: 'taobao', label: 'A', cookie: 'SYNTHETIC' }, 'a', true);
  const b = service.store.saveAccount({ platform: 'taobao', label: 'B', cookie: 'SYNTHETIC' }, 'b', true);
  const ids = ['active', 'picked', 'hidden', 'signed', 'deleted', 'no-waybill'];
  const result = { orders: ids.map(platformOrderId => ({ ...input, platformOrderId })),
    shipments: ids.slice(0, -1).map(platformOrderId => ({ platformOrderId, waybillNo: platformOrderId, status: platformOrderId === 'signed' ? 'signed' : 'arrived' })) };
  service.store.importResult(a.id, result); service.store.importResult(b.id, result);
  for (const s of service.store.snapshot([a.id]).shipments) {
    if (['picked', 'hidden', 'deleted'].includes(s.waybillNo)) {
      s[s.waybillNo] = true;
      service.store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(s), s.id);
    }
  }
  await service.requestSync(a.id);
  assert.deepEqual(options.trackedOrderIds, ['active']);
});

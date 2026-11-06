import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { createService } from '../src/service.mjs';

const NOW = Date.parse('2026-11-07T12:00:00+08:00');
const KEY = Buffer.alloc(32, 9);

function fixture(t, { now = NOW } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'order-retention-'));
  const filename = join(directory, 'store.sqlite');
  let clock = now;
  const store = new Store({ filename, key: KEY, now: () => clock });
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const account = store.saveAccount({ platform: 'taobao', label: '测试账号', cookie: 'FIXTURE' }, 'account-a', true);
  const pair = store.createPairing({ accountIds: [account.id] });
  const device = store.device(store.redeem(pair.code, '测试设备').token);
  return { store, account, device, filename, setTime: value => { clock = value; } };
}

function importOrder(store, accountId, platformOrderId, orderDate, status = 'transit', extra = {}) {
  store.importResult(accountId, { orders: [{ platformOrderId, title: platformOrderId, orderDate, ...extra }], shipments: [{
    platformOrderId, waybillNo: `${platformOrderId}-waybill`, carrier: 'ZTO', status, logisticsState: 'ok', logisticsCheckedAt: NOW,
  }] });
}

test('retention capability archives after 31 China calendar days and projects signed receipts without mutating source facts', t => {
  const { store, account, device } = fixture(t);
  const oldDate = Date.parse('2026-10-07T12:00:00+08:00');
  importOrder(store, account.id, 'signed', oldDate, 'signed');
  importOrder(store, account.id, 'transit', oldDate, 'transit');
  const before = store.snapshot(device);
  assert.ok(before.capabilities.includes('order_retention_v1'));
  assert.equal(before.orders.every(order => order.archived), true);
  assert.equal(before.orders[0].retention.version, 1);
  assert.equal(before.orders[0].retention.anchorSource, 'order_date');
  assert.equal(before.orders[0].retention.anchorDate, '2026-10-07');
  assert.equal(before.orders[0].retention.archivedAt, Date.parse('2026-11-07T00:00:00+08:00'));
  const signed = before.shipments.find(shipment => shipment.status === 'signed');
  const transit = before.shipments.find(shipment => shipment.status === 'transit');
  assert.equal(signed.picked, true);
  assert.equal(signed.pickupPicked, false);
  assert.equal(signed.receiptState, 'expired_signed');
  assert.equal(signed.receiptLabel, '超期自动确认收到');
  assert.equal(transit.picked, false);
  assert.equal(transit.receiptState, undefined);
  assert.equal(store.shipment(signed.id).picked, false);
  const pickedRaw = store.shipment(signed.id); pickedRaw.picked = true;
  store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(pickedRaw), pickedRaw.id);
  const picked = store.snapshot(device).shipments.find(shipment => shipment.id === signed.id);
  assert.equal(picked.receiptState, 'picked');
  assert.equal(picked.pickupPicked, true);
  assert.equal(picked.receiptLabel, undefined);
});

test('30 days stays active, missing and legacy dates use firstSeenAt, and return statuses do not get a signed receipt', t => {
  const { store, account, device } = fixture(t);
  const thirty = Date.parse('2026-10-08T12:00:00+08:00');
  importOrder(store, account.id, 'thirty', thirty, 'signed');
  importOrder(store, account.id, 'missing', 0, 'signed');
  importOrder(store, account.id, 'legacy', 0, 'signed');
  const missing = store.order(store.snapshot(device).orders.find(order => order.platformOrderId === 'missing').id);
  const legacy = store.order(store.snapshot(device).orders.find(order => order.platformOrderId === 'legacy').id);
  for (const order of [missing, legacy]) {
    order.orderDate = 0; order.orderDateSource = order.platformOrderId === 'legacy' ? 'legacy' : 'unknown'; order.firstSeenAt = Date.parse('2026-10-07T12:00:00+08:00');
    store.db.prepare('UPDATE orders SET data=? WHERE id=?').run(JSON.stringify(order), order.id);
  }
  const snapshots = store.snapshot(device);
  assert.equal(snapshots.orders.find(order => order.platformOrderId === 'thirty').archived, false);
  const override = store.order(snapshots.orders.find(order => order.platformOrderId === 'thirty').id);
  override.dateOverride = '2026-10-01';
  store.db.prepare('UPDATE orders SET data=? WHERE id=?').run(JSON.stringify(override), override.id);
  const overridden = store.snapshot(device).orders.find(order => order.platformOrderId === 'thirty');
  assert.equal(overridden.retention.anchorDate, '2026-10-01');
  assert.equal(overridden.archived, true);
  assert.equal(snapshots.orders.find(order => order.platformOrderId === 'missing').retention.anchorSource, 'first_seen');
  assert.equal(snapshots.orders.find(order => order.platformOrderId === 'missing').archived, true);
  assert.equal(snapshots.orders.find(order => order.platformOrderId === 'legacy').retention.anchorSource, 'first_seen');
  const oldOrderIds = new Set(snapshots.orders.filter(order => ['missing', 'legacy'].includes(order.platformOrderId)).map(order => order.id));
  const signed = snapshots.shipments.filter(shipment => oldOrderIds.has(shipment.orderId));
  assert.equal(signed.length, 2);
  assert.ok(signed.every(shipment => shipment.receiptState === 'expired_signed'));
  for (const shipment of signed) {
    const raw = store.shipment(shipment.id); raw.status = 'returning'; store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(raw), raw.id);
  }
  assert.ok(store.snapshot(device).shipments.filter(shipment => oldOrderIds.has(shipment.orderId)).every(shipment => shipment.receiptState === undefined));
});

test('signed status with an actual latest return event is excluded, while tentative and future return text remains eligible', t => {
  const { store, account, device } = fixture(t);
  const oldDate = Date.parse('2026-10-07T12:00:00+08:00');
  importOrder(store, account.id, 'actual-return', oldDate, 'signed');
  importOrder(store, account.id, 'tentative-return', oldDate, 'signed');
  importOrder(store, account.id, 'future-return', oldDate, 'signed');
  const orders = store.snapshot(device).orders;
  for (const platformOrderId of ['actual-return', 'tentative-return', 'future-return']) {
    const orderId = orders.find(order => order.platformOrderId === platformOrderId).id;
    const shipment = store.snapshot(device).shipments.find(item => item.orderId === orderId);
    const raw = store.shipment(shipment.id);
    raw.logisticsEvents = [{
      time: platformOrderId === 'future-return' ? NOW + 86400000 : NOW,
      description: platformOrderId === 'tentative-return' ? '预计退件，等待审核' : '发件人已签收退件',
    }];
    store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(raw), raw.id);
  }
  const snapshot = store.snapshot(device);
  const actual = snapshot.shipments.find(item => item.orderId === orders.find(order => order.platformOrderId === 'actual-return').id);
  const tentative = snapshot.shipments.find(item => item.orderId === orders.find(order => order.platformOrderId === 'tentative-return').id);
  const future = snapshot.shipments.find(item => item.orderId === orders.find(order => order.platformOrderId === 'future-return').id);
  assert.equal(actual.receiptState, undefined);
  assert.equal(tentative.receiptState, 'expired_signed');
  assert.equal(future.receiptState, 'expired_signed');
});

test('restoreExpiredOrder is authorized, idempotent, cycle-bound, durable and does not alter pickup facts', t => {
  const { store, account, device, filename } = fixture(t);
  const oldDate = Date.parse('2026-10-07T12:00:00+08:00');
  importOrder(store, account.id, 'restore-me', oldDate, 'signed');
  const orderId = store.snapshot(device).orders[0].id;
  const shipmentId = store.snapshot(device).shipments[0].id;
  assert.equal(store.snapshot(device).orders[0].archived, true);
  const operation = { id: 'restore-1', orderId, action: 'restoreExpiredOrder', anchorDate: '2026-10-07', occurredAt: NOW };
  assert.deepEqual(store.applyOperations(device, [operation]), { appliedIds: ['restore-1'] });
  assert.equal(store.snapshot(device).orders[0].archived, false);
  assert.equal(store.snapshot(device).shipments[0].receiptState, undefined);
  assert.equal(store.shipment(shipmentId).picked, false);
  assert.deepEqual(store.applyOperations(device, [operation]), { appliedIds: ['restore-1'] });
  assert.throws(() => store.applyOperations(device, [{ ...operation, anchorDate: '2026-10-08' }]), error => error.status === 409);
  const late = { ...operation, id: 'restore-late', occurredAt: NOW - 1000 };
  assert.deepEqual(store.applyOperations(device, [late]), { appliedIds: ['restore-late'] });
  const restored = store.order(orderId);
  assert.equal(restored.archiveRestoredAnchor, '2026-10-07');
  assert.equal(restored.archiveRestoredAt, NOW);
  store.close();
  const reopened = new Store({ filename, key: KEY, now: () => NOW });
  assert.equal(reopened.snapshot(device).orders[0].archived, false);
  const incompleteRestore = reopened.order(orderId); incompleteRestore.archiveRestoredAt = 0;
  reopened.db.prepare('UPDATE orders SET data=? WHERE id=?').run(JSON.stringify(incompleteRestore), orderId);
  assert.equal(reopened.snapshot(device).orders[0].archived, true);
  reopened.close();
});

test('restoreExpiredOrder rejects unauthorized orders and acknowledges a changed anchor as superseded', t => {
  const { store, account, device } = fixture(t);
  importOrder(store, account.id, 'changed', Date.parse('2026-10-07T12:00:00+08:00'), 'signed');
  const order = store.snapshot(device).orders[0];
  const other = store.saveAccount({ platform: 'taobao', label: '其他账号', cookie: 'FIXTURE' }, 'account-b', true);
  const foreignDevice = store.device(store.redeem(store.createPairing({ accountIds: [other.id] }).code, '其他设备').token);
  const operation = { id: 'foreign-restore', orderId: order.id, action: 'restoreExpiredOrder', anchorDate: '2026-10-07', occurredAt: NOW };
  assert.throws(() => store.applyOperations(foreignDevice, [operation]), error => error.status === 403);
  store.applyOperations(device, [{ id: 'date-change', orderId: order.id, action: 'setOrderDate', date: '2026-10-20', occurredAt: NOW }]);
  assert.deepEqual(store.applyOperations(device, [operation]), { appliedIds: ['foreign-restore'] });
  assert.equal(store.operation(device, 'foreign-restore').status, 'superseded');
  assert.equal(store.snapshot(device).orders[0].retention.anchorDate, '2026-10-20');
});

test('HTTP snapshot ETag changes when a China-calendar retention boundary is crossed', async t => {
  let clock = Date.parse('2026-11-06T23:59:59+08:00');
  const service = createService({ encryptionKey: KEY.toString('hex'), adminToken: randomUUID(), fixture: true, scheduler: false, now: () => clock });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const account = service.store.saveAccount({ platform: 'taobao', label: 'HTTP测试', cookie: 'FIXTURE' }, 'http-account', true);
  const credential = service.store.redeem(service.store.createPairing({ accountIds: [account.id] }).code, 'HTTP设备');
  const device = service.store.device(credential.token);
  service.store.importResult(account.id, { orders: [{ platformOrderId: 'http-order', orderDate: Date.parse('2026-10-07T12:00:00+08:00') }], shipments: [] });
  const url = `http://127.0.0.1:${service.server.address().port}/v1/snapshot`;
  const first = await fetch(url, { headers: { Authorization: `Bearer ${credential.token}` } });
  const firstData = await first.json(), firstTag = first.headers.get('etag');
  assert.equal(firstData.orders[0].archived, false);
  clock = Date.parse('2026-11-07T00:00:00+08:00');
  const second = await fetch(url, { headers: { Authorization: `Bearer ${credential.token}`, 'If-None-Match': firstTag } });
  const secondData = await second.json();
  assert.equal(second.status, 200);
  assert.notEqual(second.headers.get('etag'), firstTag);
  assert.equal(secondData.orders[0].archived, true);
  assert.ok(secondData.serverRevision > firstData.serverRevision);
  assert.equal(device.accountIds[0], account.id);
});

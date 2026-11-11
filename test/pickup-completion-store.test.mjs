import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { activeKnownOrders, activeKnownParcels } from '../src/collector-enrichment.mjs';

const NOW = 1800000000000;
const key = Buffer.alloc(32, 3);
function fixture(t, filename) {
  const store = new Store({ key, now: () => NOW, ...(filename ? { filename } : {}) });
  t.after(() => store.close());
  store.saveAccount({ platform: 'taobao', label: '测试', cookie: 'FIXTURE' }, 'a', true);
  const bind = () => store.device(store.redeem(store.createPairing(['a']).code, '测试').token);
  const device = bind();
  const sync = (descriptions = ['本人已签收'], extra = {}) => {
    store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: 'TEST', status: 'signed',
      logisticsState: 'ok', logisticsCheckedAt: NOW, logisticsEvents: descriptions.map((description, i) => ({ time: NOW - (i + 1) * 1000, description })), ...extra }] });
    return store.snapshot(['a']).shipments[0];
  };
  const read = () => store.snapshot(['a']).shipments[0];
  const op = (action, at = NOW, user = device, id = action + at) => store.applyOperations(user, [{ id, shipmentId: read().id, action, occurredAt: at }]);
  return { store, sync, read, bind, device, op };
}

test('code receipts repair old pending records on restart and respect manual pending overrides', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pickup-code-receipt-')), filename = join(directory, 'test.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store({ key, now: () => NOW, filename });
  store.saveAccount({ platform: 'taobao', label: '测试', cookie: 'FIXTURE' }, 'a', true);
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: ['auto', 'manual'].map(waybillNo => ({
    platformOrderId: 'o', waybillNo, status: 'arrived', arrivalAt: NOW - 1000,
    logisticsEvents: [{ time: NOW - 1000, description: '已签收，签收人凭取货码签收。感谢使用示例丰巢柜【自提柜】' }]
  })) });
  for (const row of store.db.prepare('SELECT id,data FROM shipments').all()) {
    const shipment = JSON.parse(row.data);
    shipment.picked = false; shipment.arrivalAt = NOW - 1000;
    shipment.pickupCompletion = { version: 1, autoPicked: false, manualOverride: shipment.waybillNo === 'manual' ? 'pending' : '', completedAt: 0, evidence: null };
    store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(shipment), row.id);
  }
  store.close();
  store = new Store({ key, now: () => NOW, filename });
  try {
    const parcels = store.snapshot(['a']).shipments;
    assert.equal(parcels.find(p => p.waybillNo === 'auto').picked, true);
    assert.equal(parcels.find(p => p.waybillNo === 'auto').pickupCompletion.completedAt, NOW - 1000);
    assert.equal(parcels.find(p => p.waybillNo === 'manual').picked, false);
    assert.equal(parcels.length, 2);
  } finally { store.close(); }
});

test('automatic evidence is separate, defaults on, survives refresh and manual restore wins until resumed', t => {
  const { store, sync, read, op, device } = fixture(t);
  const shipment = sync();
  assert.equal(shipment.picked, true); assert.equal(shipment.manualAt, 0);
  assert.equal(shipment.pickupCompletion.autoPicked, true); assert.equal(shipment.pickupCompletion.manualOverride, '');
  assert.deepEqual(store.snapshot(['a']).pickupCompletion, { version: 1, enabled: true, aiEnabled: true });
  assert.ok(store.snapshot(['a']).capabilities.includes('pickup_completion_v1'));
  op('restore', NOW - 200);
  assert.equal(read().picked, false); assert.equal(read().pickupCompletion.manualOverride, 'pending');
  assert.equal(sync().picked, false);
  op('pick', NOW - 300, device, 'stale');
  assert.equal(store.operation(device, 'stale').status, 'superseded'); assert.equal(read().picked, false);
  op('resumeAutoPickup', NOW - 100);
  assert.equal(read().picked, true); assert.equal(read().pickupCompletion.manualOverride, '');
  const revision = store.snapshot(['a']).serverRevision;
  op('resumeAutoPickup', NOW - 100);
  assert.equal(store.snapshot(['a']).serverRevision, revision);
});

test('courier contact details do not block completion and manual pending still wins', t => {
  const { sync, read, op } = fixture(t);
  const description = '您的快件已由本人签收，如有疑问请联系快递员：测试员（10000000000）';
  const shipment = sync([description, '已到达示例菜鸟驿站，请及时取件']);
  assert.equal(shipment.picked, true);
  assert.equal(shipment.pickupCompletion.evidence.description, description);
  op('restore');
  assert.equal(sync([description]).picked, false);
  assert.equal(read().pickupCompletion.manualOverride, 'pending');
});

test('cross-device stale writes, hide and same-millisecond legacy operations preserve the correct decision', t => {
  const { sync, read, op, bind, store } = fixture(t);
  sync(); const second = bind();
  op('restore', NOW - 200); op('hide', NOW - 100, second);
  op('pick', NOW - 300, second);
  assert.equal(read().picked, false); assert.equal(read().hidden, true);
  op('unhide', NOW - 50, second); op('pick', NOW, second); op('restore', NOW, second);
  assert.equal(read().picked, false); assert.equal(read().pickupCompletion.manualOverride, 'pending');
  assert.equal(store.snapshot(['a']).shipments[0].pickupManualAt, NOW);
  assert.equal(store.snapshot(['a']).shipments[0].pickupManualAction, 'restore');
  assert.equal(store.snapshot(['a']).shipments[0].pickupConfirmedAt, 0);
});

test('disabling pauses new auto completions, retains existing evidence, and enabling backfills visible pending', t => {
  const { store, sync, read } = fixture(t);
  sync(); store.pickupCompletion.saveConfig({ enabled: false });
  assert.equal(sync(['待取件']).picked, true);
  store.pickupCompletion.saveConfig({ enabled: true });
  assert.equal(read().picked, false);
  store.pickupCompletion.saveConfig({ enabled: false });
  sync(['本人签收'], { logisticsEvents: [{ time: NOW, description: '本人签收' }] });
  assert.equal(read().picked, false);
  store.pickupCompletion.saveConfig({ enabled: true });
  assert.equal(read().picked, true);
});

test('nonreceipt retracts automatic state even while paused and never overrides a manual pick', t => {
  const { store, sync, read, op } = fixture(t);
  sync(); store.pickupCompletion.saveConfig({ enabled: false });
  assert.equal(sync(['本人已签收']).picked, true);
  assert.equal(sync(['本人已签收，如未收到包裹请联系客服']).picked, true);
  assert.equal(sync(['收件人反馈未收到包裹']).picked, false);
  assert.equal(read().pickupCompletion.autoPicked, false);
  op('pick');
  assert.equal(sync(['收件人反馈未收到包裹']).picked, true);
  assert.equal(read().pickupCompletion.manualOverride, 'picked');
});

test('startup repairs persisted false automatic completions once, preserving manual history', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pickup-nonreceipt-')), filename = join(directory, 'test.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store({ key, now: () => NOW, filename });
  store.saveAccount({ platform: 'taobao', label: '测试', cookie: 'FIXTURE' }, 'a', true);
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: ['same', 'later', 'manual', 'valid'].map(waybillNo => ({
    platformOrderId: 'o', waybillNo, logisticsState: 'ok', logisticsEvents: [{ time: NOW - 2000, description: '本人已签收' }] })) });
  store.pickupCompletion.saveConfig({ enabled: false });
  for (const row of store.db.prepare('SELECT id,data FROM shipments').all()) {
    const ship = JSON.parse(row.data);
    if (ship.waybillNo === 'valid') {
      ship.logisticsEvents[0].description += '，如未收到包裹请联系客服';
      ship.pickupCompletion.evidence.description = ship.logisticsEvents[0].description;
    } else if (ship.waybillNo === 'same') {
      ship.logisticsEvents[0].description += '，但收件人反馈未收到包裹';
      ship.pickupCompletion.evidence.description = ship.logisticsEvents[0].description;
    } else if (ship.waybillNo !== 'valid') ship.logisticsEvents.push({ time: NOW - 1000, description: '收件人反馈未收到包裹' });
    if (ship.waybillNo === 'manual') {
      ship.pickupCompletion.manualOverride = 'picked'; ship.pickupManualAction = 'pick'; ship.pickupConfirmedAt = NOW - 100;
    }
    store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(ship), row.id);
  }
  store.close();
  store = new Store({ key, now: () => NOW, filename });
  const ships = Object.fromEntries(store.snapshot(['a']).shipments.map(s => [s.waybillNo, s]));
  assert.equal(ships.same.picked, false); assert.equal(ships.later.picked, false);
  assert.equal(ships.manual.picked, true); assert.equal(ships.manual.pickupCompletion.autoPicked, false);
  assert.equal(ships.manual.pickupConfirmedAt, NOW - 100); assert.equal(ships.valid.picked, true);
  const before = store.snapshot(['a']); store.close();
  store = new Store({ key, now: () => NOW, filename });
  assert.deepEqual(store.snapshot(['a']), before); store.close();
});

test('custom rule rollback retracts affected automatic state while preserving manual decisions', t => {
  const { store, sync, read, op } = fixture(t);
  assert.equal(sync(['本人已完成提货']).picked, false);
  store.pickupCompletion.saveRule({ id: 'ai-collection', kind: 'user_collected', keywords: ['本人已完成提货'], origin: 'ai' });
  assert.equal(read().picked, true);
  op('pick'); store.pickupCompletion.removeRule('ai-collection');
  assert.equal(read().picked, true); assert.equal(read().pickupCompletion.autoPicked, false);
  assert.equal(read().pickupCompletion.manualOverride, 'picked');
  op('resumeAutoPickup', NOW, undefined, 'resume'); assert.equal(read().picked, false);
});

test('split parcels and account scope remain independent, and new-cycle conflicts retract old auto evidence', t => {
  const { store, sync, read } = fixture(t);
  sync();
  sync(['等待取件'], { waybillNo: 'OTHER' });
  assert.equal(store.snapshot(['a']).shipments.filter(shipment => shipment.picked).length, 1);
  sync(['退回商家'], { logisticsEvents: [{ time: NOW, description: '退回商家' }] });
  assert.equal(read().pickupCompletion.autoPicked, false);
  assert.equal(store.snapshot(['unknown']).shipments.length, 0);
});

test('legacy migration distinguishes hide-only manualAt from actual restore and retains completed history', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pickup-completion-'));
  const filename = join(directory, 'test.sqlite');
  const store = new Store({ key, now: () => NOW, filename });
  store.saveAccount({ platform: 'taobao', label: '测试', cookie: 'FIXTURE' }, 'a', true);
  const device = store.device(store.redeem(store.createPairing(['a']).code, '测试').token);
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: ['hide', 'restore', 'picked', 'hidden'].map(waybillNo => ({ platformOrderId: 'o', waybillNo, logisticsState: 'ok', logisticsEvents: [{ time: NOW - 1000, description: '本人签收' }] })) });
  for (const shipment of store.snapshot(['a']).shipments) {
    if (shipment.waybillNo === 'restore') store.applyOperations(device, [{ id: 'restore', shipmentId: shipment.id, action: 'restore', occurredAt: NOW - 50 }]);
    if (shipment.waybillNo === 'hide') store.applyOperations(device, [{ id: 'hide', shipmentId: shipment.id, action: 'unhide', occurredAt: NOW - 50 }]);
    const old = JSON.parse(store.db.prepare('SELECT data FROM shipments WHERE id=?').get(shipment.id).data);
    delete old.pickupCompletion; delete old.pickupManualAt; delete old.pickupManualOperation;
    Object.assign(old, { picked: shipment.waybillNo === 'picked', hidden: shipment.waybillNo === 'hidden', manualAt: NOW - 50 });
    store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(old), old.id);
  }
  store.close();
  const reopened = new Store({ key, now: () => NOW, filename });
  t.after(() => { reopened.close(); rmSync(directory, { recursive: true, force: true }); });
  const byId = Object.fromEntries(reopened.snapshot(['a']).shipments.map(item => [item.waybillNo, item]));
  assert.equal(byId.hide.picked, true); assert.equal(byId.hide.pickupCompletion.manualOverride, '');
  assert.equal(byId.restore.picked, false); assert.equal(byId.restore.pickupCompletion.manualOverride, 'pending');
  assert.equal(byId.picked.picked, true); assert.equal(byId.picked.pickupCompletion.manualOverride, 'picked');
  assert.equal(byId.picked.pickupCompletion.autoPicked, false); assert.equal(byId.hidden.picked, false);
});

test('signed-unpicked records reenter bounded oldest-first active fetch while completed records stop', () => {
  const orders = Array.from({ length: 30 }, (_, i) => ({ platformOrderId: `o${i}`, shipments: [{ waybillNo: `w${i}`, status: 'signed', logisticsCheckedAt: i + 1 }] }));
  orders.push({ platformOrderId: 'complete', shipments: [{ waybillNo: 'done', status: 'signed', picked: true }] });
  assert.equal(activeKnownOrders(orders, new Set()).length, 20);
  assert.equal(activeKnownOrders(orders, new Set())[0].platformOrderId, 'o0');
  assert.equal(activeKnownParcels(orders.at(-1)).length, 0);
});

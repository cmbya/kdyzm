import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { confirmShipmentReplacement } from '../scripts/confirm-shipment-replacement.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'confirmed-replacement-')), database = join(dir, 'parcel.db');
  const store = new Store({ filename: database, key: Buffer.alloc(32, 7) });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'FIXTURE' }, 'a', true);
  store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [
    { platformOrderId: 'o', waybillNo: 'OLD', status: 'transit' },
    { platformOrderId: 'o', waybillNo: 'NEW', carrier: '申通快递', status: 'arrived', pickupCode: '123456' }
  ] });
  const records = store.snapshot(['a']).shipments;
  return { store, input: { database, oldId: records.find(s => s.waybillNo === 'OLD').id,
    targetId: records.find(s => s.waybillNo === 'NEW').id, orderNumber: 'o', evidence: '合成场景：平台人工核实运单变更' } };
}

test('replacement preview is read-only; confirmed repair changes only alias/revision and makes a consistent backup', async t => {
  const { store, input } = fixture(t);
  const rows = store.db.prepare('SELECT * FROM shipments ORDER BY id').all(), revision = store.snapshot(['a']).serverRevision;
  const preview = await confirmShipmentReplacement(input);
  assert.equal(preview.applied, false);
  assert.equal(store.snapshot(['a']).serverRevision, revision);
  await assert.rejects(confirmShipmentReplacement({ ...input, confirm: 'wrong-confirmation' }), /确认摘要/);
  const applied = await confirmShipmentReplacement({ ...input, confirm: preview.plan.confirmation });
  assert.deepEqual(store.db.prepare('SELECT * FROM shipments ORDER BY id').all(), rows);
  assert.equal(store.snapshot(['a']).serverRevision, revision + 1);
  assert.deepEqual(store.snapshot(['a']).shipments.map(s => s.waybillNo), ['NEW']);
  const saved = new DatabaseSync(applied.backupPath, { readOnly: true });
  try {
    assert.deepEqual(saved.prepare('SELECT * FROM shipments ORDER BY id').all(), rows);
    assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM shipment_aliases').get().n, 0);
    assert.equal(saved.prepare('SELECT revision FROM meta').get().revision, revision);
  } finally { saved.close(); }
});

test('new logistics evidence and different order assertions invalidate confirmation without mutating records', async t => {
  const { store, input } = fixture(t);
  await assert.rejects(confirmShipmentReplacement({ ...input, orderNumber: 'different-order' }), /平台订单号/);
  const preview = await confirmShipmentReplacement(input), old = store.shipment(input.oldId);
  store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify({ ...old,
    logisticsEvents: [{ time: Date.now(), description: '已揽收，运输中' }] }), old.id);
  await assert.rejects(confirmShipmentReplacement({ ...input, confirm: preview.plan.confirmation }), /确认摘要/);
  assert.equal(store.snapshot(['a']).shipmentAliases.length, 0);
});

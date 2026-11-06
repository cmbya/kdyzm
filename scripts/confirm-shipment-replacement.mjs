import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

function replacementPlan(db, { oldId, targetId, orderNumber, evidence }) {
  if (!oldId || !targetId || oldId === targetId || !orderNumber || !evidence?.trim() || evidence.length > 2000) throw new Error('需要两个不同包裹 ID、平台订单号及人工核实依据');
  const read = id => { const row = db.prepare('SELECT data FROM shipments WHERE id=?').get(id); return row && JSON.parse(row.data); };
  const old = read(oldId), target = read(targetId);
  if (!old || !target || old.accountId !== target.accountId || old.orderId !== target.orderId) throw new Error('必须属于同一账号、同一订单');
  const order = JSON.parse(db.prepare('SELECT data FROM orders WHERE id=?').get(old.orderId)?.data || '{}');
  if (order.platformOrderId !== orderNumber || !order.platform) throw new Error('平台订单号不符');
  for (const s of [old, target]) {
    if (s.picked || s.hidden || s.deleted || s.manualAt || s.pickupManualAt || s.pickupManualOperation || s.pickupCompletion?.manualOverride
      || s.pickupCompletion?.autoPicked || !s.pickupCycle?.id || s.pickupCycle.evidenceKey !== 'initial' || s.pickupCycleHistory?.length) throw new Error('存在领取决定、人工操作或多次投递历史，停止自动整理');
  }
  if (old.pickupCode || old.arrivalAt || !['transit', 'unknown'].includes(old.status)) throw new Error('旧运单已有到站或领取依据，不能作为未使用的旧运单整理');
  if (!old.waybillNo || !target.waybillNo || old.waybillNo === target.waybillNo) throw new Error('此工具仅整理已人工核实的运单变更');
  if (db.prepare('SELECT 1 FROM operations WHERE json_extract(data,\'$.shipmentId\') IN (?,?) LIMIT 1').get(oldId, targetId)) throw new Error('已有设备操作，需单独审查');
  if (db.prepare('SELECT 1 FROM shipment_aliases WHERE old_shipment_id IN (?,?) OR target_shipment_id IN (?,?) LIMIT 1').get(oldId, targetId, oldId, targetId)) throw new Error('已有身份整理记录，停止重复修改');
  const keys = db.prepare('SELECT DISTINCT platform_package_key AS key FROM shipment_identifiers WHERE shipment_id IN (?,?) AND platform_package_key<>\'\'').all(oldId, targetId);
  if (keys.length > 1) throw new Error('平台分包键不同，禁止合并');
  const identifiers = db.prepare('SELECT * FROM shipment_identifiers WHERE shipment_id IN (?,?) ORDER BY id').all(oldId, targetId);
  const evidenceDigest = createHash('sha256').update(JSON.stringify({ order, old, target, identifiers })).digest('hex');
  const plan = { orderNumber, orderId: old.orderId, accountId: old.accountId, platform: order.platform,
    oldShipmentId: oldId, oldWaybill: old.waybillNo, targetShipmentId: targetId, targetWaybill: target.waybillNo,
    sourceCycleId: old.pickupCycle.id, targetCycleId: target.pickupCycle.id,
    retainedPickupCode: target.pickupCode || '', reason: 'confirmed_waybill_replacement', evidence: evidence.trim(), evidenceDigest };
  return { ...plan, confirmation: createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
}

export async function confirmShipmentReplacement({ database, confirm = '', ...input }) {
  const filename = resolve(database);
  const db = new DatabaseSync(filename, { readOnly: true });
  let writer, backupPath;
  try {
    db.exec('BEGIN');
    const plan = replacementPlan(db, input);
    db.exec('ROLLBACK');
    if (!confirm) return { applied: false, plan };
    if (confirm !== plan.confirmation) throw new Error('确认摘要与当前整理计划不一致');
    writer = new DatabaseSync(filename);
    writer.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    // Hold the write lock through backup and commit so the backup precedes this exact repair.
    const current = replacementPlan(writer, input);
    if (current.confirmation !== confirm) throw new Error('数据已经变化，请重新核对整理计划');
    backupPath = `${filename}.before-replacement-${randomUUID()}.db`;
    closeSync(openSync(backupPath, 'wx', 0o600));
    await backup(db, backupPath);
    chmodSync(backupPath, 0o600);
    writer.prepare('INSERT INTO shipment_aliases(old_shipment_id,target_shipment_id,account_id,platform,reason,evidence,created_at,source_cycle_id,target_cycle_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(current.oldShipmentId, current.targetShipmentId, current.accountId, current.platform, current.reason, current.evidence, Date.now(), current.sourceCycleId, current.targetCycleId);
    writer.exec('UPDATE meta SET revision=revision+1 WHERE id=1; COMMIT');
    return { applied: true, plan: current, backupPath };
  } catch (error) {
    try { writer?.exec('ROLLBACK'); } catch {}
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { try { writer?.close(); } catch {} db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: Object.fromEntries(['database', 'oldId', 'targetId', 'orderNumber', 'evidence', 'confirm'].map(name => [name, { type: 'string' }])) });
  try { console.log(JSON.stringify(await confirmShipmentReplacement(values), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { encryptCookie, decryptCookie, hash, secret, fail, text, onlyKeys } from './security.mjs';

export const stableId = (...values) => hash(JSON.stringify(values)).slice(0, 32);
const parse = row => row && JSON.parse(row.data);
const carrierKey = value => {
  const name = String(value || '').toUpperCase().replace(/\s/g, '');
  for (const [pattern, key] of [[/中通|^ZTO$/, 'ZTO'], [/圆通|^YTO$/, 'YTO'], [/申通|^STO$/, 'STO'], [/顺丰|^SF$/, 'SF'], [/韵达|^YUNDA$/, 'YUNDA'], [/极兔|^JTSD$/, 'JTSD']]) if (pattern.test(name)) return key;
  return name;
};

export class Store {
  constructor({ filename = ':memory:', key, now = Date.now }) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.key = key;
    this.now = now;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES(1,0);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL, credential TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, account_ids TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS pairing (code_hash TEXT PRIMARY KEY, account_ids TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shipments (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (device_id TEXT NOT NULL REFERENCES devices(id), id TEXT NOT NULL, payload_hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(device_id,id));`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  revision() {
    this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
    return this.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision;
  }
  account(id) { return parse(this.db.prepare('SELECT data FROM accounts WHERE id=?').get(id)); }
  accounts(ids) {
    const allowed = ids && new Set(ids);
    return this.db.prepare('SELECT data FROM accounts ORDER BY id').all().map(parse).filter(a => !allowed || allowed.has(a.id));
  }
  saveAccount(body, id = randomUUID(), fixture = false) {
    onlyKeys(body, ['platform', 'label', 'cookie', 'enabled', 'intervalMinutes']);
    const old = this.account(id);
    const platform = body.platform ?? old?.platform;
    if (!['taobao', 'pdd'].includes(platform) || (old && platform !== old.platform)) fail(400, 'INVALID_PLATFORM', '平台必须是淘宝或拼多多，创建后不可改变');
    const intervalMinutes = body.intervalMinutes ?? old?.intervalMinutes ?? 60;
    if (![30, 60].includes(intervalMinutes)) fail(400, 'INVALID_INTERVAL', '同步间隔仅支持30或60分钟');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'INVALID_INPUT', 'enabled 必须是布尔值');
    const label = text(body.label ?? old?.label, '账号名称', 80);
    let credential = this.db.prepare('SELECT credential FROM accounts WHERE id=?').get(id)?.credential;
    if (body.cookie !== undefined || !old) {
      const cookie = text(body.cookie, 'Cookie', 16384);
      if (/\r|\n/.test(cookie)) fail(400, 'INVALID_COOKIE', 'Cookie 不得包含换行');
      if (!fixture && platform === 'pdd' && (!/(?:^|;\s*)PDDAccessToken=/.test(cookie) || !/(?:^|;\s*)(?:pdd_user_id|pdduid)=/.test(cookie))) fail(400, 'INVALID_COOKIE', '缺少拼多多登录字段');
      credential = encryptCookie(cookie, this.key, id);
    }
    const data = { id, platform, label, enabled: body.enabled ?? old?.enabled ?? true, intervalMinutes,
      status: body.cookie !== undefined || !old ? 'configured' : old.status, lastSuccessAt: old?.lastSuccessAt || 0,
      lastAttemptAt: body.cookie !== undefined ? 0 : old?.lastAttemptAt || 0, nextSyncAt: body.cookie !== undefined || !old ? this.now() + intervalMinutes * 60000 : old.nextSyncAt,
      error: body.cookie !== undefined ? '' : old?.error || '', revision: this.revision(), fixture,
      credentialVersion: (old?.credentialVersion || 0) + (body.cookie !== undefined || !old ? 1 : 0),
      warnings: old?.warnings || [] };
    this.db.prepare('INSERT INTO accounts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,credential=excluded.credential').run(id, JSON.stringify(data), credential);
    return data;
  }
  cookie(id) {
    const row = this.db.prepare('SELECT credential FROM accounts WHERE id=?').get(id);
    return row && decryptCookie(row.credential, this.key, id);
  }
  refreshCookie(id, cookie) {
    this.db.prepare('UPDATE accounts SET credential=? WHERE id=?').run(encryptCookie(cookie, this.key, id), id);
  }
  updateAccount(id, fields) {
    const account = this.account(id);
    if (!account) fail(404, 'NOT_FOUND', '账号不存在');
    const updated = { ...account, ...fields, revision: this.revision() };
    this.db.prepare('UPDATE accounts SET data=? WHERE id=?').run(JSON.stringify(updated), id);
    return updated;
  }
  createPairing(accountIds) {
    if (!Array.isArray(accountIds) || !accountIds.length || accountIds.length > 100 || new Set(accountIds).size !== accountIds.length || accountIds.some(id => typeof id !== 'string' || !this.account(id))) fail(400, 'INVALID_SCOPE', '请选择有效的授权账号');
    const code = hash(secret()).slice(0, 16).toUpperCase();
    const expiresAt = this.now() + 10 * 60000;
    this.db.prepare('DELETE FROM pairing WHERE expires_at<? OR used_at IS NOT NULL').run(this.now());
    this.db.prepare('INSERT INTO pairing VALUES(?,?,?,NULL)').run(hash(code), JSON.stringify(accountIds), expiresAt);
    return { code, expiresAt, accountIds };
  }
  redeem(code, deviceName) {
    code = text(code, '绑定码', 80).toUpperCase();
    deviceName = text(deviceName, '设备名称', 80);
    return this.transaction(() => {
      const pair = this.db.prepare('SELECT * FROM pairing WHERE code_hash=?').get(hash(code));
      if (!pair || pair.used_at !== null || pair.expires_at <= this.now()) fail(400, 'INVALID_PAIRING_CODE', '绑定码无效、已使用或已过期');
      const token = `pcd_${secret()}`;
      const deviceId = randomUUID();
      this.db.prepare('UPDATE pairing SET used_at=? WHERE code_hash=?').run(this.now(), hash(code));
      this.db.prepare('INSERT INTO devices VALUES(?,?,?,?,?,NULL)').run(deviceId, hash(token), deviceName, pair.account_ids, this.now());
      return { token, deviceId, accounts: this.accounts(JSON.parse(pair.account_ids)), serverTime: this.now() };
    });
  }
  device(token) {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL').get(hash(token));
    if (!row) fail(401, 'DEVICE_UNAUTHORIZED', '设备授权无效，请重新绑定');
    return { id: row.id, accountIds: JSON.parse(row.account_ids) };
  }
  devices() {
    return this.db.prepare('SELECT id,name,account_ids,created_at,revoked_at FROM devices ORDER BY created_at DESC').all()
      .map(row => ({ id: row.id, name: row.name, accountIds: JSON.parse(row.account_ids), createdAt: row.created_at, revokedAt: row.revoked_at }));
  }
  revoke(id) {
    const result = this.db.prepare('UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(this.now(), id);
    if (!result.changes && !this.db.prepare('SELECT id FROM devices WHERE id=?').get(id)) fail(404, 'NOT_FOUND', '设备不存在');
    return { revoked: true };
  }
  importResult(accountId, result) {
    const account = this.account(accountId);
    if (!account) fail(404, 'NOT_FOUND', '账号不存在');
    this.transaction(() => {
      const orderIds = new Map();
      const admittedIds = new Set(result.orders.map(input => String(input.platformOrderId)));
      for (const input of [...(result.orderUpdates || []), ...result.orders]) {
        const platformOrderId = String(input.platformOrderId);
        const id = stableId(accountId, account.platform, 'order', platformOrderId);
        orderIds.set(platformOrderId, id);
        const old = parse(this.db.prepare('SELECT data FROM orders WHERE id=?').get(id));
        // Filtered orders may refresh existing history, but must not create new shopping records.
        if (!old && !admittedIds.has(platformOrderId)) continue;
        const inputDate = Number.isFinite(input.orderDate) && input.orderDate > 0 && input.orderDate <= 8640000000000000 ? input.orderDate : 0;
        const verifiedDate = old?.orderDateSource === 'platform' && old.orderDate > 0;
        const order = { ...old, id, accountId, platform: account.platform, platformOrderId,
          title: String(input.title || old?.title || ''), amount: input.amount == null ? old?.amount ?? null : input.amount,
          orderDate: verifiedDate ? old.orderDate : inputDate || old?.orderDate || 0,
          orderDateSource: verifiedDate || inputDate ? 'platform' : old?.orderDate ? 'legacy' : 'unknown',
          firstSeenAt: old?.firstSeenAt || this.now(), tradeStatus: input.tradeStatus || old?.tradeStatus || '',
          orderStatus: input.orderStatus || old?.orderStatus || '',
          refundStatus: input.refundStatus || old?.refundStatus || '' };
        this.db.prepare('INSERT INTO orders VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, accountId, JSON.stringify(order));
      }
      for (const input of result.shipments) {
        if (!input.waybillNo) continue;
        const orderId = orderIds.get(String(input.platformOrderId)) || stableId(accountId, account.platform, 'order', String(input.platformOrderId));
        if (!this.db.prepare('SELECT id FROM orders WHERE id=?').get(orderId)) continue;
        // Order + carrier + waybill keeps every split parcel and prevents cross-account collisions.
        const carrier = carrierKey(input.carrier);
        const previous = this.db.prepare('SELECT data FROM shipments WHERE account_id=?').all(accountId).map(parse)
          .filter(s => s.orderId === orderId && s.waybillNo === String(input.waybillNo) && (!carrier || !s.carrier || carrierKey(s.carrier) === carrier));
        const id = previous.length === 1 ? previous[0].id : stableId(accountId, account.platform, orderId, carrier, String(input.waybillNo));
        const old = parse(this.db.prepare('SELECT data FROM shipments WHERE id=?').get(id));
        const status = ['transit', 'arrived', 'signed', 'unknown'].includes(input.status) ? input.status : 'unknown';
        const shipment = { id, orderId, accountId, waybillNo: String(input.waybillNo), carrier: input.carrier || old?.carrier || '', status,
          pickupCode: input.pickupCode || old?.pickupCode || '', station: input.station || old?.station || '',
          arrivalAt: old?.arrivalAt || (status === 'arrived' ? input.arrivalAt || this.now() : 0),
          updatedAt: input.updatedAt || this.now(), picked: old?.picked || false, hidden: old?.hidden || false,
          deleted: old?.deleted || false, manualAt: old?.manualAt || 0 };
        this.db.prepare('INSERT INTO shipments VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, accountId, JSON.stringify(shipment));
      }
      // Absence, pagination, refunds and source signatures never change manual state or tombstones.
      this.updateAccount(accountId, { status: 'ok', lastSuccessAt: this.now(), error: '', warnings: result.warnings || [] });
    });
  }
  snapshot(accountIds) {
    const allowed = new Set(accountIds);
    const accounts = this.accounts(accountIds);
    const orders = this.db.prepare('SELECT data FROM orders ORDER BY id').all().map(parse).filter(o => allowed.has(o.accountId))
      .map(o => ({ ...o, orderDateSource: o.orderDateSource || (o.orderDate ? 'legacy' : 'unknown'), firstSeenAt: o.firstSeenAt || 0 }));
    const shipments = this.db.prepare('SELECT data FROM shipments ORDER BY id').all().map(parse).filter(s => allowed.has(s.accountId));
    return { schemaVersion: 1, serverRevision: Math.max(0, ...accounts.map(a => a.revision)), accounts, orders, shipments,
      hiddenIds: shipments.filter(s => s.hidden).map(s => s.id), deletedIds: shipments.filter(s => s.deleted).map(s => s.id),
      events: shipments.filter(s => s.arrivalAt).map(s => ({ id: stableId(s.id, 'arrival', s.arrivalAt), shipmentId: s.id, arrivedAt: s.arrivalAt, code: s.pickupCode, stationKey: s.station })),
      syncWarnings: accounts.flatMap(a => (a.warnings || []).map(message => ({ accountId: a.id, message }))) };
  }
  applyOperations(device, operations) {
    if (!Array.isArray(operations) || !operations.length || operations.length > 100) fail(400, 'INVALID_OPERATIONS', '每批操作须为1到100条');
    return this.transaction(() => {
      const appliedIds = [];
      for (const input of operations) {
        onlyKeys(input, ['id', 'shipmentId', 'action', 'occurredAt']);
        const operation = { id: text(input.id, '操作ID', 128), shipmentId: text(input.shipmentId, '运单ID', 128), action: input.action, occurredAt: input.occurredAt };
        if (!['pick', 'restore', 'hide', 'unhide'].includes(operation.action) || !Number.isSafeInteger(operation.occurredAt) || operation.occurredAt < 0 || operation.occurredAt > this.now() + 5 * 60000) fail(400, 'INVALID_OPERATION', '不支持的操作或时间');
        const shipment = parse(this.db.prepare('SELECT data FROM shipments WHERE id=?').get(operation.shipmentId));
        if (!shipment || !device.accountIds.includes(shipment.accountId)) fail(403, 'SCOPE_FORBIDDEN', '运单不在授权范围内');
        const digest = hash(JSON.stringify(operation));
        const old = this.db.prepare('SELECT payload_hash FROM operations WHERE device_id=? AND id=?').get(device.id, operation.id);
        if (old && old.payload_hash !== digest) fail(409, 'OPERATION_CONFLICT', '相同操作ID不能用于不同内容');
        if (!old) {
          if (operation.action === 'pick' || operation.action === 'restore') shipment.picked = operation.action === 'pick';
          else shipment.hidden = operation.action === 'hide';
          shipment.manualAt = this.now();
          this.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(shipment), shipment.id);
          this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(device.id, operation.id, digest, JSON.stringify({ ...operation, appliedAt: this.now(), status: 'applied' }));
          this.updateAccount(shipment.accountId, {});
        }
        appliedIds.push(operation.id);
      }
      return { appliedIds };
    });
  }
  operation(device, id) {
    const result = parse(this.db.prepare('SELECT data FROM operations WHERE device_id=? AND id=?').get(device.id, id));
    if (!result) fail(404, 'NOT_FOUND', '操作不存在');
    return result;
  }
}

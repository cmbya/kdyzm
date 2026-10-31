import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { encryptCookie, decryptCookie, hash, secret, fail, text, onlyKeys } from './security.mjs';
import { serverVersion, capabilities } from './version.mjs';

export const stableId = (...values) => hash(JSON.stringify(values)).slice(0, 32);
const parse = row => row && JSON.parse(row.data);
const validTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : 0;
const shortText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
function logisticsData(input, old = {}) {
  const checkedAt = validTime(input.logisticsCheckedAt);
  if (checkedAt && checkedAt < (old.logisticsCheckedAt || 0)) return logisticsData({}, old);
  const supplied = Array.isArray(input.logisticsEvents) ? input.logisticsEvents : [];
  const seen = new Set();
  const events = [...supplied, ...(old.logisticsEvents || [])].filter(e => e && typeof e === 'object').map(e => ({
    time: validTime(e.time), timeText: shortText(e.timeText, 100), description: shortText(e.description, 600), location: shortText(e.location, 120)
  })).filter(e => {
    const key = JSON.stringify([e.time, e.time ? '' : e.timeText, e.description, e.location]);
    if (!e.description || seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => b.time - a.time);
  const state = ['ok', 'empty', 'error', 'unavailable'].includes(input.logisticsState) ? input.logisticsState : old.logisticsState || '';
  return { logisticsEvents: events.slice(0, 100), logisticsState: state,
    logisticsError: input.logisticsState ? shortText(input.logisticsError, 200) || ({ error: '物流查询未完成，已保留原轨迹', unavailable: '平台未返回该运单轨迹', empty: '平台本次未返回物流轨迹' }[state] || '') : old.logisticsError || '',
    logisticsCheckedAt: Math.max(checkedAt, old.logisticsCheckedAt || 0),
    logisticsDetailCheckedAt: Math.max(validTime(input.logisticsDetailCheckedAt), old.logisticsDetailCheckedAt || 0),
    logisticsUpdatedAt: Math.max(old.logisticsUpdatedAt || 0, state === 'ok' && supplied.some(e => e?.description) ? validTime(input.logisticsUpdatedAt) || checkedAt : 0),
    logisticsTruncated: !!(input.logisticsTruncated || old.logisticsTruncated || events.length > 100) };
}
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
      CREATE TABLE IF NOT EXISTS families (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL, credential TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, account_ids TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS pairing (code_hash TEXT PRIMARY KEY, account_ids TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shipments (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (device_id TEXT NOT NULL REFERENCES devices(id), id TEXT NOT NULL, payload_hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(device_id,id));`);
    this.transaction(() => {
      for (const table of ['devices', 'pairing']) {
        if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'family_ids')) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN family_ids TEXT NOT NULL DEFAULT '[]'`);
        }
      }
    });
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
  family(id) { return this.db.prepare('SELECT id,name FROM families WHERE id=?').get(id); }
  families(ids) {
    const allowed = ids && new Set(ids);
    return this.db.prepare('SELECT id,name FROM families ORDER BY rowid').all().filter(family => !allowed || allowed.has(family.id));
  }
  saveFamily(body, id = randomUUID()) {
    onlyKeys(body, ['name']);
    const name = text(body.name, '家人姓名', 80);
    if (this.families().some(family => family.id !== id && family.name === name)) fail(409, 'FAMILY_NAME_EXISTS', '家人姓名已存在');
    this.db.prepare('INSERT INTO families(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(id, name);
    this.revision();
    return this.family(id);
  }
  accountFamily(account) {
    if (!account) return account;
    const familyId = account.familyId || '';
    return { ...account, familyId, familyName: this.family(familyId)?.name || '' };
  }
  account(id) { return this.accountFamily(parse(this.db.prepare('SELECT data FROM accounts WHERE id=?').get(id))); }
  order(id) { return parse(this.db.prepare('SELECT data FROM orders WHERE id=?').get(id)); }
  accounts(ids) {
    const allowed = ids && new Set(ids);
    return this.db.prepare('SELECT data FROM accounts ORDER BY id').all().map(parse).filter(a => !allowed || allowed.has(a.id)).map(a => this.accountFamily(a));
  }
  saveAccount(body, id = randomUUID(), fixture = false) {
    onlyKeys(body, ['platform', 'label', 'cookie', 'enabled', 'intervalMinutes', 'familyId']);
    const old = this.account(id);
    const familyId = body.familyId === undefined ? old?.familyId || '' : text(body.familyId, '家人ID', 128, false);
    if (familyId && !this.family(familyId)) fail(400, 'INVALID_FAMILY', '请选择有效家人，待归属请留空');
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
    const data = { id, platform, label, familyId, familyName: this.family(familyId)?.name || '',
      familyAssigned: !!(familyId || old?.familyAssigned || old?.familyId), enabled: body.enabled ?? old?.enabled ?? true, intervalMinutes,
      status: body.cookie !== undefined || !old ? 'configured' : old.status, lastSuccessAt: old?.lastSuccessAt || 0,
      lastAttemptAt: body.cookie !== undefined ? 0 : old?.lastAttemptAt || 0, nextSyncAt: body.cookie !== undefined || !old ? this.now() + intervalMinutes * 60000 : old.nextSyncAt,
      error: body.cookie !== undefined ? '' : old?.error || '', revision: this.revision(), fixture,
      // Ownership changes also invalidate results collected under the previous scope.
      credentialVersion: (old?.credentialVersion || 0) + (body.cookie !== undefined || !old || familyId !== old.familyId ? 1 : 0),
      warnings: old?.warnings || [] };
    this.transaction(() => {
      this.db.prepare('INSERT INTO accounts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,credential=excluded.credential').run(id, JSON.stringify(data), credential);
      if (old && !old.familyId && !old.familyAssigned && familyId) {
        for (const table of ['orders', 'shipments']) {
          for (const row of this.db.prepare(`SELECT data FROM ${table} WHERE account_id=?`).all(id)) {
            const record = parse(row);
            if (record.familyId) continue;
            Object.assign(record, { familyId, familyName: data.familyName });
            this.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(record), record.id);
          }
        }
      }
    });
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
  validateIds(ids, lookup, allowEmpty = false) {
    if (!Array.isArray(ids) || (!allowEmpty && !ids.length) || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id || !lookup(id))) fail(400, 'INVALID_SCOPE', '请选择有效的家人或账号范围');
    return [...ids];
  }
  scope(familyIds = [], legacyAccountIds = []) {
    const familySet = new Set(familyIds);
    const accountIds = [...new Set([...legacyAccountIds, ...this.accounts().filter(a => a.familyId && familySet.has(a.familyId)).map(a => a.id)])];
    return { familyIds, legacyAccountIds, accountIds };
  }
  canRead(device, record) {
    if (!record) return false;
    const legacy = device.legacyAccountIds ?? (device.familyIds === undefined ? device.accountIds || [] : []);
    return legacy.includes(record.accountId) || !!record.familyId && (device.familyIds || []).includes(record.familyId);
  }
  canFilterAccount(device, id) {
    return device.accountIds.includes(id) || this.db.prepare('SELECT data FROM orders WHERE account_id=?').all(id).map(parse).some(order => this.canRead(device, order));
  }
  scopeSummary(scope) {
    const accounts = this.accounts(scope.accountIds).map(({ id, platform, label, familyId, familyName }) => ({ id, platform, label, familyId, familyName }));
    return { familyIds: scope.familyIds, legacyAccountIds: scope.legacyAccountIds, families: this.families(scope.familyIds).map(family => ({ ...family, accountCount: accounts.filter(a => a.familyId === family.id).length })),
      accountIds: scope.accountIds, accounts, includeFutureAccounts: scope.familyIds.length > 0 };
  }
  createPairing(input) {
    const body = Array.isArray(input) ? { accountIds: input } : input;
    onlyKeys(body, ['familyIds', 'accountIds']);
    if ((body.familyIds !== undefined) === (body.accountIds !== undefined)) fail(400, 'INVALID_SCOPE', '请选择家人整组授权或旧版账号授权');
    const familyIds = body.familyIds === undefined ? [] : this.validateIds(body.familyIds, id => this.family(id));
    const accountIds = body.accountIds === undefined ? [] : this.validateIds(body.accountIds, id => this.account(id));
    const code = hash(secret()).slice(0, 16).toUpperCase();
    const expiresAt = this.now() + 10 * 60000;
    this.db.prepare('DELETE FROM pairing WHERE expires_at<? OR used_at IS NOT NULL').run(this.now());
    this.db.prepare('INSERT INTO pairing(code_hash,account_ids,expires_at,used_at,family_ids) VALUES(?,?,?,NULL,?)').run(hash(code), JSON.stringify(accountIds), expiresAt, JSON.stringify(familyIds));
    return { code, expiresAt, ...this.scopeSummary(this.scope(familyIds, accountIds)) };
  }
  pairing(code) {
    code = text(code, '绑定码', 80).toUpperCase();
    const pair = this.db.prepare('SELECT * FROM pairing WHERE code_hash=?').get(hash(code));
    if (!pair || pair.used_at !== null || pair.expires_at <= this.now()) fail(400, 'INVALID_PAIRING_CODE', '绑定码无效、已使用或已过期');
    return pair;
  }
  previewPairing(code) {
    const pair = this.pairing(code);
    return { scope: this.scopeSummary(this.scope(JSON.parse(pair.family_ids), JSON.parse(pair.account_ids))), expiresAt: pair.expires_at };
  }
  redeem(code, deviceName) {
    code = text(code, '绑定码', 80).toUpperCase();
    deviceName = text(deviceName, '设备名称', 80);
    return this.transaction(() => {
      const pair = this.pairing(code);
      const token = `pcd_${secret()}`;
      const deviceId = randomUUID();
      this.db.prepare('UPDATE pairing SET used_at=? WHERE code_hash=?').run(this.now(), hash(code));
      this.db.prepare('INSERT INTO devices(id,token_hash,name,account_ids,created_at,revoked_at,family_ids) VALUES(?,?,?,?,?,NULL,?)').run(deviceId, hash(token), deviceName, pair.account_ids, this.now(), pair.family_ids);
      const scope = this.scope(JSON.parse(pair.family_ids), JSON.parse(pair.account_ids));
      return { token, deviceId, ...this.scopeSummary(scope), accounts: this.accounts(scope.accountIds), serverTime: this.now() };
    });
  }
  device(token) {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL').get(hash(token));
    if (!row) fail(401, 'DEVICE_UNAUTHORIZED', '设备授权无效，请重新绑定');
    return { id: row.id, ...this.scope(JSON.parse(row.family_ids), JSON.parse(row.account_ids)) };
  }
  devices() {
    return this.db.prepare('SELECT id,name,account_ids,family_ids,created_at,revoked_at FROM devices ORDER BY created_at DESC').all()
      .map(row => ({ id: row.id, name: row.name, ...this.scope(JSON.parse(row.family_ids), JSON.parse(row.account_ids)), createdAt: row.created_at, revokedAt: row.revoked_at }));
  }
  updateDevice(id, body) {
    onlyKeys(body, ['familyIds', 'accountIds']);
    const row = this.db.prepare('SELECT * FROM devices WHERE id=?').get(id);
    if (!row) fail(404, 'NOT_FOUND', '设备不存在');
    if (row.revoked_at !== null) fail(409, 'DEVICE_REVOKED', '已撤销设备不能重新授权');
    const familyIds = body.familyIds === undefined ? JSON.parse(row.family_ids) : this.validateIds(body.familyIds, familyId => this.family(familyId), true);
    const accountIds = body.accountIds === undefined ? JSON.parse(row.account_ids) : this.validateIds(body.accountIds, accountId => this.account(accountId), true);
    this.db.prepare('UPDATE devices SET family_ids=?,account_ids=? WHERE id=?').run(JSON.stringify(familyIds), JSON.stringify(accountIds), id);
    this.revision();
    return this.devices().find(device => device.id === id);
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
        const inputDate = validTime(input.orderDate) <= this.now() + 300000 ? validTime(input.orderDate) : 0;
        const verifiedDate = old?.orderDateSource === 'platform' && old.orderDate > 0;
        const checkedAt = validTime(input.dateCheckedAt) <= this.now() + 300000 ? validTime(input.dateCheckedAt) : 0;
        const incomingDetail = input.orderDateOrigin === 'detail';
        const replaceDate = !!inputDate && (!verifiedDate || (incomingDetail && (old?.orderDateOrigin !== 'detail' || checkedAt >= (old?.dateCheckedAt || 0))));
        const order = { ...old, id, accountId, platform: account.platform, platformOrderId,
          familyId: old ? old.familyId || '' : account.familyId, familyName: old ? old.familyName || '' : account.familyName,
          title: String(input.title || old?.title || ''), amount: input.amount == null ? old?.amount ?? null : input.amount,
          orderDate: replaceDate ? inputDate : old?.orderDate || 0,
          orderDateSource: replaceDate || verifiedDate ? 'platform' : old?.orderDate ? 'legacy' : 'unknown',
          orderDateOrigin: replaceDate ? incomingDetail ? 'detail' : 'list' : old?.orderDateOrigin || (verifiedDate ? 'list' : ''),
          dateCheckedAt: Math.max(old?.dateCheckedAt || 0, checkedAt),
          dateState: checkedAt >= (old?.dateCheckedAt || 0) && ['ok', 'empty', 'error', 'unavailable'].includes(input.dateState) ? input.dateState : old?.dateState || (inputDate ? 'ok' : 'unknown'),
          dateError: checkedAt >= (old?.dateCheckedAt || 0) && input.dateState ? shortText(input.dateError, 200) : old?.dateError || '',
          dateOverride: old?.dateOverride ?? null, dateOverrideAt: old?.dateOverrideAt || 0,
          firstSeenAt: old?.firstSeenAt || this.now(), tradeStatus: input.tradeStatus || old?.tradeStatus || '',
          orderStatus: input.orderStatus || old?.orderStatus || '',
          refundStatus: input.refundStatus || old?.refundStatus || '' };
        this.db.prepare('INSERT INTO orders VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, accountId, JSON.stringify(order));
      }
      for (const input of result.shipments) {
        if (!input.waybillNo) continue;
        const orderId = orderIds.get(String(input.platformOrderId)) || stableId(accountId, account.platform, 'order', String(input.platformOrderId));
        const order = this.order(orderId);
        if (!order) continue;
        // Order + carrier + waybill keeps every split parcel and prevents cross-account collisions.
        const carrier = carrierKey(input.carrier);
        const previous = this.db.prepare('SELECT data FROM shipments WHERE account_id=?').all(accountId).map(parse)
          .filter(s => s.orderId === orderId && s.waybillNo === String(input.waybillNo) && (!carrier || !s.carrier || carrierKey(s.carrier) === carrier));
        const id = previous.length === 1 ? previous[0].id : stableId(accountId, account.platform, orderId, carrier, String(input.waybillNo));
        const old = parse(this.db.prepare('SELECT data FROM shipments WHERE id=?').get(id));
        const status = ['transit', 'arrived', 'signed', 'unknown'].includes(input.status) ? input.status : 'unknown';
        const shipment = { id, orderId, accountId, familyId: old ? old.familyId || '' : order.familyId || '',
          familyName: old ? old.familyName || '' : order.familyName || '', waybillNo: String(input.waybillNo), carrier: input.carrier || old?.carrier || '', status,
          pickupCode: input.pickupCode || old?.pickupCode || '', station: input.station || old?.station || '',
          arrivalAt: old?.arrivalAt || (status === 'arrived' ? input.arrivalAt || this.now() : 0),
          updatedAt: input.updatedAt || this.now(), picked: old?.picked || false, hidden: old?.hidden || false,
          deleted: old?.deleted || false, manualAt: old?.manualAt || 0,
          ...logisticsData(input, old) };
        this.db.prepare('INSERT INTO shipments VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, accountId, JSON.stringify(shipment));
      }
      for (const failure of result.logisticsFailures || []) {
        if (!['error', 'unavailable', 'empty'].includes(failure.state)) continue;
        const orderId = stableId(accountId, account.platform, 'order', String(failure.platformOrderId));
        const rows = this.db.prepare('SELECT data FROM shipments WHERE account_id=?').all(accountId).map(parse);
        for (const old of rows.filter(s => s.orderId === orderId && (!failure.waybillNo || s.waybillNo === failure.waybillNo))) {
          if (failure.logisticsCheckedAt && failure.logisticsCheckedAt < (old.logisticsCheckedAt || 0)) continue;
          const updated = { ...old, ...logisticsData({ logisticsState: failure.state, logisticsError: failure.logisticsError, logisticsCheckedAt: failure.logisticsCheckedAt || this.now(), logisticsDetailCheckedAt: failure.logisticsDetailCheckedAt }, old), updatedAt: this.now() };
          this.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(updated), old.id);
        }
      }
      // Absence, pagination, refunds and source signatures never change manual state or tombstones.
      this.updateAccount(accountId, { status: 'ok', lastSuccessAt: this.now(), error: '', warnings: result.warnings || [] });
    });
  }
  snapshot(scope, accountFilter) {
    const device = Array.isArray(scope) ? { accountIds: scope, legacyAccountIds: scope, familyIds: [] } : scope;
    const narrowed = accountFilter && new Set(accountFilter);
    const visible = record => this.canRead(device, record) && (!narrowed || narrowed.has(record.accountId));
    const accounts = this.accounts(device.accountIds).filter(account => !narrowed || narrowed.has(account.id));
    const orders = this.db.prepare('SELECT data FROM orders ORDER BY id').all().map(parse).filter(visible)
      .map(o => ({ ...o, familyId: o.familyId || '', familyName: o.familyName || '', orderDateSource: o.orderDateSource || (o.orderDate ? 'legacy' : 'unknown'), firstSeenAt: o.firstSeenAt || 0,
        dateOverride: o.dateOverride ?? null, dateOverrideAt: o.dateOverrideAt || 0, dateState: o.dateState || 'unknown', dateError: o.dateError || '' }));
    const shipments = this.db.prepare('SELECT data FROM shipments ORDER BY id').all().map(parse).filter(visible).map(s => ({ ...s, familyId: s.familyId || '', familyName: s.familyName || '' }));
    const familyIds = device.familyIds || [];
    const families = this.families([...new Set([...familyIds, ...accounts.map(a => a.familyId), ...orders.map(o => o.familyId), ...shipments.map(s => s.familyId)].filter(Boolean))]);
    const histories = shipments.map(shipment => {
      const events = shipment.logisticsEvents || [];
      shipment.logisticsEvents = []; shipment.logisticsTruncated = !!shipment.logisticsTruncated;
      return { shipment, events };
    });
    const snapshot = { schemaVersion: 1, serverVersion, capabilities, serverRevision: this.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision, familyIds, legacyAccountIds: device.legacyAccountIds || [], families, accounts, orders, shipments,
      hiddenIds: shipments.filter(s => s.hidden).map(s => s.id), deletedIds: shipments.filter(s => s.deleted).map(s => s.id),
      events: shipments.filter(s => s.arrivalAt).map(s => ({ id: stableId(s.id, 'arrival', s.arrivalAt), shipmentId: s.id, arrivedAt: s.arrivalAt, code: s.pickupCode, stationKey: s.station })),
      syncWarnings: accounts.flatMap(a => (a.warnings || []).map(message => ({ accountId: a.id, message }))) };
    // Android caps the entire response at 2,000,000 bytes, not just the histories.
    // Reserve headroom and trim this response only; the SQLite cache remains intact.
    let historyBudget = Math.max(0, 1900000 - Buffer.byteLength(JSON.stringify(snapshot), 'utf8'));
    histories.sort((a, b) => Number(a.shipment.picked || a.shipment.hidden) - Number(b.shipment.picked || b.shipment.hidden));
    for (const { shipment, events } of histories) {
      for (const event of events) {
        const size = Buffer.byteLength(JSON.stringify(event), 'utf8') + (shipment.logisticsEvents.length ? 1 : 0);
        if (size > historyBudget) { shipment.logisticsTruncated = true; continue; }
        shipment.logisticsEvents.push(event); historyBudget -= size;
      }
    }
    return snapshot;
  }
  applyOperations(device, operations) {
    if (!Array.isArray(operations) || !operations.length || operations.length > 100) fail(400, 'INVALID_OPERATIONS', '每批操作须为1到100条');
    return this.transaction(() => {
      const appliedIds = [];
      for (const input of operations) {
        if (input?.action === 'setOrderDate') {
          onlyKeys(input, ['id', 'orderId', 'action', 'date', 'occurredAt']);
          const operation = { id: text(input.id, '操作ID', 128), orderId: text(input.orderId, '订单ID', 128), action: input.action, date: input.date, occurredAt: input.occurredAt };
          const validDate = operation.date === null || (typeof operation.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(operation.date)
            && Number.isFinite(Date.parse(operation.date + 'T00:00:00Z')) && new Date(operation.date + 'T00:00:00Z').toISOString().slice(0, 10) === operation.date);
          if (!validDate || !Number.isSafeInteger(operation.occurredAt) || operation.occurredAt <= 0 || operation.occurredAt > this.now() + 300000) fail(400, 'INVALID_OPERATION', '日期或操作时间无效');
          const order = this.order(operation.orderId);
          if (!this.canRead(device, order)) fail(403, 'SCOPE_FORBIDDEN', '订单不在授权范围内');
          const digest = hash(JSON.stringify(operation));
          const old = this.db.prepare('SELECT payload_hash FROM operations WHERE device_id=? AND id=?').get(device.id, operation.id);
          if (old && old.payload_hash !== digest) fail(409, 'OPERATION_CONFLICT', '相同操作ID不能用于不同内容');
          if (!old) {
            const stale = order.dateOverrideAt && operation.occurredAt <= order.dateOverrideAt;
            if (!stale) {
              Object.assign(order, { dateOverride: operation.date, dateOverrideAt: operation.occurredAt });
              this.db.prepare('UPDATE orders SET data=? WHERE id=?').run(JSON.stringify(order), order.id);
            }
            // Acknowledging a stale offline edit must still refresh the client's optimistic value.
            this.updateAccount(order.accountId, {});
            this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(device.id, operation.id, digest, JSON.stringify({ ...operation, appliedAt: this.now(), status: stale ? 'superseded' : 'applied' }));
          }
          appliedIds.push(operation.id); continue;
        }
        onlyKeys(input, ['id', 'shipmentId', 'action', 'occurredAt']);
        const operation = { id: text(input.id, '操作ID', 128), shipmentId: text(input.shipmentId, '运单ID', 128), action: input.action, occurredAt: input.occurredAt };
        if (!['pick', 'restore', 'hide', 'unhide'].includes(operation.action) || !Number.isSafeInteger(operation.occurredAt) || operation.occurredAt < 0 || operation.occurredAt > this.now() + 5 * 60000) fail(400, 'INVALID_OPERATION', '不支持的操作或时间');
        const shipment = parse(this.db.prepare('SELECT data FROM shipments WHERE id=?').get(operation.shipmentId));
        if (!this.canRead(device, shipment)) fail(403, 'SCOPE_FORBIDDEN', '运单不在授权范围内');
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
    const record = result.orderId ? this.order(result.orderId) : parse(this.db.prepare('SELECT data FROM shipments WHERE id=?').get(result.shipmentId));
    if (!this.canRead(device, record)) fail(403, 'SCOPE_FORBIDDEN', '记录不在授权范围内');
    return result;
  }
}

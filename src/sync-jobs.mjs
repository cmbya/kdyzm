import { randomUUID } from 'node:crypto';
import { fail } from './security.mjs';
import { activeKnownOrders } from './collector-enrichment.mjs';
import { COLLECTION_COOLDOWN, isCollectionStale, scheduledPlatform, scheduledSyncAt } from './collection-schedule.mjs';
import { createLogisticsQueue } from './sync-logistics.mjs';
import { stableId } from './store.mjs';
import { isLocalDeliveryOrder } from './order-fulfillment.mjs';

const INTERVAL = COLLECTION_COOLDOWN;
const active = job => ['queued', 'running'].includes(job.state);
const safeError = error => ({ ACCOUNT_EXPIRED: '平台登录态已失效，请在后台更新登录信息',
  UPSTREAM_RATE_LIMITED: '平台暂时限流，已保存进度并等待重试',
  UPSTREAM_BLOCKED: '平台拒绝访问或触发风控，请稍后重试', UPSTREAM_FORMAT: '平台返回字段暂不可解析，已保留原记录',
  UPSTREAM_ERROR: '平台接口暂不可用，请稍后重试' })[error?.code] || '同步未完成，已保留原记录，请稍后重试';
const partialErrors = {
  date: { error: '部分订单日期补查失败，已保留原日期', unavailable: '部分订单暂不支持日期补查，日期仍待确认', empty: '部分订单详情未返回有效下单日期' },
  logistics: { error: '部分运单物流查询失败，已保留原轨迹', unavailable: '平台暂未提供部分运单的物流轨迹', empty: '部分运单本次未返回物流轨迹，已保留原记录' },
};

function fullResult(job, result) {
  const parts = [['date', [...(result.orders || []), ...(result.orderUpdates || [])]],
    ['logistics', [...(result.shipments || []), ...(result.logisticsFailures || []).map(item => ({ logisticsState: item.state }))]]];
  for (const [part, items] of parts) {
    const states = items.map(item => {
      const state = item[`${part}State`];
      return ['error', 'unavailable', 'empty'].includes(state) ? state : item[`${part}Error`] ? 'error' : state;
    });
    const state = ['error', 'unavailable', 'empty', 'ok'].find(value => states.includes(value));
    if (state) Object.assign(job, { [`${part}State`]: state, [`${part}Error`]: partialErrors[part][state] || '' });
  }
}

export function createSyncJobs({ store, collector, now, onImported = () => {}, onCompleted = () => {} }) {
  const records = new Map(), scopes = new Map(), queues = new Map(), timers = new Map(), running = new Map();
  const logistics = createLogisticsQueue({ store, now });
  store.db.exec(`CREATE TABLE IF NOT EXISTS sync_job_summaries (
    account_id TEXT NOT NULL REFERENCES accounts(id), order_id TEXT NOT NULL, account_version INTEGER NOT NULL,
    data TEXT NOT NULL, updated_at INTEGER NOT NULL, active INTEGER NOT NULL,
    PRIMARY KEY(account_id,order_id));`);
  let closed = false;
  const persist = record => {
    record.job.updatedAt = Math.max(now(), record.job.createdAt || 0, (record.job.updatedAt || 0) + 1);
    store.transaction(() => {
      store.db.prepare(`INSERT INTO sync_job_summaries VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,order_id)
        DO UPDATE SET account_version=excluded.account_version,data=excluded.data,updated_at=excluded.updated_at,active=excluded.active`)
        .run(record.job.accountId, record.job.orderId, record.accountVersion, JSON.stringify(record.job), record.job.updatedAt, active(record.job) ? 1 : 0);
      // Bound historical scope summaries without discarding an in-flight operation.
      if (!active(record.job)) store.db.exec(`DELETE FROM sync_job_summaries WHERE rowid IN
        (SELECT rowid FROM sync_job_summaries WHERE active=0 ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET 1000)`);
      store.revision();
    });
    if (active(record.job)) for (const follower of records.values()) if (follower.job.parentJobId === record.job.id && active(follower.job)) {
      Object.assign(follower.job, { state: record.job.state, retryAt: record.job.retryAt || 0,
        continuation: !!record.job.continuation, error: record.job.error }); persist(follower);
    }
  };
  const makeRecord = (job, accountVersion) => {
    let resolve;
    const record = { job, accountVersion, createdAt: job.createdAt, done: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
    records.set(job.id, record); scopes.set(`${job.accountId}:${job.orderId}`, record);
    return record;
  };
  const finish = record => {
    record.job.finishedAt = now(); persist(record); record.resolve(record.job);
    if (!active(record.job)) logistics.clear(record.job.id);
    for (const follower of records.values()) if (follower.job.parentJobId === record.job.id && active(follower.job)) {
      Object.assign(follower.job, { state: record.job.state, retryAt: record.job.retryAt || 0, error: record.job.error,
      });
      if (record.job.state === 'completed') orderOutcome(follower.job);
      if (!active(record.job)) finish(follower); else persist(follower);
    }
  };
  function orderOutcome(job, result = {}) {
    const order = store.order(job.orderId);
    const parcels = store.db.prepare("SELECT data FROM shipments WHERE account_id=? AND json_extract(data,'$.orderId')=?")
      .all(job.accountId, job.orderId).map(row => JSON.parse(row.data));
    const state = ['error', 'unavailable', 'empty', 'ok'].find(value => parcels.some(s => s.logisticsState === value)
      || result.logisticsFailures?.some(failure => failure.state === value)) || 'unavailable';
    Object.assign(job, { dateState: order?.dateState || 'unknown', dateError: order?.dateError || '',
      logisticsState: state, logisticsError: parcels.find(s => s.logisticsState === state)?.logisticsError || (parcels.length ? '' : '平台尚未提供可查询运单') });
  }
  const saved = (accountId, orderId) => {
    const row = store.db.prepare('SELECT account_version,data FROM sync_job_summaries WHERE account_id=? AND order_id=?').get(accountId, orderId);
    return row && row.account_version === store.account(accountId)?.credentialVersion ? JSON.parse(row.data) : null;
  };
  const context = (accountId, orderId) => {
    const previous = store.snapshot([accountId]);
    const selected = previous.orders.filter(order => !orderId || order.id === orderId);
    const knownOrders = selected.map(order => ({ ...order, shipments: previous.shipments.filter(s => s.orderId === order.id)
      .map(s => ({ ...s, hidden: s.hidden || s.deleted })) }));
    const trackedOrderIds = activeKnownOrders(knownOrders, new Set(), knownOrders.length).map(o => o.platformOrderId);
    return { knownOrders, trackedOrderIds, ...(orderId ? { targetOrder: knownOrders[0] } : {}) };
  };
  function pump(accountId) {
    if (closed || running.has(accountId)) return;
    clearTimeout(timers.get(accountId)); timers.delete(accountId);
    const queue = queues.get(accountId) || [];
    if (!queue.length) return;
    const record = queue[0], account = store.account(accountId);
    if (!account?.enabled) {
      queue.shift(); Object.assign(record.job, { state: 'disabled', retryAt: 0, error: '账号同步已关闭，请先在后台启用' });
      finish(record); pump(accountId); return;
    }
    const retryAt = record.job.continuation ? record.job.retryAt || 0 : account.lastAttemptAt ? account.lastAttemptAt + INTERVAL : 0;
    if (retryAt > now()) {
      if (record.job.retryAt !== retryAt) { record.job.retryAt = retryAt; persist(record); }
      timers.set(accountId, setTimeout(() => pump(accountId), retryAt - now()).unref()); return;
    }
    queue.shift();
    if (record.accountVersion !== account.credentialVersion) {
      logistics.clear(record.job.id);
      for (const field of ['logisticsProgress', 'retryCount', 'throttled', 'continuation', 'collectedOrderIds']) delete record.job[field];
    }
    record.accountVersion = account.credentialVersion;
    Object.assign(record.job, { state: 'running', retryAt: 0, startedAt: now(), error: '',
      familyId: (record.job.orderId ? store.order(record.job.orderId) : account)?.familyId || '' });
    persist(record);
    store.updateAccount(accountId, { status: 'syncing', lastAttemptAt: now(),
      nextSyncAt: scheduledSyncAt(account.platform, now() + INTERVAL - 1, account.intervalMinutes), error: '' });
    const task = Promise.resolve().then(async () => {
      let continuing = false;
      try {
        const options = context(accountId, record.job.orderId);
        let importedOnce = false;
        if (record.job.orderId && !options.targetOrder) throw new Error('Order removed');
        const valid = () => {
          if (closed) throw Object.assign(new Error('Service stopping'), { code: 'SERVICE_STOPPING' });
          const current = store.account(accountId);
          if (!current?.enabled) throw Object.assign(new Error('Account disabled'), { code: 'ACCOUNT_DISABLED' });
          if (current.credentialVersion !== account.credentialVersion) throw Object.assign(new Error('Account changed'), { code: 'ACCOUNT_CHANGED' });
        };
        const importDelta = (data, partial = true) => {
          valid();
          const delta = { ...data, orders: data.orders || [], shipments: data.shipments || [] };
          // A targeted collector must never import unrelated records, including streamed deltas.
          if (options.targetOrder) {
            const matches = item => String(item.platformOrderId) === options.targetOrder.platformOrderId;
            for (const key of ['orders', 'orderUpdates', 'shipments', 'logisticsFailures']) delta[key] = (delta[key] || []).filter(matches);
          }
          const imported = store.importResult(accountId, delta, { partial, reconcile: !importedOnce });
          // Track this run, not every historical order touched by metadata reconciliation.
          const ids = new Set(record.job.collectedOrderIds || []);
          for (const item of [...delta.orders, ...delta.shipments, ...(delta.logisticsFailures || [])]) {
            const id = stableId(accountId, account.platform, 'order', String(item.platformOrderId));
            if (store.order(id)) ids.add(id);
          }
          record.job.collectedOrderIds = [...ids];
          importedOnce = true;
          if (!record.job.firstResultAt && delta.shipments.some(shipment => shipment.logisticsEvents?.length)) record.job.firstResultAt = now();
          if (imported?.evidenceChanged !== false) try { onImported(accountId, imported?.changedShipmentIds); } catch { /* Retry on the next import. */ }
          fullResult(record.job, delta);
          persist(record);
        };
        valid();
        const result = await collector(account, store.cookie(accountId), { ...options, durableLogistics: true,
          onCookieRefresh: cookie => {
            const current = store.account(accountId);
            if (!current?.enabled || current.credentialVersion !== account.credentialVersion) throw Object.assign(new Error('Account changed'), { code: 'ACCOUNT_CHANGED' });
            // Persist session rotation even during shutdown; it must never enter task checkpoints or snapshots.
            store.refreshCookie(accountId, cookie);
          },
          onProgress: delta => importDelta(delta),
          runLogistics: (items, worker, settings) => logistics.run(record, items, worker, settings, { valid,
            relevant: item => {
              if (!item?.platformOrderId) return true;
              const order = store.order(stableId(accountId, account.platform, 'order', String(item.platformOrderId)));
              if (!order || order.archived || order.hidden || order.deleted) return false;
              const parcels = store.db.prepare("SELECT data FROM shipments WHERE account_id=? AND json_extract(data,'$.orderId')=?")
                .all(accountId, order.id).map(row => JSON.parse(row.data)).filter(parcel => !item.waybillNo || parcel.waybillNo === item.waybillNo);
              return !parcels.length || parcels.some(parcel => !parcel.picked && !parcel.hidden && !parcel.deleted);
            },
            changed: progress => { record.job.logisticsProgress = progress; persist(record); } }),
        });
        valid();
        if (result.refreshedCookie) store.refreshCookie(accountId, result.refreshedCookie);
        importDelta(result, false);
        if (!record.job.orderId) store.updateAccount(accountId, { lastFullSuccessAt: now() });
        try { onCompleted(accountId); } catch { /* Cached classification is refreshed on the next sync. */ }
        record.job.state = 'completed';
        if (record.job.orderId) orderOutcome(record.job, result); else fullResult(record.job, result);
      } catch (error) {
        if (!store.account(accountId)) {
          Object.assign(record.job, { state: 'disabled', retryAt: 0, error: '账号已删除，采集已停止' }); return;
        }
        if (store.account(accountId)?.credentialVersion !== account.credentialVersion) {
          Object.assign(record.job, { state: 'error', error: '账号登录信息已更新，请重新刷新' }); return;
        }
        if (error.code === 'ACCOUNT_DISABLED') {
          Object.assign(record.job, { state: 'disabled', retryAt: 0, error: '账号同步已关闭，请先在后台启用' }); return;
        }
        if (error.code === 'SERVICE_STOPPING' || error.logisticsRetryable && (record.job.retryCount || 0) < 3) {
          const attempt = (record.job.retryCount || 0) + (closed ? 0 : 1);
          const throttle = ['UPSTREAM_BLOCKED', 'UPSTREAM_RATE_LIMITED'].includes(error.code);
          const delay = Math.min(15 * 60000, Math.max(Number(error.retryAfterMs) || 0, throttle ? INTERVAL : 15000 * 2 ** (attempt - 1)));
          Object.assign(record.job, { state: 'queued', continuation: true, retryCount: attempt,
            throttled: record.job.throttled || throttle, retryAt: closed ? now() : now() + delay,
            error: closed ? '' : '部分查询暂未完成，已保存进度，将自动继续' });
          persist(record); continuing = true;
          if (!closed) { (queues.get(accountId) || []).unshift(record); }
          else record.resolve(record.job);
          return;
        }
        const message = safeError(error), expired = error.code === 'ACCOUNT_EXPIRED';
        Object.assign(record.job, { state: expired ? 'expired' : 'error', error: message });
        store.updateAccount(accountId, { status: expired ? 'expired' : 'error', error: message, warnings: [] });
      } finally {
        running.delete(accountId); if (!continuing) finish(record); pump(accountId);
      }
    });
    running.set(accountId, task);
  }
  function request(accountId, orderId = '', { onlyIfStale = false } = {}) {
    if (closed) fail(503, 'SERVICE_STOPPING', '服务正在重启，请稍后重试');
    const account = store.account(accountId);
    if (!account) fail(404, 'NOT_FOUND', '账号不存在');
    if (orderId && store.order(orderId)?.accountId !== accountId) fail(403, 'SCOPE_FORBIDDEN', '订单不在授权范围内');
    if (onlyIfStale && (!isCollectionStale(account, now()) || running.has(accountId) || queues.get(accountId)?.length)) return null;
    const key = `${accountId}:${orderId}`, existing = scopes.get(key);
    if (existing && existing.accountVersion === account.credentialVersion && (active(existing.job) || (account.enabled && existing.job.state === 'cooldown' && existing.job.retryAt > now()))) {
      if (existing.job.state === 'queued') pump(accountId);
      return existing;
    }
    for (const [id, value] of records) if (!active(value.job) && (now() - value.createdAt > 3600000 || records.size >= 1000)) {
      records.delete(id);
      const scope = `${value.job.accountId}:${value.job.orderId}`;
      if (scopes.get(scope) === value) scopes.delete(scope);
    }
    const queue = queues.get(accountId) || [];
    queues.set(accountId, queue);
    const retryAt = account.lastAttemptAt ? account.lastAttemptAt + INTERVAL : 0;
    const inFlight = running.has(accountId) || queue.length > 0;
    // Keep a single pending request per scope. The account timer starts it at
    // the original cooldown deadline; repeated clicks never extend that time.
    const state = !account.enabled ? 'disabled' : queue.length >= 25 ? 'cooldown' : 'queued';
    const previousTime = store.db.prepare('SELECT updated_at FROM sync_job_summaries WHERE account_id=? AND order_id=?').get(accountId, orderId)?.updated_at || 0;
    const job = { id: randomUUID(), accountId, orderId, resumeVersion: 1, familyId: (orderId ? store.order(orderId) : account)?.familyId || '', state,
      createdAt: Math.max(now(), previousTime + 1),
      retryAt: state !== 'disabled' && (retryAt > now() || inFlight || state === 'cooldown') ? Math.max(retryAt, now() + (queue.length >= 25 ? INTERVAL : 0)) : 0,
      error: state === 'disabled' ? '账号同步已关闭，请先在后台启用' : state === 'cooldown' ? '账号等待任务已满，本次未排队，请稍后重新获取' : '' };
    const record = makeRecord(job, account.credentialVersion);
    const full = scopes.get(`${accountId}:`);
    // Keep the order's own authorization scope while joining a full refresh that covers its active parcels.
    if (account.enabled && orderId && full && full.accountVersion === account.credentialVersion && active(full.job)
      && activeKnownOrders(context(accountId, orderId).knownOrders, new Set(), 1).length) {
      Object.assign(job, { parentJobId: full.job.id, state: full.job.state, retryAt: full.job.retryAt || 0 });
      persist(record); return record;
    }
    if (!orderId && state === 'queued') {
      const covered = new Set(activeKnownOrders(context(accountId, '').knownOrders, new Set(), Number.MAX_SAFE_INTEGER).map(order => order.id));
      for (let index = queue.length - 1; index >= 0; index--) {
        const pending = queue[index];
        if (pending.accountVersion === account.credentialVersion && covered.has(pending.job.orderId)) {
          queue.splice(index, 1);
          Object.assign(pending.job, { parentJobId: job.id, retryAt: job.retryAt }); persist(pending);
        }
      }
    }
    persist(record);
    if (state === 'queued') { queue.push(record); pump(accountId); } else finish(record);
    return record;
  }
  for (const row of store.db.prepare('SELECT account_version,data FROM sync_job_summaries WHERE active=1 ORDER BY updated_at').all()) {
    const job = JSON.parse(row.data), account = store.account(job.accountId);
    if (job.resumeVersion === 1 && account?.enabled && account.credentialVersion === row.account_version) {
      Object.assign(job, { state: 'queued', continuation: true, retryAt: job.retryAt || 0, error: '' });
      const record = makeRecord(job, row.account_version);
      persist(record);
      if (!job.parentJobId) { const queue = queues.get(job.accountId) || []; queue.push(record); queues.set(job.accountId, queue); }
    } else {
      Object.assign(job, { state: 'error', retryAt: 0, finishedAt: now(), error: '服务重启中断了采集，请重新刷新' });
      persist({ job, accountVersion: row.account_version });
      if (account?.credentialVersion === row.account_version) store.updateAccount(job.accountId, { status: 'error', error: job.error });
      logistics.clear(job.id);
    }
  }
  for (const record of records.values()) if (record.job.parentJobId) {
    const parent = records.get(record.job.parentJobId)?.job || (() => {
      const row = store.db.prepare("SELECT data FROM sync_job_summaries WHERE json_extract(data,'$.id')=? AND account_version=?")
        .get(record.job.parentJobId, record.accountVersion);
      return row && JSON.parse(row.data);
    })();
    if (parent && !active(parent)) { Object.assign(record.job, { state: parent.state, error: parent.error, retryAt: 0 }); if (parent.state === 'completed') orderOutcome(record.job); finish(record); }
    else if (!parent) {
      delete record.job.parentJobId;
      const queue = queues.get(record.job.accountId) || []; queue.push(record); queues.set(record.job.accountId, queue); persist(record);
    }
  }
  // Delay recovery until the service has finished constructing its import callbacks.
  queueMicrotask(() => { for (const id of queues.keys()) pump(id); });
  return { running, request, pump,
    cancelAccount(accountId) {
      clearTimeout(timers.get(accountId)); timers.delete(accountId);
      queues.delete(accountId);
      for (const record of records.values()) if (record.job.accountId === accountId && active(record.job)) {
        Object.assign(record.job, { state: 'disabled', retryAt: 0, error: '账号已删除，采集已停止' });
        finish(record);
      }
    },
    runDue() {
      if (closed) return [];
      const time = now(), platform = scheduledPlatform(time), accounts = store.accounts();
      // A late timer or restart must not bunch adjacent platforms together.
      if (accounts.some(account => account.platform !== platform && account.lastAttemptAt && time - account.lastAttemptAt < INTERVAL)) return [];
      return accounts.filter(account => account.enabled && account.status !== 'expired' && account.platform === platform
        && account.nextSyncAt <= time && !running.has(account.id) && !queues.get(account.id)?.length)
        .map(account => request(account.id));
    },
    latest(accountId, { includeOrders = false } = {}) {
      const job = saved(accountId, '');
      if (!includeOrders || !job || !Array.isArray(job.collectedOrderIds)) return job;
      const rows = store.db.prepare(`SELECT data FROM orders WHERE account_id=?
        AND id IN (SELECT value FROM json_each(?))`).all(accountId, JSON.stringify(job.collectedOrderIds));
      const parcels = store.db.prepare(`SELECT data FROM shipments WHERE account_id=?
        AND json_extract(data,'$.orderId') IN (SELECT value FROM json_each(?))`)
        .all(accountId, JSON.stringify(job.collectedOrderIds)).map(row => JSON.parse(row.data));
      const byOrder = new Map();
      for (const parcel of parcels) {
        if (parcel.hidden || parcel.deleted || parcel.archived || parcel.picked || parcel.status === 'signed') continue;
        const events = (parcel.logisticsEvents || []).filter(event => event.description);
        const latest = events.reduce((best, event) => !best || (Number(event.time) || 0) > (Number(best.time) || 0) ? event : best, null);
        // Older Taobao records may still say arrived because the receipt mentions
        // a locker. An explicit code-based receipt is completion, not a pickup notice.
        if (/签收人凭(?:取货|取件)码签收/.test(latest?.description || '')
          && !/未签收|待签收|等待|请凭|尚未|虚假|误签|未收到/.test(latest.description)) continue;
        const list = byOrder.get(parcel.orderId) || [];
        list.push({ waybillNo: parcel.waybillNo, carrier: parcel.carrier,
          latestEvent: latest ? { time: latest.time, description: latest.description } : null,
          logisticsState: parcel.logisticsState, logisticsError: parcel.logisticsError });
        byOrder.set(parcel.orderId, list);
      }
      const ordersWithParcels = new Set(parcels.map(parcel => parcel.orderId));
      return { ...job, orders: rows.map(row => JSON.parse(row.data)).filter(order => !order.hidden && !order.deleted && !order.archived
        && !isLocalDeliveryOrder(order) && (!ordersWithParcels.has(order.id) || byOrder.has(order.id)))
        .map(order => ({ id: order.id, title: order.title, platformOrderId: order.platformOrderId, shipments: byOrder.get(order.id) || [] })) };
    },
    snapshot(device, accountFilter) {
      const narrowed = accountFilter && new Set(accountFilter);
      const syncJobs = [];
      for (const row of store.db.prepare('SELECT account_id,account_version,data FROM sync_job_summaries ORDER BY updated_at DESC,rowid DESC').all()) {
        if (narrowed && !narrowed.has(row.account_id)) continue;
        if (row.account_version !== store.account(row.account_id)?.credentialVersion) continue;
        const job = JSON.parse(row.data);
        if (job.orderId ? !store.canRead(device, store.order(job.orderId)) : !device.accountIds.includes(job.accountId)) continue;
        syncJobs.push(job);
        if (syncJobs.length === 100) break;
      }
      return { syncJobs };
    },
    read(id) {
      const record = records.get(id);
      const row = record ? { account_id: record.job.accountId, account_version: record.accountVersion, data: JSON.stringify(record.job) }
        : store.db.prepare("SELECT account_id,account_version,data FROM sync_job_summaries WHERE json_extract(data,'$.id')=?").get(id);
      if (!row || row.account_version !== store.account(row.account_id)?.credentialVersion) fail(404, 'NOT_FOUND', '同步任务已过期，请重新刷新');
      return JSON.parse(row.data);
    },
    async close() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      for (const queue of queues.values()) for (const record of queue) {
        Object.assign(record.job, { state: 'queued', continuation: true, error: '' }); persist(record); record.resolve(record.job);
      }
      await Promise.all([...running.values()]);
      for (const record of records.values()) if (active(record.job)) record.resolve(record.job);
    },
  };
}

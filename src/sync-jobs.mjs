import { randomUUID } from 'node:crypto';
import { fail } from './security.mjs';

const INTERVAL = 5 * 60000;
const active = job => ['queued', 'running'].includes(job.state);
const safeError = error => ({ ACCOUNT_EXPIRED: '平台登录态已失效，请在后台更新登录信息',
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

export function createSyncJobs({ store, collector, now, onImported = () => {} }) {
  const records = new Map(), scopes = new Map(), queues = new Map(), timers = new Map(), running = new Map();
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
      store.db.exec(`DELETE FROM sync_job_summaries WHERE rowid IN
        (SELECT rowid FROM sync_job_summaries WHERE active=0 ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET 1000)`);
      store.revision();
    });
  };
  for (const row of store.db.prepare('SELECT account_version,data FROM sync_job_summaries WHERE active=1').all()) {
    const job = JSON.parse(row.data);
    const account = store.account(job.accountId);
    if (job.state === 'running' && account?.credentialVersion === row.account_version && account.status === 'syncing') {
      store.updateAccount(job.accountId, { status: 'error', error: '服务重启中断了采集，请重新刷新', warnings: [] });
    }
    Object.assign(job, { state: 'error', retryAt: 0, finishedAt: now(), error: '服务重启中断了采集，请重新刷新' });
    persist({ job, accountVersion: row.account_version });
  }
  const finish = record => { record.job.finishedAt = now(); persist(record); record.resolve(record.job); };
  const saved = (accountId, orderId) => {
    const row = store.db.prepare('SELECT account_version,data FROM sync_job_summaries WHERE account_id=? AND order_id=?').get(accountId, orderId);
    return row && row.account_version === store.account(accountId)?.credentialVersion ? JSON.parse(row.data) : null;
  };
  const context = (accountId, orderId) => {
    const previous = store.snapshot([accountId]);
    const selected = previous.orders.filter(order => !orderId || order.id === orderId);
    const knownOrders = selected.map(order => ({ ...order, shipments: previous.shipments.filter(s => s.orderId === order.id)
      .map(s => ({ ...s, hidden: s.hidden || s.deleted })) }));
    const trackedOrderIds = knownOrders.filter(order => order.shipments.some(s => !s.picked && !s.hidden && s.status !== 'signed')).map(o => o.platformOrderId);
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
    const retryAt = account.lastAttemptAt ? account.lastAttemptAt + INTERVAL : 0;
    if (retryAt > now()) {
      if (record.job.retryAt !== retryAt) { record.job.retryAt = retryAt; persist(record); }
      timers.set(accountId, setTimeout(() => pump(accountId), retryAt - now()).unref()); return;
    }
    queue.shift(); record.accountVersion = account.credentialVersion;
    Object.assign(record.job, { state: 'running', retryAt: 0, startedAt: now(), error: '',
      familyId: (record.job.orderId ? store.order(record.job.orderId) : account)?.familyId || '' });
    persist(record);
    store.updateAccount(accountId, { status: 'syncing', lastAttemptAt: now(), nextSyncAt: now() + account.intervalMinutes * 60000, error: '' });
    const task = Promise.resolve().then(async () => {
      try {
        const options = context(accountId, record.job.orderId);
        if (record.job.orderId && !options.targetOrder) throw new Error('Order removed');
        const result = await collector(account, store.cookie(accountId), options);
        if (store.account(accountId).credentialVersion !== account.credentialVersion) {
          Object.assign(record.job, { state: 'error', error: '账号登录信息已更新，请重新刷新' }); return;
        }
        // A targeted collector must never import unrelated records, even if an upstream response includes them.
        if (options.targetOrder) {
          const matches = item => String(item.platformOrderId) === options.targetOrder.platformOrderId;
          for (const key of ['orders', 'orderUpdates', 'shipments', 'logisticsFailures']) result[key] = (result[key] || []).filter(matches);
        }
        store.importResult(accountId, result);
        // Optional station enrichment cannot turn a successful platform import into a sync failure.
        try { onImported(accountId); } catch { /* Retry with the next successful import. */ }
        if (result.refreshedCookie) store.refreshCookie(accountId, result.refreshedCookie);
        record.job.state = 'completed';
        if (record.job.orderId) {
          const snapshot = store.snapshot([accountId]), order = snapshot.orders.find(o => o.id === record.job.orderId);
          const parcels = snapshot.shipments.filter(s => s.orderId === record.job.orderId);
          const state = ['error', 'unavailable', 'empty', 'ok'].find(value => parcels.some(s => s.logisticsState === value) || result.logisticsFailures?.some(failure => failure.state === value)) || 'unavailable';
          Object.assign(record.job, { dateState: order?.dateState || 'unknown', dateError: order?.dateError || '',
            logisticsState: state, logisticsError: parcels.find(s => s.logisticsState === state)?.logisticsError || (parcels.length ? '' : '平台尚未提供可查询运单') });
        } else fullResult(record.job, result);
      } catch (error) {
        if (store.account(accountId).credentialVersion !== account.credentialVersion) {
          Object.assign(record.job, { state: 'error', error: '账号登录信息已更新，请重新刷新' }); return;
        }
        const message = safeError(error), expired = error.code === 'ACCOUNT_EXPIRED';
        Object.assign(record.job, { state: expired ? 'expired' : 'error', error: message });
        store.updateAccount(accountId, { status: expired ? 'expired' : 'error', error: message, warnings: [] });
      } finally {
        running.delete(accountId); finish(record); pump(accountId);
      }
    });
    running.set(accountId, task);
  }
  function request(accountId, orderId = '') {
    if (closed) fail(503, 'SERVICE_STOPPING', '服务正在重启，请稍后重试');
    const account = store.account(accountId);
    if (!account) fail(404, 'NOT_FOUND', '账号不存在');
    if (orderId && store.order(orderId)?.accountId !== accountId) fail(403, 'SCOPE_FORBIDDEN', '订单不在授权范围内');
    const key = `${accountId}:${orderId}`, existing = scopes.get(key);
    if (existing && (active(existing.job) || (account.enabled && existing.accountVersion === account.credentialVersion && existing.job.state === 'cooldown' && existing.job.retryAt > now()))) {
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
    const job = { id: randomUUID(), accountId, orderId, familyId: (orderId ? store.order(orderId) : account)?.familyId || '', state,
      createdAt: Math.max(now(), previousTime + 1),
      retryAt: state !== 'disabled' && (retryAt > now() || inFlight || state === 'cooldown') ? Math.max(retryAt, now() + (queue.length >= 25 ? INTERVAL : 0)) : 0,
      error: state === 'disabled' ? '账号同步已关闭，请先在后台启用' : state === 'cooldown' ? '账号等待任务已满，本次未排队，请稍后重新获取' : '' };
    let resolve;
    const record = { job, accountVersion: account.credentialVersion, createdAt: now(), done: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
    records.set(job.id, record); scopes.set(key, record);
    persist(record);
    if (state === 'queued') { queue.push(record); pump(accountId); } else finish(record);
    return record;
  }
  return { running, request, pump,
    latest(accountId) {
      return saved(accountId, '');
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
        Object.assign(record.job, { state: 'error', retryAt: 0, error: '服务已停止，请重新刷新' }); finish(record);
      }
      await Promise.all([...running.values()]);
    },
  };
}

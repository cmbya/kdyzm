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

export function createSyncJobs({ store, collector, now }) {
  const records = new Map(), scopes = new Map(), queues = new Map(), timers = new Map(), running = new Map();
  let closed = false;
  const finish = record => { record.resolve(record.job); };
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
      record.job.retryAt = retryAt;
      timers.set(accountId, setTimeout(() => pump(accountId), retryAt - now()).unref()); return;
    }
    queue.shift(); Object.assign(record.job, { state: 'running', retryAt: 0, error: '' });
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
    if (existing && (active(existing.job) || (account.enabled && existing.accountVersion === account.credentialVersion && existing.job.state === 'cooldown' && existing.job.retryAt > now()))) return existing;
    for (const [id, value] of records) if (!active(value.job) && (now() - value.createdAt > 3600000 || records.size >= 1000)) {
      records.delete(id);
      const scope = `${value.job.accountId}:${value.job.orderId}`;
      if (scopes.get(scope) === value) scopes.delete(scope);
    }
    const queue = queues.get(accountId) || [];
    queues.set(accountId, queue);
    const retryAt = account.lastAttemptAt ? account.lastAttemptAt + INTERVAL : 0;
    const inFlight = running.has(accountId) || queue.length > 0;
    const state = !account.enabled ? 'disabled' : queue.length >= 25 ? 'cooldown' : !inFlight && retryAt > now() ? 'cooldown' : 'queued';
    const job = { id: randomUUID(), accountId, orderId, state, retryAt: state === 'cooldown' || inFlight ? Math.max(retryAt, now() + (queue.length >= 25 ? INTERVAL : 0)) : 0,
      error: state === 'disabled' ? '账号同步已关闭，请先在后台启用' : state === 'cooldown' ? '平台查询冷却中，请在提示时间后重试' : '' };
    let resolve;
    const record = { job, accountVersion: account.credentialVersion, createdAt: now(), done: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
    records.set(job.id, record); scopes.set(key, record);
    if (state === 'queued') { queue.push(record); pump(accountId); } else finish(record);
    return record;
  }
  return { running, request, pump,
    read(id) { const record = records.get(id); if (!record) fail(404, 'NOT_FOUND', '同步任务已过期或服务已重启，请重新刷新'); return { ...record.job }; },
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

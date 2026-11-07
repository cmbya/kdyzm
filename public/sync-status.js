export function createServerClock(monotonicNow = () => performance.now(), wallNow = () => Date.now()) {
  let serverTime = wallNow(), receivedAt = monotonicNow();
  return {
    update(value) {
      if (!Number.isFinite(value) || value <= 0) return;
      serverTime = value; receivedAt = monotonicNow();
    },
    now: () => serverTime + monotonicNow() - receivedAt,
  };
}

function remaining(retryAt, now) {
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

export function syncStatus(account, now) {
  const job = account.syncJob;
  if (!job) return { label: account.status === 'syncing' ? '采集中' : '尚无采集任务', pending: account.status === 'syncing', details: [] };
  const details = [...new Set([job.error, job.dateError, job.logisticsError].filter(Boolean))];
  const pending = job.state === 'queued' || job.state === 'running';
  let label;
  if (job.state === 'queued') label = job.retryAt > now ? `已排队 · ${remaining(job.retryAt, now)}后采集` : '已排队 · 等待采集';
  else if (job.state === 'running') label = '采集中';
  else if (job.state === 'cooldown') label = job.retryAt > now ? `未排队 · ${remaining(job.retryAt, now)}后可重试` : '未排队 · 可重新采集';
  else if (job.state === 'disabled') label = '采集已停用';
  else if (job.state === 'completed') {
    if (job.error || ['error', 'expired'].includes(account.status)) label = '采集失败';
    else if (['date', 'logistics'].some(part => job[`${part}State`] === 'error' ||
      (!['ok', 'empty', 'unavailable'].includes(job[`${part}State`]) && job[`${part}Error`]))) label = '采集完成 · 部分信息未更新';
    else if ([job.dateState, job.logisticsState].some(state => ['empty', 'unavailable'].includes(state))) label = '采集完成 · 部分信息未提供';
    else label = '采集完成';
  } else label = '采集失败';
  const progress = job.logisticsProgress;
  if (progress && Number.isFinite(progress.total) && progress.total > 0 && Number.isFinite(progress.completed) && progress.completed >= 0) {
    const total = Math.min(100000, Math.floor(progress.total)), completed = Math.min(total, Math.floor(progress.completed));
    label += ` · 物流查询任务 ${completed}/${total}`;
  }
  if (pending && job.continuation === true) details.push(job.throttled === true ? '平台限流，后台会自动继续查询。' : '后台会自动继续查询，已完成的结果可先查看。');
  for (const [field, name] of [['date', '订单日期'], ['logistics', '物流']]) {
    if (job[`${field}State`] === 'error' && !job[`${field}Error`]) details.push(`${name}查询失败，已保留原数据。`);
    if (['empty', 'unavailable'].includes(job[`${field}State`]) && !job[`${field}Error`]) details.push(`平台本次未提供${name}信息。`);
  }
  return { label, pending, details };
}

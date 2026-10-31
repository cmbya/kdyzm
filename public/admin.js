import { createServerClock, syncStatus } from './sync-status.js';

const $ = id => document.getElementById(id);
let token = '';
let accounts = [];
let configurationMode = 'managed';
let baseUrl = '';
let settingsDirty = false;
let refreshRequest = null;
let pollTimer = null;
let countdownTimer = null;
let scopeKey = '';
let pollingError = '';
const serverClock = createServerClock();
const syncSubmitting = new Map();
const syncRows = new Map();
const busy = new WeakSet();
const statusNames = { configured: '待首次采集', syncing: '同步中', ok: '已连接', expired: 'Cookie 已失效', error: '同步失败' };
const date = value => value ? new Date(value).toLocaleString('zh-CN') : '尚无';
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function node(tag, content, className) { const el = document.createElement(tag); el.textContent = content; if (className) el.className = className; return el; }
function action(label, handler, className = 'secondary') {
  const el = node('button', label, className); el.type = 'button';
  el.addEventListener('click', () => run(handler, el)); return el;
}
async function run(fn, owner) {
  if (owner && busy.has(owner)) return;
  const controls = owner ? (owner.tagName === 'FORM' ? [...owner.elements] : [owner]) : [];
  const disabled = controls.map(control => control.disabled);
  const button = owner?.tagName === 'FORM' ? owner.querySelector('button:not([type]), button[type="submit"]') : owner;
  const label = button?.textContent;
  if (owner) { busy.add(owner); owner.setAttribute('aria-busy', 'true'); }
  controls.forEach(control => { control.disabled = true; });
  if (button) button.textContent = '处理中…';
  try { await fn(); } catch (e) { notice(e.message || '请求未完成', true); }
  finally {
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
    if (button) button.textContent = label;
    if (owner) { busy.delete(owner); owner.removeAttribute('aria-busy'); }
    if (owner === $('account-form')) $('platform').disabled = Boolean($('account-id').value);
    updatePairAvailability();
    renderSyncStates();
  }
}
async function api(path, options = {}, authenticated = true) {
  const requestToken = authenticated ? token : '';
  let response;
  try {
    response = await fetch(path, { ...options, redirect: 'error', cache: 'no-store',
      headers: { ...(requestToken ? { 'x-admin-token': requestToken } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  } catch { throw new Error('无法连接服务，请检查网络后重试。'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && data.error?.code === 'ADMIN_UNAUTHORIZED' && requestToken && token === requestToken) clearSession();
    const error = new Error(data.error?.message || '请求未完成，请稍后重试。');
    error.status = response.status; throw error;
  }
  if (authenticated && requestToken !== token) throw new Error('登录状态已变化，请重新操作。');
  return data;
}
function clearPairResult() {
  $('pair-result').hidden = true; $('pair-code').textContent = ''; $('pair-url').textContent = '';
  $('pair-expires').textContent = ''; $('pair-qr').removeAttribute('src');
}
function showLogin() {
  $('loading-panel').hidden = true; $('setup-panel').hidden = true; $('login-panel').hidden = false;
  $('login-label').textContent = configurationMode === 'environment' ? '原 ADMIN_TOKEN' : '管理员密码';
  $('login-hint').textContent = configurationMode === 'environment'
    ? '当前使用环境变量配置。请输入原 ADMIN_TOKEN；此模式不支持在页面修改地址或密码。登录凭证只在当前页面内存中保留。'
    : '输入初始化时设置的密码。登录凭证只在当前页面内存中保留，刷新页面后需重新登录。';
}
function clearSession() {
  stopPolling(); syncSubmitting.clear(); syncRows.clear(); scopeKey = ''; pollingError = '';
  token = ''; accounts = []; baseUrl = ''; settingsDirty = false;
  for (const form of document.forms) form.reset();
  $('setup-confirm').setCustomValidity(''); $('confirm-password').setCustomValidity('');
  resetForm(); clearPairResult();
  $('accounts').replaceChildren(); $('devices').replaceChildren(); $('scope').replaceChildren(node('legend', '授权账号范围'));
  $('workspace').hidden = true; $('logout').hidden = true; showLogin();
}
async function checkSetup() {
  $('setup-panel').hidden = true; $('login-panel').hidden = true;
  $('loading-panel').hidden = false; $('loading-panel').setAttribute('aria-busy', 'true');
  $('loading-message').textContent = '正在读取初始化状态…'; $('retry-setup').hidden = true;
  try {
    const status = await api('/v1/setup', {}, false);
    configurationMode = status.mode;
    if (status.initialized) showLogin();
    else { $('loading-panel').hidden = true; $('login-panel').hidden = true; $('setup-panel').hidden = false; }
    notice('');
  } catch (error) {
    $('loading-message').textContent = '暂时无法读取服务状态，请检查连接后重试。'; $('retry-setup').hidden = false;
    throw error;
  } finally { $('loading-panel').removeAttribute('aria-busy'); }
}
function validateBaseUrl(value) {
  const address = value.trim();
  if (!address) return '';
  let parsed;
  try { parsed = new URL(address); } catch { throw new Error('请填写有效的 HTTPS 服务地址。'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('服务地址必须使用 HTTPS，且不能包含账号、密码、路径、查询参数或片段。');
  }
  return parsed.origin;
}
function updatePairAvailability() {
  $('pair-hint').textContent = !baseUrl
    ? (configurationMode === 'environment' ? '服务地址尚未配置，请在部署环境中设置 PUBLIC_BASE_URL 后再绑定设备。' : '服务地址尚未设置，请先在“服务设置”中保存 HTTPS 地址，再绑定设备。')
    : !accounts.length ? '请先添加至少一个账号，再选择授权范围。' : '';
  $('generate-pair').disabled = !baseUrl || !accounts.length || busy.has($('pair-form'));
}
function renderSettings(status) {
  configurationMode = status.configurationMode;
  if (baseUrl !== status.baseUrl) clearPairResult();
  baseUrl = status.baseUrl || '';
  if (status.fixture !== undefined) $('fixture-notice').hidden = !status.fixture;
  $('configured-base-url').textContent = baseUrl || '尚未设置';
  $('configuration-hint').textContent = configurationMode === 'environment'
    ? '当前使用环境变量配置，此处只读。如需修改服务地址或管理员密钥，请更新部署环境变量并重启服务。'
    : '地址和管理员密码可在此修改。未设置服务地址时，仍可管理账号。';
  $('managed-settings').hidden = configurationMode !== 'managed';
  if (!settingsDirty) $('settings-base-url').value = baseUrl;
  updatePairAvailability();
}
function stopPolling() {
  clearTimeout(pollTimer); clearInterval(countdownTimer); pollTimer = null; countdownTimer = null;
}
function reportPollingError(error, requestToken) {
  if (token !== requestToken) return;
  pollingError = `采集状态暂时无法更新：${error.message}`; notice(pollingError, true);
}
function schedulePolling() {
  stopPolling();
  if (!token || document.hidden) return;
  const requestToken = token;
  const pending = accounts.some(account => syncStatus(account, serverClock.now()).pending);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    refresh(false).catch(error => reportPollingError(error, requestToken));
  }, pending ? 3000 : 30000);
  if (accounts.some(account => account.syncJob?.retryAt > serverClock.now())) countdownTimer = setInterval(renderSyncStates, 1000);
}
async function refresh(full = true) {
  if (!token) return;
  const requestToken = token;
  if (refreshRequest) {
    const active = refreshRequest;
    if (active.token === requestToken && (!full || active.full)) return active.promise;
    await active.promise.catch(() => {});
    if (token !== requestToken) return;
    return refresh(full);
  }
  const request = { token: requestToken, full };
  request.promise = (async () => {
    const [a, d, status] = await Promise.all([api('/v1/admin/accounts'), ...(full ? [api('/v1/admin/devices'), api('/v1/admin/status')] : [])]);
    if (!token || token !== requestToken) return;
    accounts = a.accounts; serverClock.update(a.serverTime);
    if (pollingError && $('notice').textContent === pollingError) notice('');
    pollingError = '';
    if (full) renderSettings(status);
    renderAccounts(); renderScope(); updatePairAvailability();
    if (full) renderDevices(d.devices);
  })().finally(() => {
    if (refreshRequest === request) refreshRequest = null;
    schedulePolling();
  });
  refreshRequest = request;
  return request.promise;
}
async function refreshAfterChange(full = true) {
  if (refreshRequest) await refreshRequest.promise.catch(() => {});
  return refresh(full);
}
function renderSyncStates() {
  for (const account of accounts) {
    const row = syncRows.get(account.id);
    if (!row) continue;
    const status = syncStatus(account, serverClock.now());
    const submitting = syncSubmitting.has(account.id);
    row.status.textContent = submitting ? '正在提交采集任务…' : status.label;
    row.details.textContent = status.details.filter(detail => detail !== account.error).join('；');
    row.details.hidden = !row.details.textContent;
    if (!busy.has(row.button)) {
      row.button.disabled = submitting || status.pending;
      row.button.textContent = submitting ? '提交中…' : status.pending ? (account.syncJob?.state === 'queued' ? '已排队' : '采集中…') : '立即采集';
    }
  }
}
async function requestSync(accountId) {
  const account = accounts.find(value => value.id === accountId);
  if (!account || syncSubmitting.has(accountId) || syncStatus(account, serverClock.now()).pending) return;
  const requestToken = token;
  const submission = {};
  syncSubmitting.set(accountId, submission); notice(''); renderSyncStates();
  try {
    const result = await api(`/v1/admin/accounts/${encodeURIComponent(accountId)}/sync`, { method: 'POST', body: '{}' });
    const current = accounts.find(value => value.id === accountId);
    if (current) current.syncJob = result.job || result.jobs?.[0] || current.syncJob;
    renderSyncStates();
    await refreshAfterChange(false).catch(error => reportPollingError(error, requestToken));
  } finally {
    if (syncSubmitting.get(accountId) === submission) syncSubmitting.delete(accountId);
    renderSyncStates(); schedulePolling();
  }
}
function renderAccounts() {
  syncRows.clear();
  $('accounts').replaceChildren();
  if (!accounts.length) $('accounts').append(node('p', '尚未配置账号。添加后可为设备选择授权账号范围。', 'hint'));
  for (const account of accounts) {
    const item = node('div', '', 'item');
    const title = node('p', `${account.label} · ${account.platform === 'taobao' ? '淘宝' : '拼多多'}`, 'item-title');
    title.append(node('span', statusNames[account.status] || account.status, 'badge'));
    item.append(title, node('p', `最近成功：${date(account.lastSuccessAt)} · ${account.enabled ? `每 ${account.intervalMinutes} 分钟同步` : '自动同步已关闭'}`, 'hint'));
    if (account.error) item.append(node('p', account.error));
    for (const warning of account.warnings || []) item.append(node('p', warning, 'hint'));
    const status = node('p', '', 'hint'), details = node('p', '', 'hint');
    item.append(status, details);
    const actions = node('div', '', 'actions');
    const button = action('立即采集', () => requestSync(account.id));
    syncRows.set(account.id, { status, details, button });
    actions.append(action('更新账号', () => edit(account)), button);
    item.append(actions); $('accounts').append(item);
  }
  renderSyncStates();
}
function renderScope() {
  const key = JSON.stringify(accounts.map(account => [account.id, account.label]));
  if (key === scopeKey) return;
  scopeKey = key;
  const selected = new Set([...$('scope').querySelectorAll('input:checked')].map(el => el.value));
  $('scope').replaceChildren(node('legend', '授权账号范围'));
  for (const account of accounts) {
    const label = node('label', '', 'checkbox'); const check = document.createElement('input');
    check.type = 'checkbox'; check.value = account.id; check.checked = selected.has(account.id);
    label.append(check, document.createTextNode(account.label)); $('scope').append(label);
  }
}
function renderDevices(devices) {
  $('devices').replaceChildren();
  if (!devices.length) $('devices').append(node('p', '尚无已绑定设备。', 'hint'));
  for (const device of devices) {
    const item = node('div', '', 'item');
    item.append(node('p', device.name, 'item-title'), node('p', `绑定于 ${date(device.createdAt)} · ${device.accountIds.map(id => accounts.find(a => a.id === id)?.label || '已移除账号').join('、')}`, 'hint'));
    if (device.revokedAt) item.append(node('p', `已撤销 · ${date(device.revokedAt)}`, 'hint'));
    else item.append(action('撤销授权', async () => {
      if (!confirm(`撤销“${device.name}”的线上访问权限？本地历史会保留。`)) return;
      await api(`/v1/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' }); await refreshAfterChange(); notice('设备授权已撤销。');
    }, 'danger'));
    $('devices').append(item);
  }
}
function edit(account) {
  $('account-id').value = account.id; $('label').value = account.label; $('platform').value = account.platform;
  $('platform').disabled = true; $('cookie').value = ''; $('interval').value = account.intervalMinutes; $('enabled').checked = account.enabled;
  $('account-heading').textContent = '更新账号'; $('account-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function resetForm() { $('account-form').reset(); $('account-id').value = ''; $('platform').disabled = false; $('account-heading').textContent = '添加账号'; }
function submit(id, handler) {
  $(id).addEventListener('submit', event => { event.preventDefault(); run(handler, event.currentTarget); });
}
function confirmPassword(passwordId, confirmId) {
  const validate = () => $(confirmId).setCustomValidity($(confirmId).value && $(passwordId).value !== $(confirmId).value ? '两次输入的密码不一致。' : '');
  $(passwordId).addEventListener('input', validate); $(confirmId).addEventListener('input', validate);
}
confirmPassword('setup-password', 'setup-confirm');
confirmPassword('new-password', 'confirm-password');
submit('setup-form', async () => {
  const address = validateBaseUrl($('setup-base-url').value);
  try {
    await api('/v1/setup', { method: 'POST', body: JSON.stringify({ setupCode: $('setup-code').value.trim(), password: $('setup-password').value, baseUrl: address }) }, false);
    $('setup-form').reset(); showLogin(); notice('初始化完成，请使用刚设置的管理员密码登录。'); $('admin-token').focus();
  } catch (error) {
    if (error.status === 409) await checkSetup();
    throw error;
  } finally { $('setup-code').value = ''; $('setup-password').value = ''; $('setup-confirm').value = ''; $('setup-confirm').setCustomValidity(''); }
});
submit('login-form', async () => {
  try {
    const session = await api('/v1/admin/login', { method: 'POST', body: JSON.stringify({ password: $('admin-token').value }) }, false);
    token = session.token; await refresh();
    if (!token) return;
    $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; notice('');
  } catch (error) { clearSession(); throw error; }
  finally { $('admin-token').value = ''; }
});
$('retry-setup').addEventListener('click', event => run(checkSetup, event.currentTarget));
$('logout').addEventListener('click', () => { clearSession(); notice('已退出管理。'); });
$('settings-base-url').addEventListener('input', () => { settingsDirty = true; });
submit('settings-form', async () => {
  const status = await api('/v1/admin/settings', { method: 'PATCH', body: JSON.stringify({ baseUrl: validateBaseUrl($('settings-base-url').value) }) });
  settingsDirty = false; renderSettings(status); notice(status.baseUrl ? '服务地址已保存。' : '服务地址已清空，补充后才能绑定设备。');
});
submit('password-form', async () => {
  try {
    const session = await api('/v1/admin/password', { method: 'POST', body: JSON.stringify({ currentPassword: $('current-password').value, password: $('new-password').value }) });
    token = session.token; schedulePolling(); notice('管理员密码已修改，当前页面保持登录；其他管理页面需重新登录。');
  } finally { $('current-password').value = ''; $('new-password').value = ''; $('confirm-password').value = ''; $('confirm-password').setCustomValidity(''); }
});
$('refresh').addEventListener('click', event => run(async () => { notice(''); await refresh(); }, event.currentTarget));
document.addEventListener('visibilitychange', () => {
  stopPolling();
  if (!document.hidden && token) run(() => refresh(false));
});
$('cancel-edit').addEventListener('click', resetForm);
submit('account-form', async () => {
  const id = $('account-id').value;
  const body = { platform: $('platform').value, label: $('label').value, intervalMinutes: Number($('interval').value), enabled: $('enabled').checked };
  if ($('cookie').value.trim()) body.cookie = $('cookie').value.trim();
  try {
    await api(id ? `/v1/admin/accounts/${encodeURIComponent(id)}` : '/v1/admin/accounts', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    resetForm(); await refreshAfterChange(); notice('账号已保存。');
  } finally { $('cookie').value = ''; }
});
submit('pair-form', async () => {
  if (!baseUrl) throw new Error('请先设置 HTTPS 服务地址，再生成设备绑定码。');
  const accountIds = [...$('scope').querySelectorAll('input:checked')].map(el => el.value);
  if (!accountIds.length) throw new Error('请至少选择一个设备可访问的账号。');
  clearPairResult();
  const result = await api('/v1/pairing-codes', { method: 'POST', body: JSON.stringify({ accountIds }) });
  $('pair-code').textContent = result.code; $('pair-url').textContent = result.baseUrl; $('pair-qr').src = result.qrDataUrl;
  $('pair-expires').textContent = `有效至 ${date(result.expiresAt)}；使用一次后立即失效。`; $('pair-result').hidden = false;
  notice('在 App 的“线上账号”页扫码，或输入服务地址与绑定码。');
});
run(checkSetup, $('retry-setup'));

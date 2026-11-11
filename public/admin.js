import { createServerClock, syncStatus } from './sync-status.js';

const $ = id => document.getElementById(id);
let token = '';
let accounts = [];
let families = [];
let devices = [];
let selectedFamily = '';
let attentionOnly = false;
let familySearch = '';
let configurationMode = 'managed';
let baseUrl = '';
let settingsDirty = false;
let diagnosticCredentials = [];
let displayedDiagnosticCredentialId = '';
let diagnosticGeneration = 0;
let refreshRequest = null;
let pollTimer = null;
let countdownTimer = null;
let scopeKey = '';
let pollingError = '';
let logisticsAdmin;
let pickupCompletionAdmin;
let cookieSyncGeneration = 0;
let cookieSyncAccountId = '';
let cookieSyncPairing = null;
let familyCookieSyncGeneration = 0;
let familyCookieSyncId = '';
let familyCookieSyncPairing = null;
let cookieSyncRequestCode = (() => {
  const hash = typeof location === 'undefined' ? '' : location.hash;
  const match = hash.match(/(?:^|[#&])cookie-sync-request=([^&]*)/);
  let value = '';
  try { value = match ? decodeURIComponent(match[1]) : ''; } catch { value = ''; }
  if (match && typeof history !== 'undefined') history.replaceState(null, '', location.pathname + location.search);
  return /^CR-[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
})();
let cookieSyncRequestGeneration = 0;
let cookieSyncRequest = null;
let cookieSyncRequestState = 'pending';
let preserveCookieSyncRequestOnClose = false;
const serverClock = createServerClock();
const syncSubmitting = new Map();
const syncRows = new Map();
const busy = new WeakSet();
const platformMeta = {
  taobao: { label: '淘宝', mark: '淘', className: '' },
  pdd: { label: '拼多多', mark: '拼', className: 'pdd' },
  jd: { label: '京东', mark: '京', className: 'jd' },
};
const platformOf = platform => platformMeta[platform] || { label: platform || '未知平台', mark: '?', className: '' };
const statusNames = { configured: '待首次采集', syncing: '同步中', ok: '最近采集成功', expired: 'Cookie 已失效', error: '同步失败' };
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
    if (owner === $('cookie-sync-request-approve') && cookieSyncRequestState === 'approved') owner.disabled = true;
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
function clearDiagnosticToken() {
  displayedDiagnosticCredentialId = '';
  $('diagnostic-token').value = ''; $('diagnostic-token-result').hidden = true;
}
function renderDiagnosticCredentials() {
  const container = $('diagnostic-credentials'); container.replaceChildren();
  if (displayedDiagnosticCredentialId && !diagnosticCredentials.some(credential => credential.id === displayedDiagnosticCredentialId && !credential.revokedAt)) clearDiagnosticToken();
  if (!diagnosticCredentials.length) { container.append(node('p', '尚无诊断凭据。', 'hint')); return; }
  for (const credential of diagnosticCredentials) {
    const item = node('div', '', 'settings-body');
    item.append(node('strong', credential.name), node('p', `创建于 ${date(credential.createdAt)} · ${credential.revokedAt ? `已撤销 ${date(credential.revokedAt)}` : '有效 · 不自动过期'}`, 'hint'));
    if (!credential.revokedAt) {
      const revoke = action('撤销', async () => {
        if (!confirm(`撤销“${credential.name}”的只读诊断凭据？使用它的脚本将无法继续访问。`)) return;
        await api(`/v1/admin/diagnostic-tokens/${encodeURIComponent(credential.id)}`, { method: 'DELETE' });
        diagnosticGeneration += 1;
        diagnosticCredentials = diagnosticCredentials.map(value => value.id === credential.id ? { ...value, revokedAt: Date.now() } : value);
        if (displayedDiagnosticCredentialId === credential.id) clearDiagnosticToken();
        renderDiagnosticCredentials(); $('diagnostic-status').textContent = ''; $('diagnostic-reload').focus(); notice('诊断凭据已撤销。');
      }, 'danger secondary');
      revoke.setAttribute('aria-label', `撤销诊断凭据：${credential.name}`); item.append(revoke);
    }
    container.append(item);
  }
}
async function loadDiagnosticCredentials() {
  if (!token) return;
  const generation = ++diagnosticGeneration;
  $('diagnostic-status').textContent = '正在读取诊断凭据…';
  try {
    const result = await api('/v1/admin/diagnostic-tokens');
    if (generation !== diagnosticGeneration) return;
    diagnosticCredentials = result.credentials; renderDiagnosticCredentials(); $('diagnostic-status').textContent = '';
  } catch (error) {
    if (token && generation === diagnosticGeneration) $('diagnostic-status').textContent = error.message;
    throw error;
  }
}
function clearCookieSync() {
  cookieSyncGeneration += 1; cookieSyncAccountId = ''; cookieSyncPairing = null;
  $('cookie-sync-panel').hidden = true; $('cookie-sync-pairing').hidden = true; $('cookie-sync-copy').hidden = true;
  $('cookie-sync-code').textContent = ''; $('cookie-sync-base-url').textContent = ''; $('cookie-sync-expires').textContent = '';
  $('cookie-sync-target').textContent = ''; $('cookie-sync-connections').replaceChildren();
}
function cookieSyncIsCurrent(generation, accountId) {
  return token && generation === cookieSyncGeneration && accountId === cookieSyncAccountId && $('account-id').value === accountId && $('account-dialog').open;
}
function renderCookieConnections(connections = []) {
  const container = $('cookie-sync-connections'); container.replaceChildren();
  if (!connections.length) { container.append(node('p', '暂无浏览器授权。', 'empty')); return; }
  for (const connection of connections) {
    const generation = cookieSyncGeneration; const accountId = cookieSyncAccountId;
    const item = node('div', '', 'item');
    item.append(node('strong', connection.name || connection.identityHint || '浏览器授权'));
    item.append(node('p', `${platformOf(connection.platform).label} · 最近同步 ${date(connection.lastSyncAt)} · 到期 ${date(connection.expiresAt)}`, 'hint'));
    if (connection.identityHint) item.append(node('p', `身份：${connection.identityHint}`, 'hint'));
    const revoke = action('撤销', async () => {
      if (!confirm(`撤销“${connection.name || '此浏览器'}”的 Cookie 同步授权？`)) return;
      await api(`/v1/admin/cookie-sync/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' });
      if (!cookieSyncIsCurrent(generation, accountId)) return;
      await loadCookieConnections(accountId, generation); notice('浏览器 Cookie 同步授权已撤销。');
    }, 'danger');
    if (connection.revokedAt || connection.expiresAt <= Date.now()) item.append(node('p', connection.revokedAt ? '已撤销' : '已到期', 'hint'));
    else { item.append(node('div', '', 'actions')); item.lastChild.append(revoke); }
    container.append(item);
  }
}
async function loadCookieConnections(accountId, generation = cookieSyncGeneration) {
  const result = await api(`/v1/admin/cookie-sync/connections?accountId=${encodeURIComponent(accountId)}`);
  if (cookieSyncIsCurrent(generation, accountId)) renderCookieConnections(result.connections || []);
}
function openCookieSync(account) {
  cookieSyncGeneration += 1; cookieSyncAccountId = account.id; cookieSyncPairing = null;
  const generation = cookieSyncGeneration;
  $('cookie-sync-panel').hidden = false; $('cookie-sync-pairing').hidden = true; $('cookie-sync-copy').hidden = true;
  $('cookie-sync-code').textContent = ''; $('cookie-sync-base-url').textContent = '';
  $('cookie-sync-target').textContent = `目标：${familyName(account.familyId || '')} · ${platformOf(account.platform).label} · ${account.label}`;
  $('cookie-sync-connections').replaceChildren(node('p', '正在读取当前授权…', 'hint'));
  loadCookieConnections(account.id, generation).catch(error => {
    if (cookieSyncIsCurrent(generation, account.id)) { $('cookie-sync-connections').replaceChildren(node('p', error.message, 'account-error')); }
  });
}
async function generateCookiePairing() {
  const accountId = cookieSyncAccountId; const generation = cookieSyncGeneration;
  if (!accountId) return;
  $('cookie-sync-pairing').hidden = true; $('cookie-sync-copy').hidden = true; cookieSyncPairing = null;
  const result = await api('/v1/admin/cookie-sync/pairing', { method: 'POST', body: JSON.stringify({ accountId }) });
  if (!cookieSyncIsCurrent(generation, accountId)) return;
  cookieSyncPairing = { schemaVersion: 1, kind: 'cookie-sync', baseUrl: result.baseUrl, code: result.code };
  $('cookie-sync-base-url').textContent = result.baseUrl || '';
  $('cookie-sync-code').textContent = result.code || '';
  $('cookie-sync-expires').textContent = `有效至 ${date(result.expiresAt)}；使用一次后失效。`;
  $('cookie-sync-pairing').hidden = false; $('cookie-sync-copy').hidden = false;
}
function clearFamilyCookieSync() {
  familyCookieSyncGeneration += 1; familyCookieSyncId = ''; familyCookieSyncPairing = null;
  $('family-cookie-sync-pairing').hidden = true; $('family-cookie-sync-copy').hidden = true;
  $('family-cookie-sync-code').textContent = ''; $('family-cookie-sync-base-url').textContent = ''; $('family-cookie-sync-expires').textContent = '';
  $('family-cookie-sync-summary').textContent = ''; $('family-cookie-sync-accounts').replaceChildren(); $('family-cookie-sync-connections').replaceChildren();
}
function familyCookieSyncIsCurrent(generation, familyId) {
  return token && generation === familyCookieSyncGeneration && familyId === familyCookieSyncId && selectedFamily === familyId && $('family-cookie-sync-dialog').open;
}
function renderFamilyCookieConnections(connections = []) {
  const container = $('family-cookie-sync-connections'); container.replaceChildren();
  if (!connections.length) { container.append(node('p', '暂无浏览器授权。', 'empty')); return; }
  for (const connection of connections) {
    const generation = familyCookieSyncGeneration; const familyId = familyCookieSyncId;
    const item = node('div', '', 'item'); item.append(node('strong', connection.name || '浏览器授权'), node('p', `创建于 ${date(connection.createdAt)} · 到期 ${date(connection.expiresAt)}`, 'hint'));
    if (connection.revokedAt) item.append(node('p', `已撤销 ${date(connection.revokedAt)}`, 'hint'));
    else item.append(action('撤销', async () => {
      if (!confirm(`撤销“${connection.name || '此浏览器'}”的 Cookie 同步授权？`)) return;
      await api(`/v1/admin/cookie-sync/families/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' });
      if (!familyCookieSyncIsCurrent(generation, familyId)) return;
      await loadFamilyCookieConnections(familyId, generation); notice('角色 Cookie 同步授权已撤销。');
    }, 'danger'));
    container.append(item);
  }
}
async function loadFamilyCookieConnections(familyId, generation = familyCookieSyncGeneration) {
  const result = await api(`/v1/admin/cookie-sync/families/connections?familyId=${encodeURIComponent(familyId)}`);
  if (familyCookieSyncIsCurrent(generation, familyId)) renderFamilyCookieConnections(result.connections || []);
}
function openFamilyCookieSync() {
  const family = families.find(value => value.id === selectedFamily); if (!family) return;
  familyCookieSyncGeneration += 1; familyCookieSyncId = family.id; familyCookieSyncPairing = null;
  const generation = familyCookieSyncGeneration;
  $('family-cookie-sync-summary').textContent = `${family.name} · 当前 ${accounts.filter(account => account.familyId === family.id).map(account => `${platformOf(account.platform).label} · ${account.label}`).join('、') || '暂无账号，以后新增账号可用'}`;
  $('family-cookie-sync-accounts').replaceChildren(...accounts.filter(account => account.familyId === family.id).map(account => node('p', `${platformOf(account.platform).label} · ${account.label}`, 'hint')));
  $('family-cookie-sync-pairing').hidden = true; $('family-cookie-sync-copy').hidden = true; $('family-cookie-sync-code').textContent = ''; $('family-cookie-sync-base-url').textContent = '';
  $('family-cookie-sync-connections').replaceChildren(node('p', '正在读取当前授权…', 'hint')); $('family-cookie-sync-dialog').showModal();
  loadFamilyCookieConnections(family.id, generation).catch(error => { if (familyCookieSyncIsCurrent(generation, family.id)) $('family-cookie-sync-connections').replaceChildren(node('p', error.message, 'account-error')); });
}
async function generateFamilyCookiePairing() {
  const familyId = familyCookieSyncId; const generation = familyCookieSyncGeneration; if (!familyId) return;
  const result = await api('/v1/admin/cookie-sync/families/pairing', { method: 'POST', body: JSON.stringify({ familyId }) });
  if (!familyCookieSyncIsCurrent(generation, familyId)) return;
  familyCookieSyncPairing = { schemaVersion: 1, kind: 'cookie-sync-family', baseUrl: result.baseUrl, code: result.code };
  $('family-cookie-sync-base-url').textContent = result.baseUrl || ''; $('family-cookie-sync-code').textContent = result.code || '';
  $('family-cookie-sync-expires').textContent = `有效至 ${date(result.expiresAt)}；使用一次后失效。`; $('family-cookie-sync-pairing').hidden = false; $('family-cookie-sync-copy').hidden = false;
}
function clearCookieSyncRequest() {
  cookieSyncRequestGeneration += 1; cookieSyncRequestCode = ''; cookieSyncRequest = null;
  cookieSyncRequestState = 'approved';
}
function renderCookieSyncRequest() {
  if (!cookieSyncRequest || !token || cookieSyncRequestState === 'approved') return;
  const dialog = $('cookie-sync-request-dialog'); cookieSyncRequestGeneration += 1;
  $('cookie-sync-request-summary').textContent = `浏览器：${cookieSyncRequest.name || '未命名浏览器'} · 有效至 ${date(cookieSyncRequest.expiresAt)}`;
  $('cookie-sync-request-platforms').replaceChildren(...(cookieSyncRequest.platforms || []).map(platform => node('p', platformOf(platform).label, 'hint')));
  const select = $('cookie-sync-request-family'); const placeholder = node('option', '请选择角色'); placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true;
  select.replaceChildren(placeholder, ...families.map(family => node('option', family.name))); families.forEach((family, index) => { select.options[index + 1].value = family.id; }); select.value = '';
  const hasFamilies = families.length > 0; const actionable = hasFamilies && !!select.value && (!cookieSyncRequest.status || cookieSyncRequest.status === 'pending'); select.hidden = !hasFamilies; $('cookie-sync-request-approve').disabled = !actionable;
  $('cookie-sync-request-create').hidden = hasFamilies; $('cookie-sync-request-create-button').hidden = hasFamilies ? true : false;
  $('cookie-sync-request-status').textContent = cookieSyncRequest.status && cookieSyncRequest.status !== 'pending' ? `此请求当前状态：${cookieSyncRequest.status}。` : '';
  if (!dialog.open) dialog.showModal();
}
async function loadCookieSyncRequest() {
  if (!token || !cookieSyncRequestCode || cookieSyncRequestState !== 'pending') return;
  cookieSyncRequestState = 'loading'; const requestToken = token; const generation = ++cookieSyncRequestGeneration;
  try {
    const result = await api(`/v1/admin/cookie-sync/families/requests/${encodeURIComponent(cookieSyncRequestCode)}`);
    if (!token || token !== requestToken || generation !== cookieSyncRequestGeneration || cookieSyncRequestState !== 'loading') return;
    cookieSyncRequest = result; cookieSyncRequestState = 'pending'; renderCookieSyncRequest();
  } catch (error) {
    if (token === requestToken && generation === cookieSyncRequestGeneration) { cookieSyncRequestState = 'approved'; notice(error.message, true); }
  }
}
async function approveCookieSyncRequest() {
  const familyId = $('cookie-sync-request-family').value; const code = cookieSyncRequestCode; const requestToken = token; const generation = cookieSyncRequestGeneration;
  if (!families.some(family => family.id === familyId) || !code || !cookieSyncRequest || cookieSyncRequestState !== 'pending') return;
  cookieSyncRequestState = 'approving'; $('cookie-sync-request-approve').disabled = true;
  try {
    await api(`/v1/admin/cookie-sync/families/requests/${encodeURIComponent(code)}/approve`, { method: 'POST', body: JSON.stringify({ familyId }) });
    if (!token || token !== requestToken || generation !== cookieSyncRequestGeneration || !$('cookie-sync-request-dialog').open) return;
    clearCookieSyncRequest(); $('cookie-sync-request-status').textContent = '已授权。请返回插件继续选择要同步的平台账号。'; $('cookie-sync-request-create-button').hidden = true;
  } finally { if (cookieSyncRequestState === 'approving') cookieSyncRequestState = 'pending'; }
}
function showLogin() {
  $('auth-shell').hidden = false;
  $('loading-panel').hidden = true; $('setup-panel').hidden = true; $('login-panel').hidden = false;
  $('login-label').textContent = configurationMode === 'environment' ? '原 ADMIN_TOKEN' : '管理员密码';
  $('login-hint').textContent = configurationMode === 'environment'
    ? '当前使用环境变量配置。请输入原 ADMIN_TOKEN；此模式不支持在页面修改地址或密码。登录凭证只在当前页面内存中保留。'
    : '输入初始化时设置的密码。登录凭证只在当前页面内存中保留，刷新页面后需重新登录。';
}
function clearSession() {
  diagnosticGeneration += 1; diagnosticCredentials = []; clearDiagnosticToken();
  $('diagnostic-credentials').replaceChildren(); $('diagnostic-status').textContent = '尚未读取诊断凭据。';
  clearCookieSync();
  clearFamilyCookieSync();
  logisticsAdmin?.reset();
  pickupCompletionAdmin?.reset();
  stopPolling(); syncSubmitting.clear(); syncRows.clear(); scopeKey = ''; pollingError = '';
  token = ''; accounts = []; families = []; devices = []; selectedFamily = ''; baseUrl = ''; settingsDirty = false;
  for (const id of ['account-dialog', 'pair-dialog', 'family-dialog', 'device-dialog']) if ($(id).open) $(id).close();
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
  if (/[\u0000-\u0020\u007f\\]/.test(address) || parsed.protocol !== 'https:' || parsed.port === '0' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('服务地址必须使用 HTTPS，且不能包含账号、密码、路径、查询参数或片段。');
  }
  return parsed.origin;
}
function updatePairAvailability() {
  $('pair-hint').textContent = !baseUrl
    ? (configurationMode === 'environment' ? '服务地址尚未配置，请在部署环境中设置 PUBLIC_BASE_URL 后再绑定设备。' : '服务地址尚未设置，请先在“服务设置”中保存 HTTPS 地址，再绑定设备。')
    : !families.length ? '请先新增家人，并为待归属账号分配家人。' : '';
  $('generate-pair').disabled = !baseUrl || !families.length || busy.has($('pair-form'));
}
function renderSettings(status) {
  configurationMode = status.configurationMode;
  if (baseUrl !== status.baseUrl) clearPairResult();
  baseUrl = status.baseUrl || '';
  if (status.fixture !== undefined) $('fixture-notice').hidden = !status.fixture;
  $('configured-base-url').textContent = baseUrl || '尚未设置';
  $('configured-lan-url').textContent = status.lanBaseUrl || '未启用';
  $('configuration-hint').textContent = configurationMode === 'environment'
    ? '服务地址和管理员密钥由环境变量管理，如需修改请更新部署环境变量并重启服务。只读诊断 API 凭据可在下方管理。'
    : '地址和管理员密码可在此修改。未设置服务地址时，仍可管理账号。';
  $('managed-settings').hidden = configurationMode !== 'managed';
  if (!settingsDirty) {
    $('settings-base-url').value = baseUrl;
    $('settings-lan-url').value = status.lanBaseUrl || '';
  }
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
    const [a, d, status, f] = await Promise.all([api('/v1/admin/accounts'), ...(full ? [api('/v1/admin/devices'), api('/v1/admin/status'), api('/v1/admin/families')] : [])]);
    if (!token || token !== requestToken) return;
    accounts = a.accounts; serverClock.update(a.serverTime);
    if (full) {
      families = f.families;
      if (!selectedFamily && families.length && !accounts.some(a => !a.familyId)) selectedFamily = families[0].id;
      if (selectedFamily && !families.some(f => f.id === selectedFamily)) selectedFamily = '';
      devices = d.devices;
    }
    if (pollingError && $('notice').textContent === pollingError) notice('');
    pollingError = '';
    if (full) renderSettings(status);
    renderFamilies(); renderAccounts(); renderScope(); updatePairAvailability();
    if (full) renderDevices(devices);
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
    row.status.textContent = submitting ? '正在提交采集任务…' : account.syncJob ? status.label : statusNames[account.status] || account.status;
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
function renderCollectionOrders(job) {
  const section = node('section', '', 'collection-orders');
  if (!job || !Array.isArray(job.orders)) {
    section.hidden = true; return section;
  }
  section.append(node('h4', `本次采集订单 · ${job.orders.length} 笔`));
  if (!job.orders.length) {
    section.append(node('p', job.state === 'completed' ? '本次没有符合采集条件的订单。' : '正在等待订单数据…', 'hint'));
    return section;
  }
  for (const order of job.orders) {
    const card = node('article', '', 'collection-order');
    card.append(node('p', order.title || '商品名称暂未提供', 'collection-product'));
    const parcels = order.shipments?.length ? order.shipments : [{}];
    for (const parcel of parcels) {
      const row = node('div', '', 'collection-parcel');
      row.append(node('p', `快递单号：${parcel.waybillNo || '暂未提供'}${parcel.carrier ? ` · ${parcel.carrier}` : ''}`, 'collection-waybill'));
      const event = parcel.latestEvent;
      row.append(node('p', event ? `最新物流：${event.description}` : '最新物流：暂无物流信息', 'collection-event'));
      if (event?.time) row.append(node('p', date(event.time), 'collection-event-time hint'));
      if (parcel.logisticsError) row.append(node('p', `${parcel.logisticsError}${event ? '（上方为已保存的最近轨迹）' : ''}`, 'hint'));
      card.append(row);
    }
    section.append(card);
  }
  return section;
}
function renderAccounts() {
  syncRows.clear();
  $('accounts').replaceChildren();
  const visible = accounts.filter(a => (a.familyId || '') === selectedFamily && (!attentionOnly || needsAttention(a)));
  if (!visible.length) $('accounts').append(node('p', attentionOnly ? '当前没有需要处理的账号。' : '暂无平台账号，添加后即可在此管理。', 'empty'));
  for (const account of visible) {
    const item = node('div', '', 'item account-row');
    const title = node('div', '', 'item-title');
    const platform = platformOf(account.platform);
    title.append(node('span', platform.mark, `platform ${platform.className}`), node('span', account.label));
    item.append(title, node('p', `${date(account.lastSuccessAt)} · ${account.enabled ? `${account.intervalMinutes} 分钟` : '已暂停'}`, 'account-meta hint'));
    const status = node('p', '', 'sync-label'), details = node('p', '', 'sync-details hint');
    item.append(status, details);
    if (account.error) item.append(node('p', account.error, 'account-error'));
    for (const warning of account.warnings || []) item.append(node('p', warning, 'account-error hint'));
    const actions = node('div', '', 'actions');
    const button = action('立即采集', () => requestSync(account.id));
    syncRows.set(account.id, { status, details, button });
    actions.append(action('详情', () => edit(account)), button);
    item.append(renderCollectionOrders(account.syncJob), actions); $('accounts').append(item);
  }
  renderSyncStates();
}
function renderScope() {
  const key = JSON.stringify([families, accounts.map(account => [account.id, account.familyId, account.label])]);
  if (key === scopeKey) return;
  scopeKey = key;
  const selected = new Set([...$('scope').querySelectorAll('input:checked')].map(el => el.value));
  fillFamilyChoices($('scope'), selected);
}
function renderDevices(list) {
  $('devices').replaceChildren();
  if (!list.length) $('devices').append(node('p', '尚无已绑定设备，可选择家人生成绑定码。', 'empty'));
  for (const device of list) {
    const item = node('div', '', 'device-card');
    const info = node('div', '');
    info.append(node('h3', device.name), node('p', `绑定于 ${date(device.createdAt)}`, 'hint'));
    info.append(node('p', `授权家人：${(device.familyIds || []).map(familyName).join('、') || '无'}`, 'hint'));
    info.append(node('p', `当前包含 ${device.accountIds.length} 个账号 · ${(device.familyIds || []).length ? '新增账号自动随家人组授权' : '指定账号授权，范围固定'}`, 'hint'));
    if (device.legacyAccountIds?.length) info.append(node('p', `另保留 ${device.legacyAccountIds.length} 个原有单账号授权`, 'hint'));
    item.append(info);
    if (device.revokedAt) item.append(node('p', `已撤销 · ${date(device.revokedAt)}`, 'hint'));
    else {
      const actions = node('div', '', 'actions');
      actions.append(action('管理家人授权', () => editDevice(device)), action('撤销设备', async () => {
      if (!confirm(`撤销“${device.name}”的线上访问权限？本地历史会保留。`)) return;
      await api(`/v1/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' }); await refreshAfterChange(); notice('设备授权已撤销。');
      }, 'danger'));
      item.append(actions);
    }
    $('devices').append(item);
  }
}
function edit(account) {
  fillAccountFamilies(account.familyId || '');
  $('account-id').value = account.id; $('label').value = account.label; $('platform').value = account.platform;
  $('platform').disabled = true; $('cookie').value = ''; $('interval').value = account.intervalMinutes; $('enabled').checked = account.enabled;
  $('account-heading').textContent = '账号详情与设置';
  $('account-delete-section').hidden = false; $('account-delete-error').textContent = '';
  $('account-collect').hidden = false; $('account-collect').onclick = () => run(() => requestSync(account.id), $('account-collect'));
  $('account-dialog').showModal(); openCookieSync(account);
}
function resetForm() { clearCookieSync(); $('account-form').reset(); $('account-id').value = ''; $('platform').disabled = false; $('account-heading').textContent = '添加平台账号'; $('account-delete-section').hidden = true; $('account-delete-error').textContent = ''; }
async function deleteAccount() {
  const id = $('account-id').value, account = accounts.find(value => value.id === id);
  if (!account || !confirm(`确认删除“${account.label}”账号？\n\n登录 Cookie 将清除，自动采集和此账号的插件同步授权将停止。已有订单和取件记录保留。再次使用需重新添加账号。`)) return;
  $('account-delete-error').textContent = '';
  try {
    await api(`/v1/admin/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (error) { $('account-delete-error').textContent = error.message; throw error; }
  accounts = accounts.filter(value => value.id !== id);
  syncSubmitting.delete(id); resetForm(); $('account-dialog').close();
  renderAccounts(); renderFamilies();
  await refreshAfterChange(); notice('账号已删除，登录信息已清除；历史订单和取件记录已保留。');
}
const familyName = id => families.find(f => f.id === id)?.name || '待归属';
const needsAttention = account => ['expired', 'error'].includes(account.status) || !!account.error;
function renderFamilies() {
  $('metric-families').textContent = families.length;
  $('metric-accounts').textContent = accounts.length;
  $('metric-connected').textContent = accounts.filter(a => a.status === 'ok').length;
  $('metric-attention').textContent = accounts.filter(needsAttention).length;
  $('families').replaceChildren();
  for (const family of [...families, { id: '', name: '待归属' }]) {
    if (familySearch && !family.name.includes(familySearch)) continue;
    const group = accounts.filter(a => (a.familyId || '') === family.id);
    const button = action('', () => {
      selectedFamily = family.id; attentionOnly = false;
      $('filter-all').classList.toggle('active', true); $('filter-attention').classList.toggle('active', false);
      renderFamilies(); renderAccounts();
    }, `person ${selectedFamily === family.id ? 'active' : ''} ${family.id ? '' : 'unassigned'}`);
    button.setAttribute('aria-pressed', String(selectedFamily === family.id));
    const description = node('span', '', 'desc');
    description.append(node('strong', family.name), node('small', `${group.length} 个平台账号`));
    button.append(node('span', family.id ? family.name.slice(0, 1) : '?', 'avatar'), description);
    if (group.some(needsAttention)) button.append(node('span', '', 'attention'));
    $('families').append(button);
  }
  $('family-title').textContent = familyName(selectedFamily);
  $('family-avatar').textContent = selectedFamily ? familyName(selectedFamily).slice(0, 1) : '?';
  $('family-description').textContent = selectedFamily ? `${accounts.filter(a => a.familyId === selectedFamily).length} 个平台账号 · 新增账号自动纳入整组授权` : '先分配所属家人，再进行整组授权';
  $('authorize-family').disabled = !selectedFamily;
  $('family-cookie-sync').disabled = !selectedFamily;
  $('rename-family').hidden = !selectedFamily;
}
function fillFamilyChoices(container, selected = new Set()) {
  container.replaceChildren(node('legend', '授权家人组'));
  for (const family of families) {
    const choice = node('div', '', 'scope-choice');
    const label = node('label', '', 'checkbox');
    const check = document.createElement('input'); check.type = 'checkbox'; check.value = family.id; check.checked = selected.has(family.id);
    const group = accounts.filter(a => a.familyId === family.id);
    label.append(check, document.createTextNode(`${family.name} · ${group.length} 个平台账号`));
    const details = node('details', '');
    details.append(node('summary', '查看包含账号'), node('p', group.map(a => `${platformOf(a.platform).label} · ${a.label}`).join('、') || '当前没有账号，以后新增自动包含', 'hint'));
    choice.append(label, details); container.append(choice);
  }
}
function fillAccountFamilies(value) {
  $('account-family').replaceChildren();
  for (const family of [{ id: '', name: '待归属' }, ...families]) {
    const option = node('option', family.name); option.value = family.id; $('account-family').append(option);
  }
  $('account-family').value = value;
}
function openPair(preselected = []) {
  clearPairResult(); fillFamilyChoices($('scope'), new Set(preselected));
  updatePairAvailability(); $('pair-dialog').showModal();
}
function editDevice(device) {
  $('device-id').value = device.id; $('device-dialog-title').textContent = `${device.name} · 家人授权`;
  fillFamilyChoices($('device-scope'), new Set(device.familyIds || []));
  $('clear-legacy').checked = false;
  $('clear-legacy').disabled = !device.legacyAccountIds?.length;
  $('device-legacy').textContent = device.legacyAccountIds?.length ? `保留原有单账号授权：${device.legacyAccountIds.map(id => accounts.find(a => a.id === id)?.label || '已移除账号').join('、')}。仅移除家人不会取消这些独立权限。` : '没有原有单账号授权。';
  $('device-dialog').showModal();
}
function showPage(page) {
  for (const id of ['accounts', 'devices', 'settings']) {
    $(`page-${id}`).hidden = id !== page;
    $(`nav-${id}`).classList.toggle('active', id === page);
  }
  $('breadcrumb').textContent = { accounts: '账号授权', devices: '设备管理', settings: '服务设置' }[page];
  if (page === 'settings') run(loadDiagnosticCredentials, $('diagnostic-reload'));
}
for (const id of ['accounts', 'devices', 'settings']) $(`nav-${id}`).addEventListener('click', () => showPage(id));
for (const id of ['account-dialog', 'pair-dialog', 'family-dialog', 'device-dialog', 'family-cookie-sync-dialog', 'cookie-sync-request-dialog']) {
  document.querySelector(`[data-close="${id}"]`)?.addEventListener('click', () => $(id).close());
  $(id).addEventListener('close', () => { if (id === 'account-dialog') { $('cookie').value = ''; clearCookieSync(); } if (id === 'family-cookie-sync-dialog') clearFamilyCookieSync(); });
}
$('new-account').addEventListener('click', () => {
  resetForm(); fillAccountFamilies(selectedFamily); $('account-collect').hidden = true; $('account-dialog').showModal();
});
$('family-search').addEventListener('input', () => { familySearch = $('family-search').value.trim(); renderFamilies(); });
$('filter-all').addEventListener('click', () => { attentionOnly = false; $('filter-all').classList.toggle('active', true); $('filter-attention').classList.toggle('active', false); renderAccounts(); });
$('filter-attention').addEventListener('click', () => { attentionOnly = true; $('filter-all').classList.toggle('active', false); $('filter-attention').classList.toggle('active', true); renderAccounts(); });
$('bind-device').addEventListener('click', () => openPair());
$('authorize-family').addEventListener('click', () => openPair([selectedFamily]));
$('family-cookie-sync').addEventListener('click', openFamilyCookieSync);
$('family-cookie-sync-generate').addEventListener('click', event => run(generateFamilyCookiePairing, event.currentTarget));
$('family-cookie-sync-copy').addEventListener('click', event => run(async () => {
  if (!familyCookieSyncPairing) return;
  await navigator.clipboard.writeText(JSON.stringify(familyCookieSyncPairing)); notice('插件配对 JSON 已复制。');
}, event.currentTarget));
$('cookie-sync-request-dialog').addEventListener('close', () => {
  if (preserveCookieSyncRequestOnClose) { preserveCookieSyncRequestOnClose = false; cookieSyncRequestGeneration += 1; return; }
  clearCookieSyncRequest();
});
$('cookie-sync-request-family').addEventListener('change', () => {
  const selected = $('cookie-sync-request-family').value;
  $('cookie-sync-request-approve').disabled = !families.some(family => family.id === selected) || !cookieSyncRequest || cookieSyncRequestState !== 'pending';
});
$('cookie-sync-request-approve').addEventListener('click', event => run(approveCookieSyncRequest, event.currentTarget));
$('cookie-sync-request-create-button').addEventListener('click', () => { preserveCookieSyncRequestOnClose = true; $('cookie-sync-request-dialog').close(); openFamily(); });
$('scope').addEventListener('change', clearPairResult);
function openFamily(id = '') {
  $('family-edit-id').value = id; $('family-name').value = id ? familyName(id) : '';
  $('family-dialog-title').textContent = id ? '重命名家人' : '新增家人'; $('family-dialog').showModal();
}
$('new-family').addEventListener('click', () => openFamily());
$('rename-family').addEventListener('click', () => openFamily(selectedFamily));
function submit(id, handler) {
  $(id).addEventListener('submit', event => { event.preventDefault(); run(handler, event.currentTarget); });
}
function confirmPassword(passwordId, confirmId) {
  const validate = () => $(confirmId).setCustomValidity($(confirmId).value && $(passwordId).value !== $(confirmId).value ? '两次输入的密码不一致。' : '');
  $(passwordId).addEventListener('input', validate); $(confirmId).addEventListener('input', validate);
}
confirmPassword('setup-password', 'setup-confirm');
confirmPassword('new-password', 'confirm-password');
submit('family-form', async () => {
  const id = $('family-edit-id').value;
  const result = await api(id ? `/v1/admin/families/${encodeURIComponent(id)}` : '/v1/admin/families', { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ name: $('family-name').value.trim() }) });
  selectedFamily = result.family.id; $('family-dialog').close(); await refreshAfterChange(); renderCookieSyncRequest(); notice('家人已保存。');
});
submit('device-form', async () => {
  const familyIds = [...$('device-scope').querySelectorAll('input:checked')].map(el => el.value);
  const body = { familyIds };
  if ($('clear-legacy').checked) body.accountIds = [];
  await api(`/v1/admin/devices/${encodeURIComponent($('device-id').value)}`, { method: 'PATCH', body: JSON.stringify(body) });
  $('device-dialog').close(); await refreshAfterChange(); notice('设备授权已更新。');
});
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
    $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; notice(''); await loadCookieSyncRequest();
    $('auth-shell').hidden = true;
  } catch (error) { clearSession(); throw error; }
  finally { $('admin-token').value = ''; }
});
$('retry-setup').addEventListener('click', event => run(checkSetup, event.currentTarget));
$('logout').addEventListener('click', () => { clearSession(); notice('已退出管理。'); });
$('diagnostic-reload').addEventListener('click', event => run(loadDiagnosticCredentials, event.currentTarget));
$('diagnostic-token-hide').addEventListener('click', () => { clearDiagnosticToken(); $('diagnostic-name').focus(); });
submit('diagnostic-token-form', async () => {
  const name = $('diagnostic-name').value.trim();
  if (!name) throw new Error('请填写诊断凭据名称。');
  clearDiagnosticToken();
  const result = await api('/v1/admin/diagnostic-tokens', { method: 'POST', body: JSON.stringify({ name }) });
  diagnosticGeneration += 1;
  diagnosticCredentials = [result.credential, ...diagnosticCredentials];
  displayedDiagnosticCredentialId = result.credential.id;
  $('diagnostic-token').value = result.token; $('diagnostic-token-result').hidden = false;
  $('diagnostic-name').value = ''; $('diagnostic-status').textContent = '';
  renderDiagnosticCredentials(); $('diagnostic-token').focus();
  notice('诊断凭据已创建，请立即保存；完整凭据仅显示这一次。');
});
$('settings-base-url').addEventListener('input', () => { settingsDirty = true; });
$('settings-lan-url').addEventListener('input', () => { settingsDirty = true; });
submit('settings-form', async () => {
  const status = await api('/v1/admin/settings', { method: 'PATCH', body: JSON.stringify({ baseUrl: validateBaseUrl($('settings-base-url').value), lanBaseUrl: validateBaseUrl($('settings-lan-url').value) }) });
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
$('cancel-edit').addEventListener('click', () => { resetForm(); $('account-dialog').close(); });
$('account-delete').addEventListener('click', () => run(deleteAccount, $('account-form')));
$('cookie-sync-generate').addEventListener('click', event => run(generateCookiePairing, event.currentTarget));
$('cookie-sync-copy').addEventListener('click', event => run(async () => {
  if (!cookieSyncPairing) return;
  await navigator.clipboard.writeText(JSON.stringify(cookieSyncPairing)); notice('插件配对信息已复制。');
}, event.currentTarget));
submit('account-form', async () => {
  const id = $('account-id').value;
  const body = { platform: $('platform').value, familyId: $('account-family').value, label: $('label').value, intervalMinutes: Number($('interval').value), enabled: $('enabled').checked };
  const old = accounts.find(a => a.id === id);
  if (old && (old.familyId || '') !== body.familyId && !confirm(old.familyId || old.familyAssigned ? '调整归属会改变家人组设备可访问的账号范围，历史包裹保留原家人。确认调整？' : '首次归属会将此账号已有包裹一并分配给所选家人。确认分配？')) return;
  if ($('cookie').value.trim()) body.cookie = $('cookie').value.trim();
  try {
    await api(id ? `/v1/admin/accounts/${encodeURIComponent(id)}` : '/v1/admin/accounts', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    selectedFamily = body.familyId; resetForm(); $('account-dialog').close(); await refreshAfterChange(); notice('账号已保存。');
  } finally { $('cookie').value = ''; }
});
submit('pair-form', async () => {
  if (!baseUrl) throw new Error('请先设置 HTTPS 服务地址，再生成设备绑定码。');
  const familyIds = [...$('scope').querySelectorAll('input:checked')].map(el => el.value);
  if (!familyIds.length) throw new Error('请至少选择一位家人。');
  clearPairResult();
  const result = await api('/v1/pairing-codes', { method: 'POST', body: JSON.stringify({ familyIds }) });
  $('pair-code').textContent = result.code; $('pair-url').textContent = result.baseUrl; $('pair-qr').src = result.qrDataUrl;
  $('pair-expires').textContent = `授权家人：${familyIds.map(familyName).join('、')}；以后新增账号自动包含。有效至 ${date(result.expiresAt)}；使用一次后失效。`; $('pair-result').hidden = false;
  notice('在 App 的“线上账号”页扫码，或输入服务地址与绑定码。');
});
run(checkSetup, $('retry-setup'));
if (typeof window !== 'undefined') import('./station-admin.js').then(async ({ initStationAdmin }) => {
  initStationAdmin({ api, notice });
  const { initLogisticsAdmin } = await import('./logistics-admin.js');
  logisticsAdmin = initLogisticsAdmin({ api, notice });
  const { initPickupCompletionAdmin } = await import('./pickup-completion-admin.js');
  pickupCompletionAdmin = initPickupCompletionAdmin({ api, notice });
}).catch(error => notice(error.message || '设置页面未能加载，请刷新页面。', true));

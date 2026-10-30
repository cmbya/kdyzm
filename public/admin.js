const $ = id => document.getElementById(id);
let token = '';
let accounts = [];
const statusNames = { configured: '待首次采集', syncing: '同步中', ok: '已连接', expired: 'Cookie 已失效', error: '同步失败' };
const date = value => value ? new Date(value).toLocaleString('zh-CN') : '尚无';
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function node(tag, content, className) { const el = document.createElement(tag); el.textContent = content; if (className) el.className = className; return el; }
function action(label, handler, className = 'secondary') {
  const el = node('button', label, className); el.type = 'button';
  el.addEventListener('click', () => run(handler, el)); return el;
}
async function run(fn, button) {
  if (button) button.disabled = true;
  try { await fn(); } catch (e) { notice(e.message || '请求未完成', true); }
  finally { if (button) button.disabled = false; }
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, redirect: 'error', cache: 'no-store',
    headers: { 'x-admin-token': token, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || '请求未完成');
  return data;
}
async function refresh() {
  const [a, d, status] = await Promise.all([api('/v1/admin/accounts'), api('/v1/admin/devices'), api('/v1/admin/status')]);
  accounts = a.accounts;
  $('fixture-notice').hidden = !status.fixture;
  $('accounts').replaceChildren();
  if (!accounts.length) $('accounts').append(node('p', '尚未配置账号。添加后可生成设备绑定码。', 'hint'));
  const selected = new Set([...$('scope').querySelectorAll('input:checked')].map(el => el.value));
  $('scope').replaceChildren(node('legend', '授权账号范围'));
  for (const account of accounts) {
    const item = node('div', '', 'item');
    const title = node('p', `${account.label} · ${account.platform === 'taobao' ? '淘宝' : '拼多多'}`, 'item-title');
    title.append(node('span', statusNames[account.status] || account.status, 'badge'));
    item.append(title, node('p', `最近成功：${date(account.lastSuccessAt)} · ${account.enabled ? `每 ${account.intervalMinutes} 分钟同步` : '自动同步已关闭'}`, 'hint'));
    if (account.error) item.append(node('p', account.error));
    for (const warning of account.warnings || []) item.append(node('p', warning, 'hint'));
    const actions = node('div', '', 'actions');
    actions.append(action('更新账号', () => edit(account)), action('立即采集', async () => {
      await api(`/v1/admin/accounts/${encodeURIComponent(account.id)}/sync`, { method: 'POST', body: '{}' });
      notice('已提交采集请求；重复请求会合并，五分钟内不重复访问平台。'); await refresh();
    }));
    item.append(actions); $('accounts').append(item);
    const label = node('label', '', 'checkbox'); const check = document.createElement('input');
    check.type = 'checkbox'; check.value = account.id; check.checked = selected.has(account.id);
    label.append(check, document.createTextNode(account.label)); $('scope').append(label);
  }
  $('devices').replaceChildren();
  if (!d.devices.length) $('devices').append(node('p', '尚无已绑定设备。', 'hint'));
  for (const device of d.devices) {
    const item = node('div', '', 'item');
    item.append(node('p', device.name, 'item-title'), node('p', `绑定于 ${date(device.createdAt)} · ${device.accountIds.map(id => accounts.find(a => a.id === id)?.label || id).join('、')}`, 'hint'));
    if (device.revokedAt) item.append(node('p', `已撤销 · ${date(device.revokedAt)}`, 'hint'));
    else item.append(action('撤销授权', async () => {
      if (!confirm(`撤销“${device.name}”的线上访问权限？本地历史会保留。`)) return;
      await api(`/v1/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' }); await refresh(); notice('设备授权已撤销。');
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
$('login-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  token = $('admin-token').value; await refresh(); $('admin-token').value = '';
  $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; notice('');
}, event.submitter); });
$('logout').addEventListener('click', () => location.reload());
$('refresh').addEventListener('click', event => run(refresh, event.currentTarget));
$('cancel-edit').addEventListener('click', resetForm);
$('account-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  const id = $('account-id').value;
  const body = { platform: $('platform').value, label: $('label').value, intervalMinutes: Number($('interval').value), enabled: $('enabled').checked };
  if ($('cookie').value.trim()) body.cookie = $('cookie').value.trim();
  await api(id ? `/v1/admin/accounts/${encodeURIComponent(id)}` : '/v1/admin/accounts', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
  $('cookie').value = ''; resetForm(); await refresh(); notice('账号已保存。');
}, event.submitter); });
$('pair-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  const accountIds = [...$('scope').querySelectorAll('input:checked')].map(el => el.value);
  const result = await api('/v1/pairing-codes', { method: 'POST', body: JSON.stringify({ accountIds }) });
  $('pair-code').textContent = result.code; $('pair-url').textContent = result.baseUrl; $('pair-qr').src = result.qrDataUrl;
  $('pair-expires').textContent = `有效至 ${date(result.expiresAt)}；使用一次后立即失效。`; $('pair-result').hidden = false;
  notice('在 App 的“线上账号”页扫码，或输入服务地址与绑定码。');
}, event.submitter); });

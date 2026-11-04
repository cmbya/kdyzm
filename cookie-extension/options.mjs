import { PLATFORMS, pairingInput, errorText } from './core.mjs';
const $ = id => document.getElementById(id);
let pair = null, pendingSync = null, busy = false;
const date = n => n ? new Date(n).toLocaleString('zh-CN') : '尚未同步';
const target = a => `${a.familyName || '待归属'} · ${PLATFORMS[a.platform]?.name || a.platform} · ${a.label}`;
function notice(value, failed = false) { $('notice').textContent = value; $('notice').className = failed ? 'error' : ''; }
async function call(action, args = {}) {
  const result = await chrome.runtime.sendMessage({ action, ...args });
  if (!result?.ok) throw new Error(result?.message || '插件后台未能响应，请重新打开此页面。');
  return result.data;
}
function node(tag, text, cls = '') { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; return el; }
async function run(fn) {
  if (busy) return;
  busy = true; document.querySelectorAll('button').forEach(b => { b.disabled = true; });
  document.querySelectorAll('.check input').forEach(input => { input.disabled = true; });
  try { await fn(); } catch (error) { notice(error.code ? errorText(error) : error.message, true); }
  finally {
    busy = false; document.querySelectorAll('button').forEach(b => { b.disabled = false; });
    document.querySelectorAll('.check input').forEach(input => { input.disabled = input.dataset.bound !== 'true'; });
  }
}
function button(label, fn, cls = 'secondary') {
  const el = node('button', label, cls); el.type = 'button'; el.addEventListener('click', () => run(fn)); return el;
}
async function render() {
  const items = await call('list'); $('connections').replaceChildren();
  $('empty').textContent = '还没有配对账号。请在下方粘贴后台生成的配对信息。'; $('empty').hidden = items.length > 0;
  for (const item of items) {
    const card = node('article', '', 'account'); card.dataset.id = item.id;
    card.append(node('h3', target(item.account)), node('p', item.baseUrl, 'hint'));
    const names = { configured: '等待采集验证', syncing: '正在采集验证', ok: '最近采集成功', expired: '平台登录已失效，请重新登录', error: '采集未完成，请查看后台详情' };
    card.append(node('p', `登录信息同步：${date(item.connection.lastSyncAt)}`, 'status'));
    card.append(node('p', `${names[item.account.status] || '尚未验证'} · 授权到期：${date(item.connection.expiresAt)}`, 'hint'));
    if (item.connection.identityHint) card.append(node('p', `已核对账号：${item.connection.identityHint}`, 'hint'));
    if (item.error) card.append(node('p', item.error, 'account-error'));
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = item.auto;
    checkbox.dataset.bound = String(item.connection.identityBound);
    checkbox.disabled = busy || !item.connection.identityBound; checkbox.setAttribute('aria-label', target(item.account) + '自动同步');
    const label = node('label', '', 'check'); label.append(checkbox, document.createTextNode('登录信息变化时自动同步'));
    checkbox.addEventListener('change', () => {
      if (busy) { checkbox.checked = item.auto; return; }
      void run(async () => { try { await call('auto', { id: item.id, enabled: checkbox.checked }); } finally { await render(); } });
    });
    card.append(label);
    const actions = node('div', '', 'actions');
    actions.append(button('打开登录页', () => call('login', { id: item.id })));
    actions.append(button(item.connection.identityBound ? '立即同步' : '读取并核对登录', async () => {
      if (item.connection.identityBound) { const result = await call('sync', { id: item.id }); notice(result.pending ? '正在同步，请稍后刷新状态。' : result.changed ? '登录信息已同步，采集状态以后台验证结果为准。' : '登录信息未变化。'); await render(); }
      else {
        pendingSync = { id: item.id, confirmation: await call('previewSync', { id: item.id }) };
        $('confirm-target').textContent = target(pendingSync.confirmation.account);
        $('confirm-identity').textContent = `浏览器账号：${pendingSync.confirmation.identityHint}`;
        $('confirm-dialog').showModal();
      }
    }, ''));
    actions.append(button('撤销并移除', async () => {
      if (!confirm(`撤销 ${target(item.account)} 的插件授权？后台历史和账号保持不变。`)) return;
      await call('remove', { id: item.id }); await render(); notice('插件授权已撤销。');
    }, 'danger'));
    card.append(actions); $('connections').append(card);
  }
}
function cancelPair() { pair = null; $('pair-confirm').hidden = true; $('pair-info').value = ''; }
$('pair-form').addEventListener('submit', event => {
  event.preventDefault();
  // Request permissions directly inside the user gesture, before network or messaging.
  let input;
  try { input = pairingInput($('pair-info').value, $('base-url').value); } catch (error) { notice(errorText(error), true); return; }
  const permission = chrome.permissions.request({ origins: [input.baseUrl + '/*'] });
  void run(async () => {
    pair = null; $('pair-confirm').hidden = true;
    if (!await permission) throw new Error('未授权访问后台，配对尚未开始。');
    const preview = await call('previewPair', input); pair = { ...input, ...preview };
    $('pair-target').textContent = target(preview.account); $('pair-origin').textContent = `${input.baseUrl} · 有效至 ${date(preview.expiresAt)}`;
    $('pair-confirm').hidden = false; notice('请核对目标账号，再确认配对。');
  });
});
$('pair-accept').addEventListener('click', () => {
  if (!pair || busy) return;
  const selected = pair;
  const permission = chrome.permissions.request({ origins: PLATFORMS[selected.account.platform].origins });
  void run(async () => {
    if (!await permission) throw new Error('未授权读取此平台登录信息，尚未配对。');
    await call('pair', { ...selected, platform: selected.account.platform, accountId: selected.account.id, name: $('browser-name').value.trim() || '我的 Chrome' });
    cancelPair(); await render(); notice('配对成功。请打开对应平台登录，再读取并核对首次同步。');
  });
});
$('pair-cancel').addEventListener('click', cancelPair);
$('pair-info').addEventListener('input', () => { pair = null; $('pair-confirm').hidden = true; });
$('base-url').addEventListener('input', () => { pair = null; $('pair-confirm').hidden = true; });
$('sync-cancel').addEventListener('click', () => $('confirm-dialog').close());
$('confirm-dialog').addEventListener('close', () => { pendingSync = null; });
$('sync-accept').addEventListener('click', () => run(async () => {
  if (!pendingSync) return;
  const selected = pendingSync;
  const result = await call('confirmSync', selected);
  if (result.pending) { notice('已有同步正在处理，请稍后再确认。'); return; }
  $('confirm-dialog').close(); await render(); notice('首次同步已完成，可按需开启自动同步。登录有效性以后台采集结果为准。');
}));
$('refresh').addEventListener('click', () => run(async () => {
  const items = await call('list'); let failed = 0;
  for (const item of items) { try { await call('status', { id: item.id }); } catch { failed++; } }
  await render(); notice(failed ? `${failed} 个账号暂时无法刷新，请检查授权或后台连接。` : '状态已刷新。', !!failed);
}));
void run(render);

import { PLATFORMS, baseOrigin, pairingInput, errorText } from './core.mjs';
const $ = id => document.getElementById(id);
let pair = null, pendingSync = null, pendingRequest = null, busy = false, renderVersion = 0;
let pollTimer, polling = false, requestVersion = 0, pageActive = true;
const date = n => n ? new Date(n).toLocaleString('zh-CN') : '尚未同步';
const platformName = platform => PLATFORMS[platform]?.name || platform;
const target = a => `${a.familyName || '待归属'} · ${platformName(a.platform)} · ${a.label || '平台账号'}`;
const message = error => error.code ? errorText(error) : error.message;
const platformFailure = (platform, error) => {
  const label = platformName(platform) + '：', detail = message(error);
  return detail.startsWith(label) ? detail : label + detail;
};
const statuses = { configured: '等待采集验证', syncing: '正在采集验证', ok: '最近采集成功', expired: '平台登录已失效，请重新登录', error: '采集未完成，请查看后台详情' };
function notice(value, failed = false) { $('notice').textContent = value; $('notice').className = failed ? 'error' : ''; }
async function call(action, args = {}) {
  const result = await chrome.runtime.sendMessage({ action, ...args });
  if (!result?.ok) throw new Error(result?.message || '插件后台未能响应，请重新打开此页面。');
  return result.data;
}
function node(tag, text, cls = '') { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; return el; }
function controls() {
  document.querySelectorAll('button, input, textarea').forEach(el => {
    el.disabled = busy || el.dataset.allowed === 'false' || (!!pendingRequest && el.dataset.requestInput === 'true');
  });
}
async function run(fn) {
  if (busy) return;
  busy = true; controls();
  try { await fn(); } catch (error) { notice(message(error), true); }
  finally { busy = false; controls(); }
}
function button(label, fn, cls = 'secondary', allowed = true) {
  const el = node('button', label, cls); el.type = 'button'; el.dataset.allowed = String(allowed);
  el.addEventListener('click', () => run(fn)); return el;
}
async function authorizePlatforms(platforms) {
  const origins = [...new Set(platforms.flatMap(platform => PLATFORMS[platform].origins))];
  if (!await chrome.permissions.request({ origins })) throw new Error('未授权读取所选平台登录信息，本次未读取或同步。');
}
function checkbox(labelText, checked, allowed = true) {
  const input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!checked; input.dataset.allowed = String(allowed);
  const label = node('label', '', 'check'); label.append(input, document.createTextNode(labelText));
  return { input, label };
}
function syncStatus(card, item) {
  const connection = item.connection;
  card.append(node('p', `登录信息同步：${date(connection?.lastSyncAt)}`, 'status'));
  card.append(node('p', item.unconfigured ? '首次确认同步后，会在此角色下添加平台账号。' : statuses[item.account.status] || '尚未验证', 'hint'));
  if (connection?.identityHint) card.append(node('p', `已核对账号：${connection.identityHint}`, 'hint'));
  if (item.error) card.append(node('p', item.error, 'account-error'));
  if (item.account.platform === 'pdd') card.append(node('p', '请在此浏览器的拼多多网页订单页登录；手机 App 登录不会同步到浏览器。', 'hint'));
}
function showConfirmation(entries, { familyName, failures = [] } = {}) {
  pendingSync = { entries, failures, familyName };
  $('confirm-title').textContent = familyName ? '核对已选平台' : '核对首次同步';
  $('confirm-target').textContent = familyName ? `同步到角色：${familyName}` : target(entries[0].confirmation.account);
  $('confirm-identity').textContent = familyName ? '请逐项核对浏览器账号，确认后会分别同步。' : `浏览器账号：${entries[0].confirmation.identityHint}`;
  const list = $('confirm-accounts'); list.replaceChildren();
  if (familyName) for (const entry of entries) {
    list.append(node('li', `${platformName(entry.confirmation.account.platform)} · ${entry.confirmation.account.label || '平台账号'} · ${entry.confirmation.identityHint}`));
  }
  list.hidden = !familyName;
  $('confirm-errors').textContent = failures.length ? `以下平台未读取成功，本次不会同步：\n${failures.join('\n')}` : '';
  $('confirm-dialog').showModal();
}
async function render() {
  const version = ++renderVersion;
  const [items, groups] = await Promise.all([call('list'), call('family:list')]);
  if (version !== renderVersion || !pageActive) return;
  $('connections').replaceChildren();
  $('empty').textContent = '还没有授权角色。可以先在浏览器登录平台，再到后台选择角色授权；也可以粘贴后台生成的配对信息。';
  $('empty').hidden = items.length + groups.length > 0;
  for (const group of groups) renderFamily(group);
  if (items.length) $('connections').append(node('h3', '单账号配对', 'legacy-title'));
  for (const item of items) renderLegacy(item);
  controls();
}
function renderLegacy(item) {
  const card = node('article', '', 'account'); card.dataset.id = item.id;
  card.append(node('h3', target(item.account)), node('p', item.baseUrl, 'hint'));
  syncStatus(card, item);
  card.append(node('p', `授权到期：${date(item.connection.expiresAt)}`, 'hint'));
  const auto = checkbox('登录信息变化时自动同步', item.auto, item.connection.identityBound);
  auto.input.setAttribute('aria-label', target(item.account) + '自动同步');
  auto.input.addEventListener('change', () => {
    if (busy) { auto.input.checked = item.auto; return; }
    const enabled = auto.input.checked;
    void run(async () => { try {
      if (enabled) await authorizePlatforms([item.account.platform]);
      await call('auto', { id: item.id, enabled });
    } finally { await render(); } });
  });
  card.append(auto.label);
  const actions = node('div', '', 'actions');
  actions.append(button('打开登录页', () => call('login', { id: item.id })));
  actions.append(button(item.connection.identityBound ? '立即同步' : '读取并核对登录', async () => {
    await authorizePlatforms([item.account.platform]);
    if (item.connection.identityBound) {
      const result = await call('sync', { id: item.id });
      notice(result.pending ? '正在同步，请稍后刷新状态。' : result.changed ? '登录信息已同步，采集状态以后台验证结果为准。' : '登录信息未变化。'); await render();
    } else showConfirmation([{ id: item.id, confirmation: await call('previewSync', { id: item.id }) }]);
  }, ''));
  actions.append(button('撤销并移除', async () => {
    if (!confirm(`撤销 ${target(item.account)} 的插件授权？后台历史和账号保持不变。`)) return;
    await call('remove', { id: item.id }); await render(); notice('插件授权已撤销。');
  }, 'danger'));
  card.append(actions); $('connections').append(card);
}
function renderFamily(group) {
  const card = node('article', '', 'account family'); card.dataset.id = group.id;
  card.append(node('h3', group.family.name), node('p', `${group.baseUrl} · 授权到期：${date(group.connection.expiresAt)}`, 'hint'));
  card.append(node('p', '勾选要同步的平台。以后新增的平台账号默认不勾选；首次同步需核对账号。', 'hint'));
  if (group.error) card.append(node('p', group.error, 'account-error'));
  if (!group.accounts.length) card.append(node('p', '此角色暂无可同步的平台，请刷新状态或更新配套后台。', 'hint'));
  for (const item of group.accounts) {
    const row = node('div', '', 'platform-account'); row.dataset.accountId = item.account.id;
    row.append(node('h4', `${platformName(item.account.platform)} · ${item.account.label || '平台账号'}`));
    const select = checkbox('同步此平台', item.selected);
    select.input.setAttribute('aria-label', `${group.family.name} · ${platformName(item.account.platform)} 同步此平台`);
    select.input.addEventListener('change', () => {
      if (busy) { select.input.checked = item.selected; return; }
      const enabled = select.input.checked;
      // Permission requests must remain directly in the user's checkbox gesture.
      const permission = enabled ? chrome.permissions.request({ origins: PLATFORMS[item.account.platform].origins }) : Promise.resolve(true);
      void run(async () => {
        try {
          if (!await permission) throw new Error('未授权读取此平台登录信息，该平台保持关闭。');
          await call('family:select', { id: group.id, accountId: item.account.id, enabled });
        } finally { await render(); }
      });
    });
    row.append(select.label); syncStatus(row, item);
    const auto = checkbox('登录信息变化时自动同步', item.auto, !!(item.selected && item.connection?.identityBound));
    auto.input.setAttribute('aria-label', `${target(item.account)}自动同步`);
    auto.input.addEventListener('change', () => {
      if (busy) { auto.input.checked = item.auto; return; }
      const enabled = auto.input.checked;
      void run(async () => { try {
        if (enabled) await authorizePlatforms([item.account.platform]);
        await call('family:auto', { id: group.id, accountId: item.account.id, enabled });
      } finally { await render(); } });
    });
    row.append(auto.label);
    const actions = node('div', '', 'actions');
    actions.append(button('打开登录页', () => call('family:login', { id: group.id, accountId: item.account.id })));
    actions.append(button(item.connection?.identityBound ? '立即同步' : '读取并核对登录', async () => {
      await authorizePlatforms([item.account.platform]);
      const args = { id: group.id, accountId: item.account.id };
      if (item.connection?.identityBound) {
        const result = await call('family:sync', args);
        notice(result.pending ? '正在同步，请稍后刷新状态。' : result.changed ? '登录信息已同步，采集状态以后台验证结果为准。' : '登录信息未变化。'); await render();
      } else showConfirmation([{ ...args, family: true, confirmation: await call('family:previewSync', args) }], { familyName: group.family.name });
    }, 'secondary', item.selected));
    row.append(actions); card.append(row);
  }
  const actions = node('div', '', 'actions');
  actions.append(button('读取并核对已选平台', async () => {
    await authorizePlatforms(group.accounts.filter(item => item.selected).map(item => item.account.platform));
    const entries = [], failures = [];
    for (const item of group.accounts.filter(account => account.selected)) {
      const args = { id: group.id, accountId: item.account.id };
      try { entries.push({ ...args, family: true, confirmation: await call('family:previewSync', args) }); }
      catch (error) { failures.push(platformFailure(item.account.platform, error)); }
    }
    if (!entries.length) { await render(); notice(failures.length ? failures.join('\n') : '请先勾选要同步的平台。', !!failures.length); return; }
    showConfirmation(entries, { familyName: group.family.name, failures });
  }, '', group.accounts.some(item => item.selected)));
  actions.append(button('刷新角色平台', async () => { await call('family:status', { id: group.id }); await render(); notice('角色平台已刷新，新增账号需手动勾选。'); }));
  actions.append(button('撤销角色授权', async () => {
    if (!confirm(`撤销 ${group.family.name} 的全部插件同步授权？后台历史和账号保持不变。`)) return;
    await call('family:remove', { id: group.id }); await render(); notice('角色的插件授权已撤销。');
  }, 'danger'));
  card.append(actions); $('connections').append(card);
}
function cancelPair() { pair = null; $('pair-confirm').hidden = true; $('pair-info').value = ''; }
$('pair-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  let input;
  try { input = pairingInput($('pair-info').value, $('base-url').value); } catch (error) { notice(errorText(error), true); return; }
  const permission = chrome.permissions.request({ origins: [input.baseUrl + '/*'] });
  void run(async () => {
    pair = null; $('pair-confirm').hidden = true;
    if (!await permission) throw new Error('未授权访问后台，配对尚未开始。');
    const preview = await call(input.scope === 'family' ? 'family:previewPair' : 'previewPair', input); pair = { ...input, ...preview };
    $('pair-target').textContent = input.scope === 'family' ? `角色：${preview.family.name}` : target(preview.account);
    $('pair-origin').textContent = `${input.baseUrl} · 有效至 ${date(preview.expiresAt)}`;
    $('pair-scope').textContent = input.scope === 'family' ? `授权覆盖此角色当前及以后新增的支持平台（${Object.values(PLATFORMS).map(p => p.name).join('、')}）。配对后由你勾选同步平台，默认全部关闭。` : '此配对只授权上方的单个平台账号。';
    $('pair-accept').textContent = input.scope === 'family' ? '确认配对角色' : '确认配对并授权平台';
    $('pair-confirm').hidden = false; notice(input.scope === 'family' ? '请核对目标角色，再确认配对。' : '请核对目标账号，再确认配对。');
  });
});
$('pair-accept').addEventListener('click', () => {
  if (!pair || busy) return;
  const selected = pair;
  const permission = selected.scope === 'family' ? Promise.resolve(true) : chrome.permissions.request({ origins: PLATFORMS[selected.account.platform].origins });
  void run(async () => {
    if (!await permission) throw new Error('未授权读取此平台登录信息，尚未配对。');
    const name = $('browser-name').value.trim() || '我的 Chrome';
    if (selected.scope === 'family') await call('family:pair', { ...selected, familyId: selected.family.id, name });
    else await call('pair', { ...selected, platform: selected.account.platform, accountId: selected.account.id, name });
    cancelPair(); await render();
    notice(selected.scope === 'family' ? '角色配对成功。请勾选要同步的平台，登录后读取并核对。' : '配对成功。请打开对应平台登录，再读取并核对首次同步。');
  });
});
$('pair-cancel').addEventListener('click', cancelPair);
for (const id of ['pair-info', 'base-url']) $(id).addEventListener('input', () => { pair = null; $('pair-confirm').hidden = true; });
$('sync-cancel').addEventListener('click', () => { if (!busy) $('confirm-dialog').close(); });
$('confirm-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('confirm-dialog').addEventListener('close', () => { pendingSync = null; });
$('sync-accept').addEventListener('click', () => run(async () => {
  if (!pendingSync) return;
  const selected = pendingSync;
  if (!selected.familyName) {
    const result = await call('confirmSync', selected.entries[0]);
    if (result.pending) { notice('已有同步正在处理，请稍后再确认。'); return; }
    $('confirm-dialog').close(); await render(); notice('首次同步已完成，可按需开启自动同步。登录有效性以后台采集结果为准。'); return;
  }
  let completed = 0;
  const failures = [...selected.failures];
  for (const entry of selected.entries) {
    try {
      const result = await call('family:confirmSync', { id: entry.id, accountId: entry.accountId, confirmation: entry.confirmation });
      if (result.pending) failures.push(`${platformName(entry.confirmation.account.platform)}：已有同步正在处理，请稍后重新读取核对。`);
      else completed++;
    } catch (error) { failures.push(`${platformName(entry.confirmation.account.platform)}：${message(error)}`); }
  }
  $('confirm-dialog').close(); await render();
  notice(`${completed} 个平台已完成同步。${completed ? '可按需开启自动同步，登录有效性以后台采集结果为准。' : ''}${failures.length ? `\n${failures.length} 个平台未同步：\n${failures.join('\n')}` : ''}`, !!failures.length);
}));
$('refresh').addEventListener('click', () => run(async () => {
  const [items, groups] = await Promise.all([call('list'), call('family:list')]); let failed = 0;
  for (const item of items) { try { await call('status', { id: item.id }); } catch { failed++; } }
  for (const group of groups) { try { await call('family:status', { id: group.id }); } catch { failed++; } }
  await render(); notice(failed ? `${failed} 个授权暂时无法刷新，请检查授权或后台连接。` : '状态已刷新。', !!failed);
}));

for (const [platform, profile] of Object.entries(PLATFORMS)) {
  const row = node('div', '', 'request-platform');
  const selected = checkbox(profile.name, false); selected.input.id = `request-platform-${platform}`; selected.input.dataset.requestInput = 'true';
  row.append(selected.label, button('打开登录页', () => chrome.tabs.create({ url: profile.login })));
  $('request-platforms').append(row);
}
function setPendingRequest(value) {
  pendingRequest = value; requestVersion++; clearTimeout(pollTimer);
  $('request-pending').hidden = !value;
  $('request-submit').dataset.allowed = String(!value);
  if (value) {
    $('request-base-url').value = value.baseUrl;
    for (const platform of Object.keys(PLATFORMS)) $(`request-platform-${platform}`).checked = value.platforms.includes(platform);
    $('request-target').textContent = `${value.baseUrl} · ${value.platforms.map(platformName).join('、')}`;
    $('request-code').textContent = value.code;
    $('request-expiry').textContent = `有效至 ${date(value.expiresAt)}。在后台选择已有角色并批准后，此处会自动更新。`;
    $('request-status').textContent = '';
    $('request-open').dataset.allowed = String(value.expiresAt > Date.now());
  }
  controls(); schedulePoll();
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!pageActive || document.hidden || !pendingRequest) return;
  if (pendingRequest.expiresAt <= Date.now()) {
    $('request-status').textContent = '授权请求已过期。请取消后重新发起。'; $('request-open').dataset.allowed = 'false'; controls(); return;
  }
  pollTimer = setTimeout(pollRequest, 3000);
}
async function pollRequest() {
  if (!pageActive || document.hidden || !pendingRequest) return;
  if (pendingRequest.expiresAt <= Date.now()) { schedulePoll(); return; }
  if (busy || polling) { schedulePoll(); return; }
  const version = requestVersion; polling = true;
  try {
    const result = await call('family:pollRequest');
    if (version !== requestVersion || !pageActive) return;
    if (result.status === 'approved') {
      setPendingRequest(null); await render();
      notice('角色已授权，已为你勾选申请的平台。请点击“读取并核对已选平台”，核对账号后首次同步；自动同步仍为关闭。');
    } else $('request-status').textContent = '等待后台批准…';
  } catch (error) {
    if (version !== requestVersion || !pageActive) return;
    $('request-status').textContent = message(error);
    const current = await call('family:pendingRequest').catch(() => pendingRequest);
    if (version !== requestVersion || !pageActive) return;
    if (!current) { setPendingRequest(null); notice(message(error), true); }
  } finally { polling = false; schedulePoll(); }
}
$('request-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy || pendingRequest) return;
  let baseUrl;
  try { baseUrl = baseOrigin($('request-base-url').value); } catch (error) { notice(errorText(error), true); return; }
  const platforms = Object.keys(PLATFORMS).filter(platform => $(`request-platform-${platform}`).checked);
  if (!platforms.length) { notice('请先勾选至少一个已经在此浏览器登录的平台。', true); return; }
  const permission = chrome.permissions.request({ origins: [baseUrl + '/*', ...platforms.flatMap(platform => PLATFORMS[platform].origins)] });
  void run(async () => {
    if (!await permission) throw new Error('未获得后台或平台访问权限，授权请求尚未发起。');
    const pending = await call('family:startRequest', { baseUrl, name: $('request-browser-name').value.trim() || '我的 Chrome', platforms });
    setPendingRequest(pending); notice('已读取选中平台的登录状态。请在打开的后台选择角色并批准；确认同步前不会保存登录信息或创建账号。');
    await call('family:openRequest');
  });
});
$('request-open').addEventListener('click', () => run(() => call('family:openRequest')));
$('request-cancel').addEventListener('click', () => run(async () => {
  await call('family:cancelRequest'); setPendingRequest(null); notice('已停止此浏览器的授权请求，可重新选择平台发起。');
}));
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(pollTimer); else schedulePoll(); });
window.addEventListener('pagehide', () => { pageActive = false; requestVersion++; renderVersion++; clearTimeout(pollTimer); });
window.addEventListener('pageshow', () => { pageActive = true; schedulePoll(); });
void run(async () => { await render(); setPendingRequest(await call('family:pendingRequest')); });

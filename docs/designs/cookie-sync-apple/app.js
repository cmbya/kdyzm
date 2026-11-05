'use strict';

// Standalone visual prototype. All accounts, connections and operations are simulated.
// It never reads browser cookies, calls a backend or launches a native update tool.
const paths = {
  package: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.2l8 4.6"/>',
  settings: '<path d="m9.5 3-.6 2.2-2 .9-2-.6-2.5 4.3L4 11.4v2.2l-1.6 1.6 2.5 4.3 2-.6 2 .9.6 2.2h5l.6-2.2 2-.9 2 .6 2.5-4.3-1.6-1.6v-2.2l1.6-1.6-2.5-4.3-2 .6-2-.9L14.5 3h-5Z" transform="translate(0 -1) scale(1 .98)"/><circle cx="12" cy="11.5" r="3.2"/>',
  cloud: '<path d="M6.5 18h11a4 4 0 0 0 .6-7.95A6.2 6.2 0 0 0 6.25 8.8 4.65 4.65 0 0 0 6.5 18Z"/>',
  shield: '<path d="M12 3 4.5 6v5c0 4.7 3.1 8 7.5 10 4.4-2 7.5-5.3 7.5-10V6L12 3Z"/><path d="m8.5 11.8 2.3 2.3 4.8-5"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2.5a7 7 0 0 1 14 0V21"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  link: '<path d="m10 7 2-2a5 5 0 0 1 7 7l-2 2M14 17l-2 2a5 5 0 0 1-7-7l2-2M8 16l8-8"/>',
  reverse: '<path d="M4 7h13l-4-4m4 4-4 4M20 17H7l4-4m-4 4 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5 5.5-5.5"/>',
  sync: '<path d="M20 8a8.2 8.2 0 0 0-14-3L3 8m0-5v5h5M4 16a8.2 8.2 0 0 0 14 3l3-3m0 5v-5h-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/>',
  more: '<circle cx="5" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="19" cy="12" r=".8"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M9 5H4v15h15v-5"/>',
  folder: '<path d="M3 7V5h6l2 2h10v13H3V7Z"/>',
  logout: '<path d="M10 4H4v16h6m4-12 4 4-4 4M8 12h13"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const platforms = {
  taobao: { name: '淘宝', mark: '淘', account: '春日***风' },
  jd: { name: '京东', mark: 'JD', account: 'jd_***0826' },
  pdd: { name: '拼多多', mark: '拼', account: '拾光***' },
};
const keys = Object.keys(platforms);
const logo = (id) => `<span class="platform-logo ${id}" aria-hidden="true">${platforms[id].mark}</span>`;
const button = (text, action, kind = 'primary', extra = '') => `<button class="button ${kind}" data-action="${action}" ${extra}>${text}</button>`;
const main = document.querySelector('#main');
const dialog = document.querySelector('#flow-dialog');
const modal = document.querySelector('#dialog-content');
const sceneSelect = document.querySelector('#scene');
const storageKey = 'pickcode-apple-design-v1';

function sampleRole() {
  return { id: 'self', name: '我的账号', selected: [...keys], automatic: ['taobao','jd'], confirmed: ['taobao','jd'], scope: [...keys], states: { taobao:'verified', jd:'verified', pdd:'login' } };
}
function freshState() {
  return { active: 0, backends: [{ address: 'https://sync.example.com', roles: [sampleRole()] }], offline: false, pending: null, loggedIn: ['taobao','jd'], browserName: '我的 Chrome', updated: false };
}
let state = freshState();
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (saved && Array.isArray(saved.backends) && saved.backends.length && Number.isInteger(saved.active)) state = saved;
} catch { /* File previews and privacy modes may not provide storage. */ }
let flow = { mode: 'bind', roleName: '家人', selected: [], roleId: null, scope: [...keys] };
let page = '';
let returnFocus = null;
let timer = null;
let toastTimer = null;
let addressReturn = 'chooser';
let updateStage = 'available';
const backend = () => state.backends[state.active] || state.backends[0];
const currentRole = () => backend().roles.find((role) => role.id === flow.roleId) || backend().roles[0];
const host = () => backend().address ? new URL(backend().address).host : '尚未设置后台';
function persist() { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Preview remains usable without persistence. */ } }
function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach((node) => { node.innerHTML = icon(node.dataset.icon); }); }
function notify(message) {
  clearTimeout(toastTimer);
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}
function header(title, description) {
  return `<div class="page-heading"><div><p class="eyebrow">CONNECTED. SIMPLY.</p><h1>${title}</h1><p>${description}</p></div><span class="page-note">让每一次登录，都刚刚好。</span></div>`;
}
function connection() {
  const b = backend();
  return `<section class="connection-bar" aria-label="后台连接"><span class="connection-icon">${icon('cloud')}</span><div class="connection-copy"><strong>我的后台</strong>${state.backends.length > 1 ? `<select class="backend-select" id="backend-select" aria-label="切换后台">${state.backends.map((item,i) => `<option value="${i}" ${i === state.active ? 'selected' : ''}>${escape(new URL(item.address).host)}</option>`).join('')}</select>` : `<span class="hostname">${b.address ? escape(host()) : '保存一次，之后自动记住'}</span>`}</div><span class="status ${!b.address || state.offline ? 'amber' : 'green'}">${!b.address ? '未设置' : state.offline ? '暂时离线' : '已连接'}</span><button class="icon-button" data-action="address" aria-label="后台地址设置">${icon('chevron')}</button></section>`;
}
const stateLabels = {
  verified: ['已同步','后台已验证 · 今天 10:42','green-text','checkCircle'],
  pending: ['已同步','等待后台采集验证','blue-text','clock'],
  login: ['需要登录','登录后继续同步','amber-text','info'],
  permission: ['需要授权','尚未授予站点权限','amber-text','shield'],
  conflict: ['账号不匹配','已停止同步此平台','red-text','info'],
  expired: ['授权已失效','请重新绑定角色','red-text','info'],
};
function platformRow(role, id) {
  const p = platforms[id];
  const status = role.states[id] || 'login';
  const [title, detail, color, glyph] = stateLabels[status];
  const actions = { login:['去登录','login'], permission:['授予权限','permission'], conflict:['查看账号','conflict'], expired:['重新授权','chooser'] };
  const action = actions[status];
  return `<div class="platform-row">${logo(id)}<div class="platform-info"><div class="platform-name">${p.name}</div><div class="platform-account">${action ? title : escape(p.account)}</div></div><div class="platform-state"><div class="state-label ${color}">${icon(glyph)}${title}</div><p>${detail}</p></div><div class="row-action">${action ? button(action[0],action[1],'small tinted',`data-role="${role.id}" data-platform="${id}"`) : ''}</div></div>`;
}
function roleCard(role) {
  return `<section class="role-card" aria-label="${escape(role.name)}同步"><div class="role-heading"><span class="avatar">${icon('user')}</span><div class="role-title"><h2>${escape(role.name)}</h2><p>${role.selected.length} 个平台${role.scope.length === 1 ? ' · 单平台授权' : ' · 已获得角色授权'}</p></div><span class="role-tag">${role.scope.length === 1 ? '单平台' : '角色'}</span><button class="icon-button" data-action="role-more" data-role="${role.id}" aria-label="${escape(role.name)}更多操作">${icon('more')}</button></div><div class="platform-list">${role.selected.length ? role.selected.map((id) => platformRow(role,id)).join('') : '<p class="compact-note">还没有选择平台，在“管理平台”中添加。</p>'}</div><div class="role-bottom"><div class="role-actions">${button(`${icon('sync')}同步所选平台`,'sync','primary',`data-role="${role.id}" ${!role.selected.length ? 'disabled' : ''}`)}${button('管理平台','manage','tertiary',`data-role="${role.id}"`)}</div><span class="auto-summary">${icon('sync')}${role.automatic.length ? `自动同步已开启 · ${role.automatic.length} 个平台` : '自动同步未开启'}</span></div></section>`;
}
function render() {
  const b = backend();
  main.innerHTML = header('登录同步', b.roles.length ? '把平台登录留给浏览器，把同步交给取件助手。' : '连接你的后台，开始更轻松的同步。') + connection()
    + (state.offline ? `<div class="inline-notice">${icon('info')}<span class="notice-copy">后台暂时无法连接，已保留上次同步状态和角色授权。</span>${button('重试','reconnect','small tertiary')}</div>` : '')
    + (state.pending ? `<div class="inline-notice info">${icon('clock')}<span class="notice-copy">有一份授权申请正在等待后台批准。</span>${button('查看','resume','small tinted')}</div>` : '')
    + (b.roles.length ? b.roles.map(roleCard).join('') + `<button class="add-authorization" data-action="chooser">${icon('plus')}添加授权<span>绑定后台 · 反向授权</span></button>` : `<section class="role-card empty-state"><div class="empty-graphic">${keys.map(logo).join('')}</div><h2>从一次授权开始。</h2><p>选择要同步的平台，连接到你的角色。<br>以后只需一键，登录状态即可同步。</p>${button(`${icon('plus')}添加授权`,'chooser')}<p class="compact-note">支持淘宝、京东、拼多多</p></section>`);
}
function close() { clearTimeout(timer); page = ''; if (dialog.open) dialog.close(); }
dialog.addEventListener('close', () => { page = ''; clearTimeout(timer); if (returnFocus?.isConnected) returnFocus.focus(); });
dialog.addEventListener('cancel', () => { clearTimeout(timer); });
dialog.addEventListener('click', (event) => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } });
function shell(kicker, body, demo = '') {
  modal.innerHTML = `<div class="dialog-top"><div class="dialog-kicker">${icon('package')}${kicker}</div><button class="icon-button" data-action="close" aria-label="关闭弹窗">${icon('close')}</button></div><div class="dialog-body">${body}</div>${demo ? `<div class="demo-controls"><span>设计稿演示</span>${demo}</div>` : ''}`;
  if (!dialog.open) { returnFocus = document.activeElement; dialog.showModal(); }
  else modal.querySelector('input:not([type="checkbox"]), textarea, button')?.focus({ preventScroll:true });
}
function mini() { return `<div class="connection-mini">${icon('cloud')}<span class="host">${escape(host())}</span><span class="saved">已记住</span></div>`; }
function steps(n) { return `<div class="progress-steps" aria-label="第 ${n} 步，共 3 步">${[1,2,3].map((i)=>`<span class="${i <= n ? 'active' : ''}"></span>`).join('')}</div>`; }
function target(name = flow.roleName) { return `<div class="target-pill">${icon('user')}<span>同步至 <strong>${escape(name)}</strong></span><span style="margin-left:auto">${escape(host())}</span></div>`; }
function title(text, description) { return `<h2 id="dialog-title">${text}</h2><p class="dialog-description">${description}</p>`; }
function formError(message) { document.querySelector('#form-error').textContent = message; }
function show(view) {
  clearTimeout(timer);
  page = view;
  const role = currentRole();
  const modeName = flow.mode === 'reverse' ? '反向授权' : '绑定后台';
  if (view === 'chooser') {
    if (!backend().address) { addressReturn = 'chooser'; return show('address'); }
    shell('添加授权', title('选择连接方式','两种方式，同一个目的地。') + mini() + `<div class="choice-list"><button class="choice" data-action="bind"><span class="choice-icon">${icon('link')}</span><span class="choice-copy"><strong>绑定后台</strong><small>已有配对信息，直接连接角色</small></span>${icon('chevron')}</button><button class="choice" data-action="reverse"><span class="choice-icon reverse">${icon('reverse')}</span><span class="choice-copy"><strong>反向授权</strong><small>从这里发起，由后台选择角色并批准</small></span>${icon('chevron')}</button></div><p class="compact-note center">后台地址会自动沿用，无需重复填写。</p>`);
  } else if (view === 'address') {
    shell('后台设置', title(backend().address ? '你的后台，已记住。' : '先连接你的后台。','两种授权方式共用这个地址。') + `<label class="form-label" for="backend-address">后台地址</label><input type="url" id="backend-address" placeholder="https://你的后台地址" value="${escape(backend().address)}" autocomplete="off"><p class="field-error" id="form-error" role="alert"></p><p class="input-hint">切换到新地址会创建独立连接，原有角色授权仍保留。</p><div class="dialog-actions">${button('取消','close','tertiary')}${button('保存地址','save-address')}</div>`, '<button data-action="fill-address">填入示例地址</button>');
  } else if (view === 'bind') {
    shell('绑定后台', title('连接到你的角色。','粘贴后台生成的配对信息，下一步选择平台。') + steps(1) + mini() + `<label class="form-label" for="pairing-code">配对信息</label><textarea id="pairing-code" placeholder="粘贴配对信息或角色配对码" spellcheck="false"></textarea><p class="field-error" id="form-error" role="alert"></p><p class="input-hint">也支持旧版单平台配对码，权限范围保持不变。</p><div class="dialog-actions spread">${button('返回','chooser','tertiary')}${button(`下一步${icon('arrow')}`,'parse-pairing')}</div>`, '<button data-action="fill-code">填入示例配对码</button>');
  } else if (view === 'select') {
    shell(modeName, title('选择要同步的平台。',flow.mode === 'reverse' ? '先选择平台，再由后台决定授权给哪个角色。' : '只读取你选择的平台，之后也可以随时修改。') + steps(2) + (flow.mode === 'reverse' ? mini() : target()) + flow.scope.map((id) => `<label class="select-row">${logo(id)}<span class="platform-info"><span class="platform-name">${platforms[id].name}</span><span class="platform-account" style="display:block">${state.loggedIn.includes(id) ? '等待检查登录状态' : '可稍后登录，不影响其他平台'}</span></span><input type="checkbox" name="platform" value="${id}" aria-label="选择${platforms[id].name}" ${flow.selected.includes(id) ? 'checked' : ''}></label>`).join('') + `<p class="select-note">后续自动同步默认关闭，可在“管理平台”中开启。</p><div class="dialog-actions spread">${button('返回',flow.mode === 'reverse' ? 'chooser' : 'bind','tertiary')}${button(flow.mode === 'reverse' ? '发起授权申请' : '检查并继续','check-selection','primary',`id="selection-next" ${!flow.selected.length ? 'disabled' : ''}`)}</div>`);
  } else if (view === 'checking') {
    shell(modeName, `<div class="status-hero"><div class="status-orb">${icon('sync')}</div>${title('正在检查登录状态','每个平台独立处理，缺少登录也可以稍后补充。')}</div><div class="sync-progress"><span></span></div><p class="compact-note center">${flow.selected.map((id)=>platforms[id].name).join(' · ')}</p><div class="dialog-actions">${button('取消','close','tertiary')}</div>`);
    timer = setTimeout(() => {
      if (flow.mode === 'reverse') { state.pending = { ...flow, selected:[...flow.selected] }; persist(); render(); show('waiting'); }
      else show('confirm');
    }, 950);
  } else if (view === 'waiting') {
    shell('反向授权', `<div class="status-hero"><div class="status-orb">${icon('cloud')}</div>${title('等待后台授权。','请在后台选择或新建角色，然后批准本次申请。')}</div><div class="wait-progress"><span class="spinner"></span><span>等待管理员批准</span><small>有效期 10 分钟</small></div>${mini()}<p class="compact-note">已选择 ${flow.selected.map((id)=>platforms[id].name).join('、')}。未登录的平台可以在授权后补充。</p><details class="details"><summary>申请详情</summary><p>浏览器：${escape(state.browserName)}<br>申请码：DEMO-8246<br>批准前不会向后台发送平台登录信息。</p></details><div class="dialog-actions spread">${button('取消申请','cancel-request','tertiary')}${button(`打开后台${icon('external')}`,'approval')}</div>`, '<button data-action="request-expired">演示申请过期</button>');
  } else if (view === 'approval') {
    shell('设计稿 · 后台审批预览', title('将授权关联到角色。','这是后台审批步骤的示意，不会访问真实后台。') + `<label class="form-label" for="approve-role">选择或新增角色</label><input id="approve-role" type="text" value="家人" maxlength="20"><p class="input-hint">申请平台：${flow.selected.map((id)=>platforms[id].name).join('、')}</p><p class="field-error" id="form-error" role="alert"></p><div class="dialog-actions spread">${button('返回插件','waiting','tertiary')}${button('批准并返回插件','approve-request')}</div>`);
  } else if (view === 'request-expired') {
    shell('反向授权', `<div class="status-hero"><div class="status-orb warning">${icon('clock')}</div>${title('申请已过期。','后台地址和平台选择已保留，可以重新发起申请。')}</div><div class="dialog-actions">${button('暂时关闭','close','tertiary')}${button('重新申请','retry-request')}</div>`);
  } else if (view === 'confirm') {
    const existingRole = backend().roles.find((item)=>item.id === flow.roleId);
    const blocked = flow.selected.filter((id)=>['conflict','permission','expired'].includes(existingRole?.states[id]));
    const available = flow.selected.filter((id)=>state.loggedIn.includes(id) && !blocked.includes(id));
    const missing = flow.selected.filter((id)=>!state.loggedIn.includes(id));
    shell(modeName, title('确认一次，安心同步。','请确认这些平台账号属于目标角色。后续账号一致时会直接同步。') + steps(3) + (flow.mode === 'reverse' ? `<div class="inline-notice success">${icon('checkCircle')}<span>后台已批准 ${flow.selected.length} 个平台，授权角色如下。</span></div>` : '') + target() + available.map((id)=>`<div class="account-row">${logo(id)}<div class="platform-info"><strong>${platforms[id].name}</strong><p>${platforms[id].account}</p></div><span class="subtle-tag">${existingRole?.confirmed.includes(id) ? '已核对' : '首次核对'}</span></div>`).join('') + (missing.length ? `<div class="inline-notice info" style="margin-top:18px">${icon('info')}<span>${missing.map((id)=>platforms[id].name).join('、')}需要登录${available.length ? '，其余平台可先同步。' : '，授权后可以逐一补充。'}</span></div>` : '') + (blocked.length ? `<p class="compact-note">${blocked.map((id)=>platforms[id].name).join('、')}仍需处理账号或权限问题，本次不会覆盖。</p>` : '') + `<div class="dialog-actions spread">${button('返回修改','select','tertiary')}${button(available.length ? `确认并同步 ${available.length} 个平台` : '保存授权，稍后处理','confirm-sync')}</div>`);
  } else if (view === 'syncing') {
    shell('登录同步', `<div class="status-hero"><div class="status-orb">${icon('sync')}</div>${title('正在同步所选平台。',`目标角色：${escape(role.name)} · ${escape(host())}`)}</div><div class="sync-progress"><span></span></div><p class="compact-note center">登录信息提交后，还需要后台采集验证。</p><div class="dialog-actions">${button('取消本次同步','close','tertiary')}</div>`);
    timer = setTimeout(() => {
      role.selected.forEach((id)=> { if (state.loggedIn.includes(id) && !['conflict','permission','expired'].includes(role.states[id])) role.states[id] = 'pending'; });
      persist(); render(); show('result');
    }, 1050);
  } else if (view === 'result') {
    const completed = role.selected.filter((id)=>['pending','verified'].includes(role.states[id]));
    const pending = role.selected.filter((id)=>!completed.includes(id));
    shell('同步结果', `<div class="status-hero"><div class="status-orb ${pending.length ? '' : 'success'}">${icon(pending.length ? 'cloud' : 'check')}</div>${title(completed.length ? `已同步 ${completed.length} 个平台。` : '授权已保存。',pending.length ? `${pending.length} 个平台待处理，已同步的平台不受影响。` : '登录信息已送达，等待后台采集验证。')}</div>${target(role.name)}<div class="result-list">${role.selected.map((id)=> {
      const status = role.states[id];
      const action = {login:['去登录','login'],permission:['授予权限','permission'],conflict:['查看账号','conflict'],expired:['重新授权','chooser']}[status];
      return `<div class="account-row">${logo(id)}<div class="platform-info"><strong>${platforms[id].name}</strong><p>${stateLabels[status][0]}${status === 'pending' ? ' · 等待采集验证' : status === 'verified' ? ' · 后台已验证' : ''}</p></div>${action ? button(action[0],action[1],'small tinted',`data-role="${role.id}" data-platform="${id}"`) : `<span class="result-check">${icon('checkCircle')}</span>`}</div>`;
    }).join('')}</div><div class="dialog-actions">${button('完成','close')}</div>`);
  } else if (view === 'login') {
    const id = flow.platform || 'pdd';
    shell('补充平台登录', `<div class="status-hero"><div style="display:flex;justify-content:center;margin:10px 0 22px">${logo(id)}</div>${title(`登录${platforms[id].name}，然后回来。`,'在安装插件的同一个 Chrome 用户配置中完成登录。')}</div>${target(role.name)}<div class="inline-notice info">${icon('info')}<span>登录完成后会重新检查此平台，已同步的平台无需重复操作。</span></div><div class="dialog-actions">${button('重新检查','recheck','secondary')}${button(`打开${platforms[id].name}${icon('external')}`,'open-login')}</div><p class="compact-note center">支持 Chrome 开发者工具中的平板模拟模式。</p>`, '<button data-action="demo-login">演示：已在平台完成登录</button>');
  } else if (view === 'login-confirm') {
    const id = flow.platform;
    shell('确认新账号', title('读到了新的平台账号。','这是此平台首次关联，请确认归属。') + target(role.name) + `<div class="account-row">${logo(id)}<div class="platform-info"><strong>${platforms[id].name}</strong><p>${platforms[id].account}</p></div><span class="subtle-tag">首次核对</span></div><div class="dialog-actions">${button('稍后处理','close','tertiary')}${button('确认并继续同步','confirm-login')}</div>`);
  } else if (view === 'platform-preview') {
    const id = flow.platform;
    shell('设计稿 · 平台登录预览', `<div class="status-hero"><div style="display:flex;justify-content:center;margin-bottom:22px">${logo(id)}</div>${title(`在${platforms[id].name}完成登录。`,'实际使用时，这一步将在平台官方网站完成。')}</div><div class="inline-notice info">${icon('info')}<span>这里用示例模拟登录返回，不需要输入密码或验证码。</span></div><div class="dialog-actions">${button('返回','login','tertiary')}${button('模拟登录完成并返回','demo-login')}</div>`);
  } else if (view === 'permission') {
    shell('平台访问权限', title('允许读取所选平台。','需要浏览器站点权限，才能读取该平台的登录信息。') + target(role.name) + `<div class="account-row">${logo(flow.platform || 'pdd')}<div class="platform-info"><strong>${platforms[flow.platform || 'pdd'].name}</strong><p>只请求此平台所需的站点范围</p></div></div><p class="compact-note">权限未授予时暂停此平台，其他平台仍可同步。</p><div class="dialog-actions">${button('暂不授权','close','tertiary')}${button('授权并继续','grant-permission')}</div>`, '<span>预览中以示例代替 Chrome 权限弹窗</span>');
  } else if (view === 'conflict') {
    const id = flow.platform || 'jd';
    shell('账号核对', title('这个账号，暂时不同。','已暂停此平台同步，请切换回角色对应的账号。') + target(role.name) + `<div class="settings-group"><div class="setting-row"><div class="setting-copy">后台绑定账号<small>${platforms[id].account}</small></div><span>已确认</span></div><div class="setting-row"><div class="setting-copy">浏览器当前账号<small>新账号***391</small></div><span class="red-text">不匹配</span></div></div><p class="compact-note">不会自动覆盖已有账号；如需关联新账号，请重新授权。</p><div class="dialog-actions">${button('关闭','close','tertiary')}${button('切换平台登录','login','primary',`data-platform="${id}" data-role="${role.id}"`)}</div>`);
  } else if (view === 'manage') {
    shell('平台管理', title('按你的习惯，同步。','选择本次同步的平台，按需开启后续自动同步。') + target(role.name) + `<div class="manage-head"><span>平台</span><span class="head-right"><span>同步</span><span>自动同步</span></span></div>` + role.scope.map((id)=>`<div class="manage-row">${logo(id)}<span class="platform-info"><span class="platform-name">${platforms[id].name}</span></span><label class="select-check"><input type="checkbox" name="manage-selected" value="${id}" aria-label="同步${platforms[id].name}" ${role.selected.includes(id) ? 'checked' : ''}></label><label class="switch"><input type="checkbox" name="manage-auto" value="${id}" role="switch" aria-label="自动同步${platforms[id].name}" ${role.automatic.includes(id) ? 'checked' : ''} ${role.selected.includes(id) ? '' : 'disabled'}><i></i></label></div>`).join('') + `<p class="compact-note">自动同步在浏览器运行时检查登录变化。失效、扫码或验证码仍需你完成。</p><div class="dialog-actions">${button('取消','close','tertiary')}${button('保存设置','save-platforms')}</div>`);
  } else if (view === 'settings') {
    shell('取件助手', title('设置','常用的保持简单，更多的留在这里。') + `<section class="settings-section"><h3>连接</h3><div class="settings-group"><button class="setting-row" data-action="address">${icon('cloud')}<span class="setting-copy">后台地址<small>${escape(backend().address || '尚未设置')}</small></span>${icon('chevron')}</button><button class="setting-row" data-action="browser-name">${icon('monitor')}<span class="setting-copy">浏览器名称</span><span>${escape(state.browserName)}</span>${icon('chevron')}</button></div></section><section class="settings-section"><h3>版本与更新</h3><div class="settings-group"><button class="setting-row" data-action="update">${icon('download')}<span class="setting-copy">本地覆盖更新<small>保留当前目录与所有授权设置</small></span><span>${state.updated ? '下一版' : '1.1.3'}</span>${icon('chevron')}</button></div></section><section class="settings-section"><h3>帮助</h3><div class="settings-group"><button class="setting-row" data-action="diagnostics">${icon('info')}<span class="setting-copy">连接诊断</span>${icon('chevron')}</button></div></section><div class="dialog-actions">${button('完成','close')}</div>`);
  } else if (view === 'browser-name') {
    shell('浏览器设置', title('让后台认得这台浏览器。','名称会显示在反向授权申请中。') + `<label class="form-label" for="browser-name">浏览器名称</label><input type="text" id="browser-name" value="${escape(state.browserName)}" maxlength="30"><p id="form-error" class="field-error" role="alert"></p><div class="dialog-actions">${button('返回','settings','tertiary')}${button('保存','save-name')}</div>`);
  } else if (view === 'role-more') {
    shell('角色设置', title(escape(role.name),'管理此角色的授权。') + `<div class="settings-group"><div class="setting-row">${icon('cloud')}<span class="setting-copy">授权后台<small>${escape(host())}</small></span></div><div class="setting-row">${icon('shield')}<span class="setting-copy">授权范围</span><span>${role.scope.map((id)=>platforms[id].name).join('、')}</span></div><button class="setting-row" data-action="diagnostics">${icon('info')}<span class="setting-copy">查看诊断</span>${icon('chevron')}</button></div><div class="dialog-actions spread">${button('撤销授权','revoke-confirm','danger')}${button('完成','close','secondary')}</div>`);
  } else if (view === 'revoke-confirm') {
    shell('撤销授权', title(`断开“${escape(role.name)}”的授权？`,'此角色将停止同步，其他角色和已保存的后台地址不受影响。') + `<div class="dialog-actions">${button('保留授权','close','secondary')}${button('确认撤销','revoke','danger')}</div>`);
  } else if (view === 'diagnostics') {
    shell('连接诊断', title('连接状态，一目了然。','诊断只展示状态，不包含 Cookie 或配对令牌。') + `<div class="settings-group"><div class="setting-row"><span class="setting-copy">后台连接</span><span>${state.offline ? '暂不可达' : '正常（示例）'}</span></div><div class="setting-row"><span class="setting-copy">浏览器</span><span>${escape(state.browserName)}</span></div><div class="setting-row"><span class="setting-copy">已授权角色</span><span>${backend().roles.length} 个</span></div></div><details class="details"><summary>展开技术诊断</summary><p>状态来源：界面演示数据<br>Cookie 值：不读取<br>网络请求：无真实后台请求<br>插件权限：待实际插件集成验证</p></details><div class="dialog-actions">${button('关闭','close')}</div>`);
  } else if (view === 'update') {
    shell('本地升级', `<div class="status-hero"><div class="status-orb">${icon('download')}</div>${title(updateStage === 'ready' ? '覆盖完成，最后一步。' : '更新软件，保留习惯。',updateStage === 'ready' ? '重新加载插件后，继续使用原有地址、角色和平台设置。' : '在原目录覆盖更新，继续使用同一个插件。')}</div>` + (updateStage === 'ready' ? `<div class="inline-notice success">${icon('checkCircle')}<span>插件文件已覆盖，原版本备份已保留。</span></div><div class="update-path">当前目录：${escape(flow.updatePath || 'D:\\应用\\取件助手-Cookie同步')}</div><div class="dialog-actions">${button('稍后重载','close','tertiary')}${button('重新加载插件','reload-extension')}</div>` : `<div class="update-version"><span class="version-number">1.1.3<small>当前版本</small></span>${icon('arrow')}<span class="version-number">1.2.0<small>示例目标版本</small></span></div><ol class="update-steps"><li><span class="step-number">1</span><div><strong>获取本地更新工具</strong><p>首次选择 Chrome 当前加载的插件目录。</p></div></li><li><span class="step-number">2</span><div><strong>在原目录覆盖</strong><p>检查安装包并备份，异常时恢复原文件。</p></div></li><li><span class="step-number">3</span><div><strong>重新加载插件</strong><p>无需卸载，无需重新配对。</p></div></li></ol><div class="dialog-actions">${button('检查更新','check-update','secondary')}${button(`${icon('download')}获取更新工具`,'get-updater')}</div><p class="compact-note center">覆盖前请结束正在进行的同步。</p>`), `<button data-action="demo-update">演示：更新工具已完成覆盖</button>`);
  } else if (view === 'updater') {
    shell('设计稿 · 本地更新工具', title('确认原目录，再升级。','更新工具会记住这个目录，下次无需重新选择。') + `<div class="update-version"><span class="version-number">1.1.3<small>当前版本</small></span>${icon('arrow')}<span class="version-number">1.2.0<small>示例目标版本</small></span></div><label class="form-label" for="update-path">Chrome 当前加载的插件目录</label><input type="text" id="update-path" value="D:\\应用\\取件助手-Cookie同步"><p id="form-error" class="field-error" role="alert"></p><p class="input-hint">实际工具中可浏览选择目录；此处路径仅用于演示。</p><div class="inline-notice info" style="margin-top:20px">${icon('shield')}<span>校验安装包 → 备份当前版本 → 覆盖原目录。异常时恢复，保留授权与同步设置。</span></div><div class="dialog-actions">${button('返回插件','update','tertiary')}${button('确认备份并覆盖','run-updater')}</div>`, '<span>不会下载文件或修改本机目录</span>');
  } else if (view === 'updating-files') {
    shell('设计稿 · 本地更新工具', `<div class="status-hero"><div class="status-orb">${icon('download')}</div>${title('正在覆盖原目录。','安装包校验通过，已保留旧版本备份。')}</div><div class="sync-progress"><span></span></div><div class="update-path">${escape(flow.updatePath)}</div>`, '<span>仅演示更新过程</span>');
    timer=setTimeout(()=> { updateStage='ready'; show('update'); },1000);
  }
}

function startFlow(mode) {
  flow = { mode, roleName:'家人', selected:[], roleId:null, scope:[...keys] };
  if (!backend().address) { addressReturn = mode === 'bind' ? 'bind' : 'reverse'; show('address'); }
  else show(mode === 'bind' ? 'bind' : 'select');
}
function saveAddress() {
  const raw = document.querySelector('#backend-address').value.trim();
  let address;
  try { const parsed = new URL(raw); if (!['https:','http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); address = parsed.origin + parsed.pathname.replace(/\/$/,''); }
  catch { return formError('请输入有效的 http:// 或 https:// 后台地址。'); }
  const exists = state.backends.findIndex((item)=>item.address === address);
  if (exists >= 0) state.active = exists;
  else if (!backend().address) backend().address = address;
  else { state.backends.push({ address, roles:[] }); state.active = state.backends.length - 1; state.pending = null; }
  state.offline = false;
  persist(); render();
  if (addressReturn === 'settings') show('settings');
  else if (addressReturn === 'reverse') startFlow('reverse');
  else show(addressReturn);
}
function syncRole() {
  const role = currentRole();
  if (state.offline) { notify('后台暂时离线，连接恢复后可重试。历史状态已保留。'); return; }
  const unknown = role.selected.filter((id)=>state.loggedIn.includes(id) && !role.confirmed.includes(id));
  if (unknown.length) { flow.selected=[...role.selected]; flow.roleName=role.name; flow.scope=[...role.scope]; return show('confirm'); }
  show('syncing');
}
function confirmSync() {
  let role = backend().roles.find((item)=>item.id === flow.roleId);
  if (!role) {
    role = { id:`role-${Date.now()}`, name:flow.roleName, selected:[...flow.selected], scope:[...flow.scope], confirmed:[], automatic:[], states:{} };
    backend().roles.push(role); flow.roleId = role.id;
  }
  role.selected=[...flow.selected];
  role.selected.forEach((id)=> {
    if (['conflict','permission','expired'].includes(role.states[id])) return;
    if (state.loggedIn.includes(id)) { if (!role.confirmed.includes(id)) role.confirmed.push(id); role.states[id]='pending'; }
    else role.states[id]='login';
  });
  state.pending=null; persist(); render(); show('syncing');
}
function recheckLogin() {
  const role = currentRole();
  const id = flow.platform;
  if (!state.loggedIn.includes(id)) { notify('尚未检测到新的登录，请完成平台登录后重试。'); return; }
  if (!role.confirmed.includes(id)) return show('login-confirm');
  role.states[id]='pending'; persist(); render(); show('result');
}
function applyScene(scene) {
  close(); state=freshState(); flow={mode:'bind',roleName:'家人',selected:[],roleId:'self',scope:[...keys]}; updateStage='available';
  if (scene === 'first') state.backends=[{address:'',roles:[]}];
  if (scene === 'offline') state.offline=true;
  if (scene === 'permission') state.backends[0].roles[0].states.pdd='permission';
  if (scene === 'conflict') state.backends[0].roles[0].states.jd='conflict';
  if (scene === 'expired') keys.forEach((id)=>state.backends[0].roles[0].states[id]='expired');
  if (scene === 'multiple') state.backends.push({address:'https://family.example.com',roles:[]});
  if (scene === 'legacy') { const role=state.backends[0].roles[0]; role.name='家人 · 旧版授权'; role.scope=['jd']; role.selected=['jd']; role.automatic=[]; }
  if (scene === 'result') { state.backends[0].roles[0].states.taobao='pending'; state.backends[0].roles[0].states.jd='pending'; }
  persist(); render();
  if (scene === 'bind') startFlow('bind');
  if (scene === 'reverse') startFlow('reverse');
  if (scene === 'confirm') { flow.roleId=null; flow.selected=[...keys]; show('confirm'); }
  if (['manage','result','update'].includes(scene)) show(scene);
}

document.addEventListener('click',(event)=> {
  const control=event.target.closest('[data-action]');
  if (!control || control.disabled) return;
  event.preventDefault();
  const action=control.dataset.action;
  if (control.dataset.role) flow.roleId=control.dataset.role;
  if (control.dataset.platform) flow.platform=control.dataset.platform;
  if (action === 'close') return close();
  if (action === 'home') { close(); render(); return; }
  if (action === 'chooser') return show('chooser');
  if (action === 'bind' || action === 'reverse') return startFlow(action);
  if (action === 'address') { addressReturn=page === 'settings' ? 'settings' : 'chooser'; return show('address'); }
  if (action === 'save-address') return saveAddress();
  if (action === 'fill-address') { document.querySelector('#backend-address').value='https://sync.example.com'; return; }
  if (action === 'fill-code') { document.querySelector('#pairing-code').value='PAIR-DEMO-2026'; return; }
  if (action === 'parse-pairing') {
    const code=document.querySelector('#pairing-code').value.trim();
    if (!code) return formError('请先粘贴配对信息。');
    if (!['PAIR-DEMO-2026','LEGACY-DEMO-JD'].includes(code)) return formError('此设计稿请使用下方“填入示例配对码”，无需输入真实凭据。');
    flow.scope=code === 'LEGACY-DEMO-JD' ? ['jd'] : [...keys]; flow.selected=[]; return show('select');
  }
  if (action === 'check-selection') { flow.selected=[...modal.querySelectorAll('input[name="platform"]:checked')].map((input)=>input.value); if (flow.selected.length) show('checking'); return; }
  if (action === 'approve-request') { const name=document.querySelector('#approve-role').value.trim(); if (!name) return formError('请选择或填写一个角色名称。'); flow.roleName=name; state.pending=null; persist(); render(); return show('confirm'); }
  if (action === 'cancel-request') { state.pending=null; persist(); render(); return close(); }
  if (action === 'request-expired') { state.pending=null; persist(); render(); return show('request-expired'); }
  if (action === 'retry-request') return show('checking');
  if (action === 'resume') { flow={...state.pending}; return show('waiting'); }
  if (action === 'confirm-sync') return confirmSync();
  if (action === 'sync') return syncRole();
  if (action === 'login') return show('login');
  if (action === 'open-login') return show('platform-preview');
  if (action === 'demo-login') { if (!state.loggedIn.includes(flow.platform)) state.loggedIn.push(flow.platform); return recheckLogin(); }
  if (action === 'recheck') return recheckLogin();
  if (action === 'confirm-login') { const role=currentRole(); role.confirmed.push(flow.platform); role.states[flow.platform]='pending'; persist(); render(); return show('result'); }
  if (action === 'grant-permission') { const role=currentRole(); role.states[flow.platform || 'pdd']='login'; persist(); render(); flow.platform ||= 'pdd'; return state.loggedIn.includes(flow.platform) ? recheckLogin() : show('login'); }
  if (action === 'save-platforms') {
    const role=currentRole();
    role.selected=[...modal.querySelectorAll('[name="manage-selected"]:checked')].map((input)=>input.value);
    role.automatic=[...modal.querySelectorAll('[name="manage-auto"]:checked:not(:disabled)')].map((input)=>input.value);
    role.selected.forEach((id)=> { role.states[id] ||= 'login'; });
    persist(); render(); close(); return notify('平台选择和自动同步设置已保存。');
  }
  if (action === 'reconnect') { state.offline=false; persist(); render(); return notify('后台连接已恢复，角色授权保持不变。'); }
  if (action === 'save-name') { const name=document.querySelector('#browser-name').value.trim(); if (!name) return formError('请填写浏览器名称。'); state.browserName=name; persist(); return show('settings'); }
  if (action === 'revoke') { backend().roles=backend().roles.filter((role)=>role.id !== flow.roleId); persist(); render(); return close(); }
  if (action === 'demo-update') { updateStage='ready'; return show('update'); }
  if (action === 'reload-extension') { state.updated=true; persist(); close(); return notify('演示：插件已重新加载，原有授权和平台设置已保留。'); }
  if (action === 'check-update') return notify('设计稿展示下一版本地升级流程，不查询真实发行版本。');
  if (action === 'get-updater') return show('updater');
  if (action === 'run-updater') { const path=document.querySelector('#update-path').value.trim(); if (!path) return formError('请先选择当前已加载的插件目录。'); flow.updatePath=path; return show('updating-files'); }
  show(action);
});
document.addEventListener('change',(event)=> {
  if (event.target === sceneSelect) return applyScene(event.target.value);
  if (event.target.id === 'backend-select') { state.active=Number(event.target.value); state.pending=null; persist(); render(); return; }
  if (event.target.name === 'platform') { flow.selected=[...modal.querySelectorAll('[name="platform"]:checked')].map((input)=>input.value); document.querySelector('#selection-next').disabled=!flow.selected.length; }
  if (event.target.name === 'manage-selected') { const auto=modal.querySelector(`[name="manage-auto"][value="${event.target.value}"]`); auto.disabled=!event.target.checked; if (auto.disabled) auto.checked=false; }
});
document.addEventListener('keydown',(event)=> {
  if (event.key === 'Enter' && dialog.open && event.target.id === 'backend-address') saveAddress();
});
hydrateIcons();
render();
if (state.pending) { flow={...state.pending}; show('waiting'); }

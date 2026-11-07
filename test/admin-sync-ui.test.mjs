import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createServerClock, syncStatus } from '../public/sync-status.js';

const NOW = 1_800_000_000_000;
const account = (job, platform = 'taobao') => ({ id: 'a', familyId: 'f', familyName: '我', label: platform === 'jd' ? '我的京东' : '我的淘宝', platform, status: 'ok', enabled: true, intervalMinutes: 60, syncJob: job });

test('continuous logistics status counts query tasks, explains automatic retry, and ignores unsafe progress', () => {
  const active = syncStatus(account({ state: 'running', continuation: true, logisticsProgress: { total: 8, completed: 3 } }), NOW);
  assert.equal(active.label, '采集中 · 物流查询任务 3/8');
  assert.match(active.details[0], /自动继续/); assert.equal(active.pending, true);
  const retry = syncStatus(account({ state: 'queued', retryAt: NOW + 10000, continuation: true, throttled: true, logisticsProgress: { total: 8, completed: 3 } }), NOW);
  assert.match(retry.label, /10 秒后采集.*查询任务 3\/8/); assert.match(retry.details[0], /平台限流/);
  assert.equal(syncStatus(account({ state: 'running', logisticsProgress: { total: 'PRIVATE', completed: 1 } }), NOW).label, '采集中');
  assert.equal(syncStatus(account({ state: 'running', logisticsProgress: { total: 1e9, completed: 2e9 } }), NOW).label, '采集中 · 物流查询任务 100000/100000');
});

test('queued countdown uses server time and monotonic elapsed time despite a wrong or changing local clock', () => {
  let monotonic = 100, wall = NOW + 86_400_000;
  const clock = createServerClock(() => monotonic, () => wall);
  clock.update(NOW);
  const queued = account({ state: 'queued', retryAt: NOW + 61_000 });
  assert.equal(syncStatus(queued, clock.now()).label, '已排队 · 1 分 1 秒后采集');
  monotonic += 2000; wall -= 172_800_000;
  assert.equal(syncStatus(queued, clock.now()).label, '已排队 · 59 秒后采集');
  monotonic += 60_000;
  assert.equal(syncStatus(queued, clock.now()).label, '已排队 · 等待采集');
  assert.equal(syncStatus(queued, clock.now()).pending, true);
});

test('JD accounts use explicit platform labels in account rows and family scope details', async () => {
  const page = await browser();
  page.state.platform = 'jd';
  await page.login();
  const row = page.elements.get('accounts').children[0];
  assert.equal(row.children[0].children[0].textContent, '京');
  const scopeDetails = page.elements.get('scope').children[1].children[1].children[1];
  assert.match(scopeDetails.textContent, /京东 · 我的京东/);
  const platformHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(platformHtml, /<option value="jd">京东<\/option>/);
});

test('rejected cooldown does not promise execution and completed jobs retain partial and platform failures', () => {
  const cooldown = syncStatus(account({ state: 'cooldown', retryAt: NOW + 10_000 }), NOW);
  assert.equal(cooldown.pending, false); assert.equal(cooldown.label, '未排队 · 10 秒后可重试');
  const partial = syncStatus(account({ state: 'completed', dateState: 'error', logisticsState: 'ok', logisticsError: '完整轨迹查询失败' }), NOW);
  assert.equal(partial.label, '采集完成 · 部分信息未更新');
  assert.deepEqual(partial.details, ['完整轨迹查询失败', '订单日期查询失败，已保留原数据。']);
  assert.equal(syncStatus(account({ state: 'completed', logisticsState: 'unavailable' }), NOW).label, '采集完成 · 部分信息未提供');
  for (const state of ['empty', 'unavailable']) {
    const result = syncStatus(account({ state: 'completed', dateState: state, dateError: '平台暂未提供日期', logisticsState: state, logisticsError: '平台暂未提供轨迹' }), NOW);
    assert.equal(result.label, '采集完成 · 部分信息未提供');
    assert.deepEqual(result.details, ['平台暂未提供日期', '平台暂未提供轨迹']);
  }
  assert.equal(syncStatus(account({ state: 'completed', logisticsError: '旧后台未标状态的查询失败' }), NOW).label, '采集完成 · 部分信息未更新');
  assert.equal(syncStatus({ ...account({ state: 'completed' }), status: 'expired' }, NOW).label, '采集失败');
  assert.equal(syncStatus(account({ state: 'error', error: '平台查询失败' }), NOW).label, '采集失败');
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.value = ''; this.textContent = '';
    this.hidden = false; this.disabled = false; this.checked = false; this.open = false; this.deferCloseEvent = false; this.attributes = {}; this.elements = [];
    this.classList = { toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  get options() { return this.children; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    return selector === '*' ? descendants : descendants.filter(child => child.tagName === 'INPUT' && (selector !== 'input:checked' || child.checked));
  }
  querySelector() { return null; }
  reset() {}
  setCustomValidity() {}
  scrollIntoView() {}
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; const close = () => this.listeners.get('close')?.(); this.deferCloseEvent ? queueMicrotask(close) : close(); }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(data) });

async function browser(hash = '') {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../public/admin.js', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"/g)].map(match => [match[2], new Element(match[1])]));
  const listeners = new Map(), timeouts = new Map(), intervals = new Map(), requests = [];
  let timerId = 0;
  const state = { job: null, platform: 'taobao', monotonic: 100, unauthorized: false, offline: false, blockAccounts: null, blockSync: null, cookieRequest: null, families: [{ id: 'f', name: '我' }] };
  const location = { hash, pathname: '/', search: '' };
  const history = { replaceState: (_state, _title, url) => { location.hash = ''; location.pathname = String(url).split(/[?#]/)[0] || '/'; } };
  const document = {
    hidden: false, forms: [...elements.values()].filter(element => element.tagName === 'FORM'),
    getElementById: id => elements.get(id), createElement: tag => new Element(tag), createTextNode: value => Object.assign(new Element('text'), { textContent: value }),
    querySelector: () => null,
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  const context = vm.createContext({ document, URL, Date, console, location, history, syncStatus,
    createServerClock: () => createServerClock(() => state.monotonic, () => NOW + 86_400_000),
    setTimeout: (callback, delay) => { const id = ++timerId; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout: id => timeouts.delete(id), setInterval: callback => { const id = ++timerId; intervals.set(id, callback); return id; }, clearInterval: id => intervals.delete(id),
    fetch: async (path, options) => {
      requests.push({ path, options });
      if (path === '/v1/setup') return response({ initialized: true, mode: 'managed' });
      if (path === '/v1/admin/login') return response({ token: 'session' });
      if (path.startsWith('/v1/admin/cookie-sync/families/requests/')) {
        if (!state.cookieRequest) return response({ error: { message: 'request not found' } }, 404);
        if (path.endsWith('/approve')) return response({ approved: true });
        return response(state.cookieRequest);
      }
      if (path === '/v1/admin/accounts') {
        if (state.blockAccounts) await state.blockAccounts;
        if (state.offline) throw new Error('offline');
        if (state.unauthorized) return response({ error: { code: 'ADMIN_UNAUTHORIZED', message: '请重新登录' } }, 401);
        return response({ accounts: [account(state.job, state.platform)], serverTime: NOW + state.monotonic - 100 });
      }
      if (path === '/v1/admin/devices') return response({ devices: [] });
      if (path === '/v1/admin/families') {
        if (options.method === 'POST') { state.families = [{ id: 'new', name: '新角色' }]; return response({ family: state.families[0] }); }
        return response({ families: state.families });
      }
      if (path === '/v1/admin/status') return response({ configurationMode: 'managed', baseUrl: 'https://example.test', lanBaseUrl: state.lanBaseUrl || '' });
      if (path === '/v1/admin/settings') {
        const settings = JSON.parse(options.body); state.lanBaseUrl = settings.lanBaseUrl;
        return response({ configurationMode: 'managed', ...settings });
      }
      if (path === '/v1/admin/accounts/a/sync') {
        if (state.blockSync) await state.blockSync;
        state.job = { id: 'job-a', state: 'queued', retryAt: NOW + 60_000 };
        return response({ jobs: [state.job] });
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  vm.runInContext(source.replace(/^import[^\n]+\n/, '') + '\n globalThis.adminTest = { refresh, requestSync, renderSyncStates };', context);
  await settle();
  const dispatch = async (element, event) => { element.listeners.get(event)({ preventDefault() {}, currentTarget: element }); await settle(); };
  const login = async () => { elements.get('admin-token').value = 'password'; await dispatch(elements.get('login-form'), 'submit'); };
  const tick = async () => {
    assert.equal(timeouts.size, 1);
    const [id, timer] = [...timeouts][0]; timeouts.delete(id); timer.callback(); await settle();
  };
  const visibility = async hidden => { document.hidden = hidden; listeners.get('visibilitychange')(); await settle(); };
  return { state, elements, requests, timeouts, intervals, location, login, tick, visibility, dispatch, api: context.adminTest };
}

test('reverse cookie request accepts base64url symbols, waits for login, and ignores invalid fragments', async () => {
  const valid = `CR-${'a'.repeat(41)}_-`;
  const page = await browser(`#cookie-sync-request=${valid}`);
  assert.equal(page.location.hash, '');
  assert.equal(page.requests.some(request => request.path.includes('/cookie-sync/families/requests/')), false);
  page.state.cookieRequest = { requestId: 'r1', name: '测试浏览器', platforms: ['jd'], expiresAt: NOW + 600000, status: 'pending' };
  await page.login();
  await settle();
  assert.equal(page.requests.filter(request => request.path.endsWith(valid)).length, 1, JSON.stringify(page.requests.map(request => request.path)));
  assert.equal(page.elements.get('cookie-sync-request-approve').disabled, true);
  page.elements.get('cookie-sync-request-family').value = 'f'; await page.dispatch(page.elements.get('cookie-sync-request-family'), 'change');
  assert.equal(page.elements.get('cookie-sync-request-approve').disabled, false);
  await page.dispatch(page.elements.get('cookie-sync-request-approve'), 'click');
  assert.equal(page.requests.at(-1).path, `/v1/admin/cookie-sync/families/requests/${valid}/approve`);
  assert.equal(page.elements.get('cookie-sync-request-approve').disabled, true);

  const invalid = await browser('#cookie-sync-request=CR-invalid');
  await invalid.login();
  assert.equal(invalid.requests.some(request => request.path.includes('/cookie-sync/families/requests/')), false);
  const malformed = await browser('#cookie-sync-request=CR-%E0%A4%A');
  await malformed.login();
  assert.equal(malformed.requests.some(request => request.path.includes('/cookie-sync/families/requests/')), false);
});

test('empty-role request survives the create-role transition for later approval', async () => {
  const valid = `CR-${'b'.repeat(43)}`; const page = await browser(`#cookie-sync-request=${valid}`);
  page.state.cookieRequest = { requestId: 'r2', name: '空角色浏览器', platforms: ['taobao'], expiresAt: NOW + 600000, status: 'pending' }; page.state.families = [];
  await page.login(); await settle();
  assert.equal(page.elements.get('cookie-sync-request-create-button').hidden, false);
  page.elements.get('cookie-sync-request-dialog').deferCloseEvent = true;
  await page.dispatch(page.elements.get('cookie-sync-request-create-button'), 'click');
  assert.equal(page.elements.get('family-dialog').open, true);
  page.elements.get('family-name').value = '新角色'; await page.dispatch(page.elements.get('family-form'), 'submit'); await settle();
  assert.equal(page.elements.get('cookie-sync-request-dialog').open, true);
  assert.equal(page.elements.get('cookie-sync-request-approve').disabled, true);
});

test('polling restores external jobs, advances states, preserves form drafts and binding selection, and sends only GET', async () => {
  const page = await browser();
  assert.equal(page.timeouts.size, 0);
  await page.login();
  assert.equal([...page.timeouts.values()][0].delay, 30000);
  page.elements.get('settings-base-url').value = 'https://draft.test';
  await page.dispatch(page.elements.get('settings-base-url'), 'input');
  page.elements.get('label').value = '未保存账号'; page.elements.get('cookie').value = '未保存Cookie';
  page.elements.get('current-password').value = '未提交密码';
  const check = page.elements.get('scope').querySelectorAll('input')[0]; check.checked = true;
  page.elements.get('pair-code').textContent = '123456'; page.elements.get('pair-result').hidden = false;
  const requestsBeforePoll = page.requests.length;
  page.state.job = { id: 'external', state: 'queued', retryAt: NOW + 60_000 };
  await page.tick();
  assert.equal([...page.timeouts.values()][0].delay, 3000);
  assert.equal(page.elements.get('scope').querySelectorAll('input')[0], check);
  assert.equal(check.checked, true);
  assert.equal(page.elements.get('settings-base-url').value, 'https://draft.test');
  assert.equal(page.elements.get('label').value, '未保存账号'); assert.equal(page.elements.get('cookie').value, '未保存Cookie');
  assert.equal(page.elements.get('current-password').value, '未提交密码');
  assert.equal(page.elements.get('pair-code').textContent, '123456'); assert.equal(page.elements.get('pair-result').hidden, false);
  page.state.monotonic += 1000; for (const callback of page.intervals.values()) callback();
  assert.match(page.elements.get('accounts').children[0].children[2].textContent, /59 秒后采集/);
  page.state.job = { id: 'external', state: 'running', continuation: true, logisticsProgress: { total: 8, completed: 3 } }; await page.tick();
  assert.equal(page.elements.get('accounts').children[0].children[2].textContent, '采集中 · 物流查询任务 3/8');
  assert.match(page.elements.get('accounts').children[0].children[3].textContent, /自动继续/);
  page.state.job = { id: 'external', state: 'completed' }; await page.tick();
  assert.equal(page.elements.get('accounts').children[0].children[2].textContent, '采集完成');
  assert.equal([...page.timeouts.values()][0].delay, 30000);
  assert.ok(page.requests.slice(requestsBeforePoll).every(request => request.path === '/v1/admin/accounts' && !request.options.method));
  assert.equal(page.elements.get('notice').textContent, '');
});

test('LAN settings preserve unsaved input while polling and save or clear the configured address', async () => {
  const page = await browser(); page.state.lanBaseUrl = 'https://lan.example'; await page.login();
  assert.equal(page.elements.get('settings-lan-url').value, 'https://lan.example');
  assert.equal(page.elements.get('configured-lan-url').textContent, 'https://lan.example');
  page.elements.get('settings-lan-url').value = 'https://updated-lan.example';
  await page.dispatch(page.elements.get('settings-lan-url'), 'input');
  await page.api.refresh();
  assert.equal(page.elements.get('settings-lan-url').value, 'https://updated-lan.example');
  await page.dispatch(page.elements.get('settings-form'), 'submit');
  assert.equal(page.state.lanBaseUrl, 'https://updated-lan.example');
  page.elements.get('settings-lan-url').value = '';
  await page.dispatch(page.elements.get('settings-form'), 'submit');
  assert.equal(page.state.lanBaseUrl, '');
  assert.equal(page.elements.get('configured-lan-url').textContent, '未启用');
});

test('a repeated sync click sends one POST, uses inline queued status, and pending jobs cannot be resubmitted', async () => {
  const page = await browser(); await page.login();
  let release; page.state.blockSync = new Promise(resolve => { release = resolve; });
  page.elements.get('notice').textContent = '旧的冷却提示';
  const first = page.api.requestSync('a');
  await page.api.requestSync('a');
  assert.equal(page.requests.filter(request => request.options.method === 'POST' && request.path.endsWith('/sync')).length, 1);
  release(); await first;
  assert.equal(page.elements.get('notice').textContent, '');
  assert.match(page.elements.get('accounts').children[0].children[2].textContent, /已排队/);
  const button = page.elements.get('accounts').children[0].children.at(-1).children[1];
  assert.equal(button.disabled, true);
  await page.api.requestSync('a');
  assert.equal(page.requests.filter(request => request.path.endsWith('/sync')).length, 1);
});

test('GET polling does not overlap, stops while hidden, resumes immediately, and stops on logout or 401', async () => {
  const page = await browser(); await page.login();
  let release; page.state.blockAccounts = new Promise(resolve => { release = resolve; });
  const before = page.requests.filter(request => request.path === '/v1/admin/accounts').length;
  const first = page.api.refresh(false), second = page.api.refresh(false);
  assert.equal(page.requests.filter(request => request.path === '/v1/admin/accounts').length, before + 1);
  await page.visibility(true);
  assert.equal(page.timeouts.size, 0); assert.equal(page.intervals.size, 0);
  release(); await Promise.all([first, second]); page.state.blockAccounts = null;
  assert.equal(page.timeouts.size, 0);
  await page.visibility(false);
  assert.equal(page.requests.filter(request => request.path === '/v1/admin/accounts').length, before + 2);
  assert.equal(page.timeouts.size, 1);
  await page.dispatch(page.elements.get('logout'), 'click');
  assert.equal(page.timeouts.size, 0); assert.equal(page.intervals.size, 0);
  await page.login(); page.state.unauthorized = true; await page.tick();
  assert.equal(page.timeouts.size, 0); assert.equal(page.intervals.size, 0);
  assert.equal(page.elements.get('workspace').hidden, true); assert.equal(page.elements.get('login-panel').hidden, false);
});

test('a temporary polling failure retries, clears its own notice on recovery, and does not resurrect a logged-out page', async () => {
  const page = await browser(); await page.login();
  page.state.offline = true; await page.tick();
  assert.match(page.elements.get('notice').textContent, /采集状态暂时无法更新/);
  assert.equal(page.timeouts.size, 1);
  page.state.offline = false; await page.tick();
  assert.equal(page.elements.get('notice').textContent, '');
  let release; page.state.blockAccounts = new Promise(resolve => { release = resolve; });
  const pending = page.api.refresh(false).catch(() => {});
  await page.dispatch(page.elements.get('logout'), 'click');
  release(); await pending;
  assert.equal(page.timeouts.size, 0); assert.equal(page.elements.get('accounts').children.length, 0);
  assert.equal(page.elements.get('workspace').hidden, true);
});

test('a successful sync POST followed by a failed GET clears only its own notice when polling recovers', async () => {
  for (const showFormError of [false, true]) {
    const page = await browser(); await page.login();
    page.state.offline = true;
    const button = page.elements.get('accounts').children[0].children.at(-1).children[1];
    await page.dispatch(button, 'click');
    assert.equal(page.requests.filter(request => request.path.endsWith('/sync')).length, 1);
    assert.match(page.elements.get('notice').textContent, /采集状态暂时无法更新/);
    assert.match(page.elements.get('accounts').children[0].children[2].textContent, /已排队/);
    assert.equal([...page.timeouts.values()][0].delay, 3000);
    let formError = '';
    if (showFormError) {
      page.elements.get('settings-base-url').value = 'http://draft.test';
      await page.dispatch(page.elements.get('settings-form'), 'submit');
      formError = page.elements.get('notice').textContent;
      assert.match(formError, /HTTPS/);
    }
    page.state.job = { id: 'job-a', state: 'completed' }; page.state.offline = false;
    await page.tick();
    assert.equal(page.elements.get('accounts').children[0].children[2].textContent, '采集完成');
    assert.equal(page.elements.get('notice').textContent, formError);
    assert.equal(page.requests.filter(request => request.path.endsWith('/sync')).length, 1);
  }
});

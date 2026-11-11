import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initPickupCompletionAdmin } from '../public/pickup-completion-admin.js';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {};
    this.textContent = ''; this.hidden = false; this.disabled = false; this.checked = false;
    this.classList = { add() {}, remove() {} };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(handler); }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName.toLowerCase() === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  async dispatch(name) { for (const handler of this.listeners.get(name) || []) await handler({ target: this, preventDefault() {} }); }
  click() { return this.dispatch('click'); }
  focus() { this.focused = true; }
  set innerHTML(_value) { throw new Error('Untrusted evidence must remain text'); }
}
const settle = () => new Promise(resolve => setImmediate(resolve));

async function browser(t) {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"/g)].map(match => [match[2], new Element(match[1])]));
  const original = { document: globalThis.document, confirm: globalThis.confirm };
  globalThis.document = { getElementById: id => elements.get(id), createElement: tag => new Element(tag) }; globalThis.confirm = () => true;
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const state = { config: { enabled: true, aiEnabled: true }, candidates: [{ fragment: '<script>hostile</script>', status: 'review', error: '待核对' }], history: [{ id: 'one', summary: '本人已完成提货', appliedAt: 1000, status: 'applied', canRollback: true }], recent: [], aiReady: true, stats: { usageToday: 1, dailyLimit: 20, review: 1 } };
  const requests = [], notices = [], control = { fail: false, waiting: null };
  const admin = initPickupCompletionAdmin({ notice: (...args) => notices.push(args), api: async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; requests.push({ path, method: options.method || 'GET', body });
    if (control.waiting) await control.waiting;
    if (control.fail) throw new Error('合成网络失败');
    if (options.method === 'PUT' && !path.includes('/rules/')) state.config = body;
    if (path.includes('/rules/')) {
      const id = path.split('/').at(-1);
      state.monitorRules = (state.monitorRules || []).filter(rule => rule.ruleId !== id);
      if (options.method === 'PUT') state.monitorRules.push({ ...body, id, ruleId: id, expectedVersion: 1, editable: true, label: '人工词组' });
    }
    if (path.endsWith('/rollback')) { assert.deepEqual(body, { historyId: 'one' }); state.history[0].canRollback = false; state.history[0].status = 'rolled_back'; }
    return structuredClone(state);
  } });
  return { elements, state, requests, notices, control, admin, click: async id => { await elements.get(id).click(); await settle(); } };
}

test('keyword editor saves explicit drafts, preserves failures and supports disable and delete', async t => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } });
  t.after(() => Object.defineProperty(globalThis, 'crypto', cryptoDescriptor));
  const page = await browser(t); await page.click('pickup-completion-settings-tab');
  await page.click('pickup-rule-new');
  assert.equal(page.elements.get('pickup-rule-form').hidden, false);
  page.elements.get('pickup-rule-keywords').value = ['用户已完成提货', '提货完成'].join(String.fromCharCode(13, 10));
  page.elements.get('pickup-rule-kind').value = 'user_collected';
  page.control.fail = true;
  await page.elements.get('pickup-rule-form').dispatch('submit');
  assert.equal(page.elements.get('pickup-rule-form').hidden, false);
  assert.match(page.elements.get('pickup-rule-error').textContent, /网络失败/);
  page.control.fail = false; await page.elements.get('pickup-rule-form').dispatch('submit');
  assert.equal(page.elements.get('pickup-rule-form').hidden, true);
  assert.deepEqual(page.state.monitorRules[0].keywords, ['用户已完成提货', '提货完成']);
  assert.match(page.state.monitorRules[0].ruleId, /^manual_[a-f0-9]{32}$/);
  const buttons = () => page.elements.get('pickup-completion-rules').querySelectorAll('button');
  await buttons().find(button => button.textContent === '编辑').click();
  assert.equal(page.elements.get('pickup-rule-keywords').value, ['用户已完成提货', '提货完成'].join(String.fromCharCode(10)));
  page.elements.get('pickup-rule-keywords').value = '签收人凭取件码签收';
  await page.elements.get('pickup-rule-form').dispatch('submit');
  assert.deepEqual(page.state.monitorRules[0].keywords, ['签收人凭取件码签收']);
  await buttons().find(button => button.textContent === '停用').click();
  assert.equal(page.state.monitorRules[0].enabled, false);
  await buttons().find(button => button.textContent === '删除').click();
  assert.equal(page.state.monitorRules.length, 0);
});

test('native default-on labeled controls save only explicit draft and preserve failed draft', async t => {
  const page = await browser(t); await page.click('pickup-completion-settings-tab');
  assert.equal(page.elements.get('pickup-completion-enabled').checked, true);
  assert.equal(page.elements.get('pickup-completion-ai-enabled').checked, true);
  assert.equal(page.elements.get('pickup-completion-save').disabled, true);
  const enabled = page.elements.get('pickup-completion-enabled'); enabled.checked = false; await enabled.dispatch('change');
  assert.equal(page.requests.filter(item => item.method === 'PUT').length, 0);
  page.control.fail = true; await page.elements.get('pickup-completion-form').dispatch('submit');
  assert.equal(enabled.checked, false); assert.equal(page.elements.get('pickup-completion-save').disabled, false);
  assert.match(page.elements.get('pickup-completion-status').textContent, /合成网络失败/);
  page.control.fail = false; await page.elements.get('pickup-completion-form').dispatch('submit');
  assert.deepEqual(page.state.config, { enabled: false, aiEnabled: true });
  assert.equal(page.elements.get('pickup-completion-save').disabled, true);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['pickup-completion-enabled', 'pickup-completion-ai-enabled']) {
    assert.match(html, new RegExp(`<label for="${id}">`));
    assert.match(html, new RegExp(`<input id="${id}" type="checkbox" checked disabled`));
  }
});

test('candidate text is not HTML and rollback refreshes audit with keyboard focus retained', async t => {
  const page = await browser(t); await page.click('pickup-completion-settings-tab');
  assert.match(page.elements.get('pickup-completion-candidates').children[0].children[0].textContent, /<script>/);
  const rollback = page.elements.get('pickup-completion-history').querySelectorAll('button')[0];
  assert.equal(rollback.attributes['aria-label'], '回滚关键词：本人已完成提货');
  await rollback.click(); await settle();
  assert.equal(page.requests.filter(item => item.method === 'POST').length, 1);
  assert.match(page.elements.get('pickup-completion-history').children[0].children[0].textContent, /已回滚/);
  assert.equal(page.elements.get('pickup-completion-reload').focused, true);
});

test('取件自动监测 displays independent keyword groups as text and clears them at logout', async t => {
  const page = await browser(t);
  page.state.monitorRules = [
    { id: 'example', label: '本人签收 · 内置示例', keywords: ['本人已签收'], enabled: true },
    { id: 'ai', label: 'AI追加词组', keywords: ['本人已完成提货', '提货完成'], enabled: true },
    { id: 'off', label: 'AI追加词组', keywords: ['<script>示例</script>'], enabled: false },
  ];
  await page.click('pickup-completion-settings-tab');
  assert.equal(page.elements.get('settings-page-title').textContent, '取件自动监测');
  const rows = page.elements.get('pickup-completion-rules').children;
  assert.equal(rows.length, 3);
  assert.match(rows[0].children[0].textContent, /本人已签收.*内置示例/);
  assert.match(rows[1].children[0].textContent, /本人已完成提货 ＋ 提货完成/);
  assert.match(rows[2].children[0].textContent, /<script>示例<\/script>.*已停用/);
  page.admin.reset();
  assert.equal(page.elements.get('pickup-completion-rules').children.length, 0);
});

test('session reset prevents late response and failed initial loading is retryable', async t => {
  const page = await browser(t); page.control.fail = true; await page.click('pickup-completion-settings-tab');
  assert.equal(page.elements.get('pickup-completion-enabled').disabled, true);
  assert.equal(page.elements.get('pickup-completion-reload').disabled, false);
  page.control.fail = false;
  let release; page.control.waiting = new Promise(resolve => { release = resolve; });
  const pending = page.click('pickup-completion-reload'); await settle(); page.admin.reset(); release(); await pending;
  assert.equal(page.elements.get('pickup-completion-enabled').disabled, true);
  assert.equal(page.elements.get('pickup-completion-candidates').children.length, 0);
  assert.equal(page.elements.get('pickup-completion-status').textContent, '尚未读取设置。');
  page.control.waiting = null; await page.click('pickup-completion-reload');
  assert.equal(page.elements.get('pickup-completion-enabled').disabled, false);
});

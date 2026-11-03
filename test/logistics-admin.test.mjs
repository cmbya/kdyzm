import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initLogisticsAdmin, logisticsTestMessage } from '../public/logistics-admin.js';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {};
    this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false;
    const classes = new Set(); this.classList = { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, add(name) { classes.add(name); }, remove(name) { classes.delete(name); } };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(listener); }
  querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
  async dispatch(name) { for (const listener of this.listeners.get(name) || []) await listener({ target: this, preventDefault() {} }); }
  click() { return this.dispatch('click'); }
  reset() {}
  focus() {}
  reportValidity() { return true; }
  set innerHTML(_value) { throw new Error('Rule data must be rendered as text'); }
}

const builtIn = { id: 'arrival', name: '暂存至', enabled: true, kind: 'arrival', starts: ['已暂存至'], end: '', keywords: [], sample: '包裹已暂存至幸福驿站', expectedStation: '幸福驿站', origin: 'builtin' };
const settle = () => new Promise(resolve => setImmediate(resolve));

async function browser(t) {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"/g)].map(match => [match[2], new Element(match[1])]));
  const controls = [...elements].filter(([id, item]) => id.startsWith('logistics-') && ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(item.tagName)).map(([, item]) => item);
  elements.get('logistics-settings-view').children = controls;
  const original = { document: globalThis.document, window: globalThis.window, confirm: globalThis.confirm };
  globalThis.document = { getElementById: id => elements.get(id), createElement: tag => new Element(tag) };
  globalThis.window = new Element('window'); globalThis.confirm = () => true;
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const state = { rules: [structuredClone(builtIn)], revision: 1, conflict: false, waitLoad: null, failLoad: false, failTest: false };
  const requests = [], notices = [];
  const admin = initLogisticsAdmin({ notice: (...args) => notices.push(args), api: async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; requests.push({ path, method: options.method || 'GET', body });
    if (path.endsWith('/test')) { if (state.failTest) throw new Error('测试连接中断'); return { station: '幸福驿站', arrival: true, status: 'matched', reason: '已识别', ruleId: body.rule.id }; }
    if (options.method === 'PATCH') {
      if (state.conflict) throw Object.assign(new Error('冲突'), { status: 409 });
      assert.equal(body.revision, state.revision); state.rules = body.rules; state.revision++;
    } else {
      if (state.waitLoad) await state.waitLoad;
      if (state.failLoad) throw new Error('无法连接服务');
    }
    return { revision: state.revision, rules: structuredClone(state.rules), defaults: [structuredClone(builtIn)] };
  } });
  const click = async id => { await elements.get(id).click(); await settle(); };
  const fill = async (id, value) => { elements.get(id).value = value; await elements.get(id).dispatch('input'); };
  return { elements, state, requests, notices, admin, click, fill };
}

test('draft editing and testing never save; conflict retains draft and later save uses the original revision', async t => {
  const page = await browser(t); await page.click('logistics-settings-tab');
  assert.equal(page.elements.get('logistics-save').disabled, true);
  const hostile = '<img src=x onerror=alert(1)>';
  await page.fill('logistics-name', hostile); await page.click('logistics-enabled'); await page.click('logistics-test');
  assert.equal(page.requests.filter(item => item.method === 'PATCH').length, 0);
  const testRequest = page.requests.find(item => item.path.endsWith('/test'));
  assert.equal(testRequest.body.rule.name, hostile); assert.equal(testRequest.body.rule.enabled, false);
  assert.equal(page.elements.get('logistics-detail-name').textContent, hostile);
  assert.match(page.elements.get('logistics-test-result').textContent, /站名与预期一致/);
  page.state.failTest = true; await page.click('logistics-test');
  assert.equal(page.elements.get('logistics-test-result').textContent, '测试连接中断');
  page.state.conflict = true; await page.click('logistics-save');
  assert.equal(page.elements.get('logistics-name').value, hostile);
  assert.equal(page.elements.get('logistics-save').disabled, false);
  assert.match(page.elements.get('logistics-status').textContent, /当前草稿仍保留/);
  page.state.conflict = false; await page.click('logistics-save');
  assert.equal(page.state.revision, 2); assert.equal(page.state.rules[0].name, hostile); assert.equal(page.state.rules[0].enabled, false);
  assert.equal(page.elements.get('logistics-save').disabled, true);
});

test('add, delete and restore are staged, including an empty rule set that can still be saved', async t => {
  const page = await browser(t); await page.click('logistics-settings-tab');
  await page.click('logistics-add');
  assert.equal(page.elements.get('logistics-enabled').attributes['aria-checked'], 'false');
  await page.fill('logistics-starts', ' 已暂存至 \n\n已存放至 ');
  await page.click('logistics-delete'); await page.click('logistics-delete');
  assert.equal(page.elements.get('logistics-form').hidden, true); assert.equal(page.elements.get('logistics-save').disabled, false);
  assert.equal(page.requests.filter(item => item.method === 'PATCH').length, 0);
  await page.click('logistics-save'); assert.deepEqual(page.state.rules, []);
  await page.click('logistics-restore'); assert.deepEqual(page.state.rules, []);
  await page.click('logistics-save'); assert.deepEqual(page.state.rules, [builtIn]);
});

test('failed initial load can be retried and session reset discards a late response and draft', async t => {
  const page = await browser(t); page.state.failLoad = true; await page.click('logistics-settings-tab');
  assert.equal(page.elements.get('logistics-add').disabled, true); assert.equal(page.elements.get('logistics-reload').disabled, false);
  page.state.failLoad = false; await page.click('logistics-reload'); await page.fill('logistics-name', '未保存内容');
  let release; page.state.waitLoad = new Promise(resolve => { release = resolve; });
  const pending = page.click('logistics-reload'); await settle();
  page.admin.reset(); release(); await pending;
  assert.equal(page.elements.get('logistics-form').hidden, true); assert.equal(page.elements.get('logistics-save').disabled, true);
  assert.equal(page.elements.get('logistics-total').textContent, '0 条');
  assert.equal(page.elements.get('logistics-status').textContent, '尚未读取规则。');
});

test('test feedback requires arrival evidence only for arrival rules and distinguishes missing expected station', () => {
  assert.equal(logisticsTestMessage({ station: '幸福驿站', arrival: false }, builtIn).valid, false);
  assert.equal(logisticsTestMessage({ station: '幸福驿站', arrival: false }, { ...builtIn, kind: 'location' }).valid, true);
  assert.equal(logisticsTestMessage({ station: '其他驿站', arrival: true }, builtIn).valid, false);
  assert.match(logisticsTestMessage({ station: '', arrival: false }, { ...builtIn, expectedStation: '' }).text, /尚未填写预期站名/);
});

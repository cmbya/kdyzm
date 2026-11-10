import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createServerClock, syncStatus } from '../public/sync-status.js';

const NOW = 1_800_000_000_000;
const secret = randomUUID();
class Element {
  constructor(tag, hidden = false) {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {};
    this.value = ''; this.textContent = ''; this.hidden = hidden; this.disabled = false; this.open = false; this.elements = [];
    this.classList = { toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector === '*' || child.tagName === selector.toUpperCase() ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector() { return null; }
  reset() { for (const control of this.elements) control.value = ''; }
  setCustomValidity() {}
  focus() { this.focused = true; }
  close() { this.open = false; this.listeners.get('close')?.(); }
  set innerHTML(_value) { throw new Error('Credential metadata must remain plain text'); }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(data) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function browser() {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../public/admin.js', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(match => [match[2], new Element(match[1], /\bhidden\b/.test(match[0]))]));
  elements.get('diagnostic-token-form').elements = [elements.get('diagnostic-name'), elements.get('diagnostic-reload')];
  const state = { credentials: [], failure: 0, pending: null, mode: 'managed', nextId: 1, session: 0 };
  const requests = [];
  const forbidden = new Proxy({}, { get() { throw new Error('Do not persist or log diagnostic credentials'); } });
  const context = vm.createContext({ URL, Date, syncStatus, console: forbidden, localStorage: forbidden, sessionStorage: forbidden,
    location: Object.freeze({ hash: '', pathname: '/', search: '' }), history: forbidden, confirm: () => true,
    document: { hidden: false, forms: [...elements.values()].filter(element => element.tagName === 'FORM'),
      getElementById: id => elements.get(id), createElement: tag => new Element(tag), createTextNode: value => Object.assign(new Element('text'), { textContent: value }),
      querySelector: () => null, addEventListener() {},
    },
    createServerClock: () => createServerClock(() => 0, () => NOW), setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (path, options) => {
      requests.push({ path, options });
      if (path === '/v1/setup') return response({ initialized: true, mode: state.mode });
      if (path === '/v1/admin/login') return response({ token: `session-${++state.session}` });
      if (path === '/v1/admin/accounts') return response({ accounts: [], serverTime: NOW });
      if (path === '/v1/admin/devices') return response({ devices: [] });
      if (path === '/v1/admin/families') return response({ families: [] });
      if (path === '/v1/admin/status') return response({ configurationMode: state.mode, baseUrl: 'https://example.test' });
      if (path.startsWith('/v1/admin/diagnostic-tokens')) {
        const snapshot = structuredClone(state.credentials);
        if (state.pending) await state.pending.promise;
        if (state.failure) return response({ error: { code: state.failure === 401 ? 'ADMIN_UNAUTHORIZED' : 'TEST_ERROR', message: '合成诊断请求失败' } }, state.failure);
        if (options.method === 'POST') {
          const credential = { id: `credential-${state.nextId++}`, name: JSON.parse(options.body).name, createdAt: NOW, revokedAt: null };
          state.credentials.unshift(credential); return response({ token: secret, credential }, 201);
        }
        if (options.method === 'DELETE') { state.credentials.find(value => path.endsWith(value.id)).revokedAt = NOW; return response({ revoked: true }); }
        return response({ credentials: snapshot });
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  });
  vm.runInContext(source.replace(/^import[^\n]+\n/, ''), context);
  await settle();
  const dispatch = async (element, event = 'click') => { element.listeners.get(event)({ preventDefault() {}, currentTarget: element }); await settle(); };
  const click = id => dispatch(elements.get(id));
  const login = async () => { elements.get('admin-token').value = 'test-password'; await dispatch(elements.get('login-form'), 'submit'); };
  const create = async (name = '每日诊断') => { elements.get('diagnostic-name').value = name; await dispatch(elements.get('diagnostic-token-form'), 'submit'); };
  const revokeButtons = () => elements.get('diagnostic-credentials').querySelectorAll('button');
  return { html, elements, state, requests, dispatch, click, login, create, revokeButtons };
}

test('diagnostic credentials load only with an admin session and metadata remains literal text in both configuration modes', async () => {
  for (const mode of ['managed', 'environment']) {
    const page = await browser(); page.state.mode = mode;
    page.state.credentials = [{ id: 'credential-1', name: '<img src=x onerror=alert(1)>', createdAt: NOW, revokedAt: null, token: secret }];
    await page.click('nav-settings');
    assert.equal(page.requests.some(request => request.path.includes('diagnostic-tokens')), false);
    await page.login(); await page.click('nav-settings');
    assert.equal(page.requests.at(-1).options.headers['x-admin-token'], 'session-1');
    assert.equal(page.elements.get('diagnostic-credentials').children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(page.elements.get('diagnostic-token').value, '');
    assert.equal(page.elements.get('diagnostic-token-result').hidden, true);
    assert.equal(page.revokeButtons().length, 1);
    assert.match(page.html, /所有账号.*只读.*不自动过期/);
    assert.match(page.html, /Authorization: Bearer &lt;凭据&gt;/);
  }
});

test('creation submits only the name, displays the secret once, blocks repeated submits and can hide it', async () => {
  const page = await browser(); await page.login(); await page.click('nav-settings');
  page.state.pending = deferred();
  await page.create('  每日诊断  '); await page.create('重复提交');
  assert.equal(page.requests.filter(request => request.options.method === 'POST' && request.path.includes('diagnostic-tokens')).length, 1);
  assert.deepEqual(JSON.parse(page.requests.at(-1).options.body), { name: '每日诊断' });
  page.state.pending.resolve(); await settle(); page.state.pending = null;
  assert.equal(page.elements.get('diagnostic-token').value, secret);
  assert.equal(page.elements.get('diagnostic-token-result').hidden, false);
  assert.equal(page.elements.get('diagnostic-token').focused, true);
  assert.equal(page.elements.get('diagnostic-name').value, '');
  assert.ok(page.requests.every(request => !JSON.stringify(request).includes(secret)));
  await page.click('diagnostic-token-hide'); await page.click('diagnostic-reload');
  assert.equal(page.elements.get('diagnostic-token').value, '');
  assert.equal(page.elements.get('diagnostic-token-result').hidden, true);
  assert.equal(page.elements.get('diagnostic-name').focused, true);
});

test('revoke clears the displayed matching secret and keeps revoked metadata without an action', async () => {
  const page = await browser(); await page.login(); await page.create();
  await page.dispatch(page.revokeButtons()[0]);
  assert.equal(page.requests.at(-1).options.method, 'DELETE');
  assert.equal(page.requests.at(-1).path, '/v1/admin/diagnostic-tokens/credential-1');
  assert.equal(page.elements.get('diagnostic-token').value, '');
  assert.equal(page.elements.get('diagnostic-token-result').hidden, true);
  assert.equal(page.revokeButtons().length, 0);
  assert.match(page.elements.get('diagnostic-credentials').children[0].children[1].textContent, /已撤销/);
  assert.equal(page.elements.get('diagnostic-reload').focused, true);
});

test('logout and unauthorized responses clear the secret and reject late creation responses', async () => {
  const page = await browser(); await page.login(); await page.create(); await page.click('logout');
  assert.equal(page.elements.get('diagnostic-token').value, '');
  assert.equal(page.elements.get('diagnostic-credentials').children.length, 0);
  await page.login(); await page.create(); page.state.failure = 401; await page.click('diagnostic-reload');
  assert.equal(page.elements.get('diagnostic-token').value, '');
  assert.equal(page.elements.get('diagnostic-token-result').hidden, true);
  assert.equal(page.elements.get('workspace').hidden, true);
  page.state.failure = 0; await page.login(); page.state.pending = deferred(); await page.create();
  await page.click('logout'); page.state.pending.resolve(); await settle();
  assert.equal(page.elements.get('diagnostic-token').value, '');
  assert.equal(page.elements.get('diagnostic-credentials').children.length, 0);
});

test('failed requests remain retryable and a late list cannot erase a newly created credential', async () => {
  const page = await browser(); await page.login(); page.state.failure = 503; await page.click('nav-settings');
  assert.match(page.elements.get('diagnostic-status').textContent, /合成诊断请求失败/);
  assert.equal(page.elements.get('diagnostic-reload').disabled, false);
  await page.create(); assert.match(page.elements.get('notice').textContent, /合成诊断请求失败/);
  assert.equal(page.elements.get('diagnostic-token').value, '');
  page.state.failure = 0; page.state.pending = deferred(); await page.click('diagnostic-reload');
  const pending = page.state.pending; page.state.pending = null; await page.create(); pending.resolve(); await settle();
  assert.equal(page.elements.get('diagnostic-token').value, secret);
  assert.equal(page.revokeButtons().length, 1);
  page.state.credentials[0].revokedAt = NOW; await page.click('diagnostic-reload');
  assert.equal(page.elements.get('diagnostic-token').value, '');
  assert.equal(page.revokeButtons().length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let n = 0; n < 100 && !check(); n++) await tick(); assert.ok(check(), 'expected asynchronous operation was reached'); }
async function legacy(t, patch = {}) {
  const previousChrome = globalThis.chrome, previousFetch = globalThis.fetch;
  const account = { id: 'a', platform: 'taobao', label: 'Synthetic', familyId: 'family', familyName: 'Synthetic', credentialVersion: 1, status: 'configured' };
  const connection = { id: 'c', accountId: 'a', platform: 'taobao', name: 'test', expiresAt: Date.now() + 1e6, identityBound: true, identityHint: 'hint', lastSyncAt: 0 };
  const storage = { connections: [{ id: 'c', token: 'csg_' + 'x'.repeat(43), baseUrl: 'https://synthetic.example', serviceId: 'a'.repeat(32),
    account, connection, storeId: '0', auto: false, error: '', checkedAt: 0, ...patch }] };
  let listener, intercept, reloads = 0;
  const requests = [], reads = [], alarms = [], events = {};
  const event = { addListener() {} };
  globalThis.chrome = {
    storage: { local: { setAccessLevel: async () => {}, get: async () => structuredClone(storage), set: async data => { Object.assign(storage, structuredClone(data)); } } },
    permissions: { contains: async () => true },
    runtime: { id: 'test', getURL: p => 'chrome-extension://test/' + p, reload: () => { reloads++; }, onMessage: { addListener: fn => { listener = fn; } }, onInstalled: event, onStartup: event },
    action: { onClicked: event }, cookies: { onChanged: { addListener: fn => { events.cookie = fn; } }, getAll: async query => {
      reads.push(query); return [{ name: 'unb', value: '123', domain: '.taobao.com', storeId: '0' }, { name: 'cookie2', value: 'synthetic-login', domain: '.taobao.com', storeId: '0' }];
    } }, alarms: { get: async () => ({}), create: async name => { alarms.push(name); }, onAlarm: { addListener: fn => { events.alarm = fn; } } }
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    const intercepted = await intercept?.(url, options); if (intercepted) return intercepted;
    const body = url.endsWith('/preview') ? { account, confirmationToken: randomBytes(32).toString('hex'), identityHint: 'hint', expiresAt: Date.now() + 1e6 }
      : { account, connection, serviceId: 'a'.repeat(32), changed: true, token: 'csg_' + 'x'.repeat(43) };
    return new Response(JSON.stringify(body));
  };
  await import('../cookie-extension/background.mjs?test=' + crypto.randomUUID());
  const call = (action, args = {}) => new Promise(resolve => listener({ action, id: 'c', ...args }, { id: 'test', url: 'chrome-extension://test/options.html' }, resolve));
  t.after(() => { globalThis.chrome = previousChrome; globalThis.fetch = previousFetch; });
  return { storage, account, connection, requests, reads, alarms, events, call, reloads: () => reloads, intercept: fn => { intercept = fn; } };
}

test('a pending enable cannot undo a later pause or removal, even when server revocation fails', async () => {
  const previousChrome = globalThis.chrome, previousFetch = globalThis.fetch;
  let listener, pending = [];
  const account = { id: 'a', platform: 'taobao', label: 'Synthetic', familyId: 'family', familyName: 'Synthetic', credentialVersion: 1, status: 'configured' };
  const connection = { id: 'c', accountId: 'a', platform: 'taobao', name: 'test', expiresAt: Date.now() + 1e6, identityBound: true, identityHint: 'hint', lastSyncAt: 0 };
  const initial = () => ({ connections: [{ id: 'c', token: 'csg_' + 'x'.repeat(43), baseUrl: 'https://synthetic.example', serviceId: 'a'.repeat(32), account, connection, storeId: '0', auto: false, error: '', checkedAt: 0 }] });
  let storage = initial();
  const event = { addListener() {} };
  globalThis.chrome = {
    storage: { local: { setAccessLevel: async () => {}, get: async () => structuredClone(storage), set: async data => { storage = structuredClone(data); } } },
    permissions: { contains: async () => true },
    runtime: { id: 'test', getURL: p => 'chrome-extension://test/' + p, onMessage: { addListener: fn => { listener = fn; } }, onInstalled: event, onStartup: event },
    action: { onClicked: event }, cookies: { onChanged: event }, alarms: { get: async () => ({}), create: async () => {}, onAlarm: event }
  };
  globalThis.fetch = (url, options) => new Promise(resolve => pending.push({ method: options.method,
    resolve: (status = 200) => resolve(new Response(JSON.stringify(status === 200 ? { account, connection, serviceId: 'a'.repeat(32) } : {}), { status })) }));
  try {
    await import('../cookie-extension/background.mjs');
    const dispatch = message => new Promise(resolve => listener(message, { id: 'test', url: 'chrome-extension://test/options.html' }, resolve));
    const request = async method => {
      for (let n = 0; n < 50; n++) {
        const index = pending.findIndex(item => item.method === method);
        if (index !== -1) return pending.splice(index, 1)[0];
        await new Promise(resolve => setImmediate(resolve));
      }
      throw Error('request not observed: ' + method);
    };
    for (const action of ['pause', 'remove', 'failed remove']) {
      storage = initial();
      const enable = dispatch({ action: 'auto', id: 'c', enabled: true }), get = await request('GET');
      if (action === 'pause') {
        const stopped = await dispatch({ action: 'auto', id: 'c', enabled: false }); assert.equal(stopped.data.enabled, false);
      } else {
        const removed = dispatch({ action: 'remove', id: 'c' }), del = await request('DELETE');
        del.resolve(action === 'failed remove' ? 503 : 200); await removed;
      }
      get.resolve(); const result = await enable;
      assert.equal(result.ok, true); assert.equal(result.data.enabled, false);
      assert.equal(storage.connections[0]?.auto ?? false, false);
      if (action === 'remove') assert.equal(storage.connections.length, 0);
    }
    storage = initial();
    let releaseCookie, cookieReads = 0, domainReads = 0;
    const cookieGate = new Promise(resolve => { releaseCookie = resolve; });
    chrome.cookies.getAll = async query => {
      cookieReads++; if (query.domain) domainReads++;
      await cookieGate;
      return [{ name: 'cookie2', value: 'synthetic', domain: '.taobao.com', path: '/', storeId: '0' }];
    };
    const preview = dispatch({ action: 'previewSync', id: 'c' });
    (await request('GET')).resolve();
    for (let n = 0; n < 100 && !cookieReads; n++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(cookieReads);
    const removing = dispatch({ action: 'remove', id: 'c' });
    const delayedDelete = await request('DELETE');
    releaseCookie();
    assert.equal((await preview).ok, false);
    assert.equal(domainReads, 0, 'revoking consent blocks a new domain read even before DELETE completes');
    delayedDelete.resolve(503); await removing;
    let called = false;
    assert.equal(listener({ action: 'list' }, { id: 'test', url: 'https://untrusted.example/' }, () => { called = true; }), false);
    assert.equal(called, false);
  } finally { globalThis.chrome = previousChrome; globalThis.fetch = previousFetch; }
});

test('legacy selection migrates old bindings as selected while new bindings remain off and cannot auto-sync', async t => {
  const s = await legacy(t);
  assert.equal((await s.call('list')).data[0].selected, true);
  chrome.permissions.contains = async ({ origins }) => origins.every(origin => origin === 'https://synthetic.example/*');
  const paired = await s.call('pair', { baseUrl: 'https://synthetic.example', platform: 'taobao', code: 'CS-' + 'x'.repeat(43),
    serviceId: 'a'.repeat(32), accountId: 'a', name: 'test' });
  assert.equal(paired.ok, true); assert.equal(paired.data.selected, false); assert.equal(paired.data.auto, false);
  assert.equal(s.reads.length, 0);
  const denied = await s.call('auto', { enabled: true });
  assert.equal(denied.code, 'PLATFORM_NOT_SELECTED'); assert.equal(denied.status, null);
  assert.equal((await s.call('sync')).code, 'PLATFORM_NOT_SELECTED'); assert.equal(s.reads.length, 0);
  chrome.permissions.contains = async () => true;
  assert.equal((await s.call('select', { enabled: true })).data.enabled, true);
  assert.equal((await s.call('auto', { enabled: true })).data.enabled, true);
  assert.equal((await s.call('select', { enabled: false })).data.enabled, false);
  assert.equal(s.storage.connections[0].auto, false);
  const count = s.requests.length;
  s.events.alarm({ name: 'cookie-sync-periodic' }); s.events.cookie({ cookie: { storeId: '0', domain: '.taobao.com' } });
  await tick(); await tick();
  assert.equal(s.requests.length, count); assert.equal(s.reads.length, 0);
});

test('canceling a legacy sync during digest preserves its target and automatic preference but blocks upload', async t => {
  const s = await legacy(t, { selected: true, auto: true });
  const nativeDigest = crypto.subtle.digest;
  let release, hashing = false;
  const gate = new Promise(resolve => { release = resolve; });
  crypto.subtle.digest = async function (...args) { hashing = true; await gate; return nativeDigest.apply(this, args); };
  t.after(() => { crypto.subtle.digest = nativeDigest; release(); });
  const syncing = s.call('sync'); await until(() => hashing);
  assert.equal((await s.call('cancelSync')).data.canceled, true);
  release(); const canceled = await syncing;
  assert.equal(canceled.ok, false); assert.equal(canceled.code, 'REQUEST_CANCELED');
  assert.equal(s.requests.filter(request => request.url.endsWith('/cookie')).length, 0);
  assert.equal(s.storage.connections.length, 1); assert.equal(s.storage.connections[0].selected, true); assert.equal(s.storage.connections[0].auto, true);
});

test('legacy confirmation is tied to current consent and succeeds only after a fresh identity preview', async t => {
  const s = await legacy(t, { selected: true, consent: 'original' }); s.connection.identityBound = false;
  const preview = await s.call('previewSync'); assert.equal(preview.ok, true);
  assert.equal(preview.data.consent, 'original'); assert.equal(preview.data.connectionId, 'c');
  await s.call('cancelSync');
  const reads = s.reads.length, rejected = await s.call('confirmSync', { confirmation: preview.data });
  assert.equal(rejected.code, 'PREVIEW_EXPIRED'); assert.equal(s.reads.length, reads);
  const fresh = await s.call('previewSync'); assert.equal(fresh.ok, true);
  s.intercept((url) => { if (url.endsWith('/cookie')) s.connection.identityBound = true; });
  const confirmed = await s.call('confirmSync', { confirmation: fresh.data });
  assert.equal(confirmed.ok, true); assert.equal(s.requests.filter(request => request.url.endsWith('/cookie')).length, 1);
  assert.equal(s.storage.connections[0].errorCode, '');
});

test('legacy preview stores safe failure states without exposing response secrets and clears after a valid preview', async t => {
  const s = await legacy(t);
  s.intercept(url => url.endsWith('/preview') ? new Response(JSON.stringify({ error: { code: 'COOKIE_IDENTITY_MISMATCH', message: 'cookie2=must-not-leak' } }), { status: 409 }) : undefined);
  const failure = await s.call('previewSync');
  assert.equal(failure.code, 'COOKIE_IDENTITY_MISMATCH'); assert.equal(failure.status, 409);
  assert.equal(s.storage.connections[0].errorCode, failure.code); assert.equal(s.storage.connections[0].errorStatus, 409);
  assert.equal(JSON.stringify(failure).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(s.storage.connections[0]).includes('must-not-leak'), false);
  s.intercept(undefined); assert.equal((await s.call('previewSync')).ok, true);
  assert.equal(s.storage.connections[0].errorCode, ''); assert.equal(s.storage.connections[0].errorStatus, null);
});

test('a canceled legacy preview cannot clear a newer result or send cookies after a target changes', async t => {
  const s = await legacy(t);
  let release, observed = false;
  const gate = new Promise(resolve => { release = resolve; }); t.after(release);
  s.intercept(async url => { if (url.endsWith('/preview')) { observed = true; await gate; } });
  const preview = s.call('previewSync'); await until(() => observed);
  await s.call('cancelSync');
  Object.assign(s.storage.connections[0], { error: '新的状态', errorCode: 'LOGIN_REQUIRED', errorStatus: null });
  release(); assert.equal((await preview).code, 'REQUEST_CANCELED');
  assert.equal(s.storage.connections[0].errorCode, 'LOGIN_REQUIRED');
  let releaseCurrent, currentObserved = false;
  const currentGate = new Promise(resolve => { releaseCurrent = resolve; }); t.after(releaseCurrent);
  s.intercept(async url => { if (url.endsWith('/current')) { currentObserved = true; await currentGate; } });
  const syncing = s.call('sync'); await until(() => currentObserved);
  s.storage.connections[0].baseUrl = 'https://different.example';
  releaseCurrent(); assert.equal((await syncing).code, 'SERVICE_CHANGED');
  assert.equal(s.requests.filter(request => request.url.endsWith('/cookie')).length, 0);
  assert.equal(s.storage.connections[0].baseUrl, 'https://different.example');
});

test('legacy status persists revoked authorization and network failures, clears recovered status errors only', async t => {
  const s = await legacy(t, { auto: true });
  s.intercept(() => new Response(JSON.stringify({ error: { code: 'COOKIE_SYNC_UNAUTHORIZED', message: 'private-token' } }), { status: 401 }));
  assert.equal((await s.call('status')).code, 'COOKIE_SYNC_UNAUTHORIZED');
  const revoked = (await s.call('list')).data[0];
  assert.equal(revoked.errorCode, 'COOKIE_SYNC_UNAUTHORIZED'); assert.equal(revoked.errorStatus, 401); assert.equal(revoked.auto, false);
  assert.equal(JSON.stringify(revoked).includes('private-token'), false);
  s.intercept(() => { throw Error('network unavailable'); });
  assert.equal((await s.call('status')).code, 'NETWORK_ERROR');
  assert.equal(s.storage.connections[0].errorCode, 'NETWORK_ERROR');
  s.intercept(undefined); assert.equal((await s.call('status')).ok, true);
  assert.equal(s.storage.connections[0].errorCode, ''); assert.equal(s.storage.connections[0].auto, false);
  Object.assign(s.storage.connections[0], { error: '请完成登录', errorCode: 'LOGIN_REQUIRED', errorSource: 'sync' });
  await s.call('status'); assert.equal(s.storage.connections[0].errorCode, 'LOGIN_REQUIRED');
});

for (const kind of ['manual-legacy', 'automatic-legacy', 'automatic-family']) test(`${kind} work prevents reload until Cookie POST finishes`, async t => {
  const s = await legacy(t, { auto: true, selected: true, consent: 'active' });
  const family = { id: 'family', name: 'Synthetic' }, groupConnection = { id: 'g', familyId: 'family', expiresAt: Date.now() + 1e6, name: 'test' };
  if (kind === 'automatic-family') {
    s.storage.connections = [];
    s.storage.familyConnections = [{ id: 'g', family, connection: groupConnection, serviceId: 'a'.repeat(32), baseUrl: 'https://synthetic.example', token: 'cfg_' + 'x'.repeat(43),
      accounts: [{ account: s.account, connection: s.connection, selected: true, auto: true, consent: 'active' }] }];
  }
  let release, posting = false;
  const gate = new Promise(resolve => { release = resolve; }); t.after(release);
  s.intercept(async url => {
    if (url.endsWith('/cookie')) { posting = true; await gate; }
    if (url.includes('/families/')) return new Response(JSON.stringify(url.endsWith('/families/current')
      ? { family, connection: groupConnection, serviceId: 'a'.repeat(32), accounts: [{ account: s.account, connection: s.connection }] }
      : { account: s.account, connection: s.connection, serviceId: 'a'.repeat(32), changed: true }));
  });
  let pending;
  if (kind === 'manual-legacy') pending = s.call('sync'); else s.events.alarm({ name: 'cookie-sync-periodic' });
  assert.equal((await s.call('runtime:reload')).code, 'SYNC_IN_PROGRESS', 'register work before the first asynchronous read');
  await until(() => posting);
  assert.equal((await s.call('runtime:reload')).code, 'SYNC_IN_PROGRESS'); assert.equal(s.reloads(), 0);
  release();
  if (pending) assert.equal((await pending).ok, true);
  else await until(() => kind === 'automatic-family' ? !!s.storage.familyConnections[0].accounts[0].lastDigest : !!s.storage.connections[0].lastDigest);
  await tick();
  assert.equal((await s.call('runtime:reload')).data.reloading, true); assert.equal(s.reloads(), 1);
  const requests = s.requests.length;
  assert.equal((await s.call('sync')).code, 'RELOAD_IN_PROGRESS');
  s.events.alarm({ name: 'cookie-sync-periodic' }); await tick();
  assert.equal(s.requests.length, requests, 'no new work starts once reload has been committed');
});

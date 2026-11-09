import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createService } from '../src/service.mjs';
import { createFamilySync } from '../cookie-extension/family.mjs';
import { PLATFORMS, pairingInput, apiRequest, errorText } from '../cookie-extension/core.mjs';

const ADMIN = 'synthetic-family-extension-admin-credential';
const fields = { taobao: { unb: '10001000', cookie2: 'fixture-tb' }, pdd: { pdd_user_id: '20002000', PDDAccessToken: 'fixture' }, jd: { pin: 'fixture-jd', thor: 'fixture' } };
const header = platform => Object.entries(fields[platform]).map(([key, value]) => `${key}=${value}`).join('; ');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t) {
  const nativeFetch = globalThis.fetch, previousChrome = globalThis.chrome;
  const service = createService({ encryptionKey: randomBytes(32).toString('hex'), adminToken: ADMIN, baseUrl: 'https://fixture.example',
    scheduler: false, fixture: true, collector: async () => ({ orders: [], shipments: [], warnings: [] }) });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`, storage = {}, reads = [], requests = [], opened = [];
  const allowed = new Set([base + '/*', ...Object.values(PLATFORMS).flatMap(profile => profile.origins)]);
  let intercept, cookieWait;
  globalThis.chrome = {
    storage: { local: { get: async key => key ? { [key]: structuredClone(storage[key]) } : structuredClone(storage), set: async patch => { Object.assign(storage, structuredClone(patch)); } } },
    permissions: { contains: async ({ origins }) => origins.every(origin => allowed.has(origin)) },
    cookies: { getAll: async ({ url }) => {
      const platform = Object.keys(PLATFORMS).find(key => PLATFORMS[key].urls.includes(url)); reads.push(platform);
      if (cookieWait) await cookieWait;
      return Object.entries(fields[platform]).map(([name, value]) => ({ name, value, domain: '.' + PLATFORMS[platform].domains[0], storeId: '0', httpOnly: true }));
    } }, alarms: { get: async () => null, create: async () => {} }, tabs: { create: async options => { opened.push(options.url); } }
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ path: new URL(url).pathname, method: options.method, body: options.body });
    if (intercept) { const result = await intercept(url, options); if (result) return result; }
    return nativeFetch(url, options);
  };
  const api = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await nativeFetch(base + path, { method, headers: { 'X-Admin-Token': ADMIN, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const family = service.store.saveFamily({ name: '合成角色' }), flow = createFamilySync(Promise.resolve());
  const call = (action, args = {}) => flow.dispatch({ action: 'family:' + action, ...args });
  const account = platform => service.store.saveAccount({ platform, familyId: family.id, label: platform, cookie: header(platform), enabled: false });
  const bind = async () => {
    const pair = await api('/v1/admin/cookie-sync/families/pairing', { familyId: family.id });
    const preview = await call('previewPair', { baseUrl: base, code: pair.code });
    return call('pair', { baseUrl: base, code: pair.code, name: '测试浏览器', familyId: family.id, serviceId: preview.serviceId });
  };
  t.after(async () => { globalThis.fetch = nativeFetch; globalThis.chrome = previousChrome; await service.close(); });
  return { service, base, family, flow, storage, reads, requests, opened, allowed, call, api, account, bind, nativeFetch,
    intercept: fn => { intercept = fn; }, waitCookie: promise => { cookieWait = promise; } };
}

test('family pairing and API paths accept only the defined scope and safe identifiers', async () => {
  const code = 'CF-' + '_'.repeat(43), baseUrl = 'https://fixture.example';
  assert.deepEqual(pairingInput(JSON.stringify({ schemaVersion: 1, kind: 'cookie-sync-family', code, baseUrl })), { code, baseUrl, scope: 'family' });
  assert.throws(() => pairingInput(JSON.stringify({ schemaVersion: 1, kind: 'cookie-sync', code, baseUrl })));
  for (const path of ['/v1/cookie-sync/families/current/accounts/a/../../admin', '/v1/cookie-sync/families/current/platforms/evil/cookie', '/v1/admin/cookie-sync/families/pairing']) {
    await assert.rejects(apiRequest(baseUrl, path), { code: 'BAD_MESSAGE' });
  }
});

test('one family code selects only PDD, stops reading when deselected and exposes later platforms unselected', async t => {
  const s = await setup(t), account = s.account('pdd'), group = await s.bind(), ref = { id: group.id, accountId: account.id };
  assert.equal(group.accounts.length, 3); assert.ok(group.accounts.every(record => !record.selected && !record.auto));
  await assert.rejects(s.call('previewSync', ref), { code: 'PLATFORM_NOT_SELECTED' }); assert.equal(s.reads.length, 0);
  await s.call('select', { ...ref, enabled: true });
  const confirmation = await s.call('previewSync', ref);
  await s.call('confirmSync', { ...ref, confirmation });
  assert.ok(s.reads.every(platform => platform === 'pdd'));
  await s.call('auto', { ...ref, enabled: true });
  const saved = s.service.store.cookie(account.id), before = s.reads.length;
  await s.call('select', { ...ref, enabled: false });
  await s.flow.onAlarm('cookie-sync-change-pdd');
  assert.equal(s.reads.length, before); assert.equal(s.service.store.cookie(account.id), saved);
  const later = s.account('taobao'); const fresh = await s.call('status', { id: group.id });
  assert.equal(fresh.accounts.find(record => record.account.id === later.id).selected, false);
  assert.equal(fresh.accounts.find(record => record.account.id === later.id).connection, null);
  const visible = JSON.stringify(await s.call('list'));
  assert.ok(!visible.includes('cfg_')); assert.ok(!visible.includes('lastDigest'));
});

test('first family preview survives an alarm refresh before its response reaches the extension', async t => {
  const s = await setup(t), account = s.account('taobao'), group = await s.bind(), ref = { id: group.id, accountId: account.id };
  await s.call('select', { ...ref, enabled: true });
  let release, observed;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { observed = resolve; });
  t.after(release);
  s.intercept(async (url, options) => {
    if (!url.endsWith(`/accounts/${account.id}/preview`)) return;
    const response = await s.nativeFetch(url, options); observed(); await gate; return response;
  });
  const pending = s.call('previewSync', ref);
  await ready;
  await s.flow.onAlarm('cookie-sync-periodic');
  release();
  const confirmation = await pending;
  const record = (await s.call('list'))[0].accounts.find(item => item.account.id === account.id);
  assert.equal(record.selected, true); assert.equal(record.auto, false);
  assert.equal(record.connection.identityBound, false);
  await s.call('confirmSync', { ...ref, confirmation });
  assert.equal((await s.call('list'))[0].id, group.id);
  assert.equal(s.requests.filter(request => request.path === '/v1/cookie-sync/families/connections').length, 1);
});

test('an older alarm snapshot cannot undo a first preview, while a later child revocation still deselects it', async t => {
  const s = await setup(t), account = s.account('taobao'), group = await s.bind(), ref = { id: group.id, accountId: account.id };
  await s.call('select', { ...ref, enabled: true });
  let release, observed;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { observed = resolve; });
  t.after(release);
  s.intercept(async (url, options) => {
    if (!url.endsWith('/v1/cookie-sync/families/current')) return;
    const response = await s.nativeFetch(url, options); observed(); await gate; return response;
  });
  const pending = s.flow.onAlarm('cookie-sync-periodic');
  await ready;
  const confirmation = await s.call('previewSync', ref);
  release(); await pending; s.intercept(undefined);
  let record = (await s.call('list'))[0].accounts.find(item => item.account.id === account.id);
  assert.equal(record.selected, true);
  assert.equal(record.connection.id, confirmation.connectionId);
  await s.call('confirmSync', { ...ref, confirmation });
  await s.call('auto', { ...ref, enabled: true });
  await s.api(`/v1/admin/cookie-sync/connections/${record.connection.id}`, undefined, 'DELETE');
  await s.flow.onAlarm('cookie-sync-periodic');
  record = (await s.call('list'))[0].accounts.find(item => item.account.id === account.id);
  assert.equal(record.connection, null);
  assert.equal(record.selected, false); assert.equal(record.auto, false);
});

test('an older alarm snapshot cannot roll back a successful first confirmation', async t => {
  const s = await setup(t), account = s.account('taobao'), group = await s.bind(), ref = { id: group.id, accountId: account.id };
  await s.call('select', { ...ref, enabled: true });
  const confirmation = await s.call('previewSync', ref);
  let release, observed;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { observed = resolve; });
  t.after(release);
  s.intercept(async (url, options) => {
    if (!url.endsWith('/v1/cookie-sync/families/current')) return;
    const response = await s.nativeFetch(url, options); observed(); await gate; return response;
  });
  const pending = s.flow.onAlarm('cookie-sync-periodic');
  await ready;
  await s.call('confirmSync', { ...ref, confirmation });
  release(); await pending;
  const record = (await s.call('list'))[0].accounts.find(item => item.account.id === account.id);
  assert.equal(record.selected, true); assert.equal(record.connection.identityBound, true);
  assert.equal(record.account.credentialVersion, s.service.store.account(account.id).credentialVersion);
});

for (const action of ['deselect', 'cancel-sync']) test(`${action} during the first preview is not undone by an alarm refresh`, async t => {
  const s = await setup(t), account = s.account('taobao'), group = await s.bind(), ref = { id: group.id, accountId: account.id };
  await s.call('select', { ...ref, enabled: true });
  let release, observed;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { observed = resolve; });
  t.after(release);
  s.intercept(async (url, options) => {
    if (!url.endsWith(`/accounts/${account.id}/preview`)) return;
    const response = await s.nativeFetch(url, options); observed(); await gate; return response;
  });
  const pending = s.call('previewSync', ref);
  const rejected = assert.rejects(pending, { code: action === 'deselect' ? 'PLATFORM_NOT_SELECTED' : 'REQUEST_CANCELED' });
  await ready;
  if (action === 'deselect') await s.call('select', { ...ref, enabled: false });
  else await s.call('cancelSync', ref);
  await s.flow.onAlarm('cookie-sync-periodic'); release(); await rejected;
  const record = (await s.call('list'))[0].accounts.find(item => item.account.id === account.id);
  assert.equal(record.selected, action !== 'deselect'); assert.equal(record.auto, false);
  assert.equal(s.requests.filter(request => request.path.endsWith('/cookie')).length, 0);
});

test('a refresh does not carry selection into an already bound first child or a replacement child', async t => {
  const s = await setup(t), account = s.account('taobao'), group = await s.bind(), ref = { id: group.id, accountId: account.id };
  await s.call('select', { ...ref, enabled: true });
  const token = s.storage.familyConnections[0].token;
  const remote = async (suffix, body) => {
    const response = await s.nativeFetch(`${s.base}/v1/cookie-sync/families/current/accounts/${account.id}/${suffix}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200); return response.json();
  };
  const preview = await remote('preview', { cookie: header('taobao') });
  await remote('cookie', { cookie: header('taobao'), expectedCredentialVersion: preview.account.credentialVersion,
    confirmationToken: preview.confirmationToken });
  await s.flow.onAlarm('cookie-sync-periodic');
  let record = (await s.call('list'))[0].accounts.find(item => item.account.id === account.id);
  assert.equal(record.selected, false); assert.equal(record.auto, false);
  await s.call('select', { ...ref, enabled: true }); await s.call('auto', { ...ref, enabled: true });
  await s.api(`/v1/admin/cookie-sync/connections/${record.connection.id}`, undefined, 'DELETE');
  await remote('preview', { cookie: header('taobao') });
  await s.flow.onAlarm('cookie-sync-periodic');
  const oldId = record.connection.id;
  record = (await s.call('list'))[0].accounts.find(item => item.account.id === account.id);
  assert.notEqual(record.connection.id, oldId);
  assert.equal(record.selected, false); assert.equal(record.auto, false);
});

test('PDD preview recovers a missing URL-query identity from matching platform-domain cookies', async t => {
  const s = await setup(t), account = s.account('pdd'), group = await s.bind(), ref = { id: group.id, accountId: account.id };
  await s.call('select', { ...ref, enabled: true });
  const queries = [];
  chrome.cookies.getAll = async query => {
    queries.push(query);
    return Object.entries(fields.pdd).filter(([name]) => query.domain || name === 'PDDAccessToken')
      .map(([name, value]) => ({ name, value, domain: 'mobile.yangkeduo.com', hostOnly: true, path: '/', storeId: '0' }));
  };
  const confirmation = await s.call('previewSync', ref);
  assert.ok(confirmation.token);
  assert.ok(queries.some(query => query.domain === 'yangkeduo.com'));
  await s.call('confirmSync', { ...ref, confirmation });
  assert.match(s.service.store.cookie(account.id), /pdd_user_id=20002000/);
});

test('deselecting during cookie read prevents the queued preview upload', async t => {
  const s = await setup(t), account = s.account('pdd'), group = await s.bind(), ref = { id: group.id, accountId: account.id };
  await s.call('select', { ...ref, enabled: true });
  let release; s.waitCookie(new Promise(resolve => { release = resolve; }));
  const pending = s.call('previewSync', ref);
  const rejected = assert.rejects(pending, { code: 'PLATFORM_NOT_SELECTED' });
  for (let n = 0; n < 100 && !s.reads.length; n++) await tick();
  assert.ok(s.reads.length); await s.call('select', { ...ref, enabled: false }); release(); await rejected;
  assert.equal(s.requests.filter(request => request.path.endsWith('/preview') && request.path.includes('/accounts/')).length, 0);
});

for (const action of ['deselect', 'cancel-sync']) test(`${action} while URL read is pending prevents a new domain read`, async t => {
  const s = await setup(t), queries = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  chrome.cookies.getAll = async query => {
    queries.push(query);
    if (query.url) await gate;
    return [{ name: 'PDDAccessToken', value: 'synthetic', domain: 'mobile.yangkeduo.com', path: '/', storeId: '0' }];
  };
  const account = s.account('pdd'), group = await s.bind(), ref = { id: group.id, accountId: account.id };
  await s.call('select', { ...ref, enabled: true });
  const pending = s.call('previewSync', ref);
  const rejected = assert.rejects(pending, { code: action === 'deselect' ? 'PLATFORM_NOT_SELECTED' : 'REQUEST_CANCELED' });
  for (let n = 0; n < 100 && !queries.length; n++) await tick();
  assert.ok(queries.length);
  if (action === 'deselect') await s.call('select', { ...ref, enabled: false });
  else await s.call('cancelSync', ref);
  release(); await rejected;
  assert.ok(queries.every(query => query.url));
});

test('reverse authorization for an empty role creates selected PDD only after first confirmation', async t => {
  const s = await setup(t);
  const pending = await s.call('startRequest', { baseUrl: s.base, name: '反向测试', platforms: ['pdd'] });
  assert.ok(!('pollToken' in pending)); assert.ok(!('nonce' in pending));
  assert.equal(s.service.store.accounts().length, 0);
  const initialRequest = s.requests.find(request => request.path.endsWith('/requests'));
  assert.deepEqual(Object.keys(JSON.parse(initialRequest.body)).sort(), ['name','platforms']);
  assert.equal((await s.call('pollRequest')).status, 'pending');
  await s.call('openRequest'); assert.equal(s.opened[0], s.base + '/#cookie-sync-request=' + pending.code);
  await s.api('/v1/admin/cookie-sync/families/requests/' + pending.code + '/approve', { familyId: s.family.id });
  const approved = await s.call('pollRequest'); assert.equal(approved.status, 'approved');
  assert.equal(await s.call('pendingRequest'), null);
  const row = approved.group.accounts.find(item => item.account.platform === 'pdd'), ref = { id: approved.group.id, accountId: row.account.id };
  assert.equal(row.selected, true); assert.equal(row.auto, false); assert.equal(row.unconfigured, true);
  assert.ok(approved.group.accounts.filter(item => item.account.platform !== 'pdd').every(item => !item.selected));
  await assert.rejects(s.call('auto', { ...ref, enabled: true }), { code: 'NOT_CONFIRMED' });
  const confirmation = await s.call('previewSync', ref); assert.equal(s.service.store.accounts().length, 0);
  await s.call('confirmSync', { ...ref, confirmation });
  const accounts = s.service.store.accounts(); assert.equal(accounts.length, 1); assert.equal(accounts[0].platform, 'pdd');
  assert.equal(accounts[0].familyId, s.family.id);
  assert.deepEqual(s.service.store.cookie(accounts[0].id).split('; ').sort(), ['PDDAccessToken=fixture', 'pdd_user_id=20002000'].sort());
  const final = await s.call('status', { id: approved.group.id });
  const synced = final.accounts.find(item => item.account.id === accounts[0].id);
  assert.equal(synced.selected, true); assert.equal(synced.connection.identityBound, true);
  assert.ok(!JSON.stringify(s.storage).includes('PDDAccessToken='));
});

test('canceling a poll in flight cannot install a role grant and revokes a late returned token', async t => {
  const s = await setup(t), pending = await s.call('startRequest', { baseUrl: s.base, name: '取消测试', platforms: ['pdd'] });
  await s.api('/v1/admin/cookie-sync/families/requests/' + pending.code + '/approve', { familyId: s.family.id });
  let release, observed = false;
  const gate = new Promise(resolve => { release = resolve; });
  s.intercept(async (url, options) => {
    if (!url.endsWith('/requests/poll')) return;
    const response = await s.nativeFetch(url, options); observed = true; await gate; return response;
  });
  const polling = s.call('pollRequest'), rejected = assert.rejects(polling, { code: 'REQUEST_CANCELED' });
  for (let n = 0; n < 100 && !observed; n++) await tick();
  assert.equal(observed, true); await s.call('cancelRequest'); release(); await rejected;
  assert.deepEqual(await s.call('list'), []);
  const grants = await s.api('/v1/admin/cookie-sync/families/connections?familyId=' + s.family.id);
  assert.equal(grants.connections.length, 1); assert.ok(grants.connections[0].revokedAt);
});

test('reverse requests need only backend permission and never read or upload platform cookies', async t => {
  const s = await setup(t); s.allowed.delete(PLATFORMS.pdd.origins[0]);
  chrome.cookies.getAll = async () => { throw Error('cookies must not be inspected before approval'); };
  const pending = await s.call('startRequest', { baseUrl: s.base, name: '权限测试', platforms: ['pdd'] });
  assert.ok(pending.requestId);
  assert.equal(s.reads.length, 0); assert.equal(s.requests.length, 1);
  assert.deepEqual(JSON.parse(s.requests[0].body), { name: '权限测试', platforms: ['pdd'] });
  s.allowed.delete(s.base + '/*');
  await assert.rejects(s.call('startRequest', { baseUrl: s.base, name: '后台未授权', platforms: ['pdd'] }), { code: 'PERMISSION_REQUIRED' });
  assert.equal(s.requests.length, 1);
  assert.match(errorText({ code: 'LOGIN_REQUIRED', platform: 'pdd' }), /^拼多多：/);
});

test('existing selected PDD pairing survives each revoked origin and recovers after restore', async t => {
  const s = await setup(t), account = s.account('pdd'), group = await s.bind(), ref = { id: group.id, accountId: account.id };
  await s.call('select', { ...ref, enabled: true });
  await s.call('confirmSync', { ...ref, confirmation: await s.call('previewSync', ref) });
  const paired = () => s.storage.familyConnections.find(item => item.id === group.id).accounts.find(item => item.account.id === account.id);
  const connectionId = paired().connection.id;
  assert.equal(paired().selected, true);

  for (const origin of PLATFORMS.pdd.origins) {
    s.allowed.delete(origin);
    const reads = s.reads.length, uploads = s.requests.filter(request => request.path.endsWith('/cookie')).length;
    await assert.rejects(s.call('previewSync', ref), { code: 'PERMISSION_REQUIRED' });
    await assert.rejects(s.call('auto', { ...ref, enabled: true }), { code: 'PERMISSION_REQUIRED' });
    assert.ok((await s.call('startRequest', { baseUrl: s.base, name: '权限测试', platforms: ['pdd'] })).requestId);
    assert.equal(s.reads.length, reads);
    assert.equal(s.requests.filter(request => request.path.endsWith('/cookie')).length, uploads);
    assert.equal(paired().selected, true);
    assert.equal(paired().connection.id, connectionId);
    s.allowed.add(origin);
  }

  const reads = s.reads.length;
  const confirmation = await s.call('previewSync', ref);
  assert.ok(confirmation.token);
  assert.ok(s.reads.length > reads);
  assert.equal(paired().selected, true);
  assert.equal(paired().connection.id, connectionId);
});

test('an expired poll snapshot cannot clear a newer reverse request from another options page', async t => {
  const s = await setup(t);
  s.storage.familyRequest = { requestId: 'expired-request', nonce: 'expired-nonce', expiresAt: Date.now() - 1 };
  const get = chrome.storage.local.get;
  let releaseRead, releaseRequest, intercepted = false, requestObserved = false;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const requestGate = new Promise(resolve => { releaseRequest = resolve; });
  s.intercept(async url => { if (url.endsWith('/requests')) { requestObserved = true; await requestGate; } });
  chrome.storage.local.get = async key => {
    const snapshot = await get(key);
    if (key === 'familyRequest' && !intercepted) { intercepted = true; await readGate; }
    return snapshot;
  };
  t.after(() => { releaseRead(); releaseRequest(); });
  const expired = assert.rejects(s.call('pollRequest'), { code: 'PREVIEW_EXPIRED' });
  for (let n = 0; n < 100 && !intercepted; n++) await tick();
  assert.equal(intercepted, true);
  const newer = s.call('startRequest', { baseUrl: s.base, name: '另一个设置页', platforms: ['pdd'] });
  for (let n = 0; n < 100 && !requestObserved; n++) await tick();
  assert.ok(requestObserved);
  const nonce = s.storage.familyRequest.nonce;
  assert.notEqual(nonce, 'expired-nonce');
  releaseRead(); await expired;
  assert.equal(s.storage.familyRequest.nonce, nonce);
  releaseRequest();
  const pending = await newer;
  assert.equal((await s.call('pendingRequest')).requestId, pending.requestId);
});

test('reverse approval with one missing login keeps successful platforms independent and requires first confirmation', async t => {
  const s = await setup(t), getAll = chrome.cookies.getAll;
  chrome.cookies.getAll = async query => {
    if (query.domain === 'yangkeduo.com' || query.url?.includes('yangkeduo.com')) return [];
    return getAll(query);
  };
  const pending = await s.call('startRequest', { baseUrl: s.base, name: '三平台', platforms: ['taobao', 'jd', 'pdd'] });
  assert.ok(pending.requestId); assert.equal(s.reads.length, 0); assert.equal(s.service.store.accounts().length, 0);
  await s.api('/v1/admin/cookie-sync/families/requests/' + pending.code + '/approve', { familyId: s.family.id });
  const approved = await s.call('pollRequest');
  for (const platform of ['taobao', 'jd']) {
    const row = approved.group.accounts.find(item => item.account.platform === platform), ref = { id: approved.group.id, accountId: row.account.id };
    await assert.rejects(s.call('sync', ref), { code: 'NOT_CONFIRMED' });
    const confirmation = await s.call('previewSync', ref);
    await s.call('confirmSync', { ...ref, confirmation });
  }
  const row = approved.group.accounts.find(item => item.account.platform === 'pdd'), ref = { id: approved.group.id, accountId: row.account.id };
  await assert.rejects(s.call('previewSync', ref), { code: 'LOGIN_REQUIRED' });
  const current = (await s.call('list'))[0];
  assert.equal(current.accounts.find(item => item.account.platform === 'pdd').errorCode, 'LOGIN_REQUIRED');
  assert.deepEqual(s.service.store.accounts().map(account => account.platform).sort(), ['jd', 'taobao']);
  assert.equal(s.requests.filter(request => request.path.endsWith('/cookie')).length, 2);
  assert.ok(!JSON.stringify(s.storage).includes('cookie2='));
});

test('canceling a family flow invalidates all pending confirmations without deselecting or deleting grants', async t => {
  const s = await setup(t), account = s.account('pdd'), group = await s.bind(), ref = { id: group.id, accountId: account.id };
  await s.call('select', { ...ref, enabled: true });
  const confirmation = await s.call('previewSync', ref);
  await s.call('cancelSync', { id: group.id });
  await assert.rejects(s.call('confirmSync', { ...ref, confirmation }), { code: 'REQUEST_CANCELED' });
  const record = (await s.call('list'))[0].accounts.find(item => item.account.id === account.id);
  assert.equal(record.selected, true); assert.equal(record.auto, false);
  assert.equal(s.requests.filter(request => request.path.endsWith('/cookie')).length, 0);
  const fresh = await s.call('previewSync', ref); await s.call('confirmSync', { ...ref, confirmation: fresh });
  await s.call('auto', { ...ref, enabled: true });
  await s.call('cancelSync', ref);
  assert.equal((await s.call('list'))[0].accounts.find(item => item.account.id === account.id).auto, true);
  await s.call('select', { ...ref, enabled: false });
  await assert.rejects(s.call('auto', { ...ref, enabled: true }), { code: 'PLATFORM_NOT_SELECTED' });
});

test('canceling a reverse request during metadata response cannot restore the pending request', async t => {
  const s = await setup(t);
  let release, observed = false;
  const gate = new Promise(resolve => { release = resolve; }); t.after(release);
  s.intercept(async url => { if (url.endsWith('/requests')) { observed = true; await gate; } });
  const request = s.call('startRequest', { baseUrl: s.base, name: '取消申请', platforms: ['pdd'] });
  const rejected = assert.rejects(request, { code: 'REQUEST_CANCELED' });
  for (let n = 0; n < 100 && !observed; n++) await tick();
  assert.ok(observed); await s.call('cancelRequest'); release(); await rejected;
  assert.equal(await s.call('pendingRequest'), null); assert.equal(s.reads.length, 0); assert.equal(s.service.store.accounts().length, 0);
});

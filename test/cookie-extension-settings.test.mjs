import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSettings } from '../cookie-extension/settings.mjs';

function setup(t, initial = {}) {
  const previousChrome = globalThis.chrome, previousFetch = globalThis.fetch, storage = structuredClone(initial);
  globalThis.chrome = { storage: { local: {
    get: async keys => Object.fromEntries(keys.map(key => [key, structuredClone(storage[key])])),
    set: async patch => Object.assign(storage, structuredClone(patch))
  } } };
  globalThis.fetch = async () => { throw Error('saving an address must not contact any host'); };
  t.after(() => { globalThis.chrome = previousChrome; globalThis.fetch = previousFetch; });
  return { storage, settings: createSettings(Promise.resolve()) };
}

test('settings migrate addresses from pending, family and legacy grants without moving or merging credentials', async t => {
  const initial = {
    familyRequest: { baseUrl: 'https://pending.example', name: '待授权浏览器', pollToken: randomBytes(32).toString('hex'), nonce: crypto.randomUUID() },
    familyConnections: [{ baseUrl: 'https://family.example/', token: randomBytes(32).toString('hex'), connection: { name: '家庭浏览器' }, accounts: [{ selected: false, auto: false }] }],
    connections: [{ baseUrl: 'https://legacy.example', token: randomBytes(32).toString('hex'), auto: true, consent: 'old-consent' },
      { baseUrl: 'https://family.example', token: randomBytes(32).toString('hex') }, { baseUrl: 'https://user:password@invalid.example', token: randomBytes(32).toString('hex') }]
  };
  const { storage, settings } = setup(t, initial), result = await settings.get();
  assert.deepEqual(result, { baseUrl: 'https://pending.example', name: '待授权浏览器',
    baseUrls: ['https://pending.example', 'https://family.example', 'https://legacy.example'] });
  for (const key of ['connections', 'familyConnections', 'familyRequest']) assert.deepEqual(storage[key], initial[key]);
  for (const secret of [initial.familyRequest.pollToken, initial.familyRequest.nonce, initial.familyConnections[0].token, ...initial.connections.map(item => item.token)]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.equal(JSON.stringify(result).includes('password'), false);
  assert.deepEqual(await createSettings(Promise.resolve()).get(), result);
});

test('settings save an unreachable valid address, preserve all prior hosts and reject unsafe addresses', async t => {
  const { storage, settings } = setup(t, { connections: [{ baseUrl: 'https://legacy.example', token: 'private', auto: true }] });
  assert.equal((await settings.get()).name, '我的 Chrome');
  const saved = await settings.save({ baseUrl: 'https://offline.example/', name: '共享浏览器' });
  assert.deepEqual(saved, { baseUrl: 'https://offline.example', name: '共享浏览器', baseUrls: ['https://offline.example', 'https://legacy.example'] });
  assert.deepEqual(storage.connections, [{ baseUrl: 'https://legacy.example', token: 'private', auto: true }]);
  for (const baseUrl of ['https://user:pass@example.com', 'https://example.com/path', 'https://example.com?token=secret']) {
    await assert.rejects(settings.save({ baseUrl }), { code: 'INVALID_BASE_URL' });
  }
  assert.deepEqual(await settings.get(), saved);
});

test('concurrent settings changes retain both host choices and ignore unrecognized credential fields', async t => {
  const { settings } = setup(t);
  await Promise.all([settings.save({ baseUrl: 'https://one.example', name: '浏览器', token: 'never-copy' }),
    settings.save({ baseUrl: 'https://two.example' })]);
  assert.deepEqual(await settings.get(), { baseUrl: 'https://two.example', name: '浏览器', baseUrls: ['https://two.example', 'https://one.example'] });
});

test('saving only the browser name preserves an existing backend and works before an address is configured', async t => {
  const { settings, storage } = setup(t);
  assert.deepEqual(await settings.save({ name: '先设置名称' }), { baseUrl: '', name: '先设置名称', baseUrls: [] });
  await settings.save({ baseUrl: 'https://saved.example' });
  assert.deepEqual(await settings.save({ name: '修改后的名称' }),
    { baseUrl: 'https://saved.example', name: '修改后的名称', baseUrls: ['https://saved.example'] });
  assert.equal(storage.connections, undefined); assert.equal(storage.familyConnections, undefined);
});

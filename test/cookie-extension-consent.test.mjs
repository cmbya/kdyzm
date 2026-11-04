import test from 'node:test';
import assert from 'node:assert/strict';

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

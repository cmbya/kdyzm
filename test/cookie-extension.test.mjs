import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baseOrigin, pairingInput, cookieHeader, platformForDomain, apiRequest, errorText } from '../cookie-extension/core.mjs';
const cookie = (name, value, domain = '.taobao.com', extra = {}) => ({ name, value, domain, storeId: '0', ...extra });

test('pairing accepts only scoped codes and safe HTTPS origins; local development stays loopback', () => {
  const code = 'CS-' + 'a'.repeat(43);
  assert.deepEqual(pairingInput(JSON.stringify({ schemaVersion: 1, kind: 'cookie-sync', baseUrl: 'https://TEST.example/', code })), { baseUrl: 'https://test.example', code });
  assert.equal(baseOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const address of ['http://192.168.1.1', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?token=private', 'https://example.com/#a', 'file:///tmp', 'https://example.com\\@evil.com', 'https://example.com:0']) assert.throws(() => baseOrigin(address));
  assert.throws(() => pairingInput(JSON.stringify({ schemaVersion: 1, baseUrl: 'https://example.com', code })));
});
test('cookie export uses allowed platform, profile, unpartitioned and unexpired cookies including HttpOnly', () => {
  const result = cookieHeader('taobao', [cookie('unb', '123'), cookie('cookie2', 'synthetic-login', '.taobao.com', { httpOnly: true }),
    cookie('unb', 'other', '.evil.com'), cookie('tracking', 'ignore', '.taobao.com', { partitionKey: { topLevelSite: 'https://example.com' } }),
    cookie('private', 'ignore', '.taobao.com', { storeId: '1' }), cookie('expired', 'ignore', '.taobao.com', { expirationDate: 1 })]);
  assert.equal(result, 'cookie2=synthetic-login; unb=123');
  assert.deepEqual(platformForDomain('.taobao.com.evil.example'), []);
  assert.deepEqual(platformForDomain('.h5api.m.taobao.com'), ['taobao']);
});
test('three platforms require login and stable identity; ambiguity and header injection fail closed', () => {
  assert.equal(cookieHeader('pdd', [cookie('pdduid', '123', '.yangkeduo.com'), cookie('PDDAccessToken', 'synthetic', '.yangkeduo.com')]), 'PDDAccessToken=synthetic; pdduid=123');
  assert.match(cookieHeader('jd', [cookie('pin', '%E6%B5%8B%E8%AF%95', '.jd.com'), cookie('pt_pin', '%E6%B5%8B%E8%AF%95', '.jd.com'), cookie('thor', 'synthetic', '.jd.com')]), /thor=synthetic/);
  assert.throws(() => cookieHeader('taobao', [cookie('unb', '123')]));
  assert.throws(() => cookieHeader('taobao', [cookie('unb', '123'), cookie('unb', '456'), cookie('cookie2', 'synthetic')]));
  assert.throws(() => cookieHeader('pdd', [cookie('pdduid', '1', '.yangkeduo.com'), cookie('pdd_user_id', '2', '.yangkeduo.com'), cookie('PDDAccessToken', 'synthetic', '.yangkeduo.com')]));
  assert.throws(() => cookieHeader('jd', [cookie('thor', 'synthetic', '.jd.com')]));
  assert.throws(() => cookieHeader('taobao', [cookie('unb', '123'), cookie('cookie2', 'bad\r\nCookie: injected')]));
});
test('requests reject redirects, omit browser credentials, cap responses and never display server-reflected secrets', async () => {
  let request;
  const result = await apiRequest('https://service.example', '/v1/cookie-sync/current', { token: 'fixture', fetchImpl: async (url, options) => {
    request = { url, options }; return new Response(JSON.stringify({ account: {} }));
  } });
  assert.ok(result.account); assert.equal(request.options.redirect, 'error'); assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.headers.Authorization, 'Bearer fixture');
  await assert.rejects(apiRequest('https://service.example', '/v1/admin/accounts'), { code: 'BAD_MESSAGE' });
  await assert.rejects(apiRequest('https://service.example', '/v1/cookie-sync/current', { fetchImpl: async () => new Response('x'.repeat(65537)) }), { code: 'INVALID_RESPONSE' });
  let error;
  try { await apiRequest('https://service.example', '/v1/cookie-sync/current', { fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'secret Cookie=leaked' } }), { status: 409 }) }); } catch (e) { error = e; }
  assert.equal(error.status, 409); assert.ok(!errorText(error).includes('leaked'));
});
test('packaged extension has no content scripts or permanent website access', () => {
  const manifest = JSON.parse(readFileSync(new URL('../cookie-extension/manifest.json', import.meta.url)));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.host_permissions, undefined); assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined); assert.equal(manifest.incognito, 'not_allowed');
  assert.deepEqual(manifest.permissions, ['cookies', 'storage', 'alarms']);
});

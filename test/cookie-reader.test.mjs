import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { errorText } from '../cookie-extension/core.mjs';
import { readCookieHeader } from '../cookie-extension/core.mjs';

const cookie = (name, value, domain = '.jd.com', extra = {}) => ({ name, value, domain, path: '/', storeId: '0', ...extra });

function apiFor({ urls = {}, domains = [] } = {}) {
  const calls = [];
  return {
    calls,
    async getAll(query) {
      calls.push(query);
      if (query.url) return urls[query.url] || [];
      return domains;
    },
  };
}

const jdUrls = ['https://api.m.jd.com/api', 'https://order.jd.com/center/list.action'];

test('normal URL reads do not perform domain fallback', async () => {
  const api = apiFor({ urls: Object.fromEntries(jdUrls.map(url => [url, [
    cookie('pin', 'USER'), cookie('pt_pin', 'USER'), cookie('light_key', 'SESSION'),
  ]])) });
  const result = await readCookieHeader('jd', api);
  assert.match(result, /light_key=SESSION/);
  assert.equal(api.calls.length, 2);
  assert.ok(api.calls.every(call => call.url));
});

test('missing login field performs constrained domain fallback', async () => {
  const api = apiFor({ urls: Object.fromEntries(jdUrls.map(url => [url, [cookie('pin', 'USER'), cookie('pt_pin', 'USER')]])),
    domains: [cookie('light_key', 'SESSION')] });
  const result = await readCookieHeader('jd', api);
  assert.match(result, /light_key=SESSION/);
  assert.deepEqual(api.calls.slice(2), [{ domain: 'jd.com', storeId: '0' }]);
});

test('fallback excludes host-only subdomain cookies and unrelated paths', async () => {
  const base = Object.fromEntries(jdUrls.map(url => [url, [cookie('pin', 'USER'), cookie('pt_pin', 'USER')]]));
  const api = apiFor({ urls: base, domains: [
    cookie('light_key', 'host-only', 'private.jd.com', { hostOnly: true }),
    cookie('light_key', 'wrong-path', '.jd.com', { path: '/private' }),
  ] });
  await assert.rejects(readCookieHeader('jd', api), { code: 'LOGIN_REQUIRED' });
});

test('parent-domain path boundary is accepted only for the matching request path', async () => {
  const api = apiFor({ urls: Object.fromEntries(jdUrls.map(url => [url, [cookie('pin', 'USER'), cookie('pt_pin', 'USER')]])),
    domains: [cookie('light_key', 'SESSION', '.jd.com', { path: '/api' })] });
  const result = await readCookieHeader('jd', api);
  assert.match(result, /light_key=SESSION/);
});

test('domain reread keeps conflicting identity or login values fail-closed', async () => {
  const api = apiFor({ urls: Object.fromEntries(jdUrls.map(url => [url, [cookie('pin', 'USER'), cookie('pt_pin', 'USER')]])),
    domains: [cookie('pin', 'OTHER'), cookie('pt_pin', 'OTHER'), cookie('light_key', 'SESSION')] });
  await assert.rejects(readCookieHeader('jd', api), { code: 'IDENTITY_CONFLICT' });
});

test('filtered fallback diagnostics explain reasons without leaking values', async () => {
  const secret = randomUUID();
  const now = 2_000_000;
  const api = apiFor({ urls: Object.fromEntries(jdUrls.map(url => [url, [cookie('pin', 'USER'), cookie('pt_pin', 'USER')]])),
    domains: [
      cookie('light_key', secret, '.jd.com', { storeId: 'other' }),
      cookie('light_key', secret + '-partitioned', '.jd.com', { partitionKey: { topLevelSite: 'https://jd.com' } }),
      cookie('light_key', secret + '-expired', '.jd.com', { expirationDate: (now - 1) / 1000 }),
    ] });
  try {
    await readCookieHeader('jd', api);
    assert.fail('expected login failure');
  } catch (error) {
    assert.equal(error.code, 'LOGIN_REQUIRED');
    const text = errorText(error);
    assert.match(text, /其他Cookie存储区/);
    assert.match(text, /分区Cookie/);
    assert.match(text, /已过期/);
    assert.ok(!text.includes(secret));
  }
});

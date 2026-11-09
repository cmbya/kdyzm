import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';
import { createCollector } from '../src/collectors.mjs';
import { cookieIdentity } from '../src/cookie-sync.mjs';

const ADMIN = 'cookie-sync-test-admin-with-at-least-32-characters';
const KEY = 'e7'.repeat(32);
const TIME = 1793350000000;
const EXTENSION = `chrome-extension://${'a'.repeat(32)}`;
const COOKIES = {
  taobao: 'unb=100123456; cookie2=SYNTHETIC-TB-LOGIN',
  pdd: 'pdd_user_id=200123456; pdduid=200123456; PDDAccessToken=SYNTHETIC-PDD-LOGIN',
  jd: 'pin=SYNTHETIC%5FJD%5F123456; pt_pin=SYNTHETIC_JD_123456; thor=SYNTHETIC-JD-LOGIN',
};
const JD_LIGHT_COOKIE = 'pin=SYNTHETIC%5FJD%5F123456; pt_pin=SYNTHETIC_JD_123456; light_key=SYNTHETIC-JD-LIGHT';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, options = {}) {
  let current = TIME;
  const service = createService({ encryptionKey: KEY, adminToken: ADMIN, baseUrl: 'https://pickup.example', now: () => current,
    scheduler: false, collector: async () => ({ orders: [], shipments: [] }), ...options });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  let stopped = false;
  const close = async () => { if (!stopped) { stopped = true; await service.close(); } };
  t.after(close);
  const request = async (path, { method = 'GET', body, token, admin = false, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(admin ? { 'x-admin-token': ADMIN } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    return { status: response.status, headers: response.headers, raw, data: raw ? JSON.parse(raw) : null };
  };
  const account = (platform = 'taobao', extra = {}) => service.store.saveAccount({ platform, label: `合成${platform}`,
    cookie: COOKIES[platform], ...extra });
  const pair = async accountId => {
    const result = await request('/v1/admin/cookie-sync/pairing', { method: 'POST', admin: true, body: { accountId } });
    assert.equal(result.status, 201, result.raw); return result.data;
  };
  const redeem = code => request('/v1/cookie-sync/connections', { method: 'POST', body: { code, name: '合成浏览器' } });
  const bind = async accountId => {
    const result = await redeem((await pair(accountId)).code);
    assert.equal(result.status, 201, result.raw); return result.data;
  };
  const preview = (token, cookie) => request('/v1/cookie-sync/current/preview', { method: 'POST', token, body: { cookie } });
  const write = (token, cookie, expectedCredentialVersion, confirmationToken) => request('/v1/cookie-sync/current/cookie', {
    method: 'POST', token, body: { cookie, expectedCredentialVersion, ...(confirmationToken === undefined ? {} : { confirmationToken }) },
  });
  const confirm = async (connection, cookie) => {
    const viewed = await preview(connection.token, cookie); assert.equal(viewed.status, 200, viewed.raw);
    return write(connection.token, cookie, viewed.data.account.credentialVersion, viewed.data.confirmationToken);
  };
  return { service, base, request, account, pair, redeem, bind, preview, write, confirm, close, advance: ms => { current += ms; } };
}

test('three platform identities are parsed from headers, reject ambiguity, and require web login fields', () => {
  for (const [platform, cookie] of Object.entries(COOKIES)) assert.ok(cookieIdentity(platform, cookie));
  assert.equal(cookieIdentity('jd', COOKIES.jd), 'SYNTHETIC_JD_123456');
  const invalid = [
    ['taobao', 'unb=100;'], ['taobao', 'unb=100; cookie2='], ['taobao', 'cookie2=login'],
    ['taobao', 'unb=100; unb=100; cookie2=login'], ['taobao', 'Cookie: unb=100; cookie2=login'],
    ['pdd', 'pdd_user_id=1; pdduid=2; PDDAccessToken=login'], ['pdd', 'pdd_user_id=1; PDDAccessToken='],
    ['jd', 'pin=a; pt_pin=b; thor=login'], ['jd', 'pin=%FF; thor=login'], ['jd', 'pin=a; pt_key=mobile-only'],
    ['jd', 'pin=a'], ['jd', 'pin=a; flash=desktop-session'],
    ['jd', 'pin=a%0D%0A; thor=login'], ['taobao', 'unb=100; cookie2=login\r\nX-Forged: yes'],
  ];
  for (const [platform, cookie] of invalid) assert.throws(() => cookieIdentity(platform, cookie), `${platform}: ${cookie}`);
});

test('JD desktop order-page cookies with light_key can preview and save without thor', async t => {
  const s = await setup(t), account = s.account('jd', { cookie: JD_LIGHT_COOKIE }), grant = await s.bind(account.id);
  const preview = await s.preview(grant.token, JD_LIGHT_COOKIE);
  assert.equal(preview.status, 200, preview.raw);
  const saved = await s.write(grant.token, JD_LIGHT_COOKIE, preview.data.account.credentialVersion, preview.data.confirmationToken);
  assert.equal(saved.status, 200, saved.raw);
  assert.equal(saved.data.connection.identityBound, true);
});

for (const platform of Object.keys(COOKIES)) test(`${platform}: explicit first confirmation, same identity refresh, no-op and encrypted storage`, async t => {
  let collections = 0;
  const s = await setup(t, { collector: async () => { collections++; return { orders: [], shipments: [] }; } });
  const account = s.account(platform), grant = await s.bind(account.id), cookie = `${COOKIES[platform]}; refresh=SYNTHETIC-NEW`;
  const rejected = await s.write(grant.token, cookie, account.credentialVersion);
  assert.equal(rejected.status, 409); assert.equal(rejected.data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
  assert.equal(s.service.store.cookie(account.id), COOKIES[platform]);
  const saved = await s.confirm(grant, cookie);
  assert.equal(saved.status, 200, saved.raw); assert.equal(saved.data.changed, true);
  assert.equal(saved.data.connection.identityBound, true); assert.ok(saved.data.connection.identityHint.startsWith('••••'));
  assert.equal(saved.data.account.credentialVersion, account.credentialVersion + 1);
  assert.equal(s.service.store.cookie(account.id), cookie);
  await Promise.all([...s.service.running.values()]);
  const revision = s.service.store.account(account.id).revision;
  const noOp = await s.write(grant.token, cookie, saved.data.account.credentialVersion);
  assert.equal(noOp.status, 200); assert.equal(noOp.data.changed, false); assert.equal(noOp.data.job, undefined);
  assert.equal(s.service.store.account(account.id).revision, revision); assert.equal(collections, 1);
  assert.equal((await s.write(grant.token, `${cookie}; automatic=yes`, saved.data.account.credentialVersion)).status, 200);
  const row = s.service.store.db.prepare('SELECT * FROM cookie_sync_connections').get();
  assert.ok(!JSON.stringify(row).includes(grant.token)); assert.ok(!JSON.stringify(row).includes(cookie));
  assert.ok(!s.service.store.db.prepare('SELECT credential FROM accounts WHERE id=?').get(account.id).credential.includes('SYNTHETIC'));
  assert.ok(!saved.raw.includes(cookie)); assert.ok(!saved.raw.includes(grant.token));
  assert.equal((await s.request(`/v1/admin/cookie-sync/connections?accountId=${account.id}`, { admin: true })).data.connections.length, 1);
});

test('pairing is single use, expiring, version bound and superseded pairing revokes only its account connection', async t => {
  const s = await setup(t), a = s.account(), b = s.account('jd');
  const first = await s.bind(a.id), other = await s.bind(b.id), pair = await s.pair(a.id);
  const preview = await s.request('/v1/cookie-sync/pairing/preview', { method: 'POST', body: { code: pair.code } });
  assert.equal(preview.status, 200); assert.equal(preview.data.account.id, a.id);
  assert.equal(preview.headers.get('cache-control'), 'no-store');
  assert.ok(!preview.raw.includes(pair.code)); assert.ok(!preview.raw.includes(COOKIES.taobao));
  const results = await Promise.all([s.redeem(pair.code), s.redeem(pair.code)]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 400]);
  assert.equal((await s.request('/v1/cookie-sync/current', { token: first.token })).status, 401);
  assert.equal((await s.request('/v1/cookie-sync/current', { token: other.token })).status, 200);
  const stale = await s.pair(a.id);
  s.service.store.saveAccount({ cookie: COOKIES.taobao }, a.id);
  assert.equal((await s.redeem(stale.code)).status, 400);
  const expired = await s.pair(a.id); s.advance(10 * 60000);
  assert.equal((await s.redeem(expired.code)).status, 400);
  s.advance(90 * 86400000);
  assert.equal((await s.request('/v1/cookie-sync/current', { token: other.token })).status, 401);
});

test('cookie grants cannot read orders/admin/device data and those credentials cannot write cookies', async t => {
  const s = await setup(t), account = s.account(), grant = await s.bind(account.id);
  const device = s.service.store.redeem(s.service.store.createPairing([account.id]).code, '合成手机');
  for (const path of ['/v1/snapshot', '/v1/accounts', '/v1/connection', '/v1/admin/accounts', '/v1/admin/devices']) {
    assert.equal((await s.request(path, { token: grant.token })).status, 401, path);
  }
  for (const token of [device.token, ADMIN, 'fake']) {
    assert.equal((await s.request('/v1/cookie-sync/current', { token })).status, 401);
    assert.equal((await s.write(token, COOKIES.taobao, account.credentialVersion)).status, 401);
  }
  assert.equal((await s.write(grant.token, COOKIES.taobao, account.credentialVersion)).status, 409);
  assert.equal((await s.request('/v1/admin/cookie-sync/pairing', { method: 'POST', token: grant.token, body: { accountId: account.id } })).status, 401);
  assert.equal((await s.request('/v1/cookie-sync/current/preview', { method: 'POST', token: grant.token, body: { cookie: COOKIES.taobao, accountId: account.id } })).status, 400);
  assert.equal((await s.request('/v1/cookie-sync/current', { method: 'DELETE', token: grant.token })).status, 200);
  assert.equal((await s.preview(grant.token, COOKIES.taobao)).status, 401);
});

test('identity mismatch, ambiguous backend identity and stale confirmation never overwrite existing credentials', async t => {
  const s = await setup(t), a = s.account('pdd'), grant = await s.bind(a.id), original = COOKIES.pdd;
  const foreign = original.replaceAll('200123456', '999000111');
  assert.equal((await s.preview(grant.token, foreign)).data.error.code, 'COOKIE_IDENTITY_MISMATCH');
  assert.equal(s.service.store.cookie(a.id), original);
  const pending = await s.preview(grant.token, original);
  assert.equal((await s.write(grant.token, `${original}; changed=yes`, a.credentialVersion, pending.data.confirmationToken)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
  s.advance(5 * 60000);
  assert.equal((await s.write(grant.token, original, a.credentialVersion, pending.data.confirmationToken)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
  assert.equal((await s.confirm(grant, original)).status, 200);
  s.service.store.saveAccount({ cookie: foreign }, a.id);
  assert.equal((await s.write(grant.token, foreign, a.credentialVersion + 1)).data.error.code, 'COOKIE_IDENTITY_MISMATCH');
  assert.equal((await s.preview(grant.token, original)).data.error.code, 'COOKIE_IDENTITY_MISMATCH');
  assert.equal(s.service.store.cookie(a.id), foreign);
  const repaired = await s.bind(a.id);
  assert.equal((await s.confirm(repaired, foreign)).status, 200);
  s.service.store.saveAccount({ cookie: `${foreign}; pdd_user_id=conflict` }, a.id);
  assert.equal((await s.preview(repaired.token, foreign)).data.error.code, 'COOKIE_BACKEND_IDENTITY_INVALID');
});

test('first preview can bind a legacy header without identity, but the required incoming identity is never inferred from label', async t => {
  const s = await setup(t), a = s.account('taobao', { cookie: 'legacy=SYNTHETIC' }), grant = await s.bind(a.id);
  assert.equal((await s.preview(grant.token, 'cookie2=SYNTHETIC')).data.error.code, 'COOKIE_IDENTITY_REQUIRED');
  assert.equal((await s.confirm(grant, COOKIES.taobao)).status, 200);
});

test('taobao identity recovery: an expired platform response cannot lock out the original browser account', async t => {
  let requests = 0;
  const collector = createCollector({ now: () => TIME, fetchImpl: async () => {
    requests++;
    return new Response(JSON.stringify({ ret: ['FAIL_SYS_SESSION_EXPIRED::synthetic'] }), {
      headers: { 'Set-Cookie': 'unb=; Max-Age=0; Path=/' },
    });
  } });
  const s = await setup(t, { collector });
  const original = `${COOKIES.taobao}; _m_h5_tk=SYNTHETIC_TOKEN_1`;
  const a = s.account('taobao', { cookie: original }), grant = await s.bind(a.id);
  assert.equal((await s.confirm(grant, original)).status, 200);
  await s.service.requestSync(a.id);
  assert.ok(requests > 0, 'the real collector must receive the synthetic expiry response');
  const preview = await s.preview(grant.token, original);
  assert.equal(preview.status, 200, 'the original browser identity must remain eligible after collection expires');
  assert.equal(s.service.store.cookie(a.id), original, 'an expiry response must not erase the trusted identity');
  assert.equal(s.service.store.account(a.id).status, 'expired');
  assert.equal(s.service.store.account(a.id).credentialVersion, a.credentialVersion);
  const saved = await s.write(grant.token, original, preview.data.account.credentialVersion, preview.data.confirmationToken);
  assert.equal(saved.status, 200, saved.raw);
});

test('taobao identity recovery: normal session and token rotation preserves the confirmed account', async t => {
  const original = `${COOKIES.taobao}; _m_h5_tk=SYNTHETIC_TOKEN_1`;
  const rotated = original.replace('SYNTHETIC-TB-LOGIN', 'SYNTHETIC-TB-ROTATED')
    .replace('SYNTHETIC_TOKEN_1', 'SYNTHETIC_TOKEN_2');
  let continued = false;
  const s = await setup(t, { collector: async (_account, _cookie, options) => {
    options.onCookieRefresh(rotated);
    continued = true;
    return { orders: [], shipments: [], refreshedCookie: rotated };
  } });
  const a = s.account('taobao', { cookie: original }), grant = await s.bind(a.id);
  assert.equal((await s.confirm(grant, original)).status, 200);
  await s.service.requestSync(a.id);
  assert.equal(continued, true);
  assert.equal(s.service.store.cookie(a.id), rotated);
  assert.equal(s.service.store.account(a.id).credentialVersion, a.credentialVersion);
  assert.equal((await s.preview(grant.token, rotated)).status, 200);
  assert.equal((await s.write(grant.token, rotated, a.credentialVersion)).status, 200);
});

for (const [name, rotated] of [
  ['missing identity', 'cookie2=SYNTHETIC-TB-ROTATED; _m_h5_tk=SYNTHETIC_TOKEN_2'],
  ['different identity', 'unb=999123456; cookie2=SYNTHETIC-TB-ROTATED; _m_h5_tk=SYNTHETIC_TOKEN_2'],
  ['duplicate conflicting identity', `${COOKIES.taobao}; unb=999123456; _m_h5_tk=SYNTHETIC_TOKEN_2`],
  ['missing login field', 'unb=100123456; _m_h5_tk=SYNTHETIC_TOKEN_2'],
]) test(`taobao identity recovery: ${name} rotation stops collection without replacing trusted credentials`, async t => {
  let continued = false;
  const s = await setup(t, { collector: async (_account, _cookie, options) => {
    options.onCookieRefresh(rotated);
    continued = true;
    return { orders: [], shipments: [], refreshedCookie: rotated };
  } });
  const a = s.account(), grant = await s.bind(a.id);
  assert.equal((await s.confirm(grant, COOKIES.taobao)).status, 200);
  await s.service.requestSync(a.id);
  assert.equal(s.service.store.cookie(a.id), COOKIES.taobao, 'rejected rotation must preserve the complete trusted header');
  assert.equal(continued, false, 'collection must stop before subsequent requests can use an unverified identity');
  assert.equal(s.service.store.account(a.id).status, 'expired');
  assert.equal(s.service.store.account(a.id).credentialVersion, a.credentialVersion);
  assert.equal((await s.preview(grant.token, COOKIES.taobao)).status, 200);
});

test('taobao identity recovery: a previously polluted backend still requires explicit reauthorization', async t => {
  const s = await setup(t), a = s.account(), grant = await s.bind(a.id);
  assert.equal((await s.confirm(grant, COOKIES.taobao)).status, 200);
  const polluted = 'cookie2=SYNTHETIC-LEGACY-WITHOUT-IDENTITY';
  assert.equal((await s.request(`/v1/admin/accounts/${a.id}`, { method: 'PATCH', admin: true,
    body: { cookie: polluted } })).status, 200);
  assert.equal((await s.preview(grant.token, COOKIES.taobao)).data.error.code, 'COOKIE_BACKEND_IDENTITY_INVALID');
  assert.equal((await s.preview(grant.token, COOKIES.taobao.replace('100123456', '999123456'))).data.error.code, 'COOKIE_IDENTITY_MISMATCH');
  assert.equal(s.service.store.cookie(a.id), polluted, 'an old binding must not silently heal a legacy credential');
  const repaired = await s.bind(a.id);
  assert.equal((await s.confirm(repaired, COOKIES.taobao)).status, 200);
});

test('account transfers revoke codes and grants permanently, including away and back without an intervening request', async t => {
  const s = await setup(t), one = s.service.store.saveFamily({ name: '合成角色一' }), two = s.service.store.saveFamily({ name: '合成角色二' });
  const a = s.account('taobao', { familyId: one.id }), grant = await s.bind(a.id), pairing = await s.pair(a.id);
  s.service.store.saveAccount({ familyId: two.id }, a.id); s.service.store.saveAccount({ familyId: one.id }, a.id);
  assert.equal((await s.request('/v1/cookie-sync/current', { token: grant.token })).status, 401);
  assert.equal((await s.redeem(pairing.code)).status, 400);
  const replacement = await s.bind(a.id);
  assert.equal((await s.request('/v1/cookie-sync/current', { token: replacement.token })).status, 200);
  s.service.store.saveFamily({ name: '只改角色显示名' }, one.id);
  assert.equal((await s.request('/v1/cookie-sync/current', { token: replacement.token })).data.account.familyName, '只改角色显示名');
});

test('credential compare-and-set protects concurrent writes and confirmation version', async t => {
  const s = await setup(t), a = s.account(), grant = await s.bind(a.id);
  const pending = await s.preview(grant.token, `${COOKIES.taobao}; value=first`);
  s.service.store.saveAccount({ cookie: `${COOKIES.taobao}; manual=changed` }, a.id);
  assert.equal((await s.write(grant.token, `${COOKIES.taobao}; value=first`, a.credentialVersion, pending.data.confirmationToken)).data.error.code, 'COOKIE_CREDENTIAL_CONFLICT');
  assert.equal((await s.write(grant.token, `${COOKIES.taobao}; value=first`, a.credentialVersion + 1, pending.data.confirmationToken)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
  const bound = await s.confirm(grant, `${COOKIES.taobao}; manual=changed`); assert.equal(bound.status, 200);
  assert.equal((await s.write(grant.token, COOKIES.taobao, undefined)).data.error.code, 'CREDENTIAL_VERSION_REQUIRED');
  const results = await Promise.all([1, 2].map(n => s.write(grant.token, `${COOKIES.taobao}; race=${n}`, bound.data.account.credentialVersion)));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(s.service.store.account(a.id).credentialVersion, a.credentialVersion + 2);
});

async function pausedWrite(s, token, body) {
  const encoded = JSON.stringify(body);
  let req;
  const done = new Promise((resolve, reject) => {
    req = httpRequest(`${s.base}/v1/cookie-sync/current/cookie`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded),
    } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', value => { text += value; });
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(text) }));
    });
    req.on('error', reject); req.write(encoded.slice(0, 1));
  });
  await tick(); await tick();
  return { finish: () => { req.end(encoded.slice(1)); return done; } };
}

test('revocation while a request body is streaming is checked again before writing', async t => {
  const s = await setup(t), a = s.account(), grant = await s.bind(a.id), cookie = `${COOKIES.taobao}; incoming=SYNTHETIC`;
  const preview = await s.preview(grant.token, cookie);
  const pending = await pausedWrite(s, grant.token, { cookie, expectedCredentialVersion: a.credentialVersion, confirmationToken: preview.data.confirmationToken });
  const revoked = await s.request(`/v1/admin/cookie-sync/connections/${grant.connection.id}`, { method: 'DELETE', admin: true });
  assert.equal(revoked.status, 200);
  assert.equal((await pending.finish()).status, 401);
  assert.equal(s.service.store.cookie(a.id), COOKIES.taobao);
});

test('changed cookies preserve cooldown, disabled accounts stay disabled, and old collectors cannot import stale results', async t => {
  let finish, calls = 0;
  const blocked = new Promise(resolve => { finish = resolve; });
  t.after(finish);
  const s = await setup(t, { collector: async () => { calls++; await blocked; return { orders: [{ platformOrderId: 'STALE', title: 'must not import' }], shipments: [] }; } });
  const a = s.account(), grant = await s.bind(a.id);
  const running = s.service.requestSync(a.id); await tick();
  const before = s.service.store.account(a.id), saved = await s.confirm(grant, `${COOKIES.taobao}; renewed=SYNTHETIC`);
  assert.equal(saved.status, 200); assert.equal(saved.data.job, undefined);
  assert.equal(s.service.store.account(a.id).lastAttemptAt, before.lastAttemptAt);
  assert.equal(s.service.store.account(a.id).nextSyncAt, before.nextSyncAt);
  finish(); await running; await tick();
  assert.deepEqual(s.service.store.snapshot([a.id]).orders, []); assert.equal(calls, 1);
  assert.equal(s.service.jobs.latest(a.id).state, 'queued');
  assert.equal(s.service.jobs.latest(a.id).retryAt, before.lastAttemptAt + 5 * 60000);
  const disabled = s.account('jd', { enabled: false }), disabledGrant = await s.bind(disabled.id);
  const update = await s.confirm(disabledGrant, `${COOKIES.jd}; renewed=SYNTHETIC`);
  assert.equal(update.data.job.state, 'disabled'); assert.equal(calls, 1);
});

test('credential replacement preserves schedule in the same database write and the option is never accepted from HTTP', async t => {
  const s = await setup(t), a = s.account('taobao', { enabled: false }), grant = await s.bind(a.id);
  const schedule = { lastAttemptAt: TIME - 60000, nextSyncAt: TIME + 120000 };
  s.service.store.updateAccount(a.id, schedule);
  // Database observers must never see a replacement credential with a temporarily reset cooldown.
  s.service.store.db.exec(`CREATE TRIGGER assert_cookie_schedule BEFORE UPDATE ON accounts
    WHEN NEW.credential <> OLD.credential AND
      (json_extract(NEW.data,'$.lastAttemptAt') <> json_extract(OLD.data,'$.lastAttemptAt')
       OR json_extract(NEW.data,'$.nextSyncAt') <> json_extract(OLD.data,'$.nextSyncAt'))
    BEGIN SELECT RAISE(ABORT,'credential replacement changed schedule'); END;`);
  const saved = await s.confirm(grant, `${COOKIES.taobao}; atomic=SYNTHETIC`);
  assert.equal(saved.status, 200, saved.raw);
  assert.equal(s.service.store.account(a.id).lastAttemptAt, schedule.lastAttemptAt);
  assert.equal(s.service.store.account(a.id).nextSyncAt, schedule.nextSyncAt);
  s.service.store.db.exec('DROP TRIGGER assert_cookie_schedule');
  const attempted = await s.request(`/v1/admin/accounts/${a.id}`, { method: 'PATCH', admin: true,
    body: { cookie: COOKIES.taobao, preserveSyncSchedule: true } });
  assert.equal(attempted.status, 400);
  const manual = await s.request(`/v1/admin/accounts/${a.id}`, { method: 'PATCH', admin: true, body: { cookie: COOKIES.taobao } });
  assert.equal(manual.status, 200);
  assert.equal(manual.data.account.lastAttemptAt, 0);
  assert.equal(manual.data.account.nextSyncAt, TIME + 60 * 60000);
});

for (const action of ['revocation', 'family transfer', 'shutdown']) test(`deferred collection is canceled by ${action}`, async t => {
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  t.after(finish);
  const s = await setup(t, { collector: async () => { await blocked; return { orders: [], shipments: [] }; } });
  const a = s.account(), grant = await s.bind(a.id), running = s.service.requestSync(a.id); await tick();
  await s.confirm(grant, `${COOKIES.taobao}; deferred=SYNTHETIC`);
  let closing;
  if (action === 'revocation') await s.request('/v1/cookie-sync/current', { method: 'DELETE', token: grant.token });
  if (action === 'family transfer') s.service.store.saveAccount({ familyId: s.service.store.saveFamily({ name: '新角色' }).id }, a.id);
  if (action === 'shutdown') closing = s.close();
  let followups = 0;
  const request = s.service.jobs.request;
  s.service.jobs.request = (...args) => { followups++; return request(...args); };
  finish(); await running; await tick();
  if (closing) await closing;
  else assert.equal(s.service.jobs.latest(a.id), null);
  assert.equal(followups, 0);
});

test('Chrome extension CORS is restricted to the cookie sync namespace and rejects web origins', async t => {
  const s = await setup(t), a = s.account(), grant = await s.bind(a.id);
  const current = await s.request('/v1/cookie-sync/current', { token: grant.token, headers: { Origin: EXTENSION } });
  assert.equal(current.status, 200); assert.equal(current.headers.get('access-control-allow-origin'), EXTENSION);
  const preflight = await s.request('/v1/cookie-sync/current/cookie', { method: 'OPTIONS', headers: { Origin: EXTENSION } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), EXTENSION);
  for (const path of ['/v1/admin/cookie-sync/pairing', '/v1/snapshot', '/v1/setup', '/health']) {
    assert.equal((await s.request(path, { headers: { Origin: EXTENSION }, admin: true })).status, 403);
    assert.equal((await s.request(path, { method: 'OPTIONS', headers: { Origin: EXTENSION } })).status, 403);
  }
  for (const origin of ['chrome-extension://short', `chrome-extension://${'z'.repeat(32)}`, `${EXTENSION}/`, 'https://untrusted.example']) {
    assert.equal((await s.request('/v1/cookie-sync/current', { token: grant.token, headers: { Origin: origin } })).status, 403);
  }
});

test('guessing and mutation rate limits cannot be bypassed with forwarded headers or repeated no-ops', async t => {
  const s = await setup(t), a = s.account(), grant = await s.bind(a.id);
  await s.confirm(grant, COOKIES.taobao);
  for (let n = 0; n < 6; n++) {
    const result = await s.write(grant.token, `${COOKIES.taobao}; rotating=${n}`, s.service.store.account(a.id).credentialVersion);
    assert.equal(result.status, 200, result.raw);
  }
  const stored = s.service.store.cookie(a.id);
  assert.equal((await s.write(grant.token, `${COOKIES.taobao}; rotating=blocked`, s.service.store.account(a.id).credentialVersion)).status, 429);
  assert.equal(s.service.store.cookie(a.id), stored);
  assert.equal((await s.write(grant.token, stored, s.service.store.account(a.id).credentialVersion)).status, 200);
  for (let n = 0; n < 9; n++) {
    assert.equal((await s.request('/v1/cookie-sync/pairing/preview', { method: 'POST', body: { code: 'WRONG' }, headers: { 'X-Forwarded-For': `192.0.2.${n}` } })).status, 400);
  }
  assert.equal((await s.redeem('WRONG')).status, 429);
});

test('grant, pin and revocation survive restarts without persisting raw cookies, codes or tokens', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-cookie-sync-'));
  const filename = join(directory, 'synthetic.db');
  const services = [];
  t.after(async () => { for (const service of services) await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const s = await setup(t, { filename }), a = s.account(), pairing = await s.pair(a.id), redeemed = await s.redeem(pairing.code), grant = redeemed.data;
  services.push(s);
  await s.confirm(grant, COOKIES.taobao); await s.close();
  const next = await setup(t, { filename });
  services.push(next);
  assert.equal((await next.request('/v1/cookie-sync/current', { token: grant.token })).data.connection.identityBound, true);
  assert.equal((await next.write(grant.token, `${COOKIES.taobao}; restarted=yes`, a.credentialVersion)).status, 200);
  await next.request('/v1/cookie-sync/current', { method: 'DELETE', token: grant.token }); await next.close();
  const restarted = await setup(t, { filename });
  services.push(restarted);
  assert.equal((await restarted.request('/v1/cookie-sync/current', { token: grant.token })).status, 401);
  await restarted.close();
  for (const file of readdirSync(directory)) {
    const content = readFileSync(join(directory, file));
    for (const forbidden of [COOKIES.taobao, 'SYNTHETIC-TB-LOGIN', pairing.code, grant.token]) assert.equal(content.includes(Buffer.from(forbidden)), false, `${file} exposes secret`);
  }
});

test('expired pairing cleanup and bounded revoked history preserve active connections', async t => {
  const s = await setup(t), a = s.account(), grant = await s.bind(a.id), pair = await s.pair(a.id);
  const db = s.service.store.db;
  const insert = db.prepare(`INSERT INTO cookie_sync_connections(id,token_hash,account_id,family_id,platform,name,created_at,expires_at,revoked_at)
    VALUES(?,?,?,'','taobao','expired synthetic',?,?,?)`);
  s.service.store.transaction(() => {
    for (let n = 0; n < 1010; n++) insert.run(`dead-${n}`, `dead-hash-${n}`, a.id, TIME - n, TIME + 86400000, TIME);
  });
  s.advance(10 * 60000);
  assert.equal((await s.request('/v1/cookie-sync/current', { token: grant.token })).status, 200);
  assert.equal(db.prepare('SELECT count(*) AS count FROM cookie_sync_connections WHERE revoked_at IS NOT NULL').get().count, 1000);
  assert.equal(db.prepare('SELECT count(*) AS count FROM cookie_sync_pairing').get().count, 0);
  assert.equal((await s.redeem(pair.code)).status, 400);
});

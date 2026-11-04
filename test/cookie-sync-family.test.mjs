import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { hash, readKey } from '../src/security.mjs';

const ADMIN = 'family-cookie-test-admin-at-least-32-characters';
const KEY = 'a9'.repeat(32), TIME = 1793350000000;
const PREFIX = '/v1/cookie-sync/families';
const COOKIES = { taobao: 'unb=12345678; cookie2=SYNTHETIC-TB', pdd: 'pdd_user_id=23456789; PDDAccessToken=SYNTHETIC-PDD', jd: 'pin=synthetic-jd; thor=SYNTHETIC-JD' };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, options = {}) {
  let now = TIME, stopped = false;
  const service = createService({ encryptionKey: KEY, adminToken: ADMIN, baseUrl: 'https://pickup.example', now: () => now,
    scheduler: false, collector: async () => ({ orders: [], shipments: [] }), ...options });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const close = async () => { if (!stopped) { stopped = true; await service.close(); } };
  t.after(close);
  const request = async (path, { method = 'GET', body, token, admin = false, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(admin ? { 'X-Admin-Token': ADMIN } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text(); return { status: response.status, data: raw ? JSON.parse(raw) : null, raw, headers: response.headers };
  };
  const family = name => service.store.saveFamily({ name });
  const account = (familyId, platform = 'taobao') => service.store.saveAccount({ familyId, platform, label: `${platform}合成账号`, cookie: COOKIES[platform] });
  const pair = async familyId => {
    const response = await request('/v1/admin/cookie-sync/families/pairing', { method: 'POST', admin: true, body: { familyId } });
    assert.equal(response.status, 201, response.raw); return response.data;
  };
  const redeem = code => request(`${PREFIX}/connections`, { method: 'POST', body: { code, name: '角色合成浏览器' } });
  const bind = async familyId => { const result = await redeem((await pair(familyId)).code); assert.equal(result.status, 201, result.raw); return result.data; };
  const current = token => request(`${PREFIX}/current`, { token });
  const selected = (token, id) => request(`${PREFIX}/current/accounts/${id}`, { token });
  const preview = (token, account, cookie = COOKIES[account.platform]) => request(`${PREFIX}/current/accounts/${account.id}/preview`, { method: 'POST', token, body: { cookie } });
  const write = (token, account, cookie = COOKIES[account.platform], confirmationToken, version = service.store.account(account.id).credentialVersion) =>
    request(`${PREFIX}/current/accounts/${account.id}/cookie`, { method: 'POST', token, body: { cookie, expectedCredentialVersion: version, ...(confirmationToken ? { confirmationToken } : {}) } });
  const confirm = async (token, account, cookie = COOKIES[account.platform]) => {
    const result = await preview(token, account, cookie); assert.equal(result.status, 200, result.raw);
    return write(token, account, cookie, result.data.confirmationToken, result.data.account.credentialVersion);
  };
  const legacy = async accountId => {
    const pair = await request('/v1/admin/cookie-sync/pairing', { method: 'POST', admin: true, body: { accountId } });
    const result = await request('/v1/cookie-sync/connections', { method: 'POST', body: { code: pair.data.code, name: '旧单账号浏览器' } });
    assert.equal(result.status, 201, result.raw); return result.data;
  };
  return { service, base, close, request, family, account, pair, redeem, bind, current, selected, preview, write, confirm, legacy, advance: ms => { now += ms; } };
}

test('one family pairing lists all three platforms and later accounts without creating or confirming children', async t => {
  const s = await setup(t), own = s.family('合成家人'), foreign = s.family('其他家人');
  const accounts = Object.keys(COOKIES).map(platform => s.account(own.id, platform)), other = s.account(foreign.id);
  const pair = await s.pair(own.id); assert.match(pair.code, /^CF-[A-Za-z0-9_-]{43}$/);
  const viewed = await s.request(`${PREFIX}/pairing/preview`, { method: 'POST', body: { code: pair.code } });
  assert.equal(viewed.status, 200); assert.deepEqual(viewed.data.family, { ...own }); assert.equal(viewed.data.accounts.length, 3);
  assert.ok(viewed.data.accounts.every(item => item.connection === null)); assert.ok(!viewed.raw.includes(pair.code));
  const redeemed = await s.redeem(pair.code), group = redeemed.data;
  assert.equal(redeemed.status, 201); assert.match(group.token, /^cfg_[A-Za-z0-9_-]{43}$/);
  assert.equal(group.connection.familyId, own.id); assert.deepEqual(group.accounts, viewed.data.accounts);
  assert.equal(s.service.store.db.prepare('SELECT count(*) AS n FROM cookie_sync_connections').get().n, 0);
  for (const account of accounts) {
    assert.equal((await s.selected(group.token, account.id)).data.connection, null);
    assert.equal((await s.write(group.token, account)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
    const preview = await s.preview(group.token, account);
    assert.equal(preview.status, 200); assert.equal(preview.data.connection.accountId, account.id); assert.equal(preview.data.connection.identityBound, false);
    assert.equal((await s.write(group.token, account)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
    const saved = await s.write(group.token, account, COOKIES[account.platform], preview.data.confirmationToken);
    assert.equal(saved.status, 200, saved.raw); assert.equal(saved.data.changed, false); assert.equal(saved.data.connection.identityBound, true);
  }
  const later = s.account(own.id, 'jd');
  const all = await s.current(group.token);
  assert.equal(all.data.accounts.length, 4); assert.equal(all.data.accounts.find(item => item.account.id === later.id).connection, null);
  assert.ok(!all.raw.includes(other.id)); assert.ok(!all.raw.includes(group.token)); assert.ok(!all.raw.includes('token_hash'));
  for (const cookie of Object.values(COOKIES)) assert.ok(!all.raw.includes(cookie));
  assert.equal((await s.selected(group.token, other.id)).status, 403);
  assert.equal((await s.preview(group.token, other)).status, 403);
  assert.equal((await s.write(group.token, other)).status, 403);
});

test('empty roles can pair and stable role renaming does not invalidate the group', async t => {
  const s = await setup(t), family = s.family('空角色'), group = await s.bind(family.id);
  assert.deepEqual(group.accounts, []);
  s.service.store.saveFamily({ name: '改名角色' }, family.id);
  const added = s.account(family.id);
  const result = await s.current(group.token);
  assert.equal(result.data.family.name, '改名角色'); assert.equal(result.data.accounts[0].account.id, added.id);
  assert.equal(result.data.accounts[0].connection, null);
});

test('family pairs are single-use, expire, share guessing limits, and never accept legacy pairing codes', async t => {
  const s = await setup(t), family = s.family('合成角色');
  const first = await s.pair(family.id), latest = await s.pair(family.id);
  assert.equal((await s.redeem(first.code)).status, 400);
  const responses = await Promise.all([s.redeem(latest.code), s.redeem(latest.code)]);
  assert.deepEqual(responses.map(item => item.status).sort(), [201, 400]);
  const expired = await s.pair(family.id); s.advance(10 * 60000);
  assert.equal((await s.redeem(expired.code)).status, 400);
  assert.equal((await s.request(`${PREFIX}/pairing/preview`, { method: 'POST', body: { code: `CS-${'a'.repeat(43)}` } })).status, 400);
  for (let n = 0; n < 8; n++) assert.equal((await s.request('/v1/cookie-sync/pairing/preview', { method: 'POST', body: { code: 'WRONG' }, headers: { 'X-Forwarded-For': `192.0.2.${n}` } })).status, 400);
  assert.equal((await s.redeem('WRONG')).status, 429);
});

test('family replacement, whole-group revocation and expiry invalidate children while legacy grants stay independent', async t => {
  const s = await setup(t), family = s.family('合成角色'), a = s.account(family.id), b = s.account(family.id, 'pdd');
  const old = await s.legacy(a.id), group = await s.bind(family.id);
  await s.confirm(group.token, a); await s.confirm(group.token, b);
  assert.equal((await s.request('/v1/cookie-sync/current', { token: old.token })).status, 200);
  const replacement = await s.bind(family.id);
  assert.equal((await s.current(group.token)).status, 401); assert.ok(replacement.accounts.every(item => item.connection === null));
  assert.equal((await s.request('/v1/cookie-sync/current', { token: old.token })).status, 200);
  await s.confirm(replacement.token, a);
  const listed = await s.request(`/v1/admin/cookie-sync/families/connections?familyId=${family.id}`, { admin: true });
  assert.equal(listed.status, 200); assert.equal(listed.data.connections.length, 2); assert.ok(!listed.raw.includes('token_hash'));
  assert.equal((await s.request(`/v1/admin/cookie-sync/families/connections/${replacement.connection.id}`, { method: 'DELETE', admin: true })).status, 200);
  assert.equal((await s.write(replacement.token, a)).status, 401);
  const last = await s.bind(family.id); s.advance(90 * 86400000);
  assert.equal((await s.current(last.token)).status, 401);
});

test('family, legacy, admin and device tokens cannot cross their API scopes', async t => {
  const s = await setup(t), family = s.family('合成角色'), account = s.account(family.id), group = await s.bind(family.id), old = await s.legacy(account.id);
  const device = s.service.store.redeem(s.service.store.createPairing([account.id]).code, '合成设备');
  for (const path of ['/v1/cookie-sync/current', '/v1/accounts', '/v1/snapshot', '/v1/admin/accounts', '/v1/admin/cookie-sync/families/connections?familyId=' + family.id]) {
    assert.equal((await s.request(path, { token: group.token })).status, 401, path);
  }
  for (const token of [old.token, device.token, ADMIN, 'fake']) {
    assert.equal((await s.current(token)).status, 401);
    assert.equal((await s.preview(token, account)).status, 401);
    assert.equal((await s.write(token, account)).status, 401);
  }
  assert.equal((await s.request('/v1/cookie-sync/current/preview', { method: 'POST', token: group.token, body: { cookie: COOKIES.taobao } })).status, 401);
  const preview = await s.preview(group.token, account);
  const child = s.service.store.db.prepare('SELECT * FROM cookie_sync_connections WHERE id=?').get(preview.data.connection.id);
  assert.ok(child.token_hash); assert.equal(child.family_connection_id, group.connection.id);
  assert.equal((await s.request('/v1/admin/cookie-sync/families/pairing', { method: 'POST', token: group.token, body: { familyId: family.id } })).status, 401);
  assert.equal((await s.request(`${PREFIX}/current/accounts/${account.id}/preview`, { method: 'POST', token: group.token,
    body: { cookie: COOKIES.taobao, familyId: family.id } })).status, 400);
});

test('transfer away and back returns null until explicit new preview; old confirmations and legacy-replaced children never revive', async t => {
  const s = await setup(t), family = s.family('原角色'), foreign = s.family('新角色'), account = s.account(family.id), group = await s.bind(family.id);
  const initial = await s.preview(group.token, account); await s.write(group.token, account, COOKIES.taobao, initial.data.confirmationToken);
  s.service.store.saveAccount({ familyId: foreign.id }, account.id);
  assert.equal((await s.current(group.token)).data.accounts.length, 0);
  assert.equal((await s.selected(group.token, account.id)).status, 403);
  s.service.store.saveAccount({ familyId: family.id }, account.id);
  assert.equal((await s.selected(group.token, account.id)).data.connection, null);
  assert.equal((await s.write(group.token, account)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
  const next = await s.preview(group.token, account);
  assert.notEqual(next.data.connection.id, initial.data.connection.id);
  assert.equal((await s.write(group.token, account, COOKIES.taobao, initial.data.confirmationToken)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
  assert.equal((await s.write(group.token, account, COOKIES.taobao, next.data.confirmationToken)).status, 200);
  const old = await s.legacy(account.id);
  assert.equal((await s.request('/v1/cookie-sync/current', { token: old.token })).status, 200);
  assert.equal((await s.selected(group.token, account.id)).data.connection, null);
  assert.equal((await s.write(group.token, account)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
  assert.equal((await s.confirm(group.token, account)).status, 200);
  assert.equal((await s.request('/v1/cookie-sync/current', { token: old.token })).status, 200);
});

async function pausedPath(s, token, path, body) {
  const encoded = JSON.stringify(body);
  const received = new Promise(resolve => s.service.server.once('request', req => req.once('data', resolve)));
  let req;
  const done = new Promise((resolve, reject) => {
    req = httpRequest(`${s.base}${path}`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded),
    } }, response => {
      let data = ''; response.setEncoding('utf8'); response.on('data', value => { data += value; });
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(data) }));
    });
    req.on('error', reject); req.write(encoded.slice(0, 1));
  });
  await received;
  return () => { req.end(encoded.slice(1)); return done; };
}
const paused = (s, token, account, action, body) => pausedPath(s, token, `${PREFIX}/current/accounts/${account.id}/${action}`, body);

for (const change of ['revoke', 'replace-child', 'transfer']) test(`streaming family upload rechecks parent, membership and original child after ${change}`, async t => {
  const s = await setup(t), family = s.family('原角色'), other = s.family('别的角色'), account = s.account(family.id), group = await s.bind(family.id);
  await s.confirm(group.token, account);
  const finish = await paused(s, group.token, account, 'cookie', { cookie: `${COOKIES.taobao}; stale=yes`, expectedCredentialVersion: account.credentialVersion });
  if (change === 'revoke') await s.request(`${PREFIX}/current`, { method: 'DELETE', token: group.token });
  else if (change === 'replace-child') { await s.legacy(account.id); await s.confirm(group.token, account); }
  else { s.service.store.saveAccount({ familyId: other.id }, account.id); s.service.store.saveAccount({ familyId: family.id }, account.id); await s.confirm(group.token, account); }
  assert.equal((await finish()).status, 401); assert.equal(s.service.store.cookie(account.id), COOKIES.taobao);
});

test('first streaming preview cannot create a child after a transfer away and back', async t => {
  const s = await setup(t), family = s.family('原角色'), other = s.family('别的角色'), account = s.account(family.id), group = await s.bind(family.id);
  const finish = await paused(s, group.token, account, 'preview', { cookie: COOKIES.taobao });
  s.service.store.saveAccount({ familyId: other.id }, account.id); s.service.store.saveAccount({ familyId: family.id }, account.id);
  assert.equal((await finish()).data.error.code, 'COOKIE_CREDENTIAL_CONFLICT');
  assert.equal((await s.selected(group.token, account.id)).data.connection, null);
});

test('family uploads reuse identity, confirmation digest, credential CAS, cooldown and write throttling', async t => {
  const s = await setup(t), family = s.family('合成角色'), account = s.account(family.id), group = await s.bind(family.id);
  const bad = await s.preview(group.token, account, COOKIES.taobao.replace('12345678', '99999999'));
  assert.equal(bad.data.error.code, 'COOKIE_IDENTITY_MISMATCH'); assert.equal((await s.selected(group.token, account.id)).data.connection, null);
  const preview = await s.preview(group.token, account);
  assert.equal((await s.write(group.token, account, `${COOKIES.taobao}; changed=yes`, preview.data.confirmationToken)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
  assert.equal((await s.write(group.token, account, COOKIES.taobao, preview.data.confirmationToken)).status, 200);
  s.service.store.updateAccount(account.id, { lastAttemptAt: TIME, nextSyncAt: TIME + 120000 });
  const first = await s.write(group.token, account, `${COOKIES.taobao}; changed=1`);
  assert.equal(first.status, 200); assert.equal(first.data.job.state, 'queued'); assert.equal(first.data.job.retryAt, TIME + 5 * 60000);
  assert.equal(s.service.store.account(account.id).nextSyncAt, TIME + 120000);
  assert.equal((await s.write(group.token, account, `${COOKIES.taobao}; stale=yes`, undefined, account.credentialVersion)).data.error.code, 'COOKIE_CREDENTIAL_CONFLICT');
  for (let n = 2; n <= 6; n++) assert.equal((await s.write(group.token, account, `${COOKIES.taobao}; changed=${n}`)).status, 200);
  assert.equal((await s.write(group.token, account, `${COOKIES.taobao}; blocked=yes`)).status, 429);
  assert.equal(s.service.store.cookie(account.id), `${COOKIES.taobao}; changed=6`);
});

test('family revocation cancels the deferred post-collector request without changing unrelated scheduler behavior', async t => {
  let finish; const blocked = new Promise(resolve => { finish = resolve; }); t.after(finish);
  const s = await setup(t, { collector: async () => { await blocked; return { orders: [], shipments: [] }; } });
  const family = s.family('合成角色'), account = s.account(family.id), group = await s.bind(family.id), running = s.service.requestSync(account.id);
  await tick(); await s.confirm(group.token, account, `${COOKIES.taobao}; renewed=yes`);
  await s.request(`${PREFIX}/current`, { method: 'DELETE', token: group.token });
  let requested = 0; const original = s.service.jobs.request;
  s.service.jobs.request = (...args) => { requested++; return original(...args); };
  finish(); await running; await tick(); assert.equal(requested, 0);
});

test('3.1.18 schema migrates in place, legacy secrets stay valid, and family state/revocation persist without plaintext secrets', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'cookie-family-migration-')), filename = join(directory, 'synthetic.db'), opened = [];
  t.after(async () => { for (const s of opened) await s.close(); rmSync(directory, { recursive: true, force: true }); });
  const store = new Store({ filename, key: readKey(KEY), now: () => TIME });
  const family = store.saveFamily({ name: '迁移角色' }), account = store.saveAccount({ familyId: family.id, platform: 'taobao', label: '旧账号', cookie: COOKIES.taobao });
  store.db.exec(`CREATE TABLE cookie_sync_pairing (code_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),family_id TEXT NOT NULL,
    credential_version INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE cookie_sync_connections (id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id),
    family_id TEXT NOT NULL,platform TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,
    last_sync_at INTEGER NOT NULL DEFAULT 0,identity_hash TEXT NOT NULL DEFAULT '',identity_hint TEXT NOT NULL DEFAULT '',
    confirmation_hash TEXT NOT NULL DEFAULT '',confirmation_digest TEXT NOT NULL DEFAULT '',confirmation_version INTEGER NOT NULL DEFAULT 0,
    confirmation_expires_at INTEGER NOT NULL DEFAULT 0);`);
  const legacyToken = `csg_${'t'.repeat(43)}`, legacyCode = `CS-${'c'.repeat(43)}`;
  store.db.prepare(`INSERT INTO cookie_sync_connections(id,token_hash,account_id,family_id,platform,name,created_at,expires_at)
    VALUES('legacy',?,?,?,'taobao','3.1.18 browser',?,?)`).run(hash(legacyToken), account.id, family.id, TIME, TIME + 90 * 86400000);
  store.db.prepare('INSERT INTO cookie_sync_pairing VALUES(?,?,?,?,?,?)').run(hash(legacyCode), account.id, family.id, account.credentialVersion, TIME, TIME + 600000);
  const encrypted = store.db.prepare('SELECT credential FROM accounts WHERE id=?').get(account.id).credential; store.close();
  const s = await setup(t, { filename }); opened.push(s);
  assert.equal((await s.request('/v1/cookie-sync/current', { token: legacyToken })).status, 200);
  assert.equal((await s.request('/v1/cookie-sync/pairing/preview', { method: 'POST', body: { code: legacyCode } })).status, 200);
  assert.equal(s.service.store.db.prepare('SELECT credential FROM accounts WHERE id=?').get(account.id).credential, encrypted);
  assert.equal(s.service.store.db.prepare('SELECT family_connection_id FROM cookie_sync_connections WHERE id=?').get('legacy').family_connection_id, null);
  const pair = await s.pair(family.id), group = (await s.redeem(pair.code)).data;
  await s.confirm(group.token, account); await s.close();
  const next = await setup(t, { filename }); opened.push(next);
  assert.equal((await next.selected(group.token, account.id)).data.connection.identityBound, true);
  assert.equal((await next.request('/v1/cookie-sync/current', { token: legacyToken })).status, 200);
  await next.request(`${PREFIX}/current`, { method: 'DELETE', token: group.token }); await next.close();
  const restarted = await setup(t, { filename }); opened.push(restarted);
  assert.equal((await restarted.current(group.token)).status, 401); await restarted.close();
  for (const file of readdirSync(directory)) {
    const bytes = readFileSync(join(directory, file));
    for (const secret of [group.token, pair.code, legacyToken, legacyCode, COOKIES.taobao]) assert.equal(bytes.includes(Buffer.from(secret)), false, file);
  }
});

async function reverseRequest(s, platforms = ['taobao', 'pdd', 'jd']) {
  const result = await s.request(`${PREFIX}/requests`, { method: 'POST', body: { name: '先登录的合成浏览器', platforms } });
  assert.equal(result.status, 201, result.raw); return result.data;
}
const pollRequest = (s, request, pollToken = request.pollToken) => s.request(`${PREFIX}/requests/poll`, {
  method: 'POST', body: { requestId: request.requestId, pollToken },
});
const approveRequest = (s, request, familyId, options = {}) => s.request(`/v1/admin/cookie-sync/families/requests/${request.code}/approve`, {
  method: 'POST', admin: true, body: { familyId }, ...options,
});
const newPreview = (s, token, platform) => s.request(`${PREFIX}/current/platforms/${platform}/preview`, {
  method: 'POST', token, body: { cookie: COOKIES[platform] },
});
const newWrite = (s, token, platform, proof, extra = {}) => s.request(`${PREFIX}/current/platforms/${platform}/cookie`, {
  method: 'POST', token, body: { cookie: COOKIES[platform], expectedCredentialVersion: 0, confirmationToken: proof, ...extra },
});

test('browser-initiated request needs admin approval and its own polling secret, then mints a family grant exactly once', async t => {
  const s = await setup(t), family = s.family('管理员仅创建角色'), request = await reverseRequest(s);
  assert.match(request.code, /^CR-[A-Za-z0-9_-]{43}$/); assert.match(request.pollToken, /^cpr_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual((await pollRequest(s, request)).data, { status: 'pending', expiresAt: request.expiresAt });
  const detail = await s.request(`/v1/admin/cookie-sync/families/requests/${request.code}`, { admin: true });
  assert.equal(detail.status, 200); assert.equal(detail.data.status, 'pending'); assert.deepEqual(detail.data.platforms, ['taobao', 'pdd', 'jd']);
  assert.ok(!detail.raw.includes(request.pollToken)); assert.ok(!detail.raw.includes(request.code));
  assert.equal((await approveRequest(s, request, family.id, { admin: false })).status, 401);
  assert.equal((await approveRequest(s, request, family.id)).status, 200);
  assert.equal((await approveRequest(s, request, family.id)).status, 409);
  assert.equal(s.service.store.db.prepare('SELECT count(*) AS n FROM cookie_sync_family_connections').get().n, 0);
  const row = s.service.store.db.prepare('SELECT * FROM cookie_sync_family_requests').get();
  for (const raw of [request.pollToken, request.code]) assert.ok(!JSON.stringify(row).includes(raw));
  assert.equal((await pollRequest(s, request, request.code)).status, 400);
  const results = await Promise.all([pollRequest(s, request), pollRequest(s, request)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  const accepted = results.find(result => result.status === 200).data;
  assert.equal(accepted.status, 'approved'); assert.match(accepted.token, /^cfg_[A-Za-z0-9_-]{43}$/);
  assert.equal(accepted.family.id, family.id); assert.deepEqual(accepted.accounts, []);
  assert.equal((await s.current(accepted.token)).status, 200); assert.equal(s.service.store.accounts().length, 0);
});

test('reverse requests expire, reject credential substitutions and unsupported metadata, and remain bounded', async t => {
  const s = await setup(t), family = s.family('合成角色'), account = s.account(family.id), legacy = await s.legacy(account.id);
  const device = s.service.store.redeem(s.service.store.createPairing([account.id]).code, '合成设备');
  const request = await reverseRequest(s, ['taobao']);
  for (const token of [ADMIN, device.token, legacy.token, `cpr_${'x'.repeat(43)}`]) {
    assert.equal((await pollRequest(s, request, token)).status, 400);
    assert.equal((await s.request(`/v1/admin/cookie-sync/families/requests/${request.code}`, { token })).status, 401);
    assert.equal((await approveRequest(s, request, family.id, { admin: false, token })).status, 401);
  }
  const bad = await s.request(`${PREFIX}/requests`, { method: 'POST', body: { name: '无效', platforms: ['jd'], cookie: COOKIES.jd } });
  assert.equal(bad.status, 400);
  for (const platforms of [[], ['taobao', 'taobao'], ['unsupported']]) {
    assert.equal((await s.request(`${PREFIX}/requests`, { method: 'POST', body: { name: '无效', platforms } })).status, 400);
  }
  s.advance(600000);
  assert.equal((await approveRequest(s, request, family.id)).status, 400);
  assert.equal((await pollRequest(s, request)).status, 400);
  assert.equal(s.service.store.db.prepare('SELECT count(*) AS n FROM cookie_sync_family_requests').get().n, 0);
  for (let n = 0; n < 10; n++) await reverseRequest(s, ['jd']);
  assert.equal((await s.request(`${PREFIX}/requests`, { method: 'POST', body: { name: '限频', platforms: ['jd'] }, headers: { 'X-Forwarded-For': '192.0.2.99' } })).status, 429);
});

test('missing-platform previews store no cookies or accounts; explicit confirmation creates and binds three encrypted accounts', async t => {
  let collected = 0;
  const s = await setup(t, { collector: async () => { collected++; return { orders: [], shipments: [] }; } });
  const family = s.family('从浏览器初始化'), group = await s.bind(family.id), previews = {};
  for (const platform of Object.keys(COOKIES)) {
    assert.equal((await newWrite(s, group.token, platform, 'not-confirmed')).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
    const result = await newPreview(s, group.token, platform); assert.equal(result.status, 200, result.raw);
    assert.equal(result.data.newAccount, true); assert.equal(result.data.platform, platform); previews[platform] = result.data;
  }
  assert.deepEqual(s.service.store.accounts(), []); assert.equal(collected, 0);
  const proofs = JSON.stringify(s.service.store.db.prepare('SELECT * FROM cookie_sync_family_creation').all());
  for (const [platform, cookie] of Object.entries(COOKIES)) {
    assert.ok(!proofs.includes(cookie)); assert.ok(!proofs.includes(previews[platform].confirmationToken));
    const saved = await newWrite(s, group.token, platform, previews[platform].confirmationToken);
    assert.equal(saved.status, 200, saved.raw); assert.equal(saved.data.changed, true);
    assert.equal(saved.data.account.platform, platform); assert.equal(saved.data.account.familyId, family.id);
    assert.equal(saved.data.account.credentialVersion, 1); assert.equal(saved.data.connection.identityBound, true);
    assert.match(saved.data.account.label, /从浏览器初始化/);
    assert.equal(s.service.store.cookie(saved.data.account.id), cookie);
    assert.ok(!s.service.store.db.prepare('SELECT credential FROM accounts WHERE id=?').get(saved.data.account.id).credential.includes('SYNTHETIC'));
    assert.equal((await newWrite(s, group.token, platform, previews[platform].confirmationToken)).data.error.code, 'COOKIE_PLATFORM_EXISTS');
  }
  await Promise.all([...s.service.running.values()]); assert.equal(collected, 3);
  assert.equal(s.service.store.accounts().length, 3);
  assert.ok((await s.current(group.token)).data.accounts.every(item => item.connection.identityBound));
  assert.equal(s.service.store.db.prepare('SELECT count(*) AS n FROM cookie_sync_family_creation').get().n, 0);
});

test('new-platform proofs bind cookie, platform and parent, expire, and are cleared by revocation', async t => {
  const s = await setup(t), family = s.family('第一角色'), other = s.family('第二角色'), group = await s.bind(family.id), second = await s.bind(other.id);
  const proof = (await newPreview(s, group.token, 'taobao')).data.confirmationToken;
  assert.equal((await newWrite(s, second.token, 'taobao', proof)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
  assert.equal((await newWrite(s, group.token, 'jd', proof)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
  assert.equal((await newWrite(s, group.token, 'taobao', proof, { cookie: `${COOKIES.taobao}; changed=yes` })).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
  assert.equal((await newWrite(s, group.token, 'taobao', proof, { expectedCredentialVersion: 1 })).status, 400);
  s.advance(300000);
  assert.equal((await newWrite(s, group.token, 'taobao', proof)).data.error.code, 'COOKIE_CONFIRMATION_REQUIRED');
  const fresh = (await newPreview(s, group.token, 'taobao')).data.confirmationToken;
  await s.request(`${PREFIX}/current`, { method: 'DELETE', token: group.token });
  assert.equal((await newWrite(s, group.token, 'taobao', fresh)).status, 401);
  assert.deepEqual(s.service.store.accounts(), []);
  assert.equal(s.service.store.db.prepare('SELECT count(*) AS n FROM cookie_sync_family_creation').get().n, 0);
});

test('new-platform concurrent creation and accounts appearing after preview never overwrite a selected or unrelated account', async t => {
  const s = await setup(t), family = s.family('原角色'), other = s.family('其他角色'), group = await s.bind(family.id);
  const foreign = s.account(other.id, 'jd'), proof = (await newPreview(s, group.token, 'jd')).data.confirmationToken;
  const results = await Promise.all([newWrite(s, group.token, 'jd', proof), newWrite(s, group.token, 'jd', proof)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(s.service.store.cookie(foreign.id), COOKIES.jd);
  assert.equal(s.service.store.accounts().filter(account => account.familyId === family.id && account.platform === 'jd').length, 1);
  const pending = (await newPreview(s, group.token, 'pdd')).data.confirmationToken;
  const appeared = s.account(family.id, 'pdd');
  assert.equal((await newWrite(s, group.token, 'pdd', pending)).data.error.code, 'COOKIE_PLATFORM_EXISTS');
  assert.equal(s.service.store.account(appeared.id).credentialVersion, 1);
});

for (const change of ['revocation', 'existing account', 'expired proof']) test(`streaming new-platform creation rechecks ${change}`, async t => {
  const s = await setup(t), family = s.family('合成角色'), group = await s.bind(family.id);
  const proof = (await newPreview(s, group.token, 'taobao')).data.confirmationToken;
  const finish = await pausedPath(s, group.token, `${PREFIX}/current/platforms/taobao/cookie`, {
    cookie: COOKIES.taobao, expectedCredentialVersion: 0, confirmationToken: proof,
  });
  if (change === 'revocation') await s.request(`${PREFIX}/current`, { method: 'DELETE', token: group.token });
  if (change === 'existing account') s.account(family.id);
  if (change === 'expired proof') s.advance(300000);
  assert.equal((await finish()).status, change === 'revocation' ? 401 : 409);
  assert.equal(s.service.store.accounts().length, change === 'existing account' ? 1 : 0);
});

test('account creation, child binding and proof consumption roll back together on a database failure', async t => {
  const s = await setup(t), family = s.family('原子创建角色'), group = await s.bind(family.id);
  const proof = (await newPreview(s, group.token, 'taobao')).data.confirmationToken;
  const revision = s.service.store.db.prepare('SELECT revision FROM meta').get().revision;
  s.service.store.db.exec(`CREATE TRIGGER synthetic_creation_failure AFTER DELETE ON cookie_sync_family_creation
    BEGIN SELECT RAISE(ABORT,'synthetic failure after consuming proof'); END;`);
  const failed = await newWrite(s, group.token, 'taobao', proof);
  assert.equal(failed.status, 500); assert.equal(failed.data.error.code, 'INTERNAL_ERROR');
  assert.deepEqual(s.service.store.accounts(), []);
  assert.equal(s.service.store.db.prepare('SELECT count(*) AS n FROM cookie_sync_connections').get().n, 0);
  assert.equal(s.service.store.db.prepare('SELECT count(*) AS n FROM cookie_sync_family_creation').get().n, 1);
  assert.equal(s.service.store.db.prepare('SELECT revision FROM meta').get().revision, revision);
  s.service.store.db.exec('DROP TRIGGER synthetic_creation_failure');
  assert.equal((await newWrite(s, group.token, 'taobao', proof)).status, 200);
  assert.throws(() => s.service.store.saveAccount({ platform: 'jd', label: '内部标志', cookie: COOKIES.jd }, undefined, false, { inTransaction: true }), /active transaction/);
  assert.equal((await s.request('/v1/admin/accounts', { method: 'POST', admin: true,
    body: { platform: 'jd', label: '外部标志', cookie: COOKIES.jd, inTransaction: true } })).status, 400);
});

test('role history cleanup cascades only old child data and preserves active grants', async t => {
  const s = await setup(t), family = s.family('合成角色'), account = s.account(family.id), group = await s.bind(family.id);
  await s.confirm(group.token, account);
  const insert = s.service.store.db.prepare('INSERT INTO cookie_sync_family_connections VALUES(?,?,?,?,?,?,?)');
  s.service.store.transaction(() => {
    for (let n = 0; n < 1010; n++) insert.run(`dead-family-${n}`, `dead-hash-${n}`, family.id, '历史', TIME - n, TIME + 86400000, TIME);
  });
  assert.equal((await s.current(group.token)).status, 200);
  assert.equal(s.service.store.db.prepare('SELECT count(*) AS n FROM cookie_sync_family_connections WHERE revoked_at IS NOT NULL').get().n, 1000);
  assert.equal((await s.selected(group.token, account.id)).data.connection.identityBound, true);
  s.advance(60000);
  for (let n = 0; n < 240; n++) assert.equal((await s.current(group.token)).status, 200);
  assert.equal((await s.current(group.token)).status, 429);
});

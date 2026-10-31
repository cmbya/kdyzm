import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';
import { Store, stableId } from '../src/store.mjs';
import { encryptCookie, hash, readKey } from '../src/security.mjs';

const ADMIN = 'family-tests-admin-secret-at-least-32-characters';
const KEY = 'cd'.repeat(32);
const TIME = 1793350000000;
const parcel = id => ({ orders: [{ platformOrderId: id, title: id, orderDate: TIME - 86400000 }],
  shipments: [{ platformOrderId: id, waybillNo: `TRACK-${id}`, carrier: '中通', status: 'arrived', pickupCode: 'A-1234' }] });

async function setup(t, options = {}) {
  let now = TIME;
  const service = createService({ encryptionKey: KEY, adminToken: ADMIN, baseUrl: 'https://pickup.example',
    now: () => now, scheduler: false, collector: async () => parcel('refresh-result'), ...options });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, { method = 'GET', body, token, admin = false, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(admin ? { 'x-admin-token': ADMIN } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    return { status: response.status, headers: response.headers, raw,
      data: raw && response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(raw) : null };
  };
  const family = async name => {
    const result = await request('/v1/admin/families', { method: 'POST', admin: true, body: { name } });
    assert.equal(result.status, 201); return result.data.family;
  };
  const account = (familyId = '', id = 'account') => service.store.saveAccount({ platform: 'taobao', label: id,
    cookie: 'SYNTHETIC-COOKIE-NEVER-RETURN', familyId }, id, true);
  const bind = familyIds => service.store.redeem(service.store.createPairing({ familyIds }).code, 'family test device');
  return { service, request, family, account, bind, advance: ms => { now += ms; } };
}

test('family groups can be authorized while empty and include future accounts without exposing pending or other families', async t => {
  const { service, request, family, account, bind } = await setup(t);
  const lin = await family('小林'), yue = await family('阿悦');
  assert.ok(!(await request('/')).raw.includes('__SERVER_VERSION__'));
  assert.equal((await request('/v1/admin/families')).status, 401);
  assert.equal((await request('/v1/admin/families', { admin: true })).data.families.length, 2);
  const pair = await request('/v1/pairing-codes', { method: 'POST', admin: true, body: { familyIds: [lin.id] } });
  assert.equal(pair.status, 201); assert.deepEqual(pair.data.accountIds, []);
  const preview = await request('/v1/pairing-codes/preview', { method: 'POST', body: { code: pair.data.code } });
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('cache-control'), 'no-store');
  assert.equal(preview.data.service.name, '取件助手');
  assert.deepEqual(preview.data.scope.families, [{ ...lin, accountCount: 0 }]);
  assert.equal(preview.data.scope.includeFutureAccounts, true);
  assert.deepEqual(preview.data.scope.legacyAccountIds, []);
  for (const forbidden of [pair.data.code, 'token', 'cookie', 'credential']) assert.ok(!preview.raw.includes(forbidden));
  const device = service.store.redeem(pair.data.code, '空家人组设备');
  assert.deepEqual(device.familyIds, [lin.id]); assert.deepEqual(device.accounts, []);
  assert.deepEqual(device.legacyAccountIds, []);
  const own = account(lin.id, 'lin-account'), foreign = account(yue.id, 'yue-account'), pending = account('', 'pending');
  for (const a of [own, foreign, pending]) service.store.importResult(a.id, parcel('identical-id'));
  const snapshot = await request('/v1/snapshot', { token: device.token });
  assert.deepEqual(snapshot.data.accounts.map(a => a.id), [own.id]);
  assert.deepEqual(snapshot.data.familyIds, [lin.id]);
  assert.deepEqual(snapshot.data.legacyAccountIds, []);
  assert.deepEqual(snapshot.data.families, [lin]);
  assert.equal(snapshot.data.orders.length, 1); assert.equal(snapshot.data.shipments.length, 1);
  assert.equal(snapshot.data.orders[0].familyId, lin.id); assert.equal(snapshot.data.shipments[0].familyName, lin.name);
  assert.ok(!snapshot.raw.includes('SYNTHETIC-COOKIE'));
  const both = bind([lin.id, yue.id]);
  assert.equal((await request('/v1/snapshot', { token: both.token })).data.orders.length, 2);
  assert.equal((await request(`/v1/snapshot?accountId=${pending.id}`, { token: device.token })).status, 403);
  assert.equal((await request('/v1/pairing-codes', { method: 'POST', admin: true, body: { familyIds: ['unassigned'] } })).status, 400);
  assert.equal((await request('/v1/pairing-codes', { method: 'POST', admin: true, body: { familyIds: [] } })).status, 400);
});

test('account transfers preserve historical family scope for snapshots, split parcels, operations, refreshes and job reads', async t => {
  const { service, request, family, account, bind } = await setup(t);
  const lin = await family('小林'), yue = await family('阿悦');
  const a = account(lin.id), original = bind([lin.id]), next = bind([yue.id]);
  service.store.importResult(a.id, parcel('old'));
  const oldOrder = service.store.snapshot([a.id]).orders[0], oldShipment = service.store.snapshot([a.id]).shipments[0];
  const move = await request(`/v1/admin/accounts/${a.id}`, { method: 'PATCH', admin: true, body: { familyId: yue.id } });
  assert.equal(move.status, 200); assert.equal(move.data.account.familyName, yue.name);
  const incoming = parcel('new'); incoming.orders.push({ platformOrderId: 'old', familyId: yue.id, familyName: 'forged' });
  incoming.shipments.push({ platformOrderId: 'old', waybillNo: 'SPLIT-OLD', carrier: '顺丰', status: 'transit', familyId: yue.id });
  service.store.importResult(a.id, incoming);
  const oldView = (await request('/v1/snapshot', { token: original.token })).data;
  const newView = (await request('/v1/snapshot', { token: next.token })).data;
  assert.deepEqual(oldView.accounts, []); assert.deepEqual(oldView.orders.map(o => o.platformOrderId), ['old']);
  assert.equal(oldView.shipments.length, 2); assert.ok(oldView.shipments.every(s => s.familyId === lin.id));
  assert.deepEqual(newView.orders.map(o => o.platformOrderId), ['new']);
  assert.equal(newView.shipments.length, 1); assert.ok(newView.events.every(e => e.shipmentId !== oldShipment.id));
  assert.equal((await request(`/v1/snapshot?accountId=${a.id}`, { token: original.token })).data.orders[0].id, oldOrder.id);
  const operation = { id: 'old-pick', shipmentId: oldShipment.id, action: 'pick', occurredAt: TIME };
  assert.equal((await request('/v1/operations', { method: 'POST', token: next.token, body: { operations: [operation] } })).status, 403);
  assert.equal((await request('/v1/operations', { method: 'POST', token: original.token, body: { operations: [operation] } })).status, 200);
  assert.equal((await request('/v1/operations', { method: 'POST', token: next.token, body: { operations: [{ id: 'date', action: 'setOrderDate', orderId: oldOrder.id, date: '2026-10-01', occurredAt: TIME }] } })).status, 403);
  assert.equal((await request(`/v1/orders/${oldOrder.id}/refresh`, { method: 'POST', token: next.token, body: {} })).status, 403);
  const refresh = await request(`/v1/orders/${oldOrder.id}/refresh`, { method: 'POST', token: original.token, body: {} });
  assert.equal(refresh.status, 202); const jobId = refresh.data.jobs[0].id;
  assert.equal((await request(`/v1/sync-jobs/${jobId}`, { token: original.token })).status, 200);
  assert.equal((await request(`/v1/sync-jobs/${jobId}`, { token: next.token })).status, 403);
  assert.equal((await request(`/v1/accounts/${a.id}/sync`, { method: 'POST', token: original.token, body: {} })).status, 403);
  await Promise.all([...service.running.values()]);
  service.store.saveAccount({ familyId: '' }, a.id); service.store.saveAccount({ familyId: yue.id }, a.id);
  assert.equal(service.store.order(oldOrder.id).familyId, lin.id);
  await request(`/v1/admin/families/${yue.id}`, { method: 'PATCH', admin: true, body: { name: '阿悦新名字' } });
  assert.equal(service.store.account(a.id).familyName, '阿悦新名字');
  assert.equal(service.store.snapshot([a.id]).orders.find(o => o.platformOrderId === 'new').familyName, '阿悦');
  await request(`/v1/admin/devices/${original.deviceId}`, { method: 'PATCH', admin: true, body: { familyIds: [] } });
  assert.deepEqual((await request('/v1/snapshot', { token: original.token })).data.orders, []);
  assert.equal((await request('/v1/operations/old-pick', { token: original.token })).status, 403);
});

test('legacy schema migration preserves IDs, encrypted credentials, manual state and account grants; first assignment backfills once', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-family-migration-'));
  const filename = join(directory, 'fixture.db'), key = readKey(KEY);
  const legacy = new DatabaseSync(filename), credential = encryptCookie('SYNTHETIC-LEGACY-COOKIE', key, 'a');
  const orderId = stableId('a', 'taobao', 'order', 'old');
  legacy.exec(`CREATE TABLE meta(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL); INSERT INTO meta VALUES(1,1);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,data TEXT NOT NULL,credential TEXT NOT NULL);
    CREATE TABLE devices(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,name TEXT NOT NULL,account_ids TEXT NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER);
    CREATE TABLE pairing(code_hash TEXT PRIMARY KEY,account_ids TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER);
    CREATE TABLE orders(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE shipments(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE operations(device_id TEXT NOT NULL,id TEXT NOT NULL,payload_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(device_id,id));`);
  legacy.prepare('INSERT INTO accounts VALUES(?,?,?)').run('a', JSON.stringify({ id: 'a', platform: 'taobao', label: 'legacy', enabled: true, intervalMinutes: 60, revision: 1 }), credential);
  legacy.prepare('INSERT INTO orders VALUES(?,?,?)').run(orderId, 'a', JSON.stringify({ id: orderId, accountId: 'a', platform: 'taobao', platformOrderId: 'old', title: 'legacy history' }));
  legacy.prepare('INSERT INTO shipments VALUES(?,?,?)').run('s', 'a', JSON.stringify({ id: 's', orderId, accountId: 'a', waybillNo: 'LEGACY', picked: true, hidden: true }));
  legacy.prepare('INSERT INTO devices VALUES(?,?,?,?,?,NULL)').run('legacy-device', hash('legacy-token'), 'legacy', '["a"]', TIME);
  legacy.prepare('INSERT INTO pairing VALUES(?,?,?,NULL)').run(hash('LEGACY-CODE'), '["a"]', TIME + 600000);
  legacy.prepare('INSERT INTO operations VALUES(?,?,?,?)').run('legacy-device', 'prior', 'hash', '{"id":"prior","shipmentId":"s","status":"applied"}');
  legacy.close();
  let store = new Store({ filename, key, now: () => TIME });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.account('a').familyId, ''); assert.deepEqual(store.device('legacy-token').familyIds, []);
  assert.equal(store.db.prepare('SELECT credential FROM accounts WHERE id=?').get('a').credential, credential);
  const lin = store.saveFamily({ name: '小林' }, 'lin'), yue = store.saveFamily({ name: '阿悦' }, 'yue');
  store.saveAccount({ familyId: lin.id }, 'a');
  const first = store.snapshot(['a']);
  assert.equal(first.orders[0].id, orderId); assert.equal(first.orders[0].familyId, lin.id);
  assert.equal(first.shipments[0].familyName, lin.name); assert.equal(first.shipments[0].picked, true); assert.equal(first.shipments[0].hidden, true);
  store.saveAccount({ familyId: yue.id }, 'a');
  assert.equal(store.snapshot(['a']).orders[0].familyId, lin.id);
  store.saveAccount({ platform: 'taobao', label: 'second', cookie: 'SYNTHETIC', familyId: yue.id }, 'second', true);
  assert.deepEqual(store.device('legacy-token').accountIds, ['a']);
  assert.deepEqual(store.device('legacy-token').familyIds, []);
  assert.equal(store.operation(store.device('legacy-token'), 'prior').status, 'applied');
  assert.deepEqual(store.previewPairing('LEGACY-CODE').scope.accountIds, ['a']);
  store.close(); store = new Store({ filename, key, now: () => TIME });
  assert.equal(store.snapshot(['a']).orders[0].familyId, lin.id);
  assert.equal(store.cookie('a'), 'SYNTHETIC-LEGACY-COOKIE');
  assert.equal(store.redeem('LEGACY-CODE', 'legacy bound').families.length, 0);
});

test('device scope edits preserve omitted legacy grants and revoke family groups immediately', async t => {
  const { service, request, family, account } = await setup(t);
  const lin = await family('小林'), a = account(lin.id, 'a'), b = account(lin.id, 'b');
  const old = service.store.redeem(service.store.createPairing([a.id]).code, 'old app');
  const update = body => request(`/v1/admin/devices/${old.deviceId}`, { method: 'PATCH', admin: true, body });
  assert.deepEqual((await update({ familyIds: [lin.id] })).data.device.legacyAccountIds, [a.id]);
  assert.deepEqual((await request('/v1/snapshot', { token: old.token })).data.legacyAccountIds, [a.id]);
  assert.equal((await request('/v1/accounts', { token: old.token })).data.accounts.length, 2);
  const revokedGroup = await update({ familyIds: [] });
  assert.deepEqual(revokedGroup.data.device.accountIds, [a.id]);
  assert.deepEqual(revokedGroup.data.device.legacyAccountIds, [a.id]);
  assert.equal((await request(`/v1/accounts/${b.id}/sync`, { method: 'POST', token: old.token, body: {} })).status, 403);
  await update({ accountIds: [] });
  assert.deepEqual((await request('/v1/accounts', { token: old.token })).data.accounts, []);
  assert.equal((await update({ familyIds: [''] })).status, 400);
  assert.equal((await request(`/v1/admin/devices/${old.deviceId}`, { method: 'PATCH', token: old.token, body: { familyIds: [lin.id] } })).status, 401);
  service.store.revoke(old.deviceId);
  assert.equal((await update({ familyIds: [lin.id] })).status, 409);
});

test('pair preview is non-consuming, rechecks expiry and use, and shares redemption guessing limits', async t => {
  const { service, request, family, account, advance } = await setup(t);
  const lin = await family('小林'); account(lin.id);
  const pair = service.store.createPairing({ familyIds: [lin.id] });
  for (let i = 0; i < 2; i++) assert.equal((await request('/v1/pairing-codes/preview', { method: 'POST', body: { code: pair.code } })).status, 200);
  const attempts = await Promise.all([1, 2].map(() => request('/v1/devices', { method: 'POST', body: { code: pair.code, deviceName: 'phone' } })));
  assert.deepEqual(attempts.map(a => a.status).sort(), [201, 400]);
  assert.equal((await request('/v1/pairing-codes/preview', { method: 'POST', body: { code: pair.code } })).status, 400);
  const expired = service.store.createPairing({ familyIds: [lin.id] }); advance(600000);
  assert.equal((await request('/v1/pairing-codes/preview', { method: 'POST', body: { code: expired.code } })).status, 400);
  for (let i = 0; i < 9; i++) assert.equal((await request('/v1/pairing-codes/preview', { method: 'POST', body: { code: 'WRONG' }, headers: { 'X-Forwarded-For': `192.0.2.${i}` } })).status, 400);
  assert.equal((await request('/v1/devices', { method: 'POST', body: { code: 'WRONG', deviceName: 'guesser' } })).status, 429);
  assert.throws(() => service.store.createPairing({ familyIds: [lin.id], accountIds: ['account'] }), /家人整组授权/);
});

test('a running collection from before an ownership change cannot import records under the new family', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const { service, family, account } = await setup(t, { collector: async () => { await pending; return parcel('stale-result'); } });
  const lin = await family('小林'), yue = await family('阿悦'), a = account(lin.id);
  const task = service.requestSync(a.id);
  await new Promise(resolve => setImmediate(resolve));
  service.store.saveAccount({ familyId: yue.id }, a.id);
  finish(); await task;
  assert.deepEqual(service.store.snapshot([a.id]).orders, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createService } from '../src/service.mjs';

const MINUTE = 60000;
const START = Date.parse('2026-11-10T00:00:00+08:00');
const ADMIN = 'conditional-sync-test-admin-secret-at-least-32-characters';
const result = () => ({ orders: [{ platformOrderId: 'fixture-order', title: 'fixture' }], shipments: [] });

async function setup(t, collector = async () => result()) {
  let now = START;
  const service = createService({ encryptionKey: '19'.repeat(32), adminToken: ADMIN, now: () => now,
    scheduler: false, collector });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, { token, method = 'GET', body } = {}) => {
    const response = await fetch(base + path, { method, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const account = (id, fields = {}) => {
    const account = service.store.saveAccount({ platform: 'jd', label: id, cookie: 'fixture' }, id, true);
    return service.store.updateAccount(account.id, fields);
  };
  const bind = ids => service.store.redeem(service.store.createPairing(ids).code, 'fixture device');
  const sync = (token, body = { onlyIfStale: true }) => request('/v1/accounts/sync', { token, method: 'POST', body });
  const settle = () => Promise.all([...service.jobs.running.values()]);
  return { service, request, account, bind, sync, settle, advance: value => { now += value; } };
}

test('conditional HTTP sync skips fresh data through the exact thirty-minute boundary and advertises capability', async t => {
  const calls = [];
  const { account, bind, sync, request, advance, settle } = await setup(t, async value => { calls.push(value.id); return result(); });
  const a = account('fresh', { lastFullSuccessAt: START });
  const device = bind([a.id]);
  const snapshot = await request('/v1/snapshot', { token: device.token });
  assert.equal(snapshot.status, 200);
  assert.ok(snapshot.data.capabilities.includes('conditionalSync'));
  for (const elapsed of [0, 30 * MINUTE]) {
    advance(elapsed);
    const response = await sync(device.token);
    assert.equal(response.status, 202);
    assert.deepEqual(response.data.jobs, []);
    assert.deepEqual(calls, []);
  }
  advance(1);
  const response = await sync(device.token); await settle();
  assert.equal(response.status, 202);
  assert.deepEqual(response.data.jobs.map(job => job.accountId), [a.id]);
  assert.deepEqual(calls, [a.id]);
  assert.deepEqual((await sync(device.token)).data.jobs, [], 'the completed full result must immediately make another automatic request a no-op');
});

test('conditional HTTP sync collects only stale authorized enabled accounts, including unknown or future success times', async t => {
  const calls = [];
  const { account, bind, sync, settle } = await setup(t, async value => { calls.push(value.id); return result(); });
  const accounts = [
    account('fresh', { lastFullSuccessAt: START - MINUTE }),
    account('boundary', { lastFullSuccessAt: START - 30 * MINUTE }),
    account('stale', { lastFullSuccessAt: START - 30 * MINUTE - 1 }),
    account('never', { lastFullSuccessAt: 0, lastSuccessAt: START }),
    account('future', { lastFullSuccessAt: START + MINUTE }),
    account('invalid', { lastFullSuccessAt: 'invalid' }),
    account('disabled', { enabled: false, lastFullSuccessAt: 0 }),
    account('expired', { status: 'expired', lastFullSuccessAt: 0 }),
  ];
  account('outside', { lastFullSuccessAt: 0 });
  const device = bind(accounts.map(value => value.id));
  const response = await sync(device.token); await settle();
  assert.equal(response.status, 202);
  const expected = ['future', 'invalid', 'never', 'stale'];
  assert.deepEqual(response.data.jobs.map(job => job.accountId).sort(), expected);
  assert.deepEqual(calls.sort(), expected);
});

test('legacy empty-body and explicit false manual requests collect fresh data while retaining the five-minute cooldown', async t => {
  const calls = [];
  const { service, account, bind, sync, advance, settle } = await setup(t, async value => { calls.push(value.id); return result(); });
  const a = account('manual', { lastFullSuccessAt: START });
  const device = bind([a.id]);
  const first = await sync(device.token, {}); await settle();
  assert.equal(first.status, 202);
  assert.deepEqual(calls, [a.id]);
  const next = await sync(device.token, { onlyIfStale: false });
  assert.equal(next.status, 202);
  assert.equal(next.data.jobs[0].state, 'queued');
  assert.equal(next.data.jobs[0].retryAt, START + 5 * MINUTE);
  advance(5 * MINUTE - 1); service.jobs.pump(a.id); await settle();
  assert.equal(calls.length, 1);
  advance(1); service.jobs.pump(a.id); await settle();
  assert.deepEqual(calls, [a.id, a.id]);
  assert.equal(service.store.account(a.id).lastFullSuccessAt, START + 5 * MINUTE);
});

test('conditional HTTP sync adds no full-account task behind running or queued order and account requests', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  t.after(release);
  const { service, account, bind, sync, settle } = await setup(t, async value => { calls.push(value.id); await gate; return result(); });
  const accounts = ['running-order', 'queued-order', 'running-full', 'queued-full'].map(id => account(id));
  const records = accounts.map((a, index) => {
    service.store.importResult(a.id, result());
    if (index % 2) service.store.updateAccount(a.id, { lastAttemptAt: START });
    const orderId = index < 2 ? service.store.snapshot([a.id]).orders[0].id : '';
    return service.jobs.request(a.id, orderId);
  });
  for (const a of accounts) service.store.updateAccount(a.id, { nextSyncAt: START - 1 });
  const device = bind(accounts.map(value => value.id));
  const before = service.store.db.prepare('SELECT account_id,order_id,data FROM sync_job_summaries ORDER BY account_id').all();
  assert.deepEqual(service.jobs.runDue(), [], 'automatic scheduling must not add work behind an existing order or account request');
  const response = await sync(device.token);
  assert.equal(response.status, 202);
  assert.deepEqual(response.data.jobs, []);
  assert.deepEqual(service.store.db.prepare('SELECT account_id,order_id,data FROM sync_job_summaries ORDER BY account_id').all(), before);
  release(); await settle();
  assert.deepEqual(calls.sort(), ['running-full', 'running-order']);
  assert.equal(records[1].job.state, 'queued');
  assert.equal(records[3].job.state, 'queued');
});

test('conditional sync rejects malformed inputs, requires device authentication and retains account/job scope checks', async t => {
  const calls = [];
  const { service, account, bind, sync, request, settle } = await setup(t, async value => { calls.push(value.id); return result(); });
  const own = account('own', { lastFullSuccessAt: START }), other = account('other');
  const device = bind([own.id]);
  assert.equal((await sync()).status, 401);
  assert.equal((await sync('invalid-token')).status, 401);
  for (const body of [null, [], 'true', { onlyIfStale: 'true' }, { onlyIfStale: 1 }, { onlyIfStale: null },
    { onlyIfStale: true, accountIds: [other.id] }, { unknown: true }]) {
    assert.equal((await sync(device.token, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await request(`/v1/accounts/${other.id}/sync`, { token: device.token, method: 'POST', body: {} })).status, 403);
  const outside = service.jobs.request(other.id); await outside.done; await settle();
  assert.equal((await request(`/v1/sync-jobs/${outside.job.id}`, { token: device.token })).status, 403);
  assert.deepEqual(calls, [other.id], 'rejected conditional requests must not collect any account');
});

test('conditional sync rechecks device authorization after a streaming request body completes', async t => {
  const calls = [];
  const { service, account, bind, request, settle } = await setup(t, async value => { calls.push(value.id); return result(); });
  const a = account('revoked-during-body'), device = bind([a.id]);
  const body = JSON.stringify({ onlyIfStale: true });
  const started = new Promise(resolve => service.server.once('request', req => resolve(req.complete)));
  let outgoing;
  const pending = new Promise((resolve, reject) => {
    outgoing = httpRequest(`http://127.0.0.1:${service.server.address().port}/v1/accounts/sync`, { method: 'POST', headers: {
      Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', value => { text += value; });
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(text) }));
    });
    outgoing.on('error', reject); outgoing.write(body.slice(0, 1));
  });
  try {
    assert.equal(await started, false, 'the server must have authenticated while the body is still incomplete');
    assert.equal((await request('/v1/devices/current', { token: device.token, method: 'DELETE' })).status, 200);
    outgoing.end(body.slice(1));
    assert.equal((await pending).status, 401);
    await settle();
    assert.deepEqual(calls, []);
    assert.equal(service.jobs.latest(a.id), null);
  } finally { outgoing.destroy(); }
});

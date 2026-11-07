import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { createSyncJobs } from '../src/sync-jobs.mjs';

const NOW = 1_800_000_000_000;
const empty = () => ({ orders: [], shipments: [] });
const order = id => ({ platformOrderId: id, title: `fixture ${id}` });
const parcel = id => ({ platformOrderId: id, waybillNo: `WB${id}`, status: 'transit', logisticsState: 'ok',
  logisticsCheckedAt: NOW, logisticsEvents: [{ time: NOW - 1000, description: '运输中' }] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup(t, collector, options = {}) {
  let time = NOW;
  const store = new Store({ key: randomBytes(32), now: () => time });
  const account = store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'fixture' }, 'fixture', true);
  const jobs = createSyncJobs({ store, collector, now: () => time, ...options });
  t.after(async () => { await jobs.close(); store.close(); });
  return { store, jobs, account, advance: ms => { time += ms; } };
}

test('each completed parcel is visible before the last query and the account stays syncing', async t => {
  const first = deferred(), last = deferred();
  const { store, jobs, account } = setup(t, async (_account, _cookie, options) => {
    options.onProgress({ orders: [order('1'), order('2')], shipments: [] });
    await options.runLogistics(['1', '2'], async id => {
      if (id === '2') await last.promise;
      return { orders: [], shipments: [parcel(id)] };
    }, { stage: 'pdd-logistics', concurrency: 2, key: id => id, onResult: delta => {
      options.onProgress(delta); first.resolve();
    } });
    return empty();
  });
  const record = jobs.request(account.id);
  await first.promise;
  assert.equal(store.snapshot([account.id]).shipments.length, 1);
  assert.equal(store.account(account.id).status, 'syncing');
  assert.equal(record.job.state, 'running');
  last.resolve(); await record.done;
  assert.equal(store.snapshot([account.id]).shipments.length, 2);
  assert.equal(record.job.logisticsProgress.completed, 2);
  assert.equal(store.account(account.id).status, 'ok');
});

test('a retry resumes only unfinished queries and honors the original backoff deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const counts = new Map();
  const { jobs, account, advance } = setup(t, async (_account, _cookie, options) => {
    options.onProgress({ orders: [order('1'), order('2'), order('3')], shipments: [] });
    await options.runLogistics(['1', '2', '3'], async id => {
      counts.set(id, (counts.get(id) || 0) + 1);
      if (id === '2' && counts.get(id) === 1) throw Object.assign(new Error('fixture throttle'), { code: 'UPSTREAM_RATE_LIMITED', retryAfterMs: 600000 });
      return { orders: [], shipments: [parcel(id)] };
    }, { stage: 'pdd-logistics', concurrency: 1, key: id => id, onResult: options.onProgress });
    return empty();
  });
  const record = jobs.request(account.id);
  await turn();
  assert.equal(record.job.state, 'queued');
  assert.equal(record.job.retryAt, NOW + 600000);
  assert.equal(jobs.request(account.id), record);
  advance(599999); t.mock.timers.tick(599999); await turn();
  assert.equal(counts.get('2'), 1);
  advance(1); t.mock.timers.tick(1); await record.done;
  assert.equal(record.job.state, 'completed');
  assert.deepEqual([...counts], [['1', 1], ['2', 2], ['3', 1]]);
});

test('pending inputs survive disappearing platform lists even before the first parcel was imported', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0, discoveries = 0;
  const { store, jobs, account, advance } = setup(t, async (_account, _cookie, options) => {
    options.onProgress({ orders: [order('1')], shipments: [] });
    const items = discoveries++ ? [] : [{ platformOrderId: '1' }];
    await options.runLogistics(items, async item => {
      if (++attempts === 1) throw Object.assign(new Error('fixture temporary failure'), { code: 'UPSTREAM_ERROR' });
      return { orders: [], shipments: [parcel(item.platformOrderId)] };
    }, { stage: 'pdd-logistics', concurrency: 1, key: item => item.platformOrderId, onResult: options.onProgress });
    return empty();
  });
  const pending = jobs.request(account.id);
  await turn(); assert.equal(pending.job.state, 'queued');
  assert.equal(store.snapshot([account.id]).shipments.length, 0);
  advance(15000); t.mock.timers.tick(15000); await pending.done;
  assert.equal(pending.job.state, 'completed');
  assert.equal(attempts, 2);
  assert.equal(store.snapshot([account.id]).shipments.length, 1);
});

test('credential changes discard completed checkpoints before any new session can reuse them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cookies = [];
  const { store, jobs, account, advance } = setup(t, async (_account, cookie, options) => {
    options.onProgress({ orders: [order('1'), order('2')], shipments: [] });
    await options.runLogistics([{ platformOrderId: '1' }, { platformOrderId: '2' }], async item => {
      cookies.push([item.platformOrderId, cookie]);
      if (item.platformOrderId === '2' && cookie === 'fixture') throw Object.assign(new Error('fixture network'), { code: 'UPSTREAM_ERROR' });
      return { orders: [], shipments: [parcel(item.platformOrderId)] };
    }, { stage: 'pdd-logistics', concurrency: 1, key: item => item.platformOrderId, onResult: options.onProgress });
    return empty();
  });
  const pending = jobs.request(account.id); await turn();
  store.saveAccount({ cookie: 'new-fixture' }, account.id, true);
  advance(15000); t.mock.timers.tick(15000); await pending.done;
  assert.deepEqual(cookies, [['1', 'fixture'], ['2', 'fixture'], ['1', 'new-fixture'], ['2', 'new-fixture']]);
  assert.equal(pending.job.state, 'completed');
});

test('SQLite checkpoints resume automatically after restart without repeating completed queries', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-continuation-'));
  const filename = join(directory, 'fixture.db'), key = randomBytes(32);
  const first = deferred(), last = deferred();
  let stopping = true;
  const calls = [];
  const collector = async (_account, _cookie, options) => {
    options.onProgress({ orders: [order('1'), order('2')], shipments: [] });
    await options.runLogistics(['1', '2'], async id => {
      calls.push(id);
      if (id === '2' && stopping) await last.promise;
      return { orders: [], shipments: [parcel(id)] };
    }, { stage: 'pdd-logistics', concurrency: 1, key: id => id, onResult: delta => { options.onProgress(delta); first.resolve(); } });
    return empty();
  };
  let store = new Store({ filename, key, now: () => NOW });
  const account = store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'fixture-secret' }, 'fixture', true);
  let jobs = createSyncJobs({ store, collector, now: () => NOW });
  t.after(async () => { await jobs.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const record = jobs.request(account.id);
  await first.promise; await turn();
  const closing = jobs.close(); last.resolve(); await closing;
  assert.equal(record.job.state, 'queued');
  const saved = store.db.prepare('SELECT * FROM sync_logistics_tasks').all();
  assert.equal(saved.filter(row => row.state === 'completed').length, 1);
  assert.ok(!JSON.stringify(saved).includes('fixture-secret'));
  store.close(); stopping = false;
  store = new Store({ filename, key, now: () => NOW + 1 });
  jobs = createSyncJobs({ store, collector, now: () => NOW + 1 });
  const resumed = jobs.request(account.id);
  assert.equal(resumed.job.id, record.job.id);
  await resumed.done;
  assert.deepEqual(calls, ['1', '2', '2']);
  assert.equal(store.snapshot([account.id]).shipments.length, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_logistics_tasks').get().n, 0);
});

test('an order refresh joins an in-flight full refresh without broadening its authorization scope', async t => {
  const gate = deferred(); let calls = 0;
  const { store, jobs, account } = setup(t, async () => { calls++; await gate.promise; return empty(); });
  store.importResult(account.id, { orders: [order('1')], shipments: [parcel('1')] });
  const target = store.snapshot([account.id]).orders[0];
  const full = jobs.request(account.id), individual = jobs.request(account.id, target.id);
  assert.equal(individual.job.parentJobId, full.job.id);
  assert.equal(individual.job.orderId, target.id);
  gate.resolve(); await Promise.all([full.done, individual.done]);
  assert.equal(calls, 1);
  assert.equal(individual.job.state, 'completed');
});

test('unchanged evidence skips parsing and AI intake but still advances the checked timestamp', async t => {
  let time = NOW, sequence = 0, intake = 0;
  const store = new Store({ key: randomBytes(32), now: () => time });
  const account = store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'fixture' }, 'fixture', true);
  const jobs = createSyncJobs({ store, now: () => time, onImported: () => intake++, collector: async () => ({
    orders: [order('1')], shipments: [{ ...parcel('1'), logisticsCheckedAt: time,
      logisticsEvents: [{ time: NOW - 1000, description: sequence < 2 ? '运输中' : '快递已到达目的地分拨中心' }] }],
  }) });
  t.after(async () => { await jobs.close(); store.close(); });
  let projected = 0;
  const original = store.pickupCompletion.project.bind(store.pickupCompletion);
  store.pickupCompletion.project = (...args) => { projected++; return original(...args); };
  await jobs.request(account.id).done;
  sequence++; time += 300000; await jobs.request(account.id).done;
  assert.equal(projected, 1); assert.equal(intake, 1);
  const shipment = store.snapshot([account.id]).shipments[0];
  assert.equal(shipment.logisticsCheckedAt, time);
  assert.equal(shipment.logisticsEvidenceHash, undefined);
  sequence++; time += 300000; await jobs.request(account.id).done;
  assert.equal(projected, 2); assert.equal(intake, 2);
});

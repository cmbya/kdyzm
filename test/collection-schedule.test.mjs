import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createSyncJobs } from '../src/sync-jobs.mjs';
import { createService } from '../src/service.mjs';
import { scheduledPlatform, scheduledSyncAt, isCollectionStale } from '../src/collection-schedule.mjs';

const MINUTE = 60000;
const START = Date.parse('2026-11-10T00:00:00+08:00');
const KEY = Buffer.alloc(32, 19);
const ADMIN = 'schedule-test-admin-secret-at-least-32-characters';
const empty = () => ({ orders: [], shipments: [] });
const save = (store, platform, id = platform, fields = {}) => store.saveAccount({ platform, label: id, cookie: 'synthetic', ...fields }, id, true);
const settle = jobs => Promise.all([...jobs.running.values()]);

test('platform windows and strictly future slots stay aligned for every supported interval', () => {
  for (let minute = 0; minute < 60; minute++) {
    assert.equal(scheduledPlatform(START + minute * MINUTE), ['jd', 'pdd', 'taobao'][Math.floor(minute / 5) % 3]);
  }
  for (const [platform, offset] of [['jd', 0], ['pdd', 5], ['taobao', 10]]) {
    for (const interval of [15, 30, 60]) {
      const slot = START + offset * MINUTE;
      assert.equal(scheduledSyncAt(platform, slot - 1, interval), slot);
      assert.equal(scheduledSyncAt(platform, slot, interval), slot + interval * MINUTE);
      assert.equal(scheduledSyncAt(platform, slot + 1, interval), slot + interval * MINUTE);
    }
  }
});

test('freshness is strictly over thirty minutes and treats missing, malformed and future full results as stale', () => {
  const account = { enabled: true, status: 'ok', lastFullSuccessAt: START };
  assert.equal(isCollectionStale(account, START + 30 * MINUTE), false);
  assert.equal(isCollectionStale(account, START + 30 * MINUTE + 1), true);
  for (const lastFullSuccessAt of [undefined, 0, -1, NaN, Infinity, 'yesterday', String(START), START + 1]) {
    assert.equal(isCollectionStale({ ...account, lastFullSuccessAt }, START), true);
  }
  assert.equal(isCollectionStale({ ...account, enabled: false, lastFullSuccessAt: 0 }, START), false);
  assert.equal(isCollectionStale({ ...account, status: 'expired', lastFullSuccessAt: 0 }, START), false);
});

test('real due jobs collect each platform four times per hour, five minutes apart, despite thirty-second polling', async t => {
  let now = START - 1;
  const calls = [];
  const store = new Store({ key: KEY, now: () => now });
  const jobs = createSyncJobs({ store, now: () => now, collector: async account => { calls.push([account.platform, now]); return empty(); } });
  t.after(async () => { await jobs.close(); store.close(); });
  for (const platform of ['jd', 'pdd', 'taobao']) {
    const account = save(store, platform);
    assert.equal(account.intervalMinutes, 15);
  }
  for (now = START; now < START + 60 * MINUTE; now += 30000) {
    jobs.runDue(); await settle(jobs);
  }
  assert.deepEqual(calls, Array.from({ length: 12 }, (_, index) => [
    ['jd', 'pdd', 'taobao'][index % 3], START + index * 5 * MINUTE,
  ]));
  for (const platform of ['jd', 'pdd', 'taobao']) assert.equal(calls.filter(call => call[0] === platform).length, 4);
});

test('the service thirty-second timer dispatches the due platform and ignores disabled or expired accounts', async t => {
  let now = START - 30000;
  const calls = [];
  t.mock.timers.enable({ apis: ['setInterval'] });
  const service = createService({ encryptionKey: KEY.toString('hex'), adminToken: ADMIN,
    now: () => now, collector: async account => { calls.push(account.id); return empty(); } });
  t.after(() => service.close());
  for (const platform of ['jd', 'pdd', 'taobao']) save(service.store, platform);
  save(service.store, 'jd', 'disabled', { enabled: false });
  save(service.store, 'jd', 'expired');
  service.store.updateAccount('expired', { status: 'expired' });
  now = START; t.mock.timers.tick(30000); await settle(service.jobs);
  assert.deepEqual(calls, ['jd']);
  now += 5 * MINUTE; t.mock.timers.tick(30000); await settle(service.jobs);
  assert.deepEqual(calls, ['jd', 'pdd']);
});

test('overdue schedules survive restart without a catch-up burst or duplicate work after clock rollback', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-schedule-'));
  const filename = join(directory, 'test.db');
  let now = START - 20 * MINUTE, store, jobs;
  const calls = [];
  const open = () => {
    store = new Store({ filename, key: KEY, now: () => now });
    jobs = createSyncJobs({ store, now: () => now, collector: async account => { calls.push([account.platform, now]); return empty(); } });
  };
  const close = async () => { await jobs.close(); store.close(); };
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  open();
  for (const platform of ['jd', 'pdd', 'taobao']) save(store, platform);
  await close(); now = START + 4 * MINUTE; open();
  assert.deepEqual(calls, []);
  for (const minute of [4, 4, 5, 8, 9, 10, 14, 15, 19, 4, 9, 14, 19, 20, 24, 23, 24]) {
    now = START + minute * MINUTE;
    jobs.runDue(); await settle(jobs);
  }
  assert.deepEqual(calls, [['jd', START + 4 * MINUTE], ['pdd', START + 9 * MINUTE],
    ['taobao', START + 14 * MINUTE], ['jd', START + 19 * MINUTE], ['pdd', START + 24 * MINUTE]]);
  await close(); open(); jobs.runDue(); await settle(jobs);
  assert.equal(calls.length, 5, 'another restart in the same slot must not collect again');
});

test('manual collection near an automatic slot retains cooldown and prevents duplicate queued work', async t => {
  let now = START + 14 * MINUTE;
  const calls = [];
  const store = new Store({ key: KEY, now: () => now });
  const jobs = createSyncJobs({ store, now: () => now, collector: async () => { calls.push(now); return empty(); } });
  t.after(async () => { await jobs.close(); store.close(); });
  const account = save(store, 'jd');
  await jobs.request(account.id).done;
  assert.equal(store.account(account.id).nextSyncAt, START + 30 * MINUTE, 'an automatic slot inside the manual cooldown must be skipped');
  now = START + 15 * MINUTE; jobs.runDue(); await settle(jobs);
  assert.deepEqual(calls, [START + 14 * MINUTE]);
  const queued = jobs.request(account.id);
  assert.equal(queued.job.state, 'queued');
  assert.equal(queued.job.retryAt, START + 19 * MINUTE);
  for (const minute of [15, 16, 18]) {
    now = START + minute * MINUTE; jobs.runDue(); jobs.pump(account.id); await settle(jobs);
  }
  assert.equal(jobs.request(account.id), queued);
  now = START + 19 * MINUTE; jobs.pump(account.id); await queued.done;
  now = START + 30 * MINUTE; jobs.runDue(); await settle(jobs);
  assert.deepEqual(calls, [START + 14 * MINUTE, START + 19 * MINUTE, START + 30 * MINUTE]);
});

test('only completing a full-account job advances freshness; partial progress, targeted refresh and failures preserve it', async t => {
  let now = START, mode = 'full', release, progressed;
  const gate = new Promise(resolve => { release = resolve; });
  const progress = new Promise(resolve => { progressed = resolve; });
  const result = () => ({ orders: [{ platformOrderId: 'order', title: 'fixture' }], shipments: [] });
  const store = new Store({ key: KEY, now: () => now });
  const jobs = createSyncJobs({ store, now: () => now, collector: async (_account, _cookie, options) => {
    if (mode === 'full') { options.onProgress(result()); progressed(); await gate; }
    if (mode === 'fail') throw Object.assign(new Error('fixture failure'), { code: 'UPSTREAM_ERROR' });
    return result();
  } });
  t.after(async () => { release(); await jobs.close(); store.close(); });
  const account = save(store, 'jd');
  const full = jobs.request(account.id); await progress;
  assert.equal(store.account(account.id).lastFullSuccessAt, 0);
  now += 1000; release(); assert.equal((await full.done).state, 'completed');
  const fullAt = now;
  assert.equal(store.account(account.id).lastFullSuccessAt, fullAt);
  now += 5 * MINUTE; mode = 'target';
  const order = store.snapshot([account.id]).orders[0];
  assert.equal((await jobs.request(account.id, order.id).done).state, 'completed');
  assert.equal(store.account(account.id).lastFullSuccessAt, fullAt);
  now += 5 * MINUTE; mode = 'fail';
  assert.equal((await jobs.request(account.id).done).state, 'error');
  assert.equal(store.account(account.id).lastFullSuccessAt, fullAt);
  for (const change of [{ label: 'renamed' }, { enabled: false }, { intervalMinutes: 30 }, { cookie: 'replacement' }]) {
    assert.equal(store.saveAccount(change, account.id, true).lastFullSuccessAt, fullAt);
  }
});

test('legacy schedules migrate once while preserving credentials and records, and explicit slower intervals survive restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-schedule-migration-'));
  const filename = join(directory, 'test.db');
  let now = START + 2 * MINUTE, store;
  const open = () => { store = new Store({ filename, key: KEY, now: () => now }); };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  open();
  save(store, 'pdd', 'legacy', { intervalMinutes: 60 });
  store.importResult('legacy', { orders: [{ platformOrderId: 'kept', title: 'preserved order' }], shipments: [] });
  store.updateAccount('legacy', { lastSuccessAt: START, lastAttemptAt: START - 10 * MINUTE, warnings: ['keep warning'], status: 'error' });
  const old = store.account('legacy');
  delete old.collectionScheduleVersion; delete old.lastFullSuccessAt;
  store.db.prepare('UPDATE accounts SET data=? WHERE id=?').run(JSON.stringify(old), old.id);
  const credential = store.db.prepare('SELECT credential FROM accounts WHERE id=?').get(old.id).credential;
  store.close(); open();
  const migrated = store.account(old.id);
  assert.equal(migrated.collectionScheduleVersion, 1);
  assert.equal(migrated.intervalMinutes, 15);
  assert.equal(migrated.nextSyncAt, START + 5 * MINUTE);
  assert.equal(migrated.lastFullSuccessAt, 0, 'legacy partial successes must not count as a completed full refresh');
  for (const field of ['lastSuccessAt', 'lastAttemptAt', 'credentialVersion', 'status', 'warnings']) assert.deepEqual(migrated[field], old[field]);
  assert.equal(store.db.prepare('SELECT credential FROM accounts WHERE id=?').get(old.id).credential, credential);
  assert.equal(store.cookie(old.id), 'synthetic');
  assert.equal(store.snapshot([old.id]).orders[0].title, 'preserved order');
  const once = store.account(old.id);
  store.close(); now += MINUTE; open();
  assert.deepEqual(store.account(old.id), once, 'migration must be idempotent');
  for (const intervalMinutes of [30, 60]) {
    store.saveAccount({ intervalMinutes }, old.id, true);
    const saved = store.account(old.id);
    store.close(); open();
    assert.deepEqual(store.account(old.id), saved);
    assert.equal(store.account(old.id).intervalMinutes, intervalMinutes);
  }
  for (const intervalMinutes of [5, 20, '15']) {
    assert.throws(() => store.saveAccount({ intervalMinutes }, old.id, true), /间隔/);
  }
});

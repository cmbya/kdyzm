import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createSyncJobs } from '../src/sync-jobs.mjs';

const NOW = 1_800_000_000_000;
const result = () => ({ orders: [{ platformOrderId: 'order', title: 'fixture' }], shipments: [] });

test('latest failed and successful scope summaries survive database restart; interrupted work is explicit', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-sync-summary-'));
  const filename = join(directory, 'test.db'), key = randomBytes(32);
  let now = NOW, fail = true;
  let store, jobs;
  const open = () => {
    store = new Store({ filename, key, now: () => now });
    jobs = createSyncJobs({ store, now: () => now, collector: async () => {
      if (fail) throw Object.assign(new Error('synthetic upstream failure'), { code: 'UPSTREAM_ERROR' });
      return result();
    } });
  };
  const stop = async () => { await jobs.close(); store.close(); };
  t.after(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  open();
  const account = store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'fixture' }, 'account', true);
  const failed = await jobs.request(account.id).done;
  assert.equal(failed.state, 'error');
  await stop(); open();
  assert.deepEqual(jobs.latest(account.id), failed);
  assert.equal(jobs.read(failed.id).error, failed.error);
  now += 300000; fail = false;
  const complete = await jobs.request(account.id).done;
  assert.equal(complete.state, 'completed');
  assert.ok(complete.updatedAt > failed.updatedAt);
  const waiting = jobs.request(account.id);
  assert.equal(waiting.job.state, 'queued');
  assert.ok(waiting.job.createdAt > complete.updatedAt, 'a same-millisecond request must supersede the previous terminal summary');
  await jobs.close();
  const interrupted = { ...waiting.job, resumeVersion: undefined, state: 'running', error: '', finishedAt: 0 };
  store.db.prepare('UPDATE sync_job_summaries SET active=1,data=?').run(JSON.stringify(interrupted));
  store.updateAccount(account.id, { status: 'syncing' });
  store.close(); now += 1000; open();
  const recovered = jobs.latest(account.id);
  assert.equal(recovered.id, interrupted.id);
  assert.equal(recovered.state, 'error');
  assert.match(recovered.error, /重启中断/);
  assert.equal(store.account(account.id).status, 'error');
  assert.ok(recovered.updatedAt > interrupted.updatedAt);
  store.saveAccount({ cookie: 'new-fixture' }, account.id, true);
  assert.equal(jobs.latest(account.id), null, 'a new login does not inherit an old success or failure');
  assert.throws(() => jobs.read(recovered.id), /已过期/);
  now -= 10000;
  const final = await jobs.request(account.id).done;
  assert.ok(final.createdAt > recovered.updatedAt, 'scope ordering survives restart, login change and a wall-clock rollback');
  assert.ok(final.updatedAt >= final.createdAt);
  await stop(); open();
  assert.deepEqual(jobs.latest(account.id), final);
});

test('summary scopes preserve historical family authorization and independent account/order results', async t => {
  let now = NOW;
  const store = new Store({ key: randomBytes(32), now: () => now });
  const jobs = createSyncJobs({ store, now: () => now, collector: async () => result() });
  t.after(async () => { await jobs.close(); store.close(); });
  const first = store.saveFamily({ name: 'first' }), second = store.saveFamily({ name: 'second' });
  const account = store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'fixture', familyId: first.id }, 'account', true);
  store.importResult(account.id, result());
  const order = store.snapshot([account.id]).orders[0];
  store.saveAccount({ familyId: second.id }, account.id, true);
  const full = await jobs.request(account.id).done;
  now += 300000;
  const target = await jobs.request(account.id, order.id).done;
  assert.equal(full.familyId, second.id);
  assert.equal(target.familyId, first.id);
  const originalFamily = jobs.snapshot(store.scope([first.id])).syncJobs;
  const currentFamily = jobs.snapshot(store.scope([second.id])).syncJobs;
  assert.deepEqual(originalFamily.map(job => job.id), [target.id]);
  assert.deepEqual(currentFamily.map(job => job.id), [full.id]);
  assert.deepEqual(jobs.snapshot(store.scope([first.id]), ['unrelated']).syncJobs, []);
  const legacy = jobs.snapshot(store.scope([], [account.id])).syncJobs;
  assert.deepEqual(new Set(legacy.map(job => job.id)), new Set([full.id, target.id]));
  store.saveAccount({ familyId: first.id }, account.id, true);
  assert.throws(() => jobs.read(full.id), /已过期/, 'do not expose the former family metadata through old full-account job ids');
});

test('summary retention is bounded, keeps in-flight work, and snapshots send at most one hundred authorized scopes', async t => {
  const store = new Store({ key: randomBytes(32), now: () => NOW });
  const jobs = createSyncJobs({ store, now: () => NOW, collector: async () => ({ orders: [], shipments: [] }) });
  t.after(async () => { await jobs.close(); store.close(); });
  const account = store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'fixture' }, 'account', true);
  store.importResult(account.id, { orders: Array.from({ length: 1005 }, (_, i) => ({ platformOrderId: String(i), title: 'fixture' })), shipments: [] });
  const orders = store.snapshot([account.id]).orders;
  const insert = store.db.prepare('INSERT INTO sync_job_summaries VALUES(?,?,?,?,?,?)');
  store.transaction(() => {
    orders.forEach((order, i) => {
      const job = { id: `history-${i}`, accountId: account.id, orderId: order.id, state: 'completed', createdAt: NOW - i - 1, updatedAt: NOW - i - 1 };
      insert.run(account.id, order.id, account.credentialVersion, JSON.stringify(job), job.updatedAt, 0);
    });
    const active = { id: 'uninterrupted', accountId: account.id, orderId: 'active-scope', state: 'queued', updatedAt: NOW - 2000 };
    insert.run(account.id, active.orderId, account.credentialVersion, JSON.stringify(active), active.updatedAt, 1);
  });
  const latest = await jobs.request(account.id).done;
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_job_summaries WHERE active=0').get().n, 1000);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_job_summaries WHERE active=1').get().n, 1);
  const snapshot = jobs.snapshot(store.scope([], [account.id])).syncJobs;
  assert.equal(snapshot.length, 100);
  assert.equal(snapshot[0].id, latest.id);
  assert.deepEqual(jobs.snapshot(store.scope()).syncJobs, []);
});

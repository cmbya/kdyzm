import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { createSyncJobs } from '../src/sync-jobs.mjs';

const NOW = Date.parse('2026-10-31T12:00:00+08:00');
function setup(t, collector) {
  let clock = NOW;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new Store({ key: randomBytes(32), now: () => clock });
  const account = store.saveAccount({ platform: 'pdd', label: '模拟账号', cookie: 'fixture' }, 'a', true);
  const jobs = createSyncJobs({ store, collector, now: () => clock });
  t.after(async () => { await jobs.close(); store.close(); });
  return { store, jobs, account, tick(ms) { clock += ms; t.mock.timers.tick(ms); } };
}

test('a cold manual refresh is queued once and starts automatically at its original deadline', async t => {
  let calls = 0;
  const { store, jobs, account, tick } = setup(t, async () => { calls++; return { orders: [], shipments: [] }; });
  await jobs.request(account.id).done;
  const waiting = jobs.request(account.id);
  assert.equal(waiting.job.state, 'queued');
  assert.equal(waiting.job.retryAt, NOW + 300000);
  assert.equal(waiting.job.error, '');
  tick(299999);
  assert.equal(jobs.request(account.id), waiting);
  assert.equal(store.account(account.id).lastAttemptAt, NOW, 'clicks must not move the cooldown');
  assert.equal(calls, 1);
  tick(1);
  await waiting.done;
  assert.equal(calls, 2);
  assert.equal(waiting.job.state, 'completed');
  assert.equal(waiting.job.finishedAt, NOW + 300000);
  tick(600000);
  assert.equal(calls, 2, 'a queued manual request does not create a recurring retry');
});

test('disabling an account cancels waiting collection and close settles waiting clients', async t => {
  let calls = 0;
  const { store, jobs, account, tick } = setup(t, async () => { calls++; return { orders: [], shipments: [] }; });
  await jobs.request(account.id).done;
  const waiting = jobs.request(account.id);
  store.saveAccount({ enabled: false }, account.id, true);
  tick(300000); await waiting.done;
  assert.equal(waiting.job.state, 'disabled'); assert.equal(calls, 1);
  store.saveAccount({ enabled: true }, account.id, true);
  await jobs.request(account.id).done;
  const stopped = jobs.request(account.id);
  await jobs.close(); await stopped.done;
  assert.equal(stopped.job.state, 'queued'); assert.equal(stopped.job.continuation, true);
  tick(300000); assert.equal(calls, 2);
});

test('credential changes during a queued refresh use new credentials and invalidate old status', async t => {
  const cookies = [];
  const { store, jobs, account, tick } = setup(t, async (_account, cookie) => {
    cookies.push(cookie); return { orders: [], shipments: [] };
  });
  await jobs.request(account.id).done;
  assert.equal(jobs.latest(account.id).state, 'completed');
  store.saveAccount({ cookie: 'new-fixture' }, account.id, true);
  assert.equal(jobs.latest(account.id), null, 'do not show old-account success after changing login');
  await jobs.request(account.id).done;
  const waiting = jobs.request(account.id);
  tick(300000); await waiting.done;
  assert.deepEqual(cookies, ['fixture', 'new-fixture', 'new-fixture']);
  assert.equal(jobs.latest(account.id).id, waiting.job.id);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { createCollector } from '../src/collectors.mjs';
import { createSyncJobs } from '../src/sync-jobs.mjs';

const NOW = 1_800_000_000_000;
const response = (value, options) => new Response(JSON.stringify(value), options);

test('identical successful evidence clears an intervening query failure without parsing it again', () => {
  let now = NOW;
  const store = new Store({ key: Buffer.alloc(32, 8), now: () => now });
  try {
    const account = store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'fixture' }, 'fixture', true);
    const parcel = { platformOrderId: '1', waybillNo: 'WB1', status: 'transit', logisticsState: 'ok', logisticsError: '',
      logisticsCheckedAt: now, logisticsEvents: [{ time: now - 1000, description: '运输中' }] };
    let projected = 0;
    const project = store.pickupCompletion.project.bind(store.pickupCompletion);
    store.pickupCompletion.project = (...args) => { projected++; return project(...args); };
    store.importResult(account.id, { orders: [{ platformOrderId: '1' }], shipments: [parcel] });
    now += 1000;
    store.importResult(account.id, { orders: [], shipments: [], logisticsFailures: [
      { platformOrderId: '1', waybillNo: 'WB1', state: 'error', logisticsCheckedAt: now },
    ] });
    now += 1000;
    const imported = store.importResult(account.id, { orders: [], shipments: [{ ...parcel, logisticsCheckedAt: now }] });
    const actual = store.snapshot([account.id]).shipments[0];
    assert.equal(actual.logisticsState, 'ok');
    assert.equal(actual.logisticsError, '');
    assert.equal(actual.logisticsCheckedAt, now);
    assert.deepEqual(actual.logisticsEvents.map(event => event.description), ['运输中']);
    assert.equal(projected, 1);
    assert.equal(imported.evidenceChanged, false);
  } finally { store.close(); }
});

test('a rotated JD cookie survives a later query failure and resumes from the vault', async t => {
  let now = NOW, rotated = false, failed = false;
  const requests = [];
  const fetchImpl = async (url, options) => {
    const target = new URL(url), fn = target.searchParams.get('functionId');
    requests.push({ fn, cookie: options.headers.Cookie });
    if (rotated && options.headers.Cookie !== 'thor=fixture-new') return response({ code: 3 });
    if (fn === 'pcorder_center_list') return response({ success: true, data: { totalNum: 2,
      orderList: ['1', '2'].map(orderId => ({ orderId, dateSubmit: now, statusInfo: { orderStateName: '待收货' } })),
    } });
    const id = JSON.parse(target.searchParams.get('body')).orderId;
    requests.at(-1).orderId = id;
    if (id === '2' && !failed) { failed = true; return new Response('', { status: 503 }); }
    rotated = true;
    return response({ code: 0, multiPackageTrackInfoList: [{ carriageInfo: { carriageId: `WB${id}` },
      trackGroupInfo: { orderTrackShowList: [{ CreationTime: '2026-11-08 12:00:00', Content: '运输中' }] },
    }] }, { headers: { 'Set-Cookie': 'thor=fixture-new; Path=/' } });
  };
  const store = new Store({ key: Buffer.alloc(32, 8), now: () => now });
  const account = store.saveAccount({ platform: 'jd', label: 'fixture', cookie: 'thor=fixture-old' }, 'fixture', true);
  const jobs = createSyncJobs({ store, now: () => now, collector: createCollector({ now: () => now, fetchImpl }) });
  t.after(async () => { await jobs.close(); store.close(); });
  const record = jobs.request(account.id);
  await jobs.running.get(account.id);
  assert.equal(record.job.state, 'queued');
  assert.equal(store.cookie(account.id), 'thor=fixture-new');
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM sync_logistics_tasks').all()).includes('thor='));
  now = record.job.retryAt;
  jobs.pump(account.id);
  await record.done;
  assert.equal(record.job.state, 'completed');
  assert.equal(requests.filter(request => request.orderId === '1').length, 1);
  assert.equal(requests.filter(request => request.orderId === '2').length, 2);
  assert.equal(requests.filter(request => request.fn === 'pcorder_center_list')[1].cookie, 'thor=fixture-new');
  assert.equal(store.snapshot([account.id]).shipments.length, 2);
});

test('a stale collector cannot overwrite credentials replaced while its request was in flight', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const store = new Store({ key: Buffer.alloc(32, 8), now: () => NOW });
  const account = store.saveAccount({ platform: 'jd', label: 'fixture', cookie: 'thor=fixture-old' }, 'fixture', true);
  const jobs = createSyncJobs({ store, now: () => NOW, collector: async (_account, _cookie, options) => {
    entered();
    await gate;
    options.onCookieRefresh('thor=stale-rotation');
    return { orders: [], shipments: [] };
  } });
  t.after(async () => { await jobs.close(); store.close(); });
  const record = jobs.request(account.id);
  await started;
  store.saveAccount({ cookie: 'thor=user-replacement' }, account.id, true);
  release();
  await record.done;
  assert.equal(record.job.state, 'error');
  assert.equal(store.cookie(account.id), 'thor=user-replacement');
  assert.equal(jobs.latest(account.id), null);
});

for (const [platform, identityName, loginName, aliasName] of [
  ['taobao', 'unb', 'cookie2', 'unb'],
  ['pdd', 'pdd_user_id', 'PDDAccessToken', 'pdduid'],
  ['jd', 'pin', 'thor', 'pt_pin'],
]) {
  const identity = `${identityName}=12345678`, login = `${loginName}=SYNTHETIC-ROTATED`;
  const original = `${identity}; ${loginName}=SYNTHETIC-ORIGINAL`;
  for (const [name, refreshedCookie, accepted = false] of [
    ['missing identity', login],
    ['different identity', `${identityName}=99999999; ${login}`],
    ['conflicting identity', `${identity}; ${aliasName}=99999999; ${login}`],
    ['missing login', identity],
    ['same identity', `${identity}; ${login}`, true],
  ]) test(`${platform} final cookie rotation: ${name} is checked before importing results`, async t => {
    const store = new Store({ key: Buffer.alloc(32, 8), now: () => NOW });
    const account = store.saveAccount({ platform, label: 'fixture', cookie: original }, 'fixture');
    const importResult = t.mock.method(store, 'importResult'), callbacks = [];
    const jobs = createSyncJobs({ store, now: () => NOW,
      onImported: () => callbacks.push('imported'), onCompleted: () => callbacks.push('completed'),
      collector: async () => ({ refreshedCookie,
        orders: [{ platformOrderId: 'SYNTHETIC-ORDER' }],
        shipments: [{ platformOrderId: 'SYNTHETIC-ORDER', waybillNo: 'SYNTHETIC-WAYBILL',
          logisticsState: 'ok', logisticsCheckedAt: NOW, logisticsEvents: [{ time: NOW - 1000, description: '运输中' }] }],
      }),
    });
    t.after(async () => { await jobs.close(); store.close(); });
    const job = await jobs.request(account.id).done, snapshot = store.snapshot([account.id]);
    assert.equal(job.state, accepted ? 'completed' : 'expired');
    assert.equal(store.account(account.id).status, accepted ? 'ok' : 'expired');
    assert.equal(store.cookie(account.id), accepted ? refreshedCookie : original);
    assert.equal(store.account(account.id).credentialVersion, account.credentialVersion);
    assert.equal(importResult.mock.callCount(), accepted ? 1 : 0);
    assert.deepEqual(snapshot.orders.map(order => order.platformOrderId), accepted ? ['SYNTHETIC-ORDER'] : []);
    assert.deepEqual(snapshot.shipments.map(parcel => parcel.waybillNo), accepted ? ['SYNTHETIC-WAYBILL'] : []);
    assert.deepEqual(callbacks, accepted ? ['imported', 'completed'] : []);
  });
}

test('an order joining a full refresh reports its own successful result despite an unrelated failure', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = new Store({ key: Buffer.alloc(32, 8), now: () => NOW });
  const account = store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'fixture' }, 'fixture', true);
  const orders = ['A', 'B'].map(platformOrderId => ({ platformOrderId, dateCheckedAt: NOW, dateState: 'ok' }));
  const shipments = orders.map(({ platformOrderId }) => ({ platformOrderId, waybillNo: `WB${platformOrderId}`,
    status: 'transit', logisticsState: 'ok', logisticsCheckedAt: NOW, logisticsEvents: [{ time: NOW - 1000, description: '运输中' }] }));
  store.importResult(account.id, { orders, shipments });
  const jobs = createSyncJobs({ store, now: () => NOW, collector: async () => {
    await gate;
    return { orders: [], shipments: [shipments[1]], logisticsFailures: [
      { platformOrderId: 'A', waybillNo: 'WBA', state: 'error', logisticsCheckedAt: NOW },
    ] };
  } });
  t.after(async () => { await jobs.close(); store.close(); });
  const full = jobs.request(account.id);
  const target = store.snapshot([account.id]).orders.find(order => order.platformOrderId === 'B');
  const follower = jobs.request(account.id, target.id);
  assert.equal(follower.job.parentJobId, full.job.id);
  release();
  await follower.done;
  assert.equal(full.job.logisticsState, 'error');
  assert.equal(follower.job.state, 'completed');
  assert.equal(follower.job.logisticsState, 'ok');
  assert.equal(follower.job.logisticsError, '');
  assert.equal(follower.job.dateState, 'ok');
  assert.equal(follower.job.logisticsProgress, undefined);
});

test('a split-list entry without a waybill cannot downgrade independently verified PDD parcels', async t => {
  const jump = waybill => `https://mobile.yangkeduo.com/goods_express.html?order_sn=fixture-order&tracking_number=${waybill}&shipping_id=4`;
  const fetchImpl = async url => {
    const target = new URL(url);
    if (target.pathname.includes('order_list_v4')) return response({ orders: target.searchParams.get('type') === 'unreceived'
      ? [{ order_sn: 'fixture-order', tracking_number: 'A', shipping_name: '合成承运商', order_status_text: '待收货' }] : [], has_more: false });
    if (target.pathname.includes('/cabinet/')) return response({ result: {} });
    if (target.pathname.endsWith('/shipping')) return response({ shipping: { tracking_number: 'A', package_info_jump_url: jump('A'),
      traces: [{ timestamp: NOW / 1000, info: 'A运输中' }] } });
    if (target.pathname.endsWith('/split/pack')) return response({ result: { list: [
      ...['A', 'B'].map(tracking_number => ({ tracking_number, shipping_id: 4, shipping_name: '合成承运商', jump_url: jump(tracking_number) })),
      null, { tracking_number: '待发货' },
    ] } });
    if (target.pathname.endsWith('/shipping/track')) return response({ shipping: { tracking_number: 'B',
      traces: [{ timestamp: NOW / 1000, info: 'B运输中' }] } });
    assert.fail(`Unexpected synthetic endpoint: ${target.pathname}`);
  };
  const store = new Store({ key: Buffer.alloc(32, 8), now: () => NOW });
  const account = store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'pdd_user_id=fixture' }, 'fixture', true);
  const jobs = createSyncJobs({ store, now: () => NOW, collector: createCollector({ now: () => NOW, fetchImpl }) });
  t.after(async () => { await jobs.close(); store.close(); });
  const job = await jobs.request(account.id).done;
  const snapshot = store.snapshot([account.id]);
  assert.equal(job.state, 'completed');
  assert.deepEqual(snapshot.shipments.map(parcel => [parcel.waybillNo, parcel.logisticsState]).sort(), [['A', 'ok'], ['B', 'ok']]);
  for (const parcel of snapshot.shipments) assert.equal(parcel.logisticsEvents[0].description, `${parcel.waybillNo}运输中`);
  assert.ok(store.account(account.id).warnings.length > 0);
});

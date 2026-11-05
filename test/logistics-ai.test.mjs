import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { StationStore } from '../src/stations.mjs';
import { LogisticsRuleStore } from '../src/logistics-rule-store.mjs';
import { LogisticsAiJobs } from '../src/logistics-ai.mjs';
import { validateLogisticsSuggestion } from '../src/logistics-ai-template.mjs';

const NOW = Date.parse('2026-11-05T12:00:00+08:00');
const STATION = '合成幸福菜鸟驿站', FRAGMENT = `已交付给${STATION}`;
const reply = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const suggestion = (changes = {}) => ({ kind: 'arrival', starts: ['已交付给'], ends: [], keywords: [STATION], expectedStation: STATION, evidence: [FRAGMENT], ...changes });
const settle = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('automatic logistics worker did not settle');
}

function fixture(t, { config = {}, call, automaticEvents = false, known = true } = {}) {
  let clock = NOW, rules;
  const now = () => clock, key = Buffer.alloc(32, 7), apiKey = randomBytes(24).toString('hex');
  const store = new Store({ key, now, getLogisticsRules: () => rules?.read().rules });
  rules = new LogisticsRuleStore(store.db, now, { onRulesChanged: value => store.refreshLogisticsRules(value) });
  const stations = new StationStore({ db: store.db, key, now });
  stations.saveAiConfig({ channelName: '合成渠道', baseUrl: 'https://api.example.com/v1', model: 'mock', apiKey, enabled: true,
    logisticsEnabled: true, intervalMinutes: 5, ...config });
  if (known) stations.saveStation(null, { name: STATION, enabled: true, aliases: [] });
  const calls = [];
  const assistance = { call: async (channelId, messages, options) => {
    calls.push({ channelId, messages, options });
    if (call) return call(channelId, messages, options);
    assert.equal(stations.reserveAiCall(), true);
    return reply(suggestion());
  } };
  const jobs = new LogisticsAiJobs({ stations, rules, store, assistance, now, automaticEvents });
  const account = store.saveAccount({ platform: 'pdd', label: 'SYNTHETIC_PRIVATE_NAME', cookie: 'SYNTHETIC_PRIVATE_COOKIE' }, undefined, true);
  const ingest = (description = FRAGMENT, extras = {}) => {
    store.importResult(account.id, { orders: [{ platformOrderId: 'PRIVATE_ORDER', title: 'PRIVATE_PRODUCT' }], shipments: [{ platformOrderId: 'PRIVATE_ORDER',
      waybillNo: 'PRIVATE_WAYBILL', status: 'transit', logisticsState: 'ok', logisticsCheckedAt: now(), logisticsUpdatedAt: now(),
      logisticsEvents: [{ time: NOW - 1000, description, timePrecision: 'second' }], ...extras }] });
    return jobs.intake(store.snapshot([account.id]));
  };
  const run = async () => { const result = jobs.runDue(); if (jobs.running) await jobs.running; return result; };
  t.after(async () => { await jobs.close(); store.close(); });
  return { store, stations, rules, jobs, assistance, calls, ingest, run, account, apiKey, now, advance: milliseconds => { clock += milliseconds; } };
}

test('default settings keep logistics disabled and default suggestion mode never saves a rule', async t => {
  const f = fixture(t, { config: { logisticsEnabled: false } });
  assert.equal(f.stations.aiConfig().autoApply, false);
  assert.equal(f.ingest().accepted, 0); assert.equal(f.jobs.candidates().length, 0);
  assert.equal((await f.run()).code, 'AI_AUTOMATIC_DISABLED');
  f.stations.saveAiConfig({ logisticsEnabled: true });
  assert.equal(f.jobs.candidates().length, 1, 'configuration enable scans unresolved cached logs');
  const before = f.rules.read();
  await f.run();
  assert.equal(f.jobs.candidates()[0].status, 'review'); assert.deepEqual(f.rules.read(), before);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.jobs.history(), []);
});

test('automatic queue applies a narrow rule and reparses cache; enabling autoApply revisits suggestions without another AI call', async t => {
  const f = fixture(t, { automaticEvents: true });
  assert.equal(f.ingest().accepted, 1);
  await until(() => f.jobs.candidates()[0]?.status === 'review');
  assert.equal(f.store.snapshot([f.account.id]).shipments[0].arrivalAt, 0);
  f.stations.saveAiConfig({ autoApply: true });
  await until(() => f.jobs.candidates()[0]?.status === 'applied');
  assert.equal(f.calls.length, 1);
  const parcel = f.store.snapshot([f.account.id]).shipments[0];
  assert.equal(parcel.station, STATION); assert.equal(parcel.arrivalAt, NOW - 1000);
  assert.equal(f.jobs.history()[0].canRollback, true);
  assert.deepEqual(f.rules.read().rules[0].keywords, [STATION]);
});

test('only the selected public action and independently known station cross the AI boundary', async t => {
  const f = fixture(t);
  f.ingest(`收件人张三，您的快件${FRAGMENT}，电话13812345678，取件码7-6-7042，运单号AB123456789，邮箱private@example.com，https://private.example.com`);
  await f.run();
  const input = JSON.parse(f.calls[0].messages[1].content);
  assert.deepEqual(input, { fragment: FRAGMENT, expectedStation: STATION });
  assert.doesNotMatch(JSON.stringify(f.calls), /张三|13812345678|7042|AB123456789|private@example|PRIVATE_|SYNTHETIC_PRIVATE/u);
  assert.equal(JSON.stringify(f.calls).includes(f.apiKey), false);
  assert.doesNotMatch(JSON.stringify(f.jobs.candidates()), /张三|13812345678|7042|AB123456789|private@example|PRIVATE_/u);
});

test('unknown station names remain local review until independent catalog evidence exists', async t => {
  const f = fixture(t, { known: false, config: { autoApply: true } });
  f.ingest(); await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.jobs.candidates()[0].reason, 'NO_STATION_EVIDENCE');
  f.stations.saveStation(null, { name: STATION, aliases: [], enabled: true });
  f.jobs.intake(f.store.snapshot([f.account.id])); await f.run();
  assert.equal(f.calls.length, 1); assert.equal(f.jobs.candidates()[0].status, 'applied');
});

test('broad starts, missing literal station scope, invented evidence and executable fields stay review', async t => {
  for (const bad of [{ starts: ['已'] }, { starts: ['交付给'] }, { keywords: [] }, { expectedStation: '菜鸟驿站' },
    { evidence: ['模型猜测'] }, { regex: '.*' }, { script: 'fetch(private)' }]) {
    await t.test(JSON.stringify(bad), async child => {
      const f = fixture(child, { config: { autoApply: true }, call: async () => reply(suggestion(bad)) });
      const before = f.rules.read(); f.ingest(); await f.run();
      assert.equal(f.jobs.candidates()[0].status, 'review'); assert.deepEqual(f.rules.read(), before);
    });
  }
});

test('unrealized, hub, reminder and sensitive station fragments are rejected before a provider call', async t => {
  const f = fixture(t, { config: { autoApply: true } });
  for (const raw of [`尚未${FRAGMENT}`, `预计${FRAGMENT}`, `下一站${FRAGMENT}`, `请快递员${FRAGMENT}`, `退回后${FRAGMENT}`,
    `催取提醒：${FRAGMENT}`, '已交付给杭州转运中心', '已交付给13812345678菜鸟驿站', '已交付给javascript:alert菜鸟驿站']) {
    f.ingest(raw);
  }
  await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.jobs.candidates().length, 0);
});

test('a known location-only sample blocks a conflicting auto arrival', async t => {
  const f = fixture(t, { config: { autoApply: true } });
  const local = { id: 'human-location', name: '位置', enabled: true, kind: 'location', starts: ['已交付给'], end: '', keywords: [],
    sample: FRAGMENT, expectedStation: STATION, origin: 'manual' };
  f.rules.save({ revision: f.rules.read().revision, rules: [local, ...f.rules.read().rules] });
  const before = f.rules.read(); f.ingest(); await f.run();
  assert.equal(f.jobs.candidates()[0].status, 'review'); assert.match(f.jobs.candidates()[0].error, /安全回归/u); assert.deepEqual(f.rules.read(), before);
});

test('rollback increments the current revision and preserves unrelated human rule additions', async t => {
  const f = fixture(t, { config: { autoApply: true } });
  f.ingest(); await f.run();
  const candidate = f.jobs.candidates()[0]; assert.equal(candidate.status, 'applied');
  const current = f.rules.read(), addition = { ...current.defaults[0], id: 'human-addition', name: '人工独立规则' };
  f.rules.save({ revision: current.revision, rules: [addition, ...current.rules] });
  const revision = f.rules.read().revision;
  assert.equal(f.jobs.rollback(candidate.id).status, 'rolled_back');
  assert.equal(f.rules.read().revision, revision + 1); assert.deepEqual(f.rules.read().rules[0], addition);
  assert.ok(!f.rules.read().rules.some(rule => rule.id === candidate.rule.id));
  assert.equal(f.store.snapshot([f.account.id]).shipments[0].arrivalAt, 0);
  assert.throws(() => f.jobs.rollback(candidate.id), { code: 'AI_ROLLBACK_CONFLICT' });
});

test('rollback refuses a human-edited generated rule without changing any history or configuration', async t => {
  const f = fixture(t, { config: { autoApply: true } }); f.ingest(); await f.run();
  const candidate = f.jobs.candidates()[0], current = f.rules.read();
  f.rules.save({ revision: current.revision, rules: current.rules.map(rule => rule.id === candidate.rule.id ? { ...rule, name: '人工编辑后' } : rule) });
  const before = f.rules.read(); assert.equal(f.jobs.history()[0].canRollback, false);
  assert.throws(() => f.jobs.rollback(candidate.id), { code: 'AI_ROLLBACK_CONFLICT' });
  assert.deepEqual(f.rules.read(), before); assert.equal(f.jobs.candidates()[0].status, 'applied');
});

test('configuration pause or channel switch cancels in-flight work and late replies cannot mutate candidates or rules', async t => {
  for (const change of ['pause', 'channel', 'apply-off', 'logistics-off']) {
    await t.test(change, async child => {
      let finish;
      const f = fixture(child, { config: { autoApply: true }, call: () => new Promise(resolve => { finish = resolve; }) });
      f.ingest(); f.jobs.runDue(); const running = f.jobs.running; await settle();
      const before = f.jobs.candidates(), rulesBefore = f.rules.read();
      if (change === 'channel') {
        const channel = f.stations.saveAiChannel(null, { name: '第二合成渠道', baseUrl: 'https://two.example.com/v1', model: 'mock', apiKey: randomBytes(24).toString('hex') });
        f.stations.saveAiConfig({ channelId: channel.id });
      } else f.stations.saveAiConfig(change === 'pause' ? { enabled: false } : change === 'apply-off' ? { autoApply: false } : { logisticsEnabled: false });
      await running; assert.equal(f.calls[0].options.signal.aborted, true);
      finish(reply(suggestion())); await settle();
      assert.deepEqual(f.jobs.candidates(), before); assert.deepEqual(f.rules.read(), rulesBefore);
    });
  }
});

test('close cancels an unresolved provider promise promptly and prevents future writes', async t => {
  const f = fixture(t, { config: { autoApply: true }, call: () => new Promise(() => {}) });
  f.ingest(); f.jobs.runDue(); await settle(); await f.jobs.close();
  assert.equal(f.jobs.runDue().code, 'SERVICE_STOPPING');
  assert.equal(f.jobs.intake({ shipments: [] }).accepted, 0); assert.equal(f.jobs.history().length, 0);
});

test('quota errors are safe, do not consume retry attempts, and never apply a rule', async t => {
  const f = fixture(t, { config: { autoApply: true }, call: async () => { throw Object.assign(new Error('PRIVATE_PROVIDER_BODY'), { code: 'AI_DAILY_LIMIT' }); } });
  f.ingest(); await f.run();
  assert.equal(f.jobs.candidates()[0].status, 'failed'); assert.equal(f.jobs.candidates()[0].attempts, 0);
  assert.doesNotMatch(JSON.stringify(f.jobs.candidates()), /PRIVATE_PROVIDER_BODY/u); assert.equal(f.jobs.history().length, 0);
});

test('failed calls retry at the independently persisted interval and stop after three attempts', async t => {
  const f = fixture(t, { call: async () => { throw new Error('PRIVATE_ERROR'); } });
  f.ingest(); await f.run();
  assert.equal(f.jobs.candidates()[0].attempts, 1); assert.equal(f.calls.length, 1);
  assert.equal((await f.run()).accepted, false);
  f.stations.markAiRun();
  for (let i = 0; i < 2; i++) { f.advance(360 * 60000); await f.run(); }
  assert.equal(f.calls.length, 3); assert.equal(f.jobs.candidates()[0].attempts, 3);
  f.advance(360 * 60000); assert.equal((await f.run()).code, 'AI_NO_PENDING'); assert.equal(f.calls.length, 3);
  assert.doesNotMatch(JSON.stringify(f.jobs.candidates()), /PRIVATE_ERROR/u);
});

test('ignored pending or in-flight candidates remain ignored and cannot later apply', async t => {
  let finish;
  const f = fixture(t, { config: { autoApply: true }, call: () => new Promise(resolve => { finish = resolve; }) });
  f.ingest(); f.jobs.runDue(); await settle();
  const id = f.jobs.candidates()[0].id; f.jobs.ignore(id); finish(reply(suggestion())); await f.jobs.running;
  assert.equal(f.jobs.candidates()[0].status, 'ignored'); assert.equal(f.jobs.history().length, 0);
  f.jobs.intake(f.store.snapshot([f.account.id])); assert.equal(f.jobs.candidates()[0].status, 'ignored');
});

test('template capability validation accepts only synthetic narrow literal rule responses', () => {
  const result = validateLogisticsSuggestion(suggestion(), { fragment: FRAGMENT, expectedStation: STATION });
  assert.equal(result.rule.origin, 'manual'); assert.equal(result.rule.sample, FRAGMENT);
  assert.throws(() => validateLogisticsSuggestion(suggestion({ starts: ['已'] }), { fragment: FRAGMENT, expectedStation: STATION }), { code: 'AI_INVALID_RESULT' });
});

test('terminal cached history blocks application, and a later cache revision allows safe reevaluation', async t => {
  const f = fixture(t, { config: { autoApply: true } });
  f.ingest();
  const other = { platformOrderId: 'PRIVATE_ORDER', waybillNo: 'OTHER_WAYBILL', status: 'signed', logisticsState: 'ok',
    logisticsEvents: [{ time: NOW - 1000, description: FRAGMENT, timePrecision: 'second' }] };
  f.store.importResult(f.account.id, { orders: [], shipments: [other] });
  await f.run(); assert.equal(f.jobs.candidates()[0].status, 'review');
  assert.equal((await f.run()).code, 'AI_NO_PENDING');
  f.store.importResult(f.account.id, { orders: [], shipments: [{ ...other, status: 'transit' }] });
  await f.run(); assert.equal(f.jobs.candidates()[0].status, 'applied'); assert.equal(f.calls.length, 1);
});

test('capacity failure stays review without repeated calls or a zero-delay rescheduling loop', async t => {
  const f = fixture(t); f.ingest(); await f.run();
  const defaults = f.rules.read().defaults;
  f.rules.save({ revision: f.rules.read().revision, rules: Array.from({ length: 100 }, (_, i) => ({ ...defaults[i % defaults.length], id: `human-${i}` })) });
  f.stations.saveAiConfig({ autoApply: true }); await f.run();
  assert.equal(f.jobs.candidates()[0].status, 'review'); assert.equal(f.jobs.candidates()[0].attempts, 1);
  assert.equal(f.jobs.candidates()[0].applyCheckedKey, f.jobs.checkKey());
  assert.equal((await f.run()).code, 'AI_NO_PENDING'); assert.equal(f.calls.length, 1); assert.equal(f.rules.read().rules.length, 100);
});

test('a failed reparse hook atomically restores rules, cached evidence and application history', async t => {
  const f = fixture(t, { config: { autoApply: true } }); f.ingest();
  const before = f.rules.read(), parcelBefore = f.store.snapshot([f.account.id]).shipments[0];
  const original = f.rules.onRulesChanged;
  f.rules.onRulesChanged = rules => { original(rules); throw new Error('LOCAL_FAILURE'); };
  await f.run();
  assert.deepEqual(f.rules.read(), before); assert.deepEqual(f.store.snapshot([f.account.id]).shipments[0], parcelBefore);
  assert.deepEqual(f.jobs.history(), []); assert.equal(f.jobs.candidates()[0].status, 'review'); assert.equal(f.jobs.candidates()[0].attempts, 1);
  assert.equal((await f.run()).code, 'AI_NO_PENDING');
});

test('disabled accounts and archived dates or event timestamps never enter an AI request', async t => {
  for (const archived of ['account', 'order', 'override', 'event']) {
    await t.test(archived, async child => {
      const f = fixture(child, { config: { logisticsEnabled: false, autoApply: true } });
      f.ingest(FRAGMENT, archived === 'event' ? { logisticsEvents: [{ time: NOW - 46 * 86400000, description: FRAGMENT }] } : {});
      if (archived === 'account') f.store.saveAccount({ enabled: false }, f.account.id, true);
      if (['order', 'override'].includes(archived)) {
        const order = f.store.snapshot([f.account.id]).orders[0];
        if (archived === 'override') order.dateOverride = '2026-08-01'; else order.orderDate = NOW - 46 * 86400000;
        f.store.db.prepare('UPDATE orders SET data=? WHERE id=?').run(JSON.stringify(order), order.id);
      }
      f.stations.saveAiConfig({ logisticsEnabled: true }); await f.run();
      assert.equal(f.calls.length, 0); assert.equal(f.jobs.candidates().length, 0);
    });
  }
});

test('disabling an account after intake prevents pending network work and later activation can requeue it', async t => {
  const f = fixture(t, { config: { autoApply: true } }); f.ingest();
  f.store.saveAccount({ enabled: false }, f.account.id, true); await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.jobs.candidates()[0].reason, 'NO_ACTIVE_EVIDENCE');
  f.store.saveAccount({ enabled: true }, f.account.id, true);
  f.jobs.intake(f.store.snapshot([f.account.id])); await f.run();
  assert.equal(f.calls.length, 1); assert.equal(f.jobs.candidates()[0].status, 'applied');
});

test('worker restart retains candidates and its own interval independently from station job timestamps', async t => {
  const f = fixture(t, { call: async () => { throw new Error('temporary'); } });
  f.ingest(); await f.run(); await f.jobs.close();
  const jobs = new LogisticsAiJobs({ stations: f.stations, rules: f.rules, store: f.store, assistance: f.assistance, now: f.now, automaticEvents: false });
  try {
    assert.equal(jobs.candidates()[0].attempts, 1); assert.equal(jobs.nextRunAt(), NOW + 360 * 60000);
    f.advance(360 * 60000); f.stations.markAiRun();
    assert.equal(jobs.runDue().accepted, true); await jobs.running;
    assert.equal(f.calls.length, 2); assert.equal(jobs.candidates()[0].attempts, 2);
  } finally { await jobs.close(); }
});

test('review application is not blocked by an older queued candidate waiting for the next AI interval', async t => {
  const f = fixture(t), other = '合成远洋菜鸟驿站';
  f.ingest(`已寄存至${other}`);
  f.ingest(); await f.run();
  assert.equal(f.calls.length, 1);
  f.stations.saveStation(null, { name: other, aliases: [], enabled: true });
  f.stations.saveAiConfig({ autoApply: true }); await f.run();
  assert.equal(f.jobs.candidates().find(candidate => candidate.expectedStation === STATION).status, 'applied');
  assert.equal(f.jobs.candidates().find(candidate => candidate.expectedStation === other).status, 'pending');
  assert.equal(f.calls.length, 1);
});

test('a fresh identical evidence fragment updates an expired queued source without creating duplicates', async t => {
  const f = fixture(t); f.ingest();
  f.advance(46 * 86400000);
  const oldOrder = f.store.snapshot([f.account.id]).orders[0];
  f.store.db.prepare('UPDATE orders SET data=? WHERE id=?').run(JSON.stringify({ ...oldOrder, firstSeenAt: f.now() }), oldOrder.id);
  f.ingest(FRAGMENT, { logisticsEvents: [{ time: f.now() - 1000, description: FRAGMENT, timePrecision: 'second' }] });
  await f.run();
  assert.equal(f.jobs.candidates().length, 1); assert.equal(f.jobs.candidates()[0].eventTime, f.now() - 1000);
  assert.equal(f.calls.length, 1); assert.equal(f.jobs.candidates()[0].status, 'review');
});

test('confirming a station resumes an unresolved cached logistics proposal without another intake or analyze click', async t => {
  const f = fixture(t, { known: false, config: { autoApply: true }, automaticEvents: true });
  f.ingest(); assert.equal(f.jobs.candidates()[0].status, 'review'); assert.equal(f.calls.length, 0);
  f.stations.saveStation(null, { name: STATION, aliases: [], enabled: true });
  await until(() => f.jobs.candidates()[0]?.status === 'applied');
  assert.equal(f.calls.length, 1); assert.equal(f.store.snapshot([f.account.id]).shipments[0].arrivalAt, NOW - 1000);
});

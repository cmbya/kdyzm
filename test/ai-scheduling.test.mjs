import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { StationStore } from '../src/stations.mjs';
import { StationAiJobs } from '../src/station-ai.mjs';
import { AiAssistance } from '../src/ai-assistance.mjs';
import { LogisticsRuleStore } from '../src/logistics-rule-store.mjs';
import { LogisticsAiJobs } from '../src/logistics-ai.mjs';
import { TEMPLATE_SAMPLE, LOGISTICS_TEST_RESULT } from '../src/ai-templates.mjs';

const NOW = Date.parse('2026-11-05T12:00:00+08:00'), SIX_HOURS = 360 * 60000;
const STATION = '合成幸福菜鸟驿站';
const template = { name: '合成模板', signature: '合成快递', keywords: ['取件码'], kind: 'pickup', rules: { code: { start: '取件码', end: '，' }, express: { start: '', end: '' }, address: { start: '已到', end: '，' } } };
const reply = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture(t, { automaticEvents = true } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  let rules, sequence = 0;
  const key = randomBytes(32), store = new Store({ key, getLogisticsRules: () => rules?.read().rules });
  rules = new LogisticsRuleStore(store.db, Date.now, { onRulesChanged: value => store.refreshLogisticsRules(value) });
  const stations = new StationStore({ db: store.db, key });
  stations.saveAiConfig({ channelName: '合成渠道', baseUrl: 'https://api.example.com/v1', model: 'synthetic', apiKey: randomBytes(24).toString('hex'), enabled: true, logisticsEnabled: true });
  stations.saveStation('known', { name: STATION });
  const calls = [], failures = new Set();
  const request = async outbound => {
    const input = JSON.parse(JSON.parse(outbound.body).messages[1].content); calls.push(input);
    if (failures.has(input.fragment)) throw Object.assign(new Error('synthetic transient'), { code: 'AI_HTTP_ERROR', retryable: true });
    return reply(input.sample ? template : input.expectedStation ? (input.expectedStation === LOGISTICS_TEST_RESULT.expectedStation ? LOGISTICS_TEST_RESULT
      : { kind: 'arrival', starts: [input.fragment.slice(0, input.fragment.indexOf(input.expectedStation))], ends: [], keywords: [input.expectedStation], expectedStation: input.expectedStation, evidence: [input.fragment] })
      : { kind: 'locker', suggestedName: input.fragment, alias: input.fragment, subLocation: '', evidence: [input.fragment] });
  };
  const assistance = new AiAssistance({ stations, request });
  const stationJobs = new StationAiJobs({ stations, request, automaticEvents });
  const logisticsJobs = new LogisticsAiJobs({ stations, rules, store, assistance, automaticEvents });
  const account = store.saveAccount({ platform: 'pdd', label: '合成账号', cookie: randomBytes(24).toString('hex') }, undefined, true);
  const enqueue = (fragment, id = `station-${++sequence}`) => stations.enqueue([{ id, stationName: fragment, fragment }]);
  const ingest = (name = STATION, id = 'order-1') => {
    store.importResult(account.id, { orders: [{ platformOrderId: id, title: '合成包裹', orderDate: Date.now() - 1000 }],
      shipments: [{ platformOrderId: id, waybillNo: `synthetic-${id}`, status: 'transit', logisticsState: 'ok',
        logisticsEvents: [{ time: NOW - 1000, description: `已交付给${name}`, timePrecision: 'second' }] }] });
    return logisticsJobs.intake(store.snapshot([account.id]));
  };
  const advance = async milliseconds => { t.mock.timers.tick(milliseconds); await settle(); };
  t.after(async () => { await stationJobs.close(); await logisticsJobs.close(); assistance.close(); store.close(); });
  return { store, stations, rules, assistance, stationJobs, logisticsJobs, calls, failures, enqueue, ingest, advance, key, account };
}

test('new station evidence wakes the real timer, batches during a shared minute and deduplicates polling and uploads', async t => {
  const f = fixture(t);
  f.enqueue('首个合成驿站', 'first'); await f.advance(0);
  assert.equal(f.calls.length, 1); assert.equal(f.stations.aiConfig().nextRunAt, NOW + SIX_HOURS);
  f.enqueue('第二个合成驿站', 'second'); f.enqueue('第三个合成驿站', 'third');
  for (let i = 0; i < 10; i++) {
    f.enqueue('第二个合成驿站', i % 2 ? 'second' : `same-content-${i}`);
    f.stationJobs.runDue(); f.stations.aiConfig(); f.stations.candidates(); f.assistance.channels();
  }
  await f.advance(59999); assert.equal(f.calls.length, 1);
  await f.advance(1); assert.equal(f.calls.length, 3);
  assert.equal(f.stations.aiConfig().lastRunAt, NOW, 'events do not postpone the six-hour fallback');
  assert.equal(f.stations.stations().length, 1, 'suggestions do not create or force-match a station');
  await f.advance(SIX_HOURS); assert.equal(f.calls.length, 3, 'completed or duplicate evidence makes no new request');
});

test('only new evidence bypasses six hours; transient failures retain cooldown and finite attempts across worker restart', async t => {
  const f = fixture(t), failed = '需要重试的合成驿站';
  f.failures.add(failed); f.enqueue(failed); await f.advance(0);
  const candidate = f.stations.candidates()[0];
  assert.equal(f.calls.length, 1); assert.equal(candidate.eventPending, false); assert.equal(candidate.retryAt, NOW + SIX_HOURS);
  f.enqueue('新发现的合成驿站'); await f.advance(60000);
  assert.equal(f.calls.length, 2); assert.equal(f.calls.filter(input => input.fragment === failed).length, 1);
  await f.stationJobs.close();
  const restarted = new StationAiJobs({ stations: f.stations, request: f.stationJobs.transport });
  t.after(() => restarted.close());
  await f.advance(SIX_HOURS - 60001); assert.equal(f.calls.length, 2);
  await f.advance(1); assert.equal(f.calls.filter(input => input.fragment === failed).length, 2);
  await f.advance(SIX_HOURS); assert.equal(f.calls.filter(input => input.fragment === failed).length, 3);
  await f.advance(SIX_HOURS); assert.equal(f.calls.filter(input => input.fragment === failed).length, 3);
});

test('persisted pre-event pending work uses a real six-hour timer without a manual run', async t => {
  const f = fixture(t, { automaticEvents: false });
  f.enqueue('旧队列合成驿站');
  const candidate = f.stations.candidates()[0]; f.stations.updateCandidate(candidate.id, { eventPending: false });
  f.stations.markAiRun();
  const jobs = new StationAiJobs({ stations: f.stations, request: f.stationJobs.transport });
  t.after(() => jobs.close());
  await f.advance(SIX_HOURS - 1); assert.equal(f.calls.length, 0);
  await f.advance(1); assert.equal(f.calls.length, 1);
  await f.advance(SIX_HOURS); assert.equal(f.calls.length, 1);
});

test('logistics new evidence triggers timers without duplicate snapshot calls', async t => {
  const f = fixture(t), second = '合成远洋菜鸟驿站';
  f.ingest(); await f.advance(0); assert.equal(f.calls.length, 1);
  f.stations.saveStation('second', { name: second });
  f.ingest(second, 'order-2');
  for (let i = 0; i < 10; i++) { f.logisticsJobs.intake(f.store.snapshot([f.account.id])); f.logisticsJobs.runDue(); }
  await f.advance(59999); assert.equal(f.calls.length, 1);
  await f.advance(1); assert.equal(f.calls.length, 2);
  assert.equal(f.logisticsJobs.nextRunAt(), NOW + SIX_HOURS);
  assert.equal(f.rules.read().rules.filter(rule => rule.origin === 'ai').length, 0);
  assert.ok(f.store.snapshot([f.account.id]).shipments.every(shipment => !shipment.arrivalAt));
  await f.advance(SIX_HOURS); assert.equal(f.calls.length, 2);
});

test('unconfirmed logistics locations proactively request only a public station suggestion until independent confirmation', async t => {
  const f = fixture(t), unconfirmed = '尚待确认的合成驿站';
  f.ingest(unconfirmed); await f.advance(0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].fragment, unconfirmed); assert.equal(f.calls[0].expectedStation, undefined);
  assert.equal(f.stations.candidates()[0].status, 'review'); assert.equal(f.stations.stations().length, 1);
  assert.equal(f.logisticsJobs.candidates()[0].reason, 'NO_STATION_EVIDENCE');
  for (let i = 0; i < 5; i++) f.logisticsJobs.intake(f.store.snapshot([f.account.id]));
  await f.advance(60000); assert.equal(f.calls.length, 1);
  f.stations.saveStation('confirmed', { name: unconfirmed }); await f.advance(0);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].expectedStation, unconfirmed);
  assert.equal(f.logisticsJobs.candidates()[0].status, 'review');
  assert.equal(f.rules.read().rules.filter(rule => rule.origin === 'ai').length, 0);
  assert.equal(f.store.snapshot([f.account.id]).shipments[0].arrivalAt, 0);
});

test('station and logistics evidence share an event cooldown and a disabled switch never schedules a provider', async t => {
  const f = fixture(t);
  f.enqueue('第一站点证据'); f.ingest(); await f.advance(0);
  assert.equal(f.calls.length, 2);
  f.enqueue('后续站点证据'); f.stations.saveStation('second', { name: '另一合成菜鸟驿站' }); f.ingest('另一合成菜鸟驿站', 'order-2');
  await f.advance(60000);
  assert.equal(f.calls.length, 3, 'one event batch wins the shared cooldown');
  await f.advance(60000); assert.equal(f.calls.length, 4);
  f.stations.saveAiConfig({ enabled: false }); f.enqueue('暂停后的新证据');
  await f.advance(SIX_HOURS); assert.equal(f.calls.length, 4);
});

test('confirming a safe alias while intake discovers a new station does not reenter or duplicate automatic application', async t => {
  const f = fixture(t), alias = `${STATION}2号柜`, unconfirmed = '缓存中未确认的合成驿站';
  f.enqueue(alias);
  const candidate = f.stations.candidates()[0];
  f.stations.recordSuggestion(candidate.id, { kind: 'locker', targetStationId: 'known', alias, subLocation: '2号柜', evidence: [alias] });
  f.store.importResult(f.account.id, { orders: [{ platformOrderId: 'cached', title: '合成包裹', orderDate: NOW - 1000 }],
    shipments: [{ platformOrderId: 'cached', waybillNo: 'cached-synthetic', status: 'transit', logisticsState: 'ok',
      logisticsEvents: [{ time: NOW - 1000, description: `已交付给${unconfirmed}`, timePrecision: 'second' }] }] });
  f.stations.saveAiConfig({ autoApply: true }); await f.advance(0);
  assert.equal(f.stations.candidate(candidate.id).status, 'approved');
  assert.equal(f.stations.revision, 2); assert.equal(f.stations.station('known').aliases.length, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].fragment, unconfirmed);
  assert.equal(f.logisticsJobs.candidates()[0].reason, 'NO_STATION_EVIDENCE');
});

test('capability checks, phone templates, station jobs and logistics share a hard twenty-call limit across channels', async t => {
  const f = fixture(t, { automaticEvents: false }), id = f.stations.aiConfig().channelId;
  assert.equal((await f.assistance.test(id)).ok, true);
  await f.assistance.template({ sample: TEMPLATE_SAMPLE, expectedCode: '654321' }, 'device-a', () => {});
  f.ingest(); f.logisticsJobs.runDue(); await f.logisticsJobs.running;
  f.enqueue('人工分析证据'); f.stationJobs.request(); await f.stationJobs.running;
  assert.equal(f.calls.length, 6);
  f.stations.saveAiConfig({ dailyLimit: 200 });
  for (let i = 0; i < 20; i++) f.enqueue(`自动证据合成驿站${i}`);
  await f.advance(60000); f.stationJobs.runDue(); await f.stationJobs.running;
  assert.equal(f.calls.length, 20); assert.equal(f.stations.aiConfig().usageToday, 20);
  const second = f.stations.saveAiChannel(undefined, { name: '第二合成渠道', baseUrl: 'https://second.example.com/v1', model: 'synthetic', apiKey: randomBytes(24).toString('hex') });
  f.stations.saveAiConfig({ channelId: second.id });
  assert.equal((await f.assistance.test(second.id)).capabilities.station_alias.code, 'AI_DAILY_LIMIT');
  await assert.rejects(f.assistance.template({ sample: TEMPLATE_SAMPLE, expectedCode: '654321' }, 'device-b', () => {}), { code: 'AI_DAILY_LIMIT' });
  assert.equal(f.calls.length, 20);
});

test('the automatic quota timer resumes at Shanghai midnight without polling and honors lower limits', async t => {
  const f = fixture(t); f.stations.saveAiConfig({ dailyLimit: 1 });
  f.enqueue('当天站点'); await f.advance(0);
  f.enqueue('次日站点'); await f.advance(12 * 3600000 - 1); assert.equal(f.calls.length, 1);
  await f.advance(1); assert.equal(f.calls.length, 2); assert.equal(f.stations.aiConfig().usageToday, 1);
  assert.equal(f.stations.aiConfig().dailyLimit, 1);
});

test('a phone template exhausting quota after a station timer is armed requeues that timer for midnight', async t => {
  const f = fixture(t); f.stations.saveAiConfig({ dailyLimit: 2 });
  f.enqueue('当天先分析的站点'); await f.advance(0);
  f.enqueue('等待跨日额度的站点');
  await f.assistance.template({ sample: TEMPLATE_SAMPLE, expectedCode: '654321' }, 'quota-device', () => {});
  assert.equal(f.calls.length, 2);
  const codes = [], runDue = f.stationJobs.runDue.bind(f.stationJobs);
  f.stationJobs.runDue = () => { const result = runDue(); codes.push(result.code); return result; };
  await f.advance(60000);
  assert.deepEqual(codes, ['AI_DAILY_LIMIT']); assert.ok(f.stationJobs.scheduled);
  await f.advance(12 * 3600000 - 60001);
  assert.equal(f.calls.length, 2); assert.deepEqual(codes, ['AI_DAILY_LIMIT'], 'quota wait must not create a polling loop');
  await f.advance(1);
  assert.equal(f.calls.length, 3); assert.deepEqual(codes, ['AI_DAILY_LIMIT', 'AI_ACCEPTED']);
  assert.equal(f.stations.aiConfig().usageToday, 1);
  assert.equal(f.stations.candidates().filter(candidate => candidate.status === 'pending').length, 0);
});

test('a logistics call advancing shared cooldown after a station timer is armed preserves the new deadline', async t => {
  const f = fixture(t);
  f.enqueue('首个定时站点'); await f.advance(0);
  f.enqueue('共享冷却后的站点'); await f.advance(30000);
  f.ingest(); await f.advance(0); assert.equal(f.calls.length, 2);
  const codes = [], runDue = f.stationJobs.runDue.bind(f.stationJobs);
  f.stationJobs.runDue = () => { const result = runDue(); codes.push(result.code); return result; };
  await f.advance(30000);
  assert.deepEqual(codes, ['AI_NOT_DUE']); assert.ok(f.stationJobs.scheduled);
  await f.advance(29999); assert.equal(f.calls.length, 2); assert.deepEqual(codes, ['AI_NOT_DUE']);
  await f.advance(1); assert.equal(f.calls.length, 3); assert.deepEqual(codes, ['AI_NOT_DUE', 'AI_ACCEPTED']);
  f.enqueue('停止后保留的候选'); await f.stationJobs.close();
  await f.advance(SIX_HOURS); assert.equal(f.calls.length, 3); assert.deepEqual(codes, ['AI_NOT_DUE', 'AI_ACCEPTED']);
});

test('stored hourly or excessive settings migrate durably without changing switches, default revision or encrypted credentials', t => {
  const f = fixture(t, { automaticEvents: false });
  for (const limit of [35, 7]) {
    const row = f.store.db.prepare('SELECT data,credential FROM station_ai_settings WHERE id=1').get();
    const previous = { ...JSON.parse(row.data), intervalMinutes: 60, dailyLimit: limit, autoApply: false, enabled: true, logisticsEnabled: false };
    f.store.db.prepare('UPDATE station_ai_settings SET data=? WHERE id=1').run(JSON.stringify(previous));
    const channels = f.store.db.prepare('SELECT * FROM ai_channels').all();
    const migrated = new StationStore({ db: f.store.db, key: f.key });
    const after = f.store.db.prepare('SELECT data,credential FROM station_ai_settings WHERE id=1').get();
    assert.deepEqual(JSON.parse(after.data), { ...previous, intervalMinutes: 360, dailyLimit: Math.min(limit, 20) });
    assert.equal(after.credential, row.credential); assert.deepEqual(f.store.db.prepare('SELECT * FROM ai_channels').all(), channels);
    assert.equal(migrated.aiConfig().intervalMinutes, 360); assert.equal(migrated.aiConfig().dailyLimit, Math.min(limit, 20));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { StationStore } from '../src/stations.mjs';
import { LogisticsRuleStore } from '../src/logistics-rule-store.mjs';
import { LogisticsAiJobs } from '../src/logistics-ai.mjs';
import { AiAssistance } from '../src/ai-assistance.mjs';
import { LogisticsDailyLearning } from '../src/logistics-daily-learning.mjs';

const NOW = Date.parse('2026-11-09T03:00:00+08:00'), DAY = 86400000;
const STATION = '合成幸福菜鸟驿站', FRAGMENT = `已交付给${STATION}`;
const reply = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { config = {}, request, automaticEvents = false } = {}) {
  let clock = NOW, rules, sequence = 0;
  const now = () => clock, key = Buffer.alloc(32, 6);
  const store = new Store({ key, now, getLogisticsRules: () => rules?.read().rules });
  rules = new LogisticsRuleStore(store.db, now, { onRulesChanged: value => store.refreshLogisticsRules(value) });
  const stations = new StationStore({ db: store.db, key, now });
  stations.saveAiConfig({ enabled: true, logisticsEnabled: true, channelName: '合成服务', model: 'synthetic',
    baseUrl: 'https://example.com/v1', apiKey: 'test-only', ...config });
  stations.saveStation('known', { name: STATION });
  const calls = [];
  const assistance = new AiAssistance({ stations, now, request: async outbound => {
    const input = JSON.parse(JSON.parse(outbound.body).messages[1].content); calls.push(input);
    if (request) return request(input);
    return reply({ kind: 'arrival', starts: [input.fragment.slice(0, input.fragment.indexOf(input.expectedStation))], ends: [],
      keywords: [input.expectedStation], expectedStation: input.expectedStation, evidence: [input.fragment] });
  } });
  const logisticsAi = new LogisticsAiJobs({ stations, rules, store, assistance, now, automaticEvents: false });
  let daily = new LogisticsDailyLearning({ store, stations, logisticsAi, now, automaticEvents });
  const account = store.saveAccount({ platform: 'pdd', label: 'PRIVATE_NAME', cookie: 'PRIVATE_COOKIE' }, undefined, true);
  const ingest = (extras = {}, description = FRAGMENT) => {
    const id = `synthetic-${++sequence}`;
    store.importResult(account.id, { orders: [{ platformOrderId: id, title: 'PRIVATE_PRODUCT', orderDate: now() - 1000 }],
      shipments: [{ platformOrderId: id, waybillNo: id, status: 'transit', logisticsState: 'ok', logisticsCheckedAt: now(),
        logisticsEvents: [{ time: NOW - 1000, timePrecision: 'second', description }], ...extras }] });
    return store.snapshot([account.id]).shipments.find(shipment => shipment.waybillNo === id);
  };
  const run = async () => { const result = daily.runDue(); if (daily.running) await daily.running; return result; };
  const restart = async () => { await daily.close(); daily = new LogisticsDailyLearning({ store, stations, logisticsAi, now, automaticEvents }); return daily; };
  t.after(async () => { await daily.close(); await logisticsAi.close(); assistance.close(); store.close(); });
  return { store, rules, stations, logisticsAi, calls, assistance, ingest, run, restart, get daily() { return daily; },
    now, advance: value => { clock += value; }, at: value => { clock = Date.parse(value); } };
}

test('Shanghai 03:00 cutoff catches up once and survives restart without repeating scans', async t => {
  const f = fixture(t); f.at('2026-11-09T02:59:59+08:00');
  await f.run();
  assert.equal(f.daily.summary().lastRun.day, '2026-11-08');
  assert.equal(f.daily.summary().nextRunAt, NOW);
  assert.equal((await f.run()).code, 'DAILY_ALREADY_RUN');
  await f.restart(); assert.equal((await f.run()).code, 'DAILY_ALREADY_RUN');
  f.advance(1000); await f.run();
  assert.equal(f.daily.summary().lastRun.day, '2026-11-09');
  assert.equal(f.daily.summary().nextRunAt, NOW + DAY);
  assert.equal(f.calls.length, 0);
});

test('empty and single-shipment samples make no AI calls; repeats within one parcel are not high frequency', async t => {
  const f = fixture(t); await f.run();
  assert.equal(f.daily.summary().lastRun.aiStatus, 'no_candidates');
  f.advance(DAY); f.ingest({ logisticsEvents: Array.from({ length: 3 }, (_, i) => ({ time: NOW - i * 1000 - 1, description: FRAGMENT, timePrecision: 'second' })) });
  await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.logisticsAi.candidates().length, 0);
  assert.equal(f.daily.summary().lastRun.highFrequencyGroups, 0);
});

test('new repeated public actions use the real shared assistance, stay review and do not leak private details', async t => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) f.ingest({}, `收件人张三，${FRAGMENT}，电话13812345678，取件码7-6-7042`);
  await f.run();
  const summary = f.daily.summary();
  assert.equal(f.calls.length, 1); assert.equal(f.stations.aiConfig().usageToday, 1);
  assert.equal(summary.lastRun.scanStatus, 'complete'); assert.equal(summary.lastRun.aiStatus, 'awaiting_review');
  assert.equal(summary.lastRun.candidateCount, 1); assert.equal(summary.lastRun.processedCount, 1);
  assert.equal(summary.lastRun.states.review, 1); assert.equal(summary.lastRun.backfilledCount, 0);
  assert.equal(f.logisticsAi.candidates()[0].dailyRunDay, '2026-11-09');
  assert.deepEqual(f.calls, [{ fragment: FRAGMENT, expectedStation: STATION }]);
  assert.doesNotMatch(JSON.stringify(summary), /13812345678|张三|PRIVATE_|7042/u);
  f.advance(DAY); await f.run();
  assert.equal(f.daily.summary().lastRun.changed, 0); assert.equal(f.calls.length, 1);
});

test('two distinct parcels arriving on separate days form a new high frequency group', async t => {
  const f = fixture(t); f.ingest(); await f.run(); assert.equal(f.calls.length, 0);
  f.advance(DAY); f.ingest(); await f.run();
  assert.equal(f.daily.summary().lastRun.changed, 1); assert.equal(f.calls.length, 1);
});

test('unknown time, unknown precision and conflicting raw timestamps remain local review and preserve trusted times', async t => {
  const f = fixture(t, { config: { autoApply: true } });
  const missing = { time: 0, timeText: '昨天 18:25', timePrecision: 'unknown', description: FRAGMENT };
  const conflict = { time: NOW - 1000, timeText: '2026-11-08 15:00:00', timePrecision: 'second', description: FRAGMENT };
  f.ingest({ logisticsEvents: [missing] }); f.ingest({ logisticsEvents: [missing] });
  f.ingest({ logisticsEvents: [conflict] }); f.ingest({ logisticsEvents: [conflict] });
  const trusted = f.ingest({ arrivalAt: NOW - 2000, arrivalAtSource: 'locker_arrival', arrivalAtPrecision: 'unknown',
    station: STATION, stationSource: 'locker', logisticsEvents: [{ time: NOW - 2000, timeText: '时间待确认', timePrecision: 'unknown', description: `请您到${STATION}领取` }] });
  const before = f.store.shipment(trusted.id);
  await f.run(); const summary = f.daily.summary();
  assert.equal(f.calls.length, 0); assert.equal(summary.timeFormatLearning, 'unsupported_requires_review');
  assert.equal(summary.lastRun.issues.unknownTime, 2); assert.equal(summary.lastRun.issues.timeConflict, 2);
  assert.equal(summary.lastRun.issues.unknownPrecision, 1);
  assert.ok(summary.lastRun.timeFormats.every(format => format.result === 'requires_review'));
  assert.deepEqual(f.store.shipment(trusted.id), before);
});

test('shared quota leaves candidates queued and never reports them processed', async t => {
  const f = fixture(t); f.ingest(); f.ingest();
  for (let i = 0; i < 20; i++) assert.equal(f.stations.reserveAiCall(), true);
  assert.equal(f.stations.reserveAiCall(), false);
  await f.run(); const summary = f.daily.summary();
  assert.equal(f.calls.length, 0); assert.equal(summary.lastRun.aiCode, 'AI_DAILY_LIMIT');
  assert.equal(summary.lastRun.processedCount, 0); assert.equal(summary.lastRun.aiStatus, 'queued');
  assert.equal(f.stations.aiConfig().usageToday, 20);
  f.advance(DAY); const result = f.logisticsAi.runDue(); assert.equal(result.accepted, true); await f.logisticsAi.running;
  assert.equal(f.calls.length, 1); assert.equal(f.stations.aiConfig().usageToday, 1);
});

test('existing ignored candidates keep the administrator decision without another provider call', async t => {
  const f = fixture(t, { config: { autoApply: true } }); f.ingest(); f.ingest();
  f.logisticsAi.intake({ shipments: f.store.snapshot([f.store.accounts()[0].id]).shipments });
  const id = f.logisticsAi.candidates()[0].id;
  f.logisticsAi.ignore(id); await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.daily.summary().lastRun.states.ignored, 1);
  assert.equal(f.logisticsAi.candidate(id).status, 'ignored');
});

test('a learned rule backfills the sampled parcels and rollback restores the previous interpretation', async t => {
  const f = fixture(t, { config: { autoApply: true } }); f.ingest(); f.ingest();
  await f.run();
  assert.equal(f.daily.summary().lastRun.states.applied, 1);
  assert.equal(f.daily.summary().lastRun.backfilledCount, 2);
  const candidate = f.logisticsAi.candidates()[0];
  f.logisticsAi.rollback(candidate.id);
  assert.equal(f.daily.summary().lastRun.states.rolled_back, 1);
  assert.equal(f.daily.summary().lastRun.backfilledCount, 0);
  f.advance(DAY); await f.run(); assert.equal(f.calls.length, 1);
});

test('provider failures remain retryable in the existing queue without a second daily scan', async t => {
  let fail = true;
  const f = fixture(t, { request: input => {
    if (fail) throw new Error('PRIVATE_PROVIDER_RESPONSE');
    return reply({ kind: 'arrival', starts: ['已交付给'], ends: [], keywords: [STATION], expectedStation: STATION, evidence: [input.fragment] });
  } });
  f.ingest(); f.ingest(); await f.run();
  assert.equal(f.daily.summary().lastRun.aiStatus, 'waiting_retry');
  assert.equal(f.logisticsAi.candidates()[0].attempts, 1);
  await f.restart(); assert.equal((await f.run()).code, 'DAILY_ALREADY_RUN');
  assert.equal(f.calls.length, 1);
  fail = false; f.advance(6 * 3600000); f.logisticsAi.runDue(); await f.logisticsAi.running;
  assert.equal(f.calls.length, 2); assert.equal(f.daily.summary().lastRun.states.review, 1);
  assert.doesNotMatch(JSON.stringify(f.daily.summary()), /PRIVATE_PROVIDER_RESPONSE/u);
});

test('pause stops a scan between committed batches and restart resumes the saved cursor', async t => {
  const f = fixture(t); for (let i = 0; i < 105; i++) f.ingest();
  f.daily.runDue(); await settle();
  f.stations.saveAiConfig({ logisticsEnabled: false }); await f.daily.running;
  assert.equal(f.daily.summary().lastRun.scanned, 100); assert.equal(f.daily.summary().lastRun.scanStatus, 'running');
  assert.equal(f.calls.length, 0); await f.restart();
  assert.equal((await f.run()).code, 'AI_AUTOMATIC_DISABLED');
  f.stations.saveAiConfig({ logisticsEnabled: true }); await f.run();
  assert.equal(f.daily.summary().lastRun.scanned, 105); assert.equal(f.daily.summary().lastRun.changed, 105);
  assert.equal(f.calls.length, 1);
});

test('a cross-day restart finishes the interrupted run without losing already scanned learning groups', async t => {
  const f = fixture(t); f.ingest(); f.ingest();
  for (let i = 0; i < 103; i++) f.ingest({}, '包裹运输中');
  f.daily.runDue(); await settle();
  f.stations.saveAiConfig({ logisticsEnabled: false }); await f.daily.running;
  assert.equal(f.daily.read('2026-11-09').scanned, 100);
  assert.equal(f.daily.read('2026-11-09').newGroupIds.length, 1);
  f.advance(DAY); await f.restart(); f.stations.saveAiConfig({ logisticsEnabled: true });
  await f.run();
  const resumed = f.daily.read('2026-11-09');
  assert.equal(resumed.scanStatus, 'complete'); assert.equal(resumed.scanned, 105); assert.equal(resumed.changed, 105);
  assert.equal(resumed.candidateIds.length, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.daily.summary().lastRun.day, '2026-11-09');
  assert.equal(f.daily.summary().nextRunAt, NOW + DAY);
  await f.run();
  assert.equal(f.daily.summary().lastRun.day, '2026-11-10'); assert.equal(f.daily.summary().lastRun.changed, 0);
  assert.equal(f.calls.length, 1);
});

test('closed and disabled workers never scan or call the configured provider', async t => {
  const f = fixture(t); f.ingest(); f.ingest(); f.stations.saveAiConfig({ enabled: false });
  assert.equal((await f.run()).code, 'AI_AUTOMATIC_DISABLED'); assert.equal(f.daily.summary().lastRun, null);
  await f.daily.close(); assert.equal((await f.run()).code, 'SERVICE_STOPPING'); assert.equal(f.calls.length, 0);
});

test('daily intake does not carry a low frequency action alongside selected high frequency actions', async t => {
  const f = fixture(t); f.ingest({}, `${FRAGMENT}，已交付给另一合成驿站`); f.ingest();
  await f.run();
  assert.equal(f.logisticsAi.candidates().length, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].expectedStation, STATION);
});

test('the daily dispatch runs selected candidates without consuming unrelated queued work', async t => {
  const f = fixture(t);
  const unrelated = f.ingest({}, `已托管至${STATION}`);
  f.logisticsAi.intake({ shipments: [unrelated] });
  const otherId = f.logisticsAi.candidates()[0].id;
  f.ingest(); f.ingest(); await f.run();
  assert.deepEqual(f.calls, [{ fragment: FRAGMENT, expectedStation: STATION }]);
  assert.equal(f.logisticsAi.candidate(otherId).status, 'pending');
});

test('automatic timer catches up on startup and runs the next Shanghai 03:00 only once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { automaticEvents: true }); f.ingest(); f.ingest();
  t.mock.timers.tick(0); if (f.daily.running) await f.daily.running;
  assert.equal(f.daily.summary().lastRun.day, '2026-11-09'); assert.equal(f.calls.length, 1);
  f.advance(DAY - 1); t.mock.timers.tick(DAY - 1); await settle();
  assert.equal(f.daily.summary().lastRun.day, '2026-11-09');
  f.advance(1); t.mock.timers.tick(1); if (f.daily.running) await f.daily.running;
  assert.equal(f.daily.summary().lastRun.day, '2026-11-10');
  assert.equal(f.daily.summary().lastRun.changed, 0); assert.equal(f.calls.length, 1);
});

test('an in-flight provider call exposes scanned but queued status until the validated reply returns', async t => {
  let finish;
  const f = fixture(t, { request: () => new Promise(resolve => { finish = resolve; }) });
  f.ingest(); f.ingest(); f.daily.runDue();
  for (let i = 0; i < 10 && !finish; i++) await settle();
  assert.ok(finish);
  const summary = f.daily.summary();
  assert.equal(summary.lastRun.scanStatus, 'complete'); assert.equal(summary.lastRun.processedCount, 0);
  assert.equal(summary.lastRun.aiStatus, 'queued'); assert.equal(summary.running, true);
  finish(reply({ kind: 'arrival', starts: ['已交付给'], ends: [], keywords: [STATION], expectedStation: STATION, evidence: [FRAGMENT] }));
  await f.daily.running; assert.equal(f.daily.summary().lastRun.aiStatus, 'awaiting_review');
});

test('a capped scan continues beyond its persisted cursor the following day', async t => {
  const f = fixture(t); f.ingest(); const second = f.ingest();
  const cursor = f.store.db.prepare('SELECT rowid AS value FROM shipments ORDER BY rowid LIMIT 1').get().value;
  f.daily.save({ day: '2026-11-08', scanStatus: 'complete', truncated: true, cursor });
  await f.run();
  assert.equal(f.daily.summary().lastRun.scanned, 1); assert.equal(f.daily.summary().lastRun.total, 1);
  assert.equal(f.store.db.prepare('SELECT id FROM logistics_daily_samples').get().id, second.id);
  assert.equal(f.calls.length, 0);
});

test('summary reuses persisted diagnostics and warm reads avoid per-shipment work with a full station directory', async t => {
  const f = fixture(t);
  const base = f.ingest({}, '包裹运输中');
  const insertShipment = f.store.db.prepare('INSERT INTO shipments VALUES(?,?,?)');
  for (let i = 1; i < 1000; i++) {
    const shipment = { ...base, id: `synthetic-copy-${i}`, waybillNo: `synthetic-copy-${i}` };
    insertShipment.run(shipment.id, shipment.accountId, JSON.stringify(shipment));
  }
  const insertStation = f.store.db.prepare('INSERT INTO station_catalog VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
  for (let i = 0; i < 100; i++) {
    const id = i ? `catalog-${i}` : 'known';
    insertStation.run(id, JSON.stringify({ id, name: i ? `合成${i}驿站` : STATION, enabled: true, region: '',
      aliases: Array.from({ length: 10 }, (_, j) => ({ id: `alias-${i}-${j}`, name: `合成别名${i}之${j}驿站`, source: 'manual', subLocation: '' })) }));
  }
  f.store.revision(); f.stations.bumpRevision();
  let directoryReads = 0;
  const readDirectory = f.stations.stationRules.bind(f.stations);
  f.stations.stationRules = () => { directoryReads++; return readDirectory(); };
  await f.run(); assert.equal(directoryReads, 1, 'the scan builds the station directory once');
  let inspected = 0;
  const inspect = f.daily.inspect.bind(f.daily);
  f.daily.inspect = (...args) => { inspected++; return inspect(...args); };
  directoryReads = 0;
  const firstAt = performance.now(), first = f.daily.summary(), coldMs = performance.now() - firstAt;
  assert.equal(first.lastRun.unconfirmedCount, 1000); assert.equal(inspected, 0); assert.equal(directoryReads, 0);
  const warmAt = performance.now();
  for (let i = 0; i < 100; i++) assert.equal(f.daily.summary().lastRun.unconfirmedCount, 1000);
  const warmMeanMs = (performance.now() - warmAt) / 100;
  assert.equal(inspected, 0); assert.equal(directoryReads, 0);
  const changed = { ...f.store.shipment(base.id), arrivalAt: NOW - 1000, arrivalAtSource: 'locker_arrival', arrivalAtPrecision: 'second' };
  f.store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(changed), base.id); f.store.revision();
  assert.equal(f.daily.summary().lastRun.unconfirmedCount, 999); assert.equal(inspected, 1);
  assert.equal(directoryReads, 0);
  t.diagnostic(`1000 parcels / 100 stations / 1000 aliases: first summary ${coldMs.toFixed(2)} ms; warm mean ${warmMeanMs.toFixed(2)} ms; directory reads 0; changed parcel inspections 1`);
});

test('cached diagnostics refresh at the exact active-age boundary across days', async t => {
  const f = fixture(t); f.ingest({}, '包裹运输中'); await f.run();
  assert.equal(f.daily.summary().lastRun.unconfirmedCount, 1);
  f.advance(45 * DAY - 2000);
  assert.equal(f.daily.summary().lastRun.unconfirmedCount, 1);
  f.advance(1000);
  assert.equal(f.daily.summary().lastRun.unconfirmedCount, 0);
});

test('cached diagnostics refresh when a formerly future timestamp becomes current without a data revision', async t => {
  const f = fixture(t);
  f.ingest({ logisticsEvents: [{ time: NOW + 1000, description: '包裹运输中', timePrecision: 'second' }] });
  await f.run(); assert.equal(f.daily.summary().lastRun.issues.timeConflict, 1);
  f.advance(1000); assert.equal(f.daily.summary().lastRun.issues.timeConflict, 0);
});

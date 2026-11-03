import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import '../src/logistics-rules.js';
import { pickupEvidence } from '../src/collector-enrichment.mjs';
import { createCollector, jdParcels, taobaoParcels } from '../src/collectors.mjs';

const engine = globalThis.PickCodeLogistics;
const STATION = '中山石岐远洋风景4卡店';
const SAMPLE = '【代收点】您的快件已暂存至 中山石岐远洋风景4卡店，地址：员峰振兴路菜鸟驿站中山石岐远洋风景4卡店，请及时领取签收';
const TIME = '2026-11-03 12:00:00';
const NOW = Date.parse(TIME.replace(' ', 'T') + '+08:00');
const rule = (overrides = {}) => ({ id: 'custom-arrival', name: '明文测试', enabled: true, kind: 'arrival', starts: ['交付给'], end: '', keywords: ['已入库'],
  sample: '已入库，交付给幸福菜鸟驿站', expectedStation: '幸福菜鸟驿站', origin: 'manual', ...overrides });

test('the exact reported storage event supplies matching station, arrival time and status on all collector paths', async () => {
  assert.equal(engine.pickupStation(SAMPLE), STATION);
  assert.equal(engine.pickupArrivalEvent(SAMPLE), true);
  assert.equal(engine.eventStatus(SAMPLE), 'arrived');
  assert.equal(pickupEvidence([{ time: NOW, timePrecision: 'second', description: SAMPLE }]).arrivalAt, NOW);
  const tb = taobaoParcels({ mailNo: 'A', multiStage: [{ time: TIME, title: '物流更新', labelDesc: { text: SAMPLE } }] }, 'o')[0];
  const jd = jdParcels({ multiPackageTrackInfoList: [{ carriageInfo: { carriageId: 'A' }, trackGroupInfo: { orderTrackShowList: [{ CreationTime: TIME, Content: SAMPLE }] } }] }, 'o', NOW)[0];
  const pdd = await createCollector({ now: () => NOW, fetchImpl: async () => new Response(JSON.stringify({ shipping: { tracking_number: 'A', traces: [{ time: TIME, info: SAMPLE }] } })) })
    ({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', { targetOrder: { platformOrderId: 'o', shipments: [{ waybillNo: 'A', status: 'transit' }] } });
  for (const parcel of [tb, jd, pdd.shipments[0]]) {
    assert.equal(parcel.arrivalAt, NOW); assert.equal(parcel.station, STATION); assert.equal(parcel.status, 'arrived');
  }
});

test('builtins cover all existing actions and new storage variants while protecting future, hub, return and reminder evidence', () => {
  const defaults = engine.validateRules(engine.defaults());
  for (const action of ['暂存至', '暂存到', '暂存于', '放置到', '放置于', '存放到', '存放在', '存入', '已成功到', '已经成功到达', '派送至', '妥投到']) {
    const description = `您的快件已${action}幸福菜鸟驿站`;
    assert.equal(engine.pickupArrivalEvent(description), true, description);
  }
  for (const description of ['预计已暂存至幸福菜鸟驿站', '尚未暂存至幸福菜鸟驿站', '未能放置到幸福菜鸟驿站',
    '您的快件已暂存至杭州转运中心，下一站幸福菜鸟驿站', '下一站已暂存至幸福菜鸟驿站', '退回后已暂存至幸福菜鸟驿站', '请快递员放置于幸福菜鸟驿站']) {
    assert.equal(engine.pickupStation(description), '', description);
    assert.equal(engine.pickupArrivalEvent(description), false, description);
  }
  assert.equal(engine.pickupStation('催取提醒，包裹仍在幸福菜鸟驿站'), '幸福菜鸟驿站');
  assert.equal(engine.pickupArrivalEvent('催取提醒，包裹已暂存至幸福菜鸟驿站'), false);
  defaults[0].starts.push('修改');
  assert.ok(!engine.defaults()[0].starts.includes('修改'));
});

test('literal templates use every keyword within the action fragment, never evaluate patterns, and test disabled drafts', () => {
  const customized = rule({ sample: '已入库交付给幸福菜鸟驿站' });
  assert.deepEqual(engine.validateRule(customized), customized);
  assert.equal(engine.pickupStation(customized.sample, [customized]), '幸福菜鸟驿站');
  assert.equal(engine.pickupStation('已入库，交付给幸福菜鸟驿站', [customized]), '');
  assert.equal(engine.pickupStation(customized.sample, [{ ...customized, enabled: false }]), '');
  const preview = engine.test({ ...customized, id: '', enabled: false }, customized.sample);
  assert.equal(preview.station, '幸福菜鸟驿站'); assert.equal(preview.arrival, true); assert.equal(preview.ruleId, 'preview');
  const literal = rule({ starts: ['(到|存).*'], keywords: [], sample: '文字(到|存).*幸福菜鸟驿站' });
  assert.equal(engine.test(literal, literal.sample).station, '幸福菜鸟驿站');
  assert.equal(engine.test(literal, '文字到幸福菜鸟驿站').station, '');
  const location = { ...customized, kind: 'location', starts: ['交付给'], end: '等待领取', sample: '已入库交付给幸福菜鸟驿站等待领取' };
  assert.equal(engine.test(location, location.sample).arrival, false);
  assert.equal(engine.test(location, location.sample).station, '幸福菜鸟驿站');
});

test('validation rejects executable/unknown fields, invalid enabled examples, duplicate ids and oversized rules atomically', () => {
  const valid = rule({ keywords: [], sample: '交付给幸福菜鸟驿站' });
  for (const invalid of [{ ...valid, regex: '(.*)' }, { ...valid, script: 'throw 1' }, { ...valid, starts: [''] }, { ...valid, starts: ['已到，'] },
    { ...valid, sample: '未能交付给幸福菜鸟驿站' }, { ...valid, expectedStation: '错误站点' }, { ...valid, keywords: ['不存在'] }, { ...valid, sample: 'x'.repeat(601) }]) {
    assert.throws(() => engine.validateRule(invalid));
  }
  assert.throws(() => engine.validateRules([valid, valid]));
  assert.throws(() => engine.validateRules([{ ...valid, id: '__proto__' }, { ...valid, id: '__proto__' }]));
  assert.throws(() => engine.validateRules(Array(101).fill(valid)));
  assert.equal(engine.validateRule({ ...valid, enabled: false, sample: '', expectedStation: '' }).enabled, false);
});

test('explicit trailing markers can include punctuation without crossing an action or future destination boundary', () => {
  const simple = rule({ starts: ['暂存至'], keywords: [], end: '，', sample: SAMPLE, expectedStation: STATION });
  assert.equal(engine.validateRule(simple).end, '，');
  assert.equal(engine.test(simple, SAMPLE).station, STATION);
  const long = { ...simple, end: '，请及时取件', sample: '已暂存至幸福菜鸟驿站，请及时取件', expectedStation: '幸福菜鸟驿站' };
  assert.equal(engine.validateRule(long).end, '，请及时取件');
  assert.equal(engine.test(long, long.sample).station, '幸福菜鸟驿站');
  assert.equal(engine.test(long, '已暂存至幸福菜鸟驿站，请尽快取件').station, '');
  assert.equal(engine.test(simple, '已暂存至杭州转运中心，下一站幸福菜鸟驿站，请取件').station, '');
  assert.equal(engine.test(long, '已暂存至杭州中心下一站幸福菜鸟驿站，请及时取件').station, '');
  assert.equal(engine.test({ ...long, end: '请及时取件' }, long.sample).station, '');
});

test('editable unknown arrival verbs cannot bypass fixed negation, future and instruction guards', () => {
  const custom = rule({ keywords: [], sample: '已交付给幸福菜鸟驿站' });
  for (const prefix of ['未', '尚未', '并未', '没有', '还没', '不能', '不要', '不会', '将', '将会', '准备', '待', '等待', '正在', '请快递员', '要求快递员']) {
    const sample = prefix + '交付给幸福菜鸟驿站';
    const result = engine.test(custom, sample);
    assert.equal(result.arrival, false, sample); assert.equal(result.station, '', sample);
    assert.equal(engine.pickupEvidence([{ time: NOW, description: sample }], [custom]).arrivalAt, 0, sample);
    assert.throws(() => engine.validateRule({ ...custom, sample }), sample);
  }
  for (const sample of ['已交付给幸福菜鸟驿站', '已经将包裹交付给幸福菜鸟驿站', '待取件：已交付给幸福菜鸟驿站']) {
    assert.equal(engine.test(custom, sample).arrival, true, sample);
  }
  assert.equal(engine.pickupArrivalEvent('待取件：已暂存至幸福菜鸟驿站'), true);
  assert.equal(engine.pickupStation('请您及时到幸福菜鸟驿站'), '幸福菜鸟驿站');
});

test('builtin arrivals require pickup semantics for ordinary shops while explicit manual arrival templates remain usable', () => {
  const delivered = '已送达幸福服装店';
  assert.equal(engine.pickupStation(delivered), '幸福服装店');
  assert.equal(engine.pickupArrivalEvent(delivered), false);
  assert.equal(engine.eventStatus(delivered), 'signed');
  assert.equal(engine.pickupEvidence([{ time: NOW, description: delivered }]).arrivalAt, 0);
  assert.equal(engine.pickupArrivalEvent(SAMPLE), true);
  assert.equal(engine.pickupEvidence([{ time: NOW, description: SAMPLE }]).station, STATION);
  const manual = rule({ starts: ['托管完成：'], keywords: [], sample: '托管完成：4卡店', expectedStation: '4卡店' });
  assert.equal(engine.validateRule(manual).expectedStation, '4卡店');
  const evidence = engine.pickupEvidence([{ time: NOW, description: manual.sample }], [manual]);
  assert.equal(evidence.station, '4卡店'); assert.equal(evidence.arrivalAt, NOW);
});

test('explicit location templates persist station evidence without fabricating an arrival time', () => {
  const location = rule({ kind: 'location', starts: ['当前存储地点：'], keywords: [], sample: '当前存储地点：幸福菜鸟驿站' });
  assert.equal(engine.validateRule(location).kind, 'location');
  assert.equal(engine.test(location, location.sample).station, location.expectedStation);
  const evidence = engine.pickupEvidence([{ time: NOW, description: location.sample }], [location]);
  assert.equal(evidence.station, location.expectedStation); assert.equal(evidence.stationSource, 'platform_event');
  assert.equal(evidence.arrivalAt, 0); assert.equal(evidence.arrivalAtSource, 'unknown');
  for (const description of ['预计当前存储地点：幸福菜鸟驿站', '下一站当前存储地点：幸福菜鸟驿站', '退回后当前存储地点：幸福菜鸟驿站']) {
    const rejected = engine.pickupEvidence([{ time: NOW, description }], [location]);
    assert.equal(rejected.station, '', description); assert.equal(rejected.arrivalAt, 0, description);
  }
});

test('the canonical parser executes as a standalone script without modern syntax or module dependencies', () => {
  const source = readFileSync(new URL('../src/logistics-rules.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:import|export|const|let)\s|=>|\\p\{/);
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(context.PickCodeLogistics.pickupStation(SAMPLE), STATION);
  assert.equal(context.PickCodeLogistics.validateRules(context.PickCodeLogistics.defaults()).length, 6);
});

test('a collector uses a stable per-collection rule snapshot and reads edits for the next collection', async () => {
  const configured = rule({ keywords: [], sample: '交付给幸福菜鸟驿站' });
  let rules = [], first = true;
  const collector = createCollector({ now: () => NOW, getLogisticsRules: () => rules, fetchImpl: async () => {
    if (first) { first = false; rules = [configured]; }
    return new Response(JSON.stringify({ shipping: { tracking_number: 'A', traces: [{ time: TIME, info: configured.sample }] } }));
  } });
  const collect = () => collector({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', { targetOrder: { platformOrderId: 'o', shipments: [{ waybillNo: 'A', status: 'transit' }] } });
  const initial = await collect(); assert.equal(initial.shipments[0].arrivalAt, 0); assert.deepEqual(initial.logisticsRules, []);
  const next = await collect(); assert.equal(next.shipments[0].arrivalAt, NOW); assert.equal(next.shipments[0].station, '幸福菜鸟驿站');
});

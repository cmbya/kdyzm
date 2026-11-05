import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { StationStore } from '../src/stations.mjs';
import { AiAssistance } from '../src/ai-assistance.mjs';
import { PickupCompletionAi } from '../src/pickup-completion-ai.mjs';
import { detectPickupCompletion, validatePickupCompletionRule } from '../src/pickup-completion.mjs';
import { completionFragment, completionNegativeSamples, validateCompletionSuggestion } from '../src/pickup-completion-ai-template.mjs';

const NOW = Date.parse('2026-11-06T12:00:00+08:00'), FRAGMENT = '本人已完成提货';
const reply = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const suggestion = (changes = {}) => ({ kind: 'user_collected', keywords: [FRAGMENT], evidence: FRAGMENT, ...changes });

function fixture(t, { config = {}, request, automaticEvents = false } = {}) {
  let clock = NOW;
  const now = () => clock, key = Buffer.alloc(32, 9), store = new Store({ key, now });
  const stations = new StationStore({ db: store.db, key, now });
  stations.saveAiConfig({ channelName: '合成渠道', baseUrl: 'https://example.com/v1', model: 'fixture', apiKey: randomBytes(24).toString('hex'), enabled: true, ...config });
  const calls = [];
  const assistance = new AiAssistance({ stations, now, request: async args => { calls.push(args); return request ? request(args) : reply(suggestion()); } });
  const jobs = new PickupCompletionAi({ store, completionStore: store.pickupCompletion, stations, assistance, now, automaticEvents });
  const account = store.saveAccount({ platform: 'pdd', label: 'PRIVATE_ACCOUNT', cookie: 'PRIVATE_COOKIE' }, undefined, true);
  let sequence = 0;
  const ingest = (description = FRAGMENT, extras = {}) => {
    const suffix = sequence++;
    store.importResult(account.id, { orders: [{ platformOrderId: `PRIVATE_ORDER_${suffix}`, title: 'PRIVATE_PRODUCT' }],
      shipments: [{ platformOrderId: `PRIVATE_ORDER_${suffix}`, waybillNo: `PRIVATE_WAYBILL_${suffix}`, status: 'signed', logisticsState: 'ok',
        logisticsEvents: [{ time: now() - 1000, description, timePrecision: 'second' }], ...extras }] });
    return jobs.intake(store.snapshot([account.id]));
  };
  const run = async () => { const result = jobs.runDue(); await jobs.running; return result; };
  t.after(async () => { await jobs.close(); assistance.close(); store.close(); });
  return { store, stations, assistance, jobs, account, calls, ingest, run, now, advance: amount => { clock += amount; } };
}

test('literal tuning uses shared AI and applies missed explicit completion, with auditable rollback', async t => {
  const f = fixture(t);
  assert.equal(f.store.pickupCompletion.config().aiEnabled, true);
  assert.equal(f.ingest().accepted, 1);
  assert.equal(f.store.snapshot([f.account.id]).shipments[0].picked, false);
  assert.equal((await f.run()).code, 'AI_ACCEPTED');
  assert.equal(f.calls.length, 1); assert.equal(f.stations.aiConfig().usageToday, 1);
  const candidate = f.jobs.candidates()[0]; assert.equal(candidate.status, 'applied');
  assert.equal(f.store.snapshot([f.account.id]).shipments[0].picked, true);
  assert.equal(f.jobs.history()[0].canRollback, true);
  f.jobs.rollback(candidate.id);
  assert.equal(f.store.snapshot([f.account.id]).shipments[0].picked, false);
  assert.equal(f.jobs.history()[0].status, 'rolled_back');
  assert.throws(() => f.jobs.rollback(candidate.id), { code: 'AI_ROLLBACK_CONFLICT' });
  f.jobs.intake(f.store.snapshot([f.account.id])); await f.run(); assert.equal(f.calls.length, 1, 'rollback is not relearned');
});

test('only whitelisted actor and completion phrase cross AI boundary, never original PII or own labels', async t => {
  const f = fixture(t);
  f.ingest(`姓名张三 电话13812345678 地址广东市某小区 ${FRAGMENT}，运单AB123456789`);
  await f.run();
  const payload = JSON.parse(f.calls[0].body).messages[1].content;
  assert.deepEqual(JSON.parse(payload), { fragment: FRAGMENT, kind: 'user_collected' });
  assert.doesNotMatch(payload, /PRIVATE|张三|13812345678|广东|AB123/);
  assert.equal(f.jobs.intake(f.store.snapshot([f.account.id])).accepted, 0);
  assert.equal(f.jobs.candidates().length, 1);
});

test('unknown logistics status still learns from explicit missed completion and recalculates the parcel', async t => {
  const f = fixture(t); assert.equal(f.ingest(FRAGMENT, { status: 'unknown' }).accepted, 1);
  assert.equal(f.jobs.candidates()[0].source, 'uncompleted_trace'); await f.run();
  assert.equal(f.jobs.candidates()[0].status, 'applied'); assert.equal(f.store.snapshot([f.account.id]).shipments[0].picked, true);
});

test('取件自动监测 appends distinct optimized literal groups without duplicate growth', async t => {
  const phrases = ['本人已完成提货成功', '客户提取成功'];
  const f = fixture(t, { request: async request => {
    const messages = JSON.parse(request.body).messages, input = JSON.parse(messages[1].content);
    assert.match(messages[0].content, /取件自动监测/); assert.match(messages[0].content, /同组keywords必须同时出现/);
    return reply({ kind: input.kind, keywords: input.fragment === phrases[0] ? [FRAGMENT, input.fragment, input.fragment] : [input.fragment], evidence: input.fragment });
  } });
  for (const phrase of phrases) assert.equal(f.ingest(phrase, { status: 'unknown' }).accepted, 1);
  await f.run();
  const rules = f.store.pickupCompletion.rules();
  assert.equal(f.calls.length, 2); assert.equal(rules.length, 2);
  assert.deepEqual(rules.map(rule => rule.keywords).sort(), phrases.map(phrase => [phrase]).sort());
  assert.equal(f.store.snapshot([f.account.id]).shipments.every(item => item.picked), true);
  for (const phrase of phrases) f.ingest(phrase, { status: 'unknown' });
  await f.run();
  assert.equal(f.calls.length, 2); assert.equal(f.jobs.candidates().length, 2); assert.equal(f.store.pickupCompletion.rules().length, 2);
  const status = f.jobs.status(), learned = status.monitorRules.filter(rule => !rule.isExample);
  assert.deepEqual(learned.map(rule => rule.keywords).sort(), phrases.map(phrase => [phrase]).sort());
  assert.equal(learned.every(rule => rule.origin === 'ai' && rule.enabled && rule.version === 1 && rule.label === 'AI 追加词组'), true);
  assert.ok(status.monitorRules.some(rule => rule.isExample && rule.origin === 'builtin' && rule.keywords[0] === '本人已签收'));
  for (const candidate of status.candidates) assert.deepEqual(candidate.appliedRule.keywords, candidate.rule.keywords);
  f.store.pickupCompletion.saveRule({ ...rules[0], enabled: false });
  assert.equal(f.jobs.status().monitorRules.find(rule => rule.id === rules[0].id).enabled, false);
});

test('removing redundant AND literals retains the more specific match and all fixed safety guards', () => {
  const fragment = '本人已完成提货成功', kind = 'user_collected';
  const before = validatePickupCompletionRule({ id: 'and-before', kind, keywords: [FRAGMENT, fragment], origin: 'ai' });
  const { rule: after } = validateCompletionSuggestion({ kind, keywords: [FRAGMENT, fragment, FRAGMENT], evidence: fragment }, { kind, fragment });
  assert.deepEqual(after.keywords, [fragment]);
  const detect = (description, rule) => detectPickupCompletion({ logisticsEvents: [{ time: NOW - 1000, description }] }, { rules: [rule], now: NOW });
  const negatives = [...completionNegativeSamples(fragment), FRAGMENT, `${fragment}？`, `${fragment}是否属实`, '快递员已完成提货成功', '已完成提货成功'];
  assert.ok(detect(fragment, after));
  for (const description of [fragment, `包裹：${fragment}`, ...negatives]) {
    assert.equal(Boolean(detect(description, after)), Boolean(detect(description, before)), description);
  }
  for (const description of negatives) assert.equal(detect(description, after), null, description);
});

test('uncertain, negated, future, station, courier and status-only evidence never enters a call', async t => {
  const f = fixture(t);
  for (const text of [...completionNegativeSamples(FRAGMENT), '将本人已完成提货', '本人已完成提货前', '本人已完成提货时', '未能本人已完成提货']) f.ingest(text);
  await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.jobs.candidates().length, 0);
  assert.equal(completionFragment('收件人张三已提货'), null, 'PII cannot be stripped into invented evidence');
});

test('full source qualifications are checked before deidentification removes surrounding context', async t => {
  const f = fixture(t);
  for (const text of ['须本人签收', '本人签收服务已开通', '要求本人签收', '用户已领取是否属实', '用户已领取？', '用户已取走快递，请核实是否本人领取']) {
    assert.equal(completionFragment(text), null, text);
    f.ingest(text);
  }
  await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.jobs.candidates().length, 0);
});

test('untrusted broad, executable, invented and extra output remains review without a rule', async t => {
  for (const change of [{ keywords: ['已完成'] }, { keywords: ['本人.*提货'] }, { evidence: '本人已领取' }, { script: 'x()' }, { kind: 'recipient_signed' }]) {
    await t.test(JSON.stringify(change), async child => {
      const f = fixture(child, { request: async () => reply(suggestion(change)) }); f.ingest(); await f.run();
      assert.equal(f.jobs.candidates()[0].status, 'review'); assert.equal(f.store.pickupCompletion.rules().length, 0);
      await f.run(); assert.equal(f.calls.length, 1);
    });
  }
  assert.throws(() => validateCompletionSuggestion(suggestion({ keywords: ['用户'] }), { fragment: FRAGMENT, kind: 'user_collected' }), { code: 'AI_INVALID_RESULT' });
});

test('global disable, missing credential and feature disable prevent calls and late results', async t => {
  for (const kind of ['global', 'feature', 'credential']) await t.test(kind, async child => {
    let release; const response = new Promise(resolve => { release = resolve; });
    const f = fixture(child, { request: () => response }); f.ingest(); f.jobs.runDue();
    await new Promise(resolve => setImmediate(resolve));
    if (kind === 'global') f.stations.saveAiConfig({ enabled: false });
    else if (kind === 'credential') f.stations.saveAiChannel(f.stations.aiConfig().channelId, { clearApiKey: true });
    else { f.store.pickupCompletion.saveConfig({ aiEnabled: false }); f.jobs.configChanged(); }
    release(reply(suggestion())); await f.jobs.running;
    assert.equal(f.store.pickupCompletion.rules().length, 0); assert.equal(f.store.snapshot([f.account.id]).shipments[0].picked, false);
    assert.equal((await f.run()).code, 'AI_AUTOMATIC_DISABLED');
  });
});

test('shared quota and three bounded retries use six-hour cadence and survive duplicate intake', async t => {
  const f = fixture(t, { config: { dailyLimit: 1 }, request: async () => { throw Object.assign(new Error('PRIVATE_PROVIDER_RESPONSE'), { code: 'AI_UPSTREAM_ERROR' }); } });
  f.ingest(); await f.run();
  assert.equal(f.jobs.candidates()[0].attempts, 1); assert.doesNotMatch(f.jobs.candidates()[0].error, /PRIVATE/);
  assert.equal((await f.run()).code, 'AI_DAILY_LIMIT'); assert.equal(f.calls.length, 1);
  f.stations.saveAiConfig({ dailyLimit: 20 }); assert.equal((await f.run()).code, 'AI_NOT_DUE');
  for (let i = 0; i < 2; i++) { f.advance(360 * 60000); f.jobs.intake(f.store.snapshot([f.account.id])); await f.run(); }
  assert.equal(f.calls.length, 3); assert.equal(f.jobs.candidates()[0].attempts, 3);
  f.advance(360 * 60000); await f.run(); assert.equal(f.calls.length, 3);
  f.jobs.intake(f.store.snapshot([f.account.id])); await f.run(); assert.equal(f.calls.length, 3, 'unchanged evidence does not restart retries');
  f.ingest(); await f.run(); assert.equal(f.calls.length, 4, 'strictly newer source evidence permits another bounded retry cycle');
  assert.equal(f.jobs.candidates()[0].attempts, 1); assert.equal(f.jobs.candidates()[0].totalAttempts, 4); assert.equal(f.jobs.candidates()[0].retryCycles, 1);
});

test('corpus replay rejects a literal that also matches a distinct longer actor phrase', async t => {
  const f = fixture(t); f.ingest(); f.ingest('收件人' + FRAGMENT);
  await f.run(); assert.equal(f.jobs.candidates().find(item => item.fragment === FRAGMENT).status, 'review'); assert.equal(f.store.pickupCompletion.rules().length, 0);
});

test('disabled accounts, old traces and invalid timestamps never become evidence', async t => {
  const f = fixture(t); f.ingest(FRAGMENT, { logisticsEvents: [{ description: FRAGMENT, time: 0 }] });
  f.ingest(FRAGMENT, { logisticsEvents: [{ description: FRAGMENT, time: NOW - 46 * 86400000 }] });
  f.store.saveAccount({ enabled: false }, f.account.id); f.ingest(); await f.run();
  assert.equal(f.calls.length, 0);
});

test('manual confirmation can teach from explicit trace and rollback preserves the manual choice', async t => {
  const f = fixture(t, { config: { enabled: false } }); f.ingest();
  const shipment = f.store.snapshot([f.account.id]).shipments[0];
  const device = f.store.device(f.store.redeem(f.store.createPairing([f.account.id]).code, '合成设备').token);
  f.store.applyOperations(device, [{ id: 'manual-pick', shipmentId: shipment.id, action: 'pick', occurredAt: NOW }]);
  f.stations.saveAiConfig({ enabled: true });
  assert.equal(f.jobs.candidates()[0].source, 'manual_trace'); await f.run();
  assert.equal(f.jobs.candidates()[0].status, 'applied'); f.jobs.rollback(f.jobs.candidates()[0].id);
  const after = f.store.snapshot([f.account.id]).shipments[0];
  assert.equal(after.picked, true); assert.equal(after.pickupCompletion.manualOverride, 'picked'); assert.equal(after.pickupCompletion.autoPicked, false);
});

test('manual cancellation before an AI call makes the queued evidence ineligible', async t => {
  const f = fixture(t); f.ingest();
  const shipment = f.store.snapshot([f.account.id]).shipments[0];
  const device = f.store.device(f.store.redeem(f.store.createPairing([f.account.id]).code, '合成设备').token);
  f.store.applyOperations(device, [{ id: 'manual-restore', shipmentId: shipment.id, action: 'restore', occurredAt: NOW }]);
  await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.jobs.candidates()[0].status, 'review');
});

test('new evidence starts the automatic worker and queue history survives worker restart', async t => {
  const f = fixture(t, { automaticEvents: true }); f.ingest();
  for (let i = 0; i < 100 && f.jobs.candidates()[0]?.status !== 'applied'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.jobs.candidates()[0].status, 'applied'); assert.equal(f.calls.length, 1);
  await f.jobs.close();
  const restarted = new PickupCompletionAi({ store: f.store, completionStore: f.store.pickupCompletion, stations: f.stations, assistance: f.assistance, now: f.now, automaticEvents: false });
  try { assert.equal(restarted.history().length, 1); assert.equal(restarted.runDue().code, 'AI_NO_PENDING'); assert.equal(f.calls.length, 1); }
  finally { await restarted.close(); }
});

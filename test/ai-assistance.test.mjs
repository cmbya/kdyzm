import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { StationStore } from '../src/stations.mjs';
import { StationAiJobs } from '../src/station-ai.mjs';
import { AiAssistance } from '../src/ai-assistance.mjs';
import { TEMPLATE_SAMPLE, LOGISTICS_TEST_RESULT, validateTemplateInput, validateTemplateCandidate } from '../src/ai-templates.mjs';
import { encryptCookie } from '../src/security.mjs';
import { randomBytes } from 'node:crypto';

const SYNTHETIC_CREDENTIAL = randomBytes(24).toString('hex');
const SECOND_CREDENTIAL = randomBytes(24).toString('hex');

const NOW = Date.parse('2026-11-05T10:00:00+08:00');
const candidate = { name: '合成模板', signature: '合成快递', keywords: ['取件码'], kind: 'pickup', rules: { code: { start: '取件码', end: '，' }, express: { start: '', end: '' }, address: { start: '已到', end: '，' } } };
const reply = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const input = channelId => ({ channelId, sample: TEMPLATE_SAMPLE, expectedCode: '654321' });
const ready = { name: '合成渠道', baseUrl: 'https://api.example.com/v1', model: 'synthetic-model', apiKey: SYNTHETIC_CREDENTIAL, enabled: true };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, request = async () => reply(candidate)) {
  let time = NOW;
  const db = new DatabaseSync(':memory:'), key = Buffer.alloc(32, 5), now = () => time;
  const stations = new StationStore({ db, key, now }), channel = stations.saveAiChannel(undefined, ready);
  const assistance = new AiAssistance({ stations, now, request });
  t.after(() => { assistance.close(); db.close(); });
  return { stations, assistance, channel, db, advance: duration => { time += duration; } };
}

test('legacy migration retains original encrypted secret, selected provider and opt-in state across restart', () => {
  const db = new DatabaseSync(':memory:'), key = Buffer.alloc(32, 7);
  db.exec('CREATE TABLE station_ai_settings (id INTEGER PRIMARY KEY,data TEXT NOT NULL,credential TEXT NOT NULL)');
  const credential = encryptCookie('legacy-private-key', key, 'station-ai-key');
  db.prepare('INSERT INTO station_ai_settings VALUES(1,?,?)').run(JSON.stringify({ channelName: '旧渠道', baseUrl: ready.baseUrl, model: 'legacy-model', enabled: true, intervalMinutes: 1440, dailyLimit: 31, lastRunAt: NOW }), credential);
  const stations = new StationStore({ db, key, now: () => NOW });
  assert.equal(stations.aiConfig().channelId, 'default'); assert.equal(stations.aiConfig().enabled, true);
  assert.equal(stations.aiConfig().defaultSelectionRevision, 1);
  assert.equal(stations.aiConfig().dailyLimit, 31); assert.equal(stations.aiConfig().intervalMinutes, 360);
  assert.equal(stations.aiCredentials().apiKey, 'legacy-private-key');
  assert.equal(db.prepare('SELECT credential FROM station_ai_settings').get().credential, credential);
  assert.equal(db.prepare('SELECT credential FROM ai_channels').get().credential, credential);
  assert.ok(!JSON.stringify(stations.aiChannels()).includes('legacy-private-key'));
  assert.equal(new StationStore({ db, key }).aiChannels().length, 1); db.close();
});

test('registry limits, encryption, pause and selected channel semantics preserve shared quota', t => {
  const { stations, assistance, channel, db } = fixture(t);
  const other = stations.saveAiChannel(undefined, { ...ready, name: '第二渠道', baseUrl: 'https://other.example.com/v1', apiKey: SECOND_CREDENTIAL, jsonMode: false });
  stations.saveAiConfig({ channelId: other.id, enabled: true, intervalMinutes: 5, dailyLimit: 2 });
  assert.equal(stations.aiCredentials().apiKey, SECOND_CREDENTIAL); assert.equal(stations.aiConfig().baseUrl, 'https://other.example.com/v1');
  stations.saveAiChannel(other.id, { apiKey: '' }); assert.equal(stations.aiCredentials().apiKey, SECOND_CREDENTIAL);
  assert.equal(stations.reserveAiCall(), true); assert.equal(stations.reserveAiCall(), true); assert.equal(stations.reserveAiCall(), false);
  stations.saveAiConfig({ channelId: channel.id }); assert.equal(stations.aiConfig().usageToday, 2);
  stations.saveAiChannel(channel.id, { enabled: false });
  assert.equal(assistance.channels().defaultChannelId, ''); assert.equal(stations.aiConfig().channelId, channel.id);
  assert.equal(assistance.channels().channels.length, 0);
  assert.equal(assistance.channels().service.code, 'AI_CHANNEL_DISABLED');
  assert.ok(!JSON.stringify(assistance.channels()).includes('baseUrl')); assert.ok(!JSON.stringify(assistance.channels()).includes('Key'));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM ai_channels').all()).includes(SECOND_CREDENTIAL));
  for (let index = 2; index < 10; index++) stations.saveAiChannel(undefined, { ...ready, name: String(index) });
  assert.throws(() => stations.saveAiChannel(undefined, ready), { code: 'AI_CHANNEL_LIMIT' });
  assert.throws(() => stations.saveAiChannel(channel.id, { script: 'anything' }), { code: 'INVALID_INPUT' });
  assert.throws(() => stations.saveAiConfig({ channelId: 'missing' }), { code: 'AI_CHANNEL_UNAVAILABLE' });
});

test('creating the first channel retains the six-hour policy and budget saved before credentials', () => {
  const db = new DatabaseSync(':memory:'), stations = new StationStore({ db, key: Buffer.alloc(32, 8) });
  stations.saveAiConfig({ dailyLimit: 41, intervalMinutes: 5 });
  stations.saveAiChannel(undefined, ready);
  assert.equal(stations.aiConfig().dailyLimit, 41); assert.equal(stations.aiConfig().intervalMinutes, 360); assert.equal(stations.aiConfig().enabled, false);
  db.close();
});

test('only synthetic redacted input is accepted before any provider request', async t => {
  let calls = 0;
  const { assistance, channel } = fixture(t, async () => { calls++; return reply(candidate); });
  for (const text of ['电话13812345678', '链接https://evil.example.com', '运单SF123456789012', '张先生', '上海市测试区幸福小区', 'PRIVATE_SENTINEL', '用户test@example.com', '验证码', '第２号柜']) {
    await assert.rejects(assistance.template({ ...input(channel.id), sample: TEMPLATE_SAMPLE + text }, 'device-a', () => {}), { code: 'AI_SAMPLE_UNSAFE' });
  }
  await assert.rejects(assistance.template({ ...input(channel.id), expectedCode: '123456' }, 'device-a', () => {}), { code: 'AI_SAMPLE_UNSAFE' });
  assert.equal(calls, 0);
  const redacted = { ...input(channel.id), sample: TEMPLATE_SAMPLE + '电话[PHONE]，运单[WAYBILL]，地址[ADDRESS]，联系[NAME]，[URL]' };
  assert.equal(validateTemplateInput(redacted).expectedCode, '654321');
  for (const marker of ['取件密码', '取件编号', '取件码', '取货码', '提货码', '自提码', '领取码', '快递码']) assert.equal(validateTemplateInput({ ...input(channel.id), sample: `${marker}654321。` }).expectedCode, '654321');
  assert.equal((await assistance.template(redacted, 'device-a', () => {})).validation.requiresConfirmation, true); assert.equal(calls, 1);
});

test('literal template validation rejects executable fields, invented delimiters, dummy literals and incorrect extraction', () => {
  assert.equal(validateTemplateCandidate(candidate, TEMPLATE_SAMPLE, '654321').validation.code, '654321');
  for (const change of [value => { value.script = 'anything'; }, value => { value.rules.code.regex = '.*'; },
    value => { value.rules.code.end = '不存在'; }, value => { value.rules.code.start = '已到'; }, value => { value.keywords = ['654321']; },
    value => { value.rules.address.start = '合成驿站'; }, value => { value.rules.address.end = '[PHONE]'; },
    value => { value.signature = '另一个签名'; }, value => { value.kind = 'reminder'; }, value => { value.rules.url = {}; }]) {
    const altered = structuredClone(candidate); change(altered);
    assert.throws(() => validateTemplateCandidate(altered, TEMPLATE_SAMPLE, '654321'), { code: 'AI_INVALID_RESULT' });
  }
});

test('template cache deduplicates concurrent retries and partitions device, channel, revision and TTL', async t => {
  const calls = []; let finish;
  const { assistance, stations, channel, advance } = fixture(t, request => { calls.push(request); return calls.length === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(reply(candidate)); });
  let authorizations = 0; const authorize = () => { authorizations++; };
  const first = assistance.template(input(channel.id), 'device-a:grant-1', authorize), repeated = assistance.template(input(channel.id), 'device-a:grant-1', authorize);
  finish(reply(candidate)); assert.deepEqual(await first, await repeated); assert.equal(calls.length, 1);
  const cached = await assistance.template(input(channel.id), 'device-a:grant-1', authorize); cached.candidate.name = 'client-only';
  assert.equal((await assistance.template(input(channel.id), 'device-a:grant-1', authorize)).candidate.name, candidate.name); assert.equal(calls.length, 1);
  assert.ok(authorizations >= 8);
  await assistance.template(input(channel.id), 'device-b:grant-1', authorize); assert.equal(calls.length, 2);
  await assistance.template(input(channel.id), 'device-a:grant-2', authorize); assert.equal(calls.length, 3);
  stations.saveAiChannel(channel.id, { model: 'changed-model', jsonMode: false });
  await assistance.template(input(channel.id), 'device-a:grant-1', authorize); assert.equal(calls.length, 4);
  assert.equal(JSON.parse(calls[3].body).response_format, undefined); assert.equal(JSON.parse(calls[3].body).model, 'changed-model');
  advance(5 * 60000); await assistance.template(input(channel.id), 'device-a:grant-1', authorize); assert.equal(calls.length, 5);
  assert.equal(stations.aiConfig().usageToday, 5);
});

test('channel pause or credentials change cancels in-flight responses without provider fallback or cached results', async t => {
  for (const patch of [{ enabled: false }, { model: 'new-model' }, { apiKey: randomBytes(24).toString('hex') }, { baseUrl: 'https://next.example.com' }]) await t.test(Object.keys(patch)[0], async t => {
    let finish, signal; let calls = 0;
    const { assistance, stations, channel } = fixture(t, request => { calls++; signal = request.signal; return new Promise(resolve => { finish = resolve; }); });
    stations.saveAiChannel(undefined, { ...ready, name: '不能自动改用此渠道' });
    const pending = assistance.template(input(channel.id), 'device', () => {});
    stations.saveAiChannel(channel.id, patch);
    await assert.rejects(pending, { code: 'AI_CONFIG_CHANGED' }); assert.equal(signal.aborted, true); assert.equal(calls, 1);
    finish(reply(candidate)); await tick(); assert.equal(assistance.cache.size, 0);
    if (patch.enabled === false) await assert.rejects(assistance.template(input(channel.id), 'device', () => {}), { code: 'AI_CHANNEL_DISABLED' });
  });
});

test('synthetic capability test requires actual extraction and shares quota with templates and station jobs', async t => {
  const calls = [];
  const { assistance, stations, channel } = fixture(t, async request => { calls.push(request); const value = JSON.parse(JSON.parse(request.body).messages[1].content);
    return reply(value.expectedStation ? LOGISTICS_TEST_RESULT : value.fragment ? { kind: 'locker', suggestedName: '合成驿站', alias: value.fragment, subLocation: '2号柜', evidence: [value.fragment] } : candidate); });
  const tested = await assistance.test(channel.id); assert.equal(tested.ok, true); assert.equal(calls.length, 3); assert.equal(tested.capabilities.logistics_rule.ok, true);
  assert.ok(tested.message.includes('仍需核对'));
  stations.saveAiConfig({ dailyLimit: 4 });
  await assistance.template(input(channel.id), 'device', () => {});
  const exhausted = await assistance.test(channel.id); assert.equal(exhausted.ok, false); assert.equal(exhausted.capabilities.station_alias.code, 'AI_DAILY_LIMIT'); assert.equal(calls.length, 4);
  const jobs = new StationAiJobs({ stations, automaticEvents: false });
  stations.enqueue([{ id: 'station', fragment: '合成驿站' }]); assert.equal(jobs.request().code, 'AI_DAILY_LIMIT'); await jobs.close();
});

test('an ok true response and provider secrets cannot be reported as successful capability checks', async t => {
  const { assistance, channel } = fixture(t, async () => reply({ ok: true }));
  const result = await assistance.test(channel.id); assert.equal(result.ok, false); assert.equal(result.capabilities.sms_template.code, 'AI_INVALID_RESULT');
  assistance.transport = async () => { throw new Error(SYNTHETIC_CREDENTIAL + ' PRIVATE_PROVIDER_BODY'); };
  const failed = await assistance.test(channel.id); assert.equal(failed.ok, false); assert.ok(!JSON.stringify(failed).includes(SYNTHETIC_CREDENTIAL)); assert.ok(!JSON.stringify(failed).includes('PRIVATE_PROVIDER_BODY'));
});

test('unresponsive providers time out within eleven seconds, abort transport and cannot leave a result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal, finish;
  const { assistance, stations, channel } = fixture(t, request => { signal = request.signal; return new Promise(resolve => { finish = resolve; }); });
  const pending = assistance.template(input(channel.id), 'device', () => {});
  const rejected = assert.rejects(pending, { code: 'AI_TIMEOUT' });
  t.mock.timers.tick(11000); await rejected;
  assert.equal(signal.aborted, true); assert.equal(stations.aiConfig().usageToday, 1); assert.equal(assistance.pending.size, 0);
  finish(reply(candidate)); await tick(); assert.equal(assistance.cache.size, 0);
});

test('a changed channel stops the remainder of a capability test instead of testing replacement credentials', async t => {
  let calls = 0, finish;
  const { assistance, stations, channel } = fixture(t, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const pending = assistance.test(channel.id); stations.saveAiChannel(channel.id, { model: 'new-model' });
  const result = await pending; assert.equal(result.ok, false); assert.equal(calls, 1);
  assert.equal(result.capabilities.station_alias.code, 'AI_CONFIG_CHANGED'); assert.equal(result.capabilities.sms_template.code, 'AI_CONFIG_CHANGED');
  finish(reply(candidate)); await tick(); assert.equal(assistance.cache.size, 0);
});

test('opted-in station queue starts after enqueue or enable without a manual run and never approves results', async t => {
  const { stations } = fixture(t);
  let calls = 0;
  const jobs = new StationAiJobs({ stations, request: async () => { calls++; return reply({ kind: 'pickup_station', suggestedName: '合成驿站', alias: '合成驿站', evidence: ['合成驿站'] }); } });
  t.after(() => jobs.close());
  stations.enqueue([{ id: 'automatic-one', fragment: '合成驿站' }]);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls, 0);
  stations.saveAiConfig({ enabled: true, intervalMinutes: 5 });
  await new Promise(resolve => setTimeout(resolve, 10)); if (jobs.running) await jobs.running;
  assert.equal(calls, 1); assert.equal(stations.candidates()[0].status, 'review'); assert.equal(stations.stations().length, 0);
  stations.enqueue([{ id: 'automatic-two', fragment: '另一个合成驿站' }]); await tick(); assert.equal(calls, 1);
  stations.saveAiConfig({ enabled: false }); assert.equal(jobs.scheduled, null);
});

test('default service readiness distinguishes missing configuration, missing default, pause and incomplete configuration without fallback', async t => {
  const db = new DatabaseSync(':memory:'), stations = new StationStore({ db, key: randomBytes(32) });
  let calls = 0;
  const assistance = new AiAssistance({ stations, request: async () => { calls++; return reply(candidate); } });
  t.after(() => { assistance.close(); db.close(); });
  const empty = assistance.channels();
  assert.deepEqual(Object.keys(empty).sort(), ['channels', 'defaultChannelId', 'service']);
  assert.deepEqual(Object.keys(empty.service).sort(), ['available', 'channelId', 'channelName', 'code', 'message', 'mode', 'model', 'revision']);
  assert.equal(empty.service.mode, 'backend_default'); assert.equal(empty.service.code, 'AI_NOT_CONFIGURED');
  assert.equal(empty.service.available, false); assert.match(empty.service.revision, /^[a-f0-9]{64}$/u);
  await assert.rejects(assistance.template(input(), 'device', () => {}), { code: 'AI_NOT_CONFIGURED', status: 409 });
  await assert.rejects(assistance.template({ ...input(), sample: TEMPLATE_SAMPLE + '电话13812345678' }, 'device', () => {}), { code: 'AI_SAMPLE_UNSAFE' });
  const selected = stations.saveAiChannel(undefined, { name: '尚未配置完整', enabled: true });
  const other = stations.saveAiChannel(undefined, { ...ready, apiKey: randomBytes(24).toString('hex') });
  assert.equal(assistance.channels().service.code, 'AI_CHANNEL_INCOMPLETE'); assert.deepEqual(assistance.channels().channels, []);
  assert.equal(assistance.channels().service.channelId, selected.id); assert.equal(assistance.channels().defaultChannelId, '');
  await assert.rejects(assistance.template(input(), 'device', () => {}), { code: 'AI_CHANNEL_INCOMPLETE', status: 409 });
  stations.saveAiChannel(selected.id, { ...ready, apiKey: randomBytes(24).toString('hex') });
  assert.equal(stations.aiConfig().enabled, false, 'automatic scheduling remains independent of manual service readiness');
  assert.equal(assistance.channels().service.code, 'AI_READY'); assert.equal(assistance.channels().channels.length, 1);
  assert.equal(assistance.channels().channels[0].id, selected.id); assert.notEqual(selected.id, other.id);
  stations.saveAiChannel(selected.id, { enabled: false });
  assert.equal(assistance.channels().service.code, 'AI_CHANNEL_DISABLED'); assert.deepEqual(assistance.channels().channels, []);
  assert.equal(assistance.channels().service.channelName, ready.name);
  await assert.rejects(assistance.template(input(), 'device', () => {}), { code: 'AI_CHANNEL_DISABLED', status: 409 });
  const saved = JSON.parse(db.prepare('SELECT data FROM station_ai_settings WHERE id=1').get().data);
  for (const missing of ['', 'missing-default']) {
    db.prepare('UPDATE station_ai_settings SET data=? WHERE id=1').run(JSON.stringify({ ...saved, channelId: missing }));
    assert.equal(assistance.channels().service.code, 'AI_DEFAULT_MISSING'); assert.deepEqual(assistance.channels().channels, []);
    await assert.rejects(assistance.template(input(), 'device', () => {}), { code: 'AI_DEFAULT_MISSING', status: 409 });
  }
  assert.equal(calls, 0); assert.equal(stations.aiConfig().usageToday, 0);
  assert.doesNotMatch(JSON.stringify(assistance.channels()), /baseUrl|apiKey|example\.com/u);
});

test('selection revision changes only when the default identity changes and survives reloading stored settings', t => {
  const { stations, assistance, channel, db } = fixture(t);
  const initial = assistance.service(); assert.equal(stations.aiConfig().defaultSelectionRevision, 1);
  stations.saveAiConfig({ channelId: channel.id, enabled: false, intervalMinutes: 5, dailyLimit: 39 });
  const other = stations.saveAiChannel(undefined, { ...ready, apiKey: randomBytes(24).toString('hex') });
  assert.equal(stations.aiConfig().defaultSelectionRevision, 1); assert.equal(assistance.service().revision, initial.revision);
  stations.saveAiConfig({ channelId: other.id });
  const middle = assistance.service(); assert.equal(stations.aiConfig().defaultSelectionRevision, 2); assert.notEqual(middle.revision, initial.revision);
  stations.saveAiConfig({ channelId: channel.id });
  const returned = assistance.service(); assert.equal(stations.aiConfig().defaultSelectionRevision, 3); assert.notEqual(returned.revision, initial.revision);
  const reloadedStations = new StationStore({ db, key: Buffer.alloc(32, 5) }), reloaded = new AiAssistance({ stations: reloadedStations });
  try { assert.equal(reloadedStations.aiConfig().defaultSelectionRevision, 3); assert.equal(reloaded.service().revision, returned.revision); }
  finally { reloaded.close(); }
  stations.saveAiChannel(channel.id, { model: 'updated-model' });
  assert.equal(stations.aiConfig().defaultSelectionRevision, 3); assert.notEqual(assistance.service().revision, returned.revision);
});

test('omitted channel routes to the backend default, accepts its legacy id and rejects every other explicit id without quota use', async t => {
  const calls = [];
  const { stations, assistance, channel } = fixture(t, async request => { calls.push(request); return reply(candidate); });
  const other = stations.saveAiChannel(undefined, { ...ready, baseUrl: 'https://default.example.com/v1', model: 'selected-model', apiKey: randomBytes(24).toString('hex') });
  stations.saveAiConfig({ channelId: other.id });
  const first = await assistance.template({ sample: TEMPLATE_SAMPLE, expectedCode: '654321' }, 'device', () => {});
  assert.equal(first.validation.ok, true); assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://default.example.com/v1');
  assert.equal(JSON.parse(calls[0].body).model, 'selected-model'); assert.equal(stations.aiConfig().enabled, false);
  assert.deepEqual(await assistance.template(input(other.id), 'device', () => {}), first);
  assert.deepEqual(await assistance.template(input(''), 'device', () => {}), first);
  await assert.rejects(assistance.template(input(channel.id), 'device', () => {}), { code: 'AI_CONFIG_CHANGED', status: 409 });
  assert.equal(calls.length, 1); assert.equal(stations.aiConfig().usageToday, 1);
  for (const channelId of [null, 1, 'bad id', '../path']) assert.throws(() => validateTemplateInput(input(channelId)), { code: 'AI_CHANNEL_UNAVAILABLE' });
});

test('default changes abort old requests, clear cached routes and allow a new route immediately for the same device', async t => {
  const calls = []; let finish;
  const { stations, assistance, channel } = fixture(t, request => {
    calls.push(request); return calls.length === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(reply(candidate));
  });
  const other = stations.saveAiChannel(undefined, { ...ready, baseUrl: 'https://next.example.com/v1', apiKey: randomBytes(24).toString('hex') });
  const old = assistance.template(input(), 'device', () => {}), rejected = assert.rejects(old, { code: 'AI_CONFIG_CHANGED', status: 409 });
  stations.saveAiConfig({ channelId: other.id });
  assert.equal(calls[0].signal.aborted, true);
  const next = assistance.template(input(), 'device', () => {});
  await rejected; assert.equal((await next).validation.ok, true); assert.equal(calls.length, 2);
  finish(reply(candidate)); await tick();
  assert.equal(assistance.cache.size, 1); assert.equal([...assistance.cache.values()][0].channelId, other.id);
  stations.saveAiConfig({ channelId: channel.id }); assert.equal(assistance.cache.size, 0);
  await assistance.template(input(), 'device', () => {}); assert.equal(calls.length, 3); assert.equal(stations.aiConfig().usageToday, 3);
});

test('A-to-B-to-A selection changes cannot resurrect a pending result or join its old cache identity', async t => {
  let finish; const calls = [];
  const { stations, assistance, channel } = fixture(t, request => { calls.push(request); return calls.length === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(reply(candidate)); });
  const other = stations.saveAiChannel(undefined, { ...ready, apiKey: randomBytes(24).toString('hex') });
  const before = assistance.service().revision;
  const pending = assistance.template(input(), 'device', () => {}), rejected = assert.rejects(pending, { code: 'AI_CONFIG_CHANGED' });
  stations.saveAiConfig({ channelId: other.id }); stations.saveAiConfig({ channelId: channel.id });
  assert.notEqual(assistance.service().revision, before); await rejected;
  await assistance.template(input(), 'device', () => {});
  finish(reply(candidate)); await tick();
  assert.equal(calls.length, 2); assert.equal(assistance.cache.size, 1);
  assert.equal([...assistance.cache.values()][0].defaultRevision, assistance.service().revision);
});

test('editing another channel does not cancel default requests and admin tests keep their explicit channel after a default switch', async t => {
  let finish, signal;
  const { stations, assistance, channel } = fixture(t, request => { signal = request.signal; return new Promise(resolve => { finish = resolve; }); });
  const other = stations.saveAiChannel(undefined, { ...ready, apiKey: randomBytes(24).toString('hex') });
  const pending = assistance.template(input(), 'device', () => {});
  stations.saveAiChannel(other.id, { model: 'unrelated-model' });
  assert.equal(signal.aborted, false); finish(reply(candidate)); assert.equal((await pending).validation.ok, true);
  const calls = []; let first;
  assistance.transport = request => {
    calls.push(request);
    const value = JSON.parse(JSON.parse(request.body).messages[1].content);
    const result = reply(value.expectedStation ? LOGISTICS_TEST_RESULT : value.fragment ? { kind: 'locker', suggestedName: '合成驿站', alias: value.fragment, evidence: [value.fragment] } : candidate);
    return calls.length === 1 ? new Promise(resolve => { first = () => resolve(result); }) : Promise.resolve(result);
  };
  const tested = assistance.test(channel.id);
  stations.saveAiConfig({ channelId: other.id }); assert.equal(calls[0].signal.aborted, false);
  first(); assert.equal((await tested).ok, true); assert.equal(calls.length, 3);
  assert.ok(calls.every(request => request.url === ready.baseUrl));
});

test('default routing is rechecked after authorization callbacks for cached and newly returned results', async t => {
  const { stations, assistance, channel } = fixture(t);
  const other = stations.saveAiChannel(undefined, { ...ready, apiKey: randomBytes(24).toString('hex') });
  await assistance.template(input(), 'cached', () => {});
  let checks = 0;
  await assert.rejects(assistance.template(input(), 'cached', () => { if (++checks === 2) stations.saveAiConfig({ channelId: other.id }); }), { code: 'AI_CONFIG_CHANGED', status: 409 });
  assert.equal(assistance.cache.size, 0); stations.saveAiConfig({ channelId: channel.id }); checks = 0;
  await assert.rejects(assistance.template(input(), 'uncached', () => { if (++checks === 2) stations.saveAiConfig({ channelId: other.id }); }), { code: 'AI_CONFIG_CHANGED', status: 409 });
  assert.equal(assistance.cache.size, 0);
});

test('existing registry settings acquire a durable selection baseline without rewriting credentials or user settings', () => {
  const db = new DatabaseSync(':memory:'), key = randomBytes(32), stations = new StationStore({ db, key });
  try {
    const selected = stations.saveAiChannel(undefined, { ...ready, apiKey: randomBytes(24).toString('hex') });
    stations.saveAiConfig({ enabled: true, autoApply: true, logisticsEnabled: true, intervalMinutes: 5, dailyLimit: 37 });
    const settings = db.prepare('SELECT data,credential FROM station_ai_settings WHERE id=1').get(), original = JSON.parse(settings.data);
    delete original.defaultSelectionRevision;
    db.prepare('UPDATE station_ai_settings SET data=? WHERE id=1').run(JSON.stringify(original));
    const channelBefore = db.prepare('SELECT * FROM ai_channels WHERE id=?').get(selected.id);
    const restored = new StationStore({ db, key });
    assert.equal(restored.aiConfig().defaultSelectionRevision, 0);
    assert.equal(restored.aiConfig().channelId, selected.id); assert.equal(restored.aiConfig().autoApply, true);
    const stored = db.prepare('SELECT data,credential FROM station_ai_settings WHERE id=1').get();
    assert.deepEqual(JSON.parse(stored.data), { ...original, defaultSelectionRevision: 0 }); assert.equal(stored.credential, settings.credential);
    assert.deepEqual(db.prepare('SELECT * FROM ai_channels WHERE id=?').get(selected.id), channelBefore);
  } finally { db.close(); }
});

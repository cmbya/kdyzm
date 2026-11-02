import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { StationStore } from '../src/stations.mjs';
import { StationAiJobs, publicAddress, validateAiBaseUrl, resolveAiEndpoint, requestAiJson } from '../src/station-ai.mjs';

const NOW = Date.parse('2026-11-03T12:00:00+08:00');
function fixture(t, request) {
  let time = NOW;
  const db = new DatabaseSync(':memory:'), now = () => time;
  const stations = new StationStore({ db, key: Buffer.alloc(32, 4), now });
  stations.saveAiConfig({ channelName: '测试', baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'test-key', enabled: true });
  const jobs = new StationAiJobs({ stations, now, request });
  t.after(async () => { await jobs.close(); db.close(); });
  return { stations, jobs, advance: duration => { time += duration; } };
}
const reply = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const suggestion = { kind: 'locker', suggestedName: '4卡2号柜', alias: '4卡2号柜', subLocation: '2号柜', evidence: ['4卡2号柜'] };
const enqueue = (stations, id = 'c1', fragment = '包裹在4卡2号柜，电话13812345678，取件码7-6-7042') => stations.enqueue([{ id, stationName: '4卡2号柜', fragment, source: 'sms' }]);

test('AI calls are asynchronous, deduplicated, redacted and require human approval', async t => {
  let finish, outbound;
  const { stations, jobs } = fixture(t, request => { outbound = request; return new Promise(resolve => { finish = resolve; }); });
  enqueue(stations);
  assert.deepEqual(jobs.request(), { accepted: true, running: true });
  assert.deepEqual(jobs.request(), { accepted: false, running: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(outbound.headers.Authorization, 'Bearer test-key');
  assert.ok(!outbound.body.includes('13812345678'));
  assert.ok(!outbound.body.includes('7-6-7042'));
  const body = JSON.parse(outbound.body);
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.tools, undefined);
  finish(reply(suggestion)); await jobs.running;
  assert.equal(stations.candidates()[0].status, 'review');
  assert.equal(stations.stations().length, 0);
  stations.approveCandidate(stations.candidates()[0].id, {});
  assert.equal(stations.stations()[0].aliases[0].subLocation, '2号柜');
});

test('hallucinated ids, aliases, evidence, executable fields and tool calls are rejected', async t => {
  const cases = [
    reply({ ...suggestion, targetStationId: 'missing', suggestedName: '' }),
    reply({ ...suggestion, alias: '模型编造的站名' }),
    reply({ ...suggestion, evidence: ['输入中不存在的证据'] }),
    reply({ ...suggestion, suggestedName: 'https://evil.example.com' }),
    reply({ ...suggestion, script: 'curl https://evil.example.com' }),
    { choices: [{ message: { content: JSON.stringify(suggestion), tool_calls: [{ type: 'function' }] } }] },
    { choices: [{ message: { content: '```json\n{}\n```' } }] },
  ];
  for (let i = 0; i < cases.length; i++) await t.test(String(i), async t => {
    const { stations, jobs } = fixture(t, async () => cases[i]); enqueue(stations); jobs.request(); await jobs.running;
    assert.equal(stations.candidates()[0].status, 'failed');
    assert.ok(stations.candidates()[0].error.includes('校验'));
    assert.equal(stations.stations().length, 0);
  });
});

test('unknown stays for manual review and home/hub classifications cannot create aliases', async t => {
  for (const kind of ['unknown', 'home', 'hub']) await t.test(kind, async t => {
    const { stations, jobs } = fixture(t, async () => reply({ kind, targetStationId: '', suggestedName: '', alias: '', subLocation: '', evidence: [] }));
    enqueue(stations); jobs.request(); await jobs.running;
    assert.equal(stations.candidates()[0].status, kind === 'unknown' ? 'unknown' : 'ignored');
    assert.equal(stations.stations().length, 0);
    if (kind !== 'unknown') assert.throws(() => stations.approveCandidate(stations.candidates()[0].id, {}), { code: 'CANDIDATE_CLOSED' });
  });
});

test('finite retries consume the daily budget and provider errors never persist secrets', async t => {
  let calls = 0;
  const { stations, jobs } = fixture(t, async () => { calls++; throw Object.assign(new Error('test-key echoed request'), { retryable: true }); });
  stations.saveAiConfig({ dailyLimit: 2 }); enqueue(stations); enqueue(stations, 'c2', '另一条包裹在4卡2号柜');
  jobs.request(); await jobs.running;
  assert.equal(calls, 2);
  assert.equal(stations.aiConfig().usageToday, 2);
  assert.equal(stations.candidates().filter(c => c.status === 'pending').length, 1);
  assert.equal(stations.candidates().filter(c => c.status === 'failed').length, 1);
  assert.ok(!JSON.stringify(stations.candidates()).includes('test-key'));
  assert.equal(jobs.request().accepted, false);
});

test('transient failures retry after the configured interval and stop after three total attempts', async t => {
  let calls = 0;
  const { stations, jobs, advance } = fixture(t, async () => { calls++; throw Object.assign(new Error('temporary'), { retryable: true }); });
  enqueue(stations); jobs.request(); await jobs.running;
  assert.equal(calls, 2);
  assert.equal(stations.candidates()[0].attempts, 2);
  assert.equal(stations.candidates()[0].retryAt, NOW + 3600000);
  assert.equal(jobs.request().accepted, false);
  advance(3600000); assert.equal(jobs.runDue().accepted, true); await jobs.running;
  assert.equal(calls, 3);
  assert.equal(stations.candidates()[0].attempts, 3);
  assert.equal(stations.candidates()[0].retryAt, 0);
  advance(86400000); assert.equal(jobs.runDue().accepted, false);
});

test('scheduled empty queues and completed candidates make no calls; new items wait for the interval', async t => {
  let calls = 0;
  const { stations, jobs, advance } = fixture(t, async () => { calls++; return reply(suggestion); });
  assert.equal(jobs.runDue().accepted, false); assert.equal(calls, 0); assert.equal(stations.aiConfig().lastRunAt, 0);
  enqueue(stations); assert.equal(jobs.runDue().accepted, true); await jobs.running;
  assert.equal(calls, 1);
  enqueue(stations, 'c2', '另一条包裹在4卡2号柜'); assert.equal(jobs.runDue().accepted, false);
  advance(3600000); assert.equal(jobs.runDue().accepted, true); await jobs.running;
  assert.equal(calls, 2);
  advance(86400000); assert.equal(stations.aiConfig().usageToday, 0); assert.equal(jobs.runDue().accepted, false);
});

test('connection testing sends a fixed privacy-free payload and uses the same daily budget', async t => {
  let outbound;
  const { stations, jobs } = fixture(t, async request => { outbound = request; return reply({ ok: true }); });
  enqueue(stations); stations.saveAiConfig({ enabled: false });
  assert.deepEqual(await jobs.testConnection(), { ok: true, message: 'AI连接正常' });
  assert.ok(!outbound.body.includes('4卡'));
  assert.ok(outbound.body.includes('connectionTest'));
  assert.equal(stations.aiConfig().usageToday, 1);
  assert.equal(stations.candidates()[0].status, 'pending');
  assert.equal(jobs.request().accepted, false);
});

test('close aborts active work promptly and never writes a late model response', async t => {
  let finish, signal;
  const { stations, jobs } = fixture(t, async request => { signal = request.signal; return new Promise(resolve => { finish = resolve; }); });
  enqueue(stations); jobs.request();
  await new Promise(resolve => setImmediate(resolve));
  await jobs.close();
  assert.equal(signal.aborted, true);
  finish(reply(suggestion));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stations.candidates()[0].status, 'pending');
  assert.equal(jobs.request().accepted, false);
});

test('public HTTPS endpoint validation blocks private, special, credentialed and redirected destinations', async () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.0.1', '100.64.0.1', '169.254.169.254', '198.18.0.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2002:7f00:1::', '2001:db8::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(publicAddress(address), true, address);
  for (const url of ['http://api.example.com', 'https://localhost', 'https://host.local', 'https://2130706433', 'https://0x7f000001', 'https://127.1', 'https://[::1]', 'https://user:pass@api.example.com', 'https://api.example.com?token=x', 'https://api.example.com#x']) assert.throws(() => validateAiBaseUrl(url), { code: 'AI_ENDPOINT_BLOCKED' }, url);
  const endpoint = await resolveAiEndpoint('https://api.example.com/v1/', async () => [{ address: '1.1.1.1', family: 4 }]);
  assert.equal(endpoint.url.href, 'https://api.example.com/v1/chat/completions');
  assert.equal(endpoint.address, '1.1.1.1');
  await assert.rejects(resolveAiEndpoint('https://api.example.com', async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]), { code: 'AI_ENDPOINT_BLOCKED' });
  await assert.rejects(requestAiJson({ url: 'https://api.example.com', headers: {}, body: '{}', signal: new AbortController().signal }, async () => [{ address: '10.0.0.1', family: 4 }]), { code: 'AI_ENDPOINT_BLOCKED' });
});

test('HTTPS transport pins the validated DNS address, refuses redirects and limits response bytes', async () => {
  const resolver = async () => [{ address: '1.1.1.1', family: 4 }];
  const options = { url: 'https://api.example.com/v1', headers: { Authorization: 'Bearer SYNTHETIC' }, body: '{}', signal: new AbortController().signal };
  let calls = 0, captured;
  const requester = (statusCode, content) => (url, settings, callback) => {
    calls++; captured = { url, settings };
    const req = new EventEmitter(); req.setTimeout = () => req;
    req.end = () => { const response = Readable.from([Buffer.from(content)]); response.statusCode = statusCode; callback(response); };
    return req;
  };
  assert.deepEqual(await requestAiJson(options, resolver, requester(200, '{"ok":true}')), { ok: true });
  assert.equal(captured.url.hostname, 'api.example.com');
  assert.equal(captured.settings.agent, false);
  captured.settings.lookup('api.example.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '1.1.1.1'); assert.equal(family, 4); });
  captured.settings.lookup('api.example.com', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '1.1.1.1', family: 4 }]); });
  await assert.rejects(requestAiJson(options, resolver, requester(302, '{"location":"https://127.0.0.1"}')), { code: 'AI_HTTP_ERROR' });
  assert.equal(calls, 2);
  await assert.rejects(requestAiJson(options, resolver, requester(200, ' '.repeat(65537))), { code: 'AI_RESPONSE_TOO_LARGE' });
});

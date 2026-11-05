import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.mjs';
import { TEMPLATE_SAMPLE } from '../src/ai-templates.mjs';
import { randomBytes } from 'node:crypto';

const SYNTHETIC_CREDENTIAL = randomBytes(24).toString('hex');
const SECOND_CREDENTIAL = randomBytes(24).toString('hex');

const ADMIN = 'synthetic-admin-ai-testing-token-long-enough';
const channelConfig = { name: '统一渠道', baseUrl: 'https://api.example.com/v1', model: 'synthetic-model', apiKey: SYNTHETIC_CREDENTIAL, enabled: true };
const candidate = { name: '合成模板', signature: '合成快递', keywords: ['取件码'], kind: 'pickup', rules: { code: { start: '取件码', end: '，' }, express: { start: '', end: '' }, address: { start: '已到', end: '，' } } };
const response = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const body = channelId => ({ channelId, sample: TEMPLATE_SAMPLE, expectedCode: '654321' });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, aiRequest) {
  const service = createService({ encryptionKey: '74'.repeat(32), adminToken: ADMIN, scheduler: false, fixture: true, aiRequest: aiRequest || (async () => response(candidate)) });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve)); t.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (path, { method = 'GET', token, admin = false, body } = {}) => {
    const result = await fetch(base + path, { method, headers: { ...(admin ? { 'x-admin-token': ADMIN } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await result.text(); return { status: result.status, raw, data: raw ? JSON.parse(raw) : null };
  };
  const account = service.store.saveAccount({ platform: 'taobao', label: '合成账号', cookie: 'SYNTHETIC_COOKIE' }, undefined, true);
  const device = service.store.redeem(service.store.createPairing({ accountIds: [account.id] }).code, '测试设备');
  return { service, request, account, device };
}

test('channel routes protect admin writes, expose only configured public choices and never export secrets', async t => {
  const { request, service, device } = await fixture(t);
  assert.equal((await request('/v1/ai/channels')).status, 401);
  assert.equal((await request('/v1/admin/ai-channels', { token: device.token })).status, 401);
  assert.equal((await request('/v1/admin/ai-channels', { method: 'POST', token: device.token, body: channelConfig })).status, 401);
  const created = await request('/v1/admin/ai-channels', { method: 'POST', admin: true, body: channelConfig });
  assert.equal(created.status, 201); assert.equal(created.data.channels.length, 1); assert.equal(created.data.dailyLimit, 20); assert.ok(!created.raw.includes(SYNTHETIC_CREDENTIAL));
  const channel = created.data.channels[0];
  const list = await request('/v1/ai/channels', { token: device.token });
  assert.deepEqual(list.data, { channels: [{ id: channel.id, name: channel.name, model: channel.model, capabilities: ['station_alias', 'sms_template'] }], defaultChannelId: channel.id });
  assert.ok(!list.raw.includes('example.com')); assert.ok(!list.raw.includes('Key'));
  const snapshot = await request('/v1/snapshot', { token: device.token }); assert.ok(!snapshot.raw.includes(SYNTHETIC_CREDENTIAL));
  const paused = await request(`/v1/admin/ai-channels/${channel.id}`, { method: 'PATCH', admin: true, body: { enabled: false } }); assert.equal(paused.data.channel.enabled, false);
  assert.deepEqual((await request('/v1/ai/channels', { token: device.token })).data, { channels: [], defaultChannelId: '' });
  assert.equal(service.stations.aiConfig().channelId, channel.id);
  assert.equal((await request(`/v1/admin/ai-channels/${channel.id}`, { method: 'DELETE', admin: true })).status, 404);
  const rejected = await request('/v1/ai/template-proposals', { method: 'POST', token: device.token, body: body(channel.id) }); assert.equal(rejected.status, 409); assert.equal(rejected.data.error.code, 'AI_CHANNEL_UNAVAILABLE');
});

test('device proposal stays unpersisted pending confirmation, reuses retries, isolates devices and shares daily quota', async t => {
  let calls = 0;
  const { request, service, device, account } = await fixture(t, async () => { calls++; return response(candidate); });
  const channel = service.stations.saveAiChannel(undefined, channelConfig);
  const first = await request('/v1/ai/template-proposals', { method: 'POST', token: device.token, body: body(channel.id) });
  assert.equal(first.status, 200); assert.equal(first.data.validation.ok, true); assert.equal(first.data.validation.requiresConfirmation, true); assert.deepEqual(first.data.candidate, candidate);
  const repeated = await request('/v1/ai/template-proposals', { method: 'POST', token: device.token, body: body(channel.id) }); assert.deepEqual(repeated.data, first.data); assert.equal(calls, 1);
  const other = service.store.redeem(service.store.createPairing({ accountIds: [account.id] }).code, '另一设备');
  assert.equal((await request('/v1/ai/template-proposals', { method: 'POST', token: other.token, body: body(channel.id) })).status, 200); assert.equal(calls, 2);
  assert.equal(service.stations.candidates().length, 0); assert.equal(service.stations.stations().length, 0);
  service.stations.saveAiConfig({ dailyLimit: 2 });
  const exhausted = await request('/v1/ai/template-proposals', { method: 'POST', token: device.token, body: { ...body(channel.id), sample: TEMPLATE_SAMPLE + '请尽快领取' } });
  assert.equal(exhausted.status, 429); assert.equal(exhausted.data.error.code, 'AI_DAILY_LIMIT'); assert.equal(calls, 2);
});

test('sensitive input is rejected before dispatch and device request rate limits cannot be bypassed by malformed repeats', async t => {
  let calls = 0;
  const { request, service, device } = await fixture(t, async () => { calls++; return response(candidate); });
  const channel = service.stations.saveAiChannel(undefined, channelConfig);
  for (let count = 0; count < 4; count++) {
    const result = await request('/v1/ai/template-proposals', { method: 'POST', token: device.token, body: { ...body(channel.id), sample: TEMPLATE_SAMPLE + '手机号13812345678' } });
    assert.equal(result.status, 400); assert.equal(result.data.error.code, 'AI_SAMPLE_UNSAFE');
  }
  assert.equal((await request('/v1/ai/template-proposals', { method: 'POST', token: device.token, body: body(channel.id) })).status, 429); assert.equal(calls, 0);
});

test('revocation and grant changes during transport suppress late results and prevent caching', async t => {
  for (const change of ['revoke', 'scope']) await t.test(change, async t => {
    let finish, started;
    const dispatched = new Promise(resolve => { started = resolve; });
    const { request, service, device } = await fixture(t, () => { started(); return new Promise(resolve => { finish = resolve; }); });
    const channel = service.stations.saveAiChannel(undefined, channelConfig);
    const pending = request('/v1/ai/template-proposals', { method: 'POST', token: device.token, body: body(channel.id) });
    await dispatched;
    if (change === 'revoke') service.store.revoke(device.deviceId); else service.store.updateDevice(device.deviceId, { accountIds: [] });
    finish(response(candidate)); const result = await pending;
    assert.equal(result.status, change === 'revoke' ? 401 : 403); assert.equal(result.data.candidate, undefined); assert.equal(service.aiAssistance.cache.size, 0);
  });
});

test('per-channel test checks both synthetic capabilities using the selected provider only', async t => {
  const calls = [];
  const { request, service } = await fixture(t, async value => { calls.push(value); const input = JSON.parse(JSON.parse(value.body).messages[1].content);
    return response(input.fragment ? { kind: 'locker', suggestedName: '合成驿站', alias: input.fragment, subLocation: '2号柜', evidence: [input.fragment] } : candidate); });
  service.stations.saveAiChannel(undefined, channelConfig);
  const other = service.stations.saveAiChannel(undefined, { ...channelConfig, name: '测试第二渠道', baseUrl: 'https://second.example.com/v1', apiKey: SECOND_CREDENTIAL, model: 'second-model' });
  const result = await request(`/v1/admin/ai-channels/${other.id}/test`, { method: 'POST', admin: true, body: {} });
  assert.equal(result.status, 200); assert.equal(result.data.ok, true); assert.equal(calls.length, 2);
  assert.ok(calls.every(value => value.url === 'https://second.example.com/v1' && value.headers.Authorization === 'Bearer ' + SECOND_CREDENTIAL && JSON.parse(value.body).model === 'second-model'));
  assert.equal(service.stations.aiConfig().usageToday, 2); assert.ok(!result.raw.includes('PRIVATE_KEY'));
});

test('pausing an active channel promptly cancels HTTP work and preserves daily charge', async t => {
  let started, signal;
  const dispatched = new Promise(resolve => { started = resolve; });
  const { request, service, device } = await fixture(t, value => { signal = value.signal; started(); return new Promise(() => {}); });
  const channel = service.stations.saveAiChannel(undefined, channelConfig);
  const pending = request('/v1/ai/template-proposals', { method: 'POST', token: device.token, body: body(channel.id) }); await dispatched;
  service.stations.saveAiChannel(channel.id, { enabled: false });
  const result = await pending; assert.equal(result.status, 409); assert.equal(result.data.error.code, 'AI_CONFIG_CHANGED'); assert.equal(signal.aborted, true);
  await tick(); assert.equal(service.aiAssistance.cache.size, 0); assert.equal(service.stations.aiConfig().usageToday, 1);
});

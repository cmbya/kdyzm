import test from 'node:test';
import assert from 'node:assert/strict';
import '../app-source/pickcode/core/load-core.mjs';

const at = Date.now() - 3600000;
const account = { id: 'a', platform: 'jd', status: 'ok' };
const order = { id: 'o', accountId: 'a', platform: 'jd', title: '测试包裹', orderDate: at };
const shipment = { id: 'remote-s', orderId: 'o', accountId: 'a', waybillNo: 'JD12345678901', carrier: '中通',
  status: 'arrived', pickupCode: '', station: '示例花园店', arrivalAt: 0, arrivalAtSource: 'unknown', arrivalAtPrecision: 'unknown', updatedAt: at };
function fixture({ capabilities = ['recognition_workflow_v1'], ships = [shipment], messageStation = shipment.station } = {}) {
  let saved = '';
  const call = (action = 'snapshot', payload = {}) => {
    const value = JSON.parse(globalThis.PickCodeCore.dispatch(saved, JSON.stringify({ action, payload })));
    saved = JSON.stringify(value.state); return value.result;
  };
  call.saved = () => JSON.parse(saved);
  call('syncMeta', { bound: true, baseUrl: 'https://fixture.example', deviceId: 'd', accounts: [account] });
  call.sync = (next = ships, revision = 2, extra = {}) => call('syncImport', { snapshot: {
    schemaVersion: 1, serverRevision: revision, accounts: [account], orders: [order], shipments: next, capabilities,
    stationRulesVersion: 1, stationRules: [], ...extra } });
  call.sync(ships, 1);
  call.ingest = (id = 'm') => call('ingest', { messages: [{ id, date: at + 15000,
    body: '【菜鸟驿站】张先生您的包裹已到达' + messageStation + '，取件码7-6-7042。联系电话13800138000' }] });
  call.ingest();
  return call;
}
const batch = c => c('recognitionIssueBatch').items;
const source = value => value.codes.find(code => code.sources.length).sources[0];
const ack = (items, status = 'pending', retryCount = 0) => ({ accepted: items.map(({ id, revision }) => ({ id, revision })),
  issues: items.map(({ id, revision }) => ({ id, revision, status, retryCount, reasonCode: 'MISSING_ARRIVAL', nextRetryAt: 0 })) });

test('能力默认启动单候选失败追踪，站点学习关闭不上传片段或短信正文', () => {
  const c = fixture(), items = batch(c);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].candidateShipmentIds, ['remote-s']);
  assert.equal(items[0].state, 'unresolved');
  assert.equal(items[0].source.station, '');
  assert.equal(items[0].source.fragment, '');
  assert.equal(items[0].source.pickupCode, '7-6-7042');
  assert.ok(items[0].reasonCodes.includes('arrival_time_unknown'));
  assert.equal(source(c()).linkedShipmentIds.length, 0);
  assert.ok(!JSON.stringify(items).includes('13800138000'));
  assert.ok(!JSON.stringify(items).includes('张先生'));
  assert.notEqual(items[0].sourceId, source(c()).sourceId);
});

test('重复快照、同证据同步、上传失败与精确ack幂等且不累计业务重试', () => {
  const c = fixture(), first = batch(c);
  for (let i = 0; i < 4; i++) { c(); c('recognitionIssueFailed'); c.sync([shipment], 2 + i); }
  assert.deepEqual(batch(c), first);
  c.sync([{ ...shipment, updatedAt: at + 60000 }], 9);
  assert.deepEqual(batch(c), first, 'a collection timestamp alone is not new matching evidence');
  c('recognitionIssueAck', { accepted: [{ id: first[0].id, revision: first[0].revision + 1 }], issues: [] });
  assert.equal(batch(c).length, 1);
  c('recognitionIssueAck', ack(first, 'retrying', 2));
  c('recognitionIssueAck', ack(first, 'pending', 0));
  assert.equal(batch(c).length, 0);
  assert.equal(c().online.recognitionIssues[0].retryCount, 2);
  assert.equal(c().online.recognitionIssues[0].status, 'retrying');
});

test('真实证据变化产生新版本，已匹配才报告resolved且旧回执不能确认新版本', () => {
  const c = fixture(), first = batch(c); c('recognitionIssueAck', ack(first));
  c.sync([{ ...shipment, arrivalAt: at, arrivalAtSource: 'platform_event', arrivalAtPrecision: 'second' }]);
  const next = batch(c);
  assert.equal(source(c()).linkedShipmentIds.length, 1);
  assert.equal(next[0].id, first[0].id);
  assert.equal(next[0].revision, first[0].revision + 1);
  assert.equal(next[0].state, 'resolved');
  c('recognitionIssueAck', ack(first));
  assert.equal(batch(c).length, 1);
  c('recognitionIssueAck', ack(next, 'resolved'));
  assert.equal(batch(c).length, 0);
  assert.equal(c().online.recognitionIssues[0].status, 'resolved');
});

test('学习开关只决定片段，改变开关刷新版本并保留纯净站名', () => {
  const c = fixture(), first = batch(c);
  c('settings', { stationEnhancement: true });
  const learned = batch(c)[0];
  assert.equal(learned.revision, first[0].revision + 1);
  assert.equal(learned.source.station, '示例花园店');
  assert.equal(learned.source.fragment, '示例花园店');
  c('settings', { stationEnhancement: false, manualLearning: false });
  assert.equal(batch(c)[0].source.fragment, '');
  assert.equal(batch(c)[0].revision, learned.revision + 1);
});

test('改绑、撤销授权、已领取与旧后台不上传旧服务或非活动候选', () => {
  assert.equal(batch(fixture({ capabilities: [] })).length, 0);
  assert.equal(batch(fixture({ ships: [] })).length, 0);
  assert.equal(batch(fixture({ ships: [{ ...shipment, picked: true }] })).length, 0);
  const c = fixture(), first = batch(c);
  c('syncMeta', { bound: true, baseUrl: 'https://other.example', deviceId: 'other-d', accounts: [account] });
  assert.equal(batch(c).length, 0);
  assert.deepEqual(c().online.recognitionIssues, []);
  c('recognitionIssueAck', ack(first));
  assert.deepEqual(c().online.recognitionIssues, []);
  c.sync([shipment]);
  assert.equal(batch(c).length, 1);
  assert.notEqual(batch(c)[0].id, first[0].id);
  c.sync([], 3, { familyIds: [], legacyAccountIds: [], accounts: [], orders: [] });
  assert.equal(batch(c).length, 0);
  assert.deepEqual(c().online.recognitionIssues, []);
});

test('同服务同设备重新绑定也使用新的报告epoch，迟到回执不能确认新报告', () => {
  const c = fixture(), old = batch(c);
  c('syncMeta', { bound: false });
  c('syncMeta', { bound: true, baseUrl: 'https://fixture.example', deviceId: 'd', accounts: [account] });
  c.sync([shipment]);
  const current = batch(c);
  assert.equal(current.length, 1);
  assert.notEqual(current[0].id, old[0].id);
  assert.notEqual(current[0].sourceId, old[0].sourceId);
  c('recognitionIssueAck', ack(old));
  assert.equal(batch(c).length, 1);
});

test('多个候选按remote id报告但不强制配对，每批最多20', () => {
  const c = fixture({ ships: [shipment, { ...shipment, id: 'remote-s2' }] });
  assert.deepEqual(batch(c)[0].candidateShipmentIds, ['remote-s', 'remote-s2']);
  assert.equal(source(c()).linkedShipmentIds.length, 0);
  for (let i = 0; i < 22; i++) c.ingest('m-' + i);
  assert.equal(batch(c).length, 20);
});

test('后台状态只更新诊断，规则已应用或后台resolved不会制造手机关联', () => {
  const c = fixture(), first = batch(c);
  c.sync([shipment], 2, { recognitionIssues: ack(first, 'resolved', 3).issues });
  assert.equal(source(c()).linkedShipmentIds.length, 0);
  assert.equal(batch(c)[0].state, 'unresolved');
  assert.equal(c().online.recognitionIssues[0].status, 'review');
  c('recognitionIssueAck', ack(first, 'blocked', 3));
  assert.equal(c().online.recognitionIssues[0].status, 'blocked');
});

test('多件短信仅关联其中一件仍未解决', () => {
  const c = fixture();
  const snapshot = c('ingest', { messages: [{ id: 'multi', date: at + 15000,
    body: '【菜鸟驿站】您有2个包裹已到达示例花园店，取件码3-2-9001' }] });
  const partial = snapshot.codes.flatMap(code => code.sources).find(item => item.packageCount === 2);
  const row = c.saved().recognitionIssues.items.find(item => item.localSourceId === partial.sourceId);
  c('linkSource', { sourceId: partial.sourceId, shipmentIds: [snapshot.packages[0].shipments[0].id] });
  const report = batch(c).find(item => item.id === row.id);
  assert.equal(report.state, 'unresolved');
});

test('驿站代收signed但未领取仍报告同站缺失时间，家门口签收不报告', () => {
  for (const status of ['arrived', 'signed']) {
    const station = '示例花园菜鸟驿站', c = fixture({ ships: [{ ...shipment, status, station, picked: false }], messageStation: station });
    assert.equal(source(c()).matchCandidates.length, 1, status);
    assert.equal(batch(c).length, 1, status);
    assert.equal(batch(c)[0].state, 'unresolved', status);
    assert.ok(batch(c)[0].reasonCodes.includes('arrival_time_unknown'), status);
  }
  const c = fixture({ ships: [{ ...shipment, status: 'signed', station: '家门口', picked: false }], messageStation: '家门口' });
  assert.equal(source(c()).matchCandidates.length, 0);
  assert.equal(batch(c).length, 0);
});

test('已有取件组的signed保留本机真实匹配解决回执', () => {
  const c = fixture(), pending = batch(c), snapshot = c();
  c('recognitionIssueAck', ack(pending));
  c('linkSource', { sourceId: source(snapshot).sourceId, shipmentIds: [snapshot.packages[0].shipments[0].id] });
  c.sync([{ ...shipment, status: 'signed', station: '', picked: false }]);
  assert.equal(batch(c).length, 1);
  assert.equal(batch(c)[0].state, 'resolved');
});

test('已上报来源被忽略删除或手动解绑后发送独立withdrawn终态', () => {
  for (const action of ['ignore', 'remove', 'unlinkSource']) {
    const c = fixture(), sent = batch(c), current = c();
    c('recognitionIssueAck', ack(sent));
    c(action, action === 'remove' ? { ids: [current.codes[0].id] } : { sourceId: source(current).sourceId });
    const withdrawn = batch(c);
    assert.equal(withdrawn.length, 1, action);
    assert.equal(withdrawn[0].id, sent[0].id, action);
    assert.equal(withdrawn[0].sourceId, sent[0].sourceId, action);
    assert.equal(withdrawn[0].revision, sent[0].revision + 1, action);
    assert.equal(withdrawn[0].state, 'withdrawn', action);
    assert.deepEqual(withdrawn[0].candidateShipmentIds, []);
    assert.deepEqual(withdrawn[0].source, { station: '', carrier: '', waybillNo: '', pickupCode: '', occurredAt: null, fragment: '' });
    c(); c('recognitionIssueAck', ack(sent));
    assert.deepEqual(batch(c), withdrawn);
    c.sync([], 3, { accounts: [], orders: [], familyIds: [], legacyAccountIds: [] });
    assert.deepEqual(batch(c), withdrawn, 'withdrawal does not require a still-active candidate');
    c('recognitionIssueAck', ack(withdrawn, 'ignored'));
    assert.equal(batch(c).length, 0);
  }
});

test('在途报告撤回不等旧ACK，恢复来源以更高版本重新报告', () => {
  const c = fixture(), sent = batch(c), sourceId = source(c()).sourceId;
  c('ignore', { sourceId });
  const withdrawn = batch(c);
  c('recognitionIssueAck', ack(sent));
  assert.deepEqual(batch(c), withdrawn);
  c('recognitionIssueAck', ack(withdrawn, 'ignored'));
  c('restore', { sourceId });
  const restored = batch(c);
  assert.equal(restored[0].id, sent[0].id);
  assert.equal(restored[0].revision, withdrawn[0].revision + 1);
  assert.equal(restored[0].state, 'unresolved');
  assert.deepEqual(restored[0].candidateShipmentIds, ['remote-s']);
  c('recognitionIssueAck', ack(withdrawn, 'ignored'));
  assert.deepEqual(batch(c), restored);
});

test('从未准备上传的本地问题被忽略后不产生远程任务', () => {
  const c = fixture();
  c('ignore', { sourceId: source(c()).sourceId });
  assert.equal(batch(c).length, 0);
});

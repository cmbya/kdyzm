import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { StationStore, enqueuePlatformCandidates, enqueueStationProposal } from '../src/stations.mjs';

const NOW = Date.parse('2026-11-03T12:00:00+08:00');
const fixture = t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return { db, stations: new StationStore({ db, key: Buffer.alloc(32, 7), now: () => NOW }) };
};
const item = (id = 'client-1', extra = {}) => ({ id, stationName: '4卡2号柜', fragment: '包裹在4卡2号柜，请取件', source: 'sms', ...extra });
const configured = { channelName: '测试渠道', baseUrl: 'https://api.example.com/v1', model: 'configured-model', apiKey: 'test-key' };

test('station tables preserve business data and use an independent rules revision', t => {
  const { stations, db } = fixture(t);
  db.exec('CREATE TABLE meta (revision INTEGER); INSERT INTO meta VALUES(25); CREATE TABLE orders (data TEXT); INSERT INTO orders VALUES(\'synthetic-order\')');
  let station = stations.saveStation(null, { name: '四卡驿站', region: '测试地区', aliases: [{ name: '4卡2号柜', subLocation: '2号柜' }, { name: '四卡菜鸟驿站' }] });
  assert.equal(station.revision, 1);
  assert.equal(station.aliases[0].name, '4卡2号柜');
  assert.equal(station.aliases[0].subLocation, '2号柜');
  assert.equal(stations.stationRules().stations.length, 1);
  station = stations.saveStation(station.id, { enabled: false });
  assert.equal(stations.stationRules().revision, 2);
  assert.deepEqual(stations.stationRules().stations, []);
  assert.equal(stations.stations()[0].aliases.length, 2);
  assert.equal(db.prepare('SELECT revision FROM meta').get().revision, 25);
  assert.equal(db.prepare('SELECT data FROM orders').get().data, 'synthetic-order');
});

test('duplicate and conflicting aliases are rejected without changing station rules', t => {
  const { stations } = fixture(t);
  stations.saveStation('s1', { name: '四卡驿站', aliases: [{ name: '4卡2号柜' }] });
  assert.throws(() => stations.saveStation('s2', { name: '别的驿站', aliases: [{ name: '４卡2号柜' }] }), { code: 'ALIAS_EXISTS' });
  assert.throws(() => stations.saveStation('s2', { name: '别的驿站', aliases: [{ name: '别称' }, { name: '别称' }] }), { code: 'ALIAS_EXISTS' });
  assert.throws(() => stations.saveStation('s2', { name: '住宅', aliases: [] }), { code: 'INVALID_STATION' });
  assert.throws(() => stations.saveStation('s2', { name: '<script>坏站点</script>' }), { code: 'INVALID_STATION' });
  assert.equal(stations.revision, 1);
});

test('station regions reject private contacts and codes while ordinary regions remain valid', t => {
  const { stations } = fixture(t);
  const station = stations.saveStation('safe', { name: '合成服务站', region: '合成地区东区' });
  for (const region of ['联系电话13812345678', '邮箱test@example.com', '取件码7-6-7042', '运单SF123456789012']) {
    assert.throws(() => stations.saveStation('safe', { region }), { code: 'INVALID_STATION' }, region);
    assert.deepEqual(stations.station('safe'), station);
  }
});

test('active station ownership uses the same location numbers and punctuation as mobile recognition', t => {
  const { stations } = fixture(t);
  stations.saveStation('s1', { name: '城东总站', region: '地区甲', aliases: [{ name: '远洋风景四卡店' }, { name: '幸福花园二号柜' }] });
  for (const alias of ['远洋风景4卡店', '远洋风景（４卡店）', '幸福花园 2号柜']) {
    assert.throws(() => stations.saveStation('s2', { name: '城西总站', region: '地区乙', aliases: [{ name: alias }] }), { code: 'ALIAS_EXISTS' });
  }
  assert.throws(() => stations.saveStation('s2', { name: '远洋风景4卡店' }), { code: 'ALIAS_EXISTS' });
  assert.throws(() => stations.saveStation('s2', { name: '独立总站', aliases: [{ name: '西区四卡店' }, { name: '西区4卡店' }] }), { code: 'ALIAS_EXISTS' });
  stations.saveStation('s3', { name: '四卡服务站', region: '地区甲' });
  assert.throws(() => stations.saveStation('s4', { name: '4卡服务站', region: '地区乙' }), { code: 'ALIAS_EXISTS' });
  const disabled = stations.saveStation('s5', { name: '停用总站', enabled: false, aliases: [{ name: '远洋风景4卡店' }] });
  assert.equal(disabled.enabled, false);
  assert.throws(() => stations.saveStation('s5', { enabled: true }), { code: 'ALIAS_EXISTS' });
});

test('conflict normalization preserves station brands, station types and numbers inside proper names', t => {
  const { stations } = fixture(t);
  const names = ['远洋风景4卡丰巢快递柜', '远洋风景四卡菜鸟驿站', '四季花园', '4季花园', '三里屯', '3里屯'];
  names.forEach((name, index) => stations.saveStation(`station-${index}`, { name }));
  assert.equal(stations.stationRules().stations.length, names.length);
});

test('nonterminal locations are blocked locally at queue, direct save, model validation and human approval', t => {
  const { stations } = fixture(t);
  const valid = stations.saveStation('valid', { name: '幸福取件站' });
  for (const [index, term] of ['分拣中心', '中转场', '发货仓', '分拨点', '转运场', '集散仓库', '发件仓', '配送中心'].entries()) {
    const name = `合成${term}`;
    assert.equal(stations.enqueue([item(`bad-${index}`, { stationName: name, fragment: name })]).rejected, 1, term);
    assert.throws(() => stations.saveStation(`bad-${index}`, { name }), { code: 'INVALID_STATION' }, term);
    assert.throws(() => stations.saveStation(valid.id, { aliases: [{ name }] }), { code: 'INVALID_ALIAS' }, term);
    stations.enqueue([item(`legacy-${index}`, { stationName: `历史取件站${index}`, fragment: `历史取件站${index}` })]);
    const candidate = stations.candidates().find(c => c.stationName === `历史取件站${index}`);
    stations.updateCandidate(candidate.id, { stationName: name, fragment: name });
    const suggestion = { kind: 'pickup_station', targetStationId: valid.id, alias: name, subLocation: '', evidence: [name] };
    assert.throws(() => stations.recordSuggestion(candidate.id, suggestion), { code: 'AI_INVALID_RESULT' }, term);
    stations.updateCandidate(candidate.id, { status: 'review', suggestion });
    assert.throws(() => stations.approveCandidate(candidate.id, {}), { code: 'INVALID_STATION' }, term);
  }
  assert.equal(stations.stationRules().stations.length, 1);
  assert.equal(stations.station(valid.id).aliases.length, 0);
});

test('queue redacts private data before storage, deduplicates and acknowledges client ids', t => {
  const { stations, db } = fixture(t);
  const fragment = '包裹在4卡2号柜，电话13812345678，运单SF123456789012，取件码7-6-7042，https://example.com/code?k=888888';
  assert.deepEqual(stations.enqueue([item('c1', { fragment }), item('c2', { fragment })], { deviceId: 'device-1' }), { accepted: 1, duplicates: 1, rejected: 0, acceptedIds: ['c1', 'c2'], rejectedIds: [] });
  const candidate = stations.candidates()[0];
  assert.equal(candidate.occurrences, 2);
  assert.ok(candidate.fragment.includes('4卡2号柜'));
  assert.equal(candidate.status, 'pending');
  const stored = JSON.stringify(db.prepare('SELECT * FROM station_candidates').all());
  for (const secret of ['13812345678', 'SF123456789012', '7-6-7042', 'https://', '888888', 'device-1']) assert.ok(!stored.includes(secret), secret);
  assert.equal(stations.revision, 0);
});

test('queue rejects unknown fields, spoofed sources, homes, hubs and oversized fragments', t => {
  const { stations } = fixture(t);
  const result = stations.enqueue([item('a', { script: 'bad' }), item('b', { source: 'platform' }), item('c', { fragment: '包裹放在家门口' }), item('d', { fragment: '快件到达转运中心' }), item('e', { fragment: '字'.repeat(601) })]);
  assert.equal(result.rejected, 5);
  assert.deepEqual(result.acceptedIds, []);
  assert.equal(stations.candidates().length, 0);
  assert.throws(() => stations.enqueue(Array.from({ length: 21 }, (_, i) => item(String(i)))), { code: 'INVALID_CANDIDATES' });
});

test('only a human confirmation promotes literal aliases and preserves the locker location', t => {
  const { stations } = fixture(t);
  const station = stations.saveStation('s1', { name: '四卡驿站', region: '测试地区' });
  stations.enqueue([item()]);
  const candidate = stations.candidates()[0];
  stations.recordSuggestion(candidate.id, { kind: 'locker', targetStationId: station.id, alias: '4卡2号柜', subLocation: '2号柜', evidence: ['4卡2号柜'] });
  assert.equal(stations.station(station.id).aliases.length, 0);
  assert.throws(() => stations.approveCandidate(candidate.id, { alias: '编造别名' }), { code: 'INVALID_ALIAS' });
  const result = stations.approveCandidate(candidate.id, {});
  assert.equal(result.candidate.status, 'approved');
  assert.equal(result.station.aliases[0].name, '4卡2号柜');
  assert.equal(result.station.aliases[0].source, 'ai');
  assert.equal(result.station.aliases[0].subLocation, '2号柜');
  assert.throws(() => stations.approveCandidate(candidate.id, {}), { code: 'CANDIDATE_CLOSED' });
  assert.throws(() => stations.ignoreCandidate(candidate.id), { code: 'CANDIDATE_CLOSED' });
  assert.equal(stations.stationRules().stations[0].aliases.length, 1);
});

test('ignore cannot be overwritten by an AI response already in flight', t => {
  const { stations } = fixture(t);
  stations.enqueue([item()]);
  const candidate = stations.candidates()[0];
  stations.ignoreCandidate(candidate.id);
  const result = stations.recordSuggestion(candidate.id, { kind: 'locker', suggestedName: '4卡2号柜', alias: '4卡2号柜', evidence: ['4卡2号柜'] });
  assert.equal(result.status, 'ignored');
  assert.equal(stations.stations().length, 0);
});

test('AI settings encrypt credentials, never echo key material, and require explicit clearing', t => {
  const { stations, db } = fixture(t);
  assert.equal(stations.aiConfig().enabled, false);
  assert.throws(() => stations.saveAiConfig({ enabled: true }), { code: 'AI_NOT_CONFIGURED' });
  let config = stations.saveAiConfig({ ...configured, enabled: true });
  assert.equal(config.hasApiKey, true);
  assert.ok(!JSON.stringify(config).includes(configured.apiKey));
  assert.equal(config.apiKey, undefined);
  const row = db.prepare('SELECT * FROM station_ai_settings').get();
  assert.ok(row.credential.startsWith('v1.'));
  assert.ok(!JSON.stringify(row).includes(configured.apiKey));
  assert.equal(stations.aiCredentials().apiKey, configured.apiKey);
  stations.saveAiConfig({ apiKey: '', model: 'another-model' });
  assert.equal(stations.aiCredentials().apiKey, configured.apiKey);
  assert.throws(() => stations.saveAiConfig({ clearApiKey: true }), { code: 'AI_NOT_CONFIGURED' });
  config = stations.saveAiConfig({ enabled: false, clearApiKey: true });
  assert.equal(config.hasApiKey, false);
  assert.equal(stations.saveAiConfig({ dailyLimit: 200 }).dailyLimit, 20);
  for (const dailyLimit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '20', null]) assert.throws(() => stations.saveAiConfig({ dailyLimit }));
  for (const body of [{ intervalMinutes: 1 }, { baseUrl: 'http://api.example.com' }, { apiKey: 'bad\r\nkey' }]) assert.throws(() => stations.saveAiConfig(body));
});

test('platform candidates require current pickup provenance and repeated snapshots do not inflate counts', t => {
  const { stations } = fixture(t);
  stations.saveStation('known', { name: '已知驿站', aliases: [{ name: '完整已知别名2号柜' }] });
  const shipment = { id: 'shipment-1', station: '4卡2号柜', status: 'arrived', stationSource: 'platform_event', arrivalAt: NOW - 1000 };
  const snapshot = { shipments: [shipment,
    { ...shipment, id: 'known', station: '完整已知别名2号柜' }, { ...shipment, id: 'unknown-origin', stationSource: 'unknown' },
    { ...shipment, id: 'picked', picked: true }, { ...shipment, id: 'hidden', hidden: true }, { ...shipment, id: 'deleted', deleted: true },
    { ...shipment, id: 'old', arrivalAt: NOW - 46 * 86400000 }, { ...shipment, id: 'future', arrivalAt: NOW + 1000 },
    { ...shipment, id: 'home', station: '家门口' }, { ...shipment, id: 'hub', station: '转运中心' }, { ...shipment, id: 'transit', status: 'transit' }] };
  assert.deepEqual(enqueuePlatformCandidates(stations, snapshot, NOW), { accepted: 1, duplicates: 0, rejected: 0 });
  assert.equal(stations.candidates()[0].source, 'platform');
  assert.equal(stations.candidates()[0].fragment, '4卡2号柜');
  assert.deepEqual(enqueuePlatformCandidates(stations, snapshot, NOW), { accepted: 0, duplicates: 1, rejected: 0 });
  assert.equal(stations.candidates()[0].occurrences, 1);
  enqueuePlatformCandidates(stations, { shipments: [{ ...shipment, id: 'shipment-2' }] }, NOW);
  assert.equal(stations.candidates()[0].occurrences, 2);
});

test('remembering a station relationship creates a sanitized proposal without writing aliases', t => {
  const { stations } = fixture(t);
  const station = stations.saveStation('s1', { name: '四卡驿站' });
  const result = enqueueStationProposal(stations, { stationName: '四卡驿站', otherStationName: '4卡2号柜', subLocation: '2号柜' }, 'device-1');
  assert.equal(result.accepted, 1);
  assert.equal(stations.candidates()[0].status, 'pending');
  assert.equal(stations.candidates()[0].source, 'manual');
  assert.ok(stations.candidates().some(c => c.fragment.includes('4卡2号柜')));
  const candidate = stations.candidates()[0];
  assert.equal(candidate.fragment, '4卡2号柜');
  assert.equal(candidate.feedback.sourceStationName, '4卡2号柜');
  assert.equal(candidate.feedback.targetStationId, station.id);
  assert.equal(candidate.feedback.subLocation, '2号柜');
  assert.ok(!candidate.fragment.includes('四卡驿站'));
  assert.equal(stations.station(station.id).aliases.length, 0);
  enqueueStationProposal(stations, { stationName: '四卡驿站', otherStationName: '4卡2号柜', subLocation: '2号柜' }, 'device-1');
  assert.equal(stations.candidates()[0].occurrences, 1);
});

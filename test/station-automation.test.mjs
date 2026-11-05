import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { StationStore } from '../src/stations.mjs';
import { StationAiJobs } from '../src/station-ai.mjs';

const name = '远洋风景4卡兔喜快递柜', alias = `${name}2号柜`;
const response = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const suggestion = { kind: 'locker', targetStationId: 'station-a', alias, subLocation: '2号柜', evidence: [alias] };
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('automatic worker did not finish');
}
function fixture(t, { autoApply = false, automaticEvents = false, request } = {}) {
  const db = new DatabaseSync(':memory:'), stations = new StationStore({ db, key: Buffer.alloc(32, 6) });
  stations.saveStation('station-a', { name });
  stations.saveAiConfig({ channelName: '合成渠道', baseUrl: 'https://api.example.com/v1', model: 'fixture', apiKey: randomBytes(24).toString('hex'), enabled: true, autoApply });
  const jobs = new StationAiJobs({ stations, automaticEvents, request: request || (async () => response(suggestion)) });
  t.after(async () => { await jobs.close(); db.close(); });
  const enqueue = (fragment = alias) => { stations.enqueue([{ id: 'synthetic', source: 'platform', stationName: fragment, fragment }], { source: 'platform' }); return stations.candidates()[0].id; };
  return { db, stations, jobs, enqueue };
}

test('old configuration remains suggestion-only and explicit automatic mode has strict booleans', async t => {
  const { stations, jobs, enqueue } = fixture(t);
  assert.equal(stations.aiConfig().autoApply, false); assert.equal(stations.aiConfig().logisticsEnabled, false);
  for (const field of ['autoApply', 'logisticsEnabled']) assert.throws(() => stations.saveAiConfig({ [field]: 'true' }), { code: 'INVALID_AI_CONFIG' });
  const id = enqueue(); jobs.request(); await jobs.running;
  assert.equal(stations.candidate(id).status, 'review'); assert.equal(stations.station('station-a').aliases.length, 0);
  assert.deepEqual(stations.automationHistory(), []);
});

test('queue events automatically apply a validated unique literal alias and record a reversible revision', async t => {
  const { stations, enqueue } = fixture(t, { autoApply: true, automaticEvents: true });
  const before = stations.revision, id = enqueue();
  await until(() => stations.candidate(id).status === 'approved');
  assert.equal(stations.revision, before + 1);
  assert.equal(stations.candidate(id).approvalMode, 'automatic');
  assert.equal(stations.station('station-a').aliases[0].subLocation, '2号柜');
  const [change] = stations.automationHistory(); assert.equal(change.id, id); assert.equal(change.canRollback, true);
  stations.saveStation('station-a', { aliases: [...stations.station('station-a').aliases, { name: '远洋风景独立入口', source: 'manual' }] });
  const revision = stations.revision;
  assert.equal(stations.rollbackAutomaticAlias(id).status, 'rolled_back');
  assert.equal(stations.revision, revision + 1);
  assert.deepEqual(stations.station('station-a').aliases.map(value => value.name), ['远洋风景独立入口']);
  assert.throws(() => stations.rollbackAutomaticAlias(id), { code: 'AI_CHANGE_CLOSED' });
});

test('turning on automatic application revisits existing validated suggestions without another AI call', async t => {
  let calls = 0;
  const { stations, jobs, enqueue } = fixture(t, { automaticEvents: true, request: async () => { calls++; return response(suggestion); } });
  const id = enqueue(); await until(() => stations.candidate(id).status === 'review'); await jobs.running;
  stations.saveAiConfig({ autoApply: true });
  assert.equal(stations.candidate(id).status, 'approved'); assert.equal(calls, 1);
});

test('new targets, similar words, multiple literal owners and discarded cabinet numbers remain reviewable', async t => {
  for (const scenario of ['new', 'similar', 'ambiguous', 'discarded', 'conflict']) {
    await t.test(scenario, async sub => {
      const fragment = scenario === 'discarded' ? `${alias}3号柜` : scenario === 'similar' ? '远洋风景4卡菜鸟驿站2号柜' : alias;
      const value = { ...suggestion, alias: fragment, evidence: [fragment] };
      if (scenario === 'new') { value.targetStationId = ''; value.suggestedName = fragment; }
      if (scenario === 'discarded') { value.alias = alias; value.evidence = [alias]; }
      if (scenario === 'conflict') value.subLocation = '3号柜';
      const actualFragment = scenario === 'conflict' ? `${fragment}，另有3号柜` : fragment;
      const { stations, jobs, enqueue } = fixture(sub, { autoApply: true, request: async () => response(value) });
      if (scenario === 'ambiguous') stations.saveStation('station-b', { name: alias });
      const revision = stations.revision, id = enqueue(actualFragment); jobs.request(); await jobs.running;
      assert.equal(stations.candidate(id).status, 'review'); assert.ok(stations.candidate(id).automationReason);
      assert.equal(stations.revision, revision); assert.equal(stations.station('station-a').aliases.length, 0);
    });
  }
});

test('rollback refuses edited aliases and never overwrites human changes', async t => {
  const { stations, jobs, enqueue } = fixture(t, { autoApply: true });
  const id = enqueue(); assert.match(jobs.request().message, /会自动应用/); await jobs.running;
  const current = stations.station('station-a'); stations.saveStation(current.id, { aliases: current.aliases.map(value => ({ ...value, source: 'manual' })) });
  const revision = stations.revision;
  assert.equal(stations.automationHistory()[0].canRollback, false);
  assert.throws(() => stations.rollbackAutomaticAlias(id), { code: 'AI_CHANGE_CONFLICT' });
  assert.equal(stations.revision, revision); assert.equal(stations.station('station-a').aliases[0].source, 'manual');
});

test('alias application and its audit record roll back together on persistence failure', t => {
  const { stations, enqueue } = fixture(t, { autoApply: true }), id = enqueue();
  stations.recordSuggestion(id, suggestion);
  const before = stations.revision, update = stations.updateCandidate.bind(stations);
  stations.updateCandidate = (candidateId, fields) => { if (fields.application) throw new Error('synthetic persistence failure'); return update(candidateId, fields); };
  assert.throws(() => stations.autoApplyCandidate(id), /synthetic persistence failure/);
  assert.equal(stations.revision, before); assert.equal(stations.candidate(id).status, 'review'); assert.equal(stations.station('station-a').aliases.length, 0);
});

test('switching off automatic application during a call retains only the suggestion', async t => {
  let finish;
  const { stations, jobs, enqueue } = fixture(t, { autoApply: true, request: () => new Promise(resolve => { finish = resolve; }) });
  const id = enqueue(); jobs.request(); await new Promise(resolve => setImmediate(resolve));
  stations.saveAiConfig({ autoApply: false }); finish(response(suggestion)); await jobs.running;
  assert.equal(stations.candidate(id).status, 'review'); assert.equal(stations.station('station-a').aliases.length, 0);
});

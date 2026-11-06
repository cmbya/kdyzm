import { randomUUID } from 'node:crypto';
import { fail, hash, onlyKeys } from './security.mjs';
import { nonPickupPlace, redactStationFragment, stationKey, stationText } from './station-text.mjs';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const parse = row => row && JSON.parse(row.data);
const fragment = (value, name, max = 120) => redactStationFragment(stationText(value ?? '', name, max, false));
const reasons = new Set(['', 'station_correction', 'manual_match', 'station_mismatch', 'missing_station', 'ambiguous_match', 'user_confirmed', 'other']);
const requestDigest = input => hash(JSON.stringify(['kind', 'shipmentId', 'stationName', 'otherStationName', 'targetStationId', 'subLocation', 'reason'].map(key => input[key] ?? '')));

// Device-owned receipts outlive parcel completion. Candidates may share identical
// evidence, but withdrawing one receipt must never remove another device's sample.
export class MatchingFeedbackStore {
  constructor({ store, stations, now = Date.now }) {
    this.store = store; this.stations = stations; this.db = store.db; this.now = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS matching_feedback (
      device_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(device_id,id));`);
  }
  read(deviceId, id) { return parse(this.db.prepare('SELECT data FROM matching_feedback WHERE device_id=? AND id=?').get(deviceId, id)); }
  rows() { return this.db.prepare('SELECT data FROM matching_feedback').all().map(parse); }
  save(deviceId, value) {
    this.db.prepare('INSERT INTO matching_feedback VALUES(?,?,?) ON CONFLICT(device_id,id) DO UPDATE SET data=excluded.data').run(deviceId, value.id, JSON.stringify(value));
  }
  state(value) {
    const candidate = value.candidateId ? this.stations.candidate(value.candidateId) : null;
    const station = candidate?.stationId ? this.stations.station(candidate.stationId) : null;
    const aliasKey = stationKey(candidate?.approvedAlias?.name || candidate?.suggestion?.alias || candidate?.stationName);
    const rulePresent = station?.enabled && aliasKey && [station.name, ...station.aliases.map(alias => alias.name)].some(name => stationKey(name) === aliasKey);
    const status = value.action === 'withdraw' ? 'withdrawn' : candidate?.application?.rolledBackAt ? 'review'
      : candidate?.status === 'approved' && rulePresent ? 'applied' : candidate?.status === 'pending' ? 'pending' : candidate?.status === 'failed' ? 'failed' : 'review';
    return { id: value.id, revision: value.revision, status, candidateId: value.candidateId || '',
      error: value.action === 'withdraw' ? candidate?.feedback?.active === false && candidate?.application && !candidate.application.rolledBackAt ? candidate.automationReason : ''
        : candidate?.status === 'approved' && !rulePresent ? '关联站点或别名已停用、变更或回滚，请核对' : candidate?.automationReason || candidate?.error || value.error || '',
      updatedAt: Math.max(value.updatedAt, candidate?.updatedAt || 0) };
  }
  summary(device, limit = 500) {
    const config = this.stations.aiConfig();
    return { items: this.db.prepare('SELECT data FROM matching_feedback WHERE device_id=? ORDER BY rowid DESC').all(device.id).map(parse).map(value => this.state(value)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit),
      configured: Boolean(config.channelEnabled && config.hasApiKey && config.channelName && config.baseUrl && config.model), enabled: config.enabled, autoApply: config.autoApply };
  }
  normalize(input, device) {
    onlyKeys(input, ['id', 'revision', 'action', 'kind', 'shipmentId', 'stationName', 'otherStationName', 'targetStationId', 'subLocation', 'reason']);
    if (!validId(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !['upsert', 'withdraw'].includes(input.action)) fail(400, 'INVALID_FEEDBACK', '反馈标识、版本或动作无效');
    if (input.action === 'withdraw') return { id: input.id, revision: input.revision, action: input.action };
    if (!['station_correction', 'manual_match'].includes(input.kind)) fail(400, 'INVALID_FEEDBACK', '反馈类型无效');
    const shipmentId = input.shipmentId ?? '', targetStationId = input.targetStationId ?? '', reason = input.reason ?? '';
    if (shipmentId && !validId(shipmentId) || targetStationId && !validId(targetStationId) || !reasons.has(reason)) fail(400, 'INVALID_FEEDBACK', '反馈字段无效');
    if (input.kind === 'manual_match' && !shipmentId || input.kind === 'station_correction' && !targetStationId) fail(400, 'INVALID_FEEDBACK', '缺少运单或目标站点');
    let shipment;
    if (shipmentId) {
      shipment = parse(this.db.prepare('SELECT data FROM shipments WHERE id=?').get(shipmentId));
      if (!this.store.canRead(device, shipment)) fail(403, 'SCOPE_FORBIDDEN', '运单不在授权范围内');
    }
    const target = targetStationId ? this.stations.station(targetStationId) : null;
    if (targetStationId && !target?.enabled) fail(400, 'INVALID_STATION', '目标站点不存在或已停用');
    const stationName = fragment(input.stationName, '原站名'), suppliedOther = fragment(input.otherStationName, '物流站名'), subLocation = fragment(input.subLocation, '柜号', 60);
    // A client-provided logistics label is never evidence of what the server saw.
    const otherStationName = shipment ? fragment(shipment.station, '物流站名') : suppliedOther;
    const owners = otherStationName ? this.stations.stationRules().stations.filter(station => [station.name, ...station.aliases.map(alias => alias.name)].some(name => stationKey(name) && stationKey(name) === stationKey(otherStationName))) : [];
    const resolvedTarget = targetStationId || (owners.length === 1 ? owners[0].id : '');
    const sourceKnown = this.stations.station(resolvedTarget)?.aliases.some(alias => stationKey(alias.name) === stationKey(stationName))
      || stationKey(this.stations.station(resolvedTarget)?.name) && stationKey(this.stations.station(resolvedTarget)?.name) === stationKey(stationName);
    const error = !stationKey(stationName) ? '缺少可学习的原站名，仅保留人工确认记录'
      : [stationName, otherStationName, subLocation].some(nonPickupPlace) ? '片段并非末端取件站点，需核对'
      : input.kind === 'manual_match' && suppliedOther && suppliedOther !== otherStationName ? '提交的物流站名与授权运单不一致，需核对'
      : input.kind === 'manual_match' && (owners.length !== 1 || owners[0].id !== resolvedTarget) ? '授权运单尚无唯一已知站点，不能据此自动学习'
      : input.kind === 'manual_match' && sourceKnown ? '两端站点已由现有规则对应；其他匹配条件仍需核对，未修改规则'
      : !resolvedTarget ? '缺少唯一目标站点，仅保留人工确认记录' : '';
    return { id: input.id, revision: input.revision, action: input.action, kind: input.kind, shipmentId,
      stationName, otherStationName, targetStationId: resolvedTarget, subLocation, reason, error };
  }
  candidateFor(value) {
    const evidenceKey = hash(JSON.stringify([value.kind, value.stationName, value.otherStationName, value.targetStationId, value.subLocation, value.error]));
    const existing = this.stations.candidates().find(candidate => candidate.feedback?.key === evidenceKey && candidate.feedback.active && !candidate.application?.rolledBackAt);
    if (existing) return existing;
    if (this.stations.candidates().length >= 2000) fail(429, 'STATION_QUEUE_FULL', '站点队列已满');
    const id = randomUUID(), candidate = { id, stationName: value.stationName,
      fragment: [value.stationName, value.subLocation && !value.stationName.includes(value.subLocation) ? value.subLocation : ''].filter(Boolean).join('，'),
      source: 'manual', region: '', status: value.error ? 'unknown' : 'pending', eventPending: !value.error,
      suggestion: null, evidence: [], occurrences: 0, attempts: 0, cancelledAttempts: 0, retryAt: 0, error: '', automationReason: value.error,
      feedback: { key: evidenceKey, active: true, kind: value.kind, sourceStationName: value.stationName, otherStationName: value.otherStationName,
        targetStationId: value.targetStationId, subLocation: value.subLocation, reason: value.reason, verified: !value.error },
      analysis: null, createdAt: this.now(), updatedAt: this.now() };
    this.db.prepare('INSERT INTO station_candidates VALUES(?,?,?)').run(id, `feedback-${id}`, JSON.stringify(candidate));
    return candidate;
  }
  refreshOwnership(id) {
    if (!id) return;
    const candidate = this.stations.candidate(id), count = this.rows().filter(value => value.action === 'upsert' && value.candidateId === id).length;
    if (count) { this.stations.updateCandidate(id, { occurrences: count }); return; }
    this.stations.updateCandidate(id, { status: 'withdrawn', eventPending: false, feedback: { ...candidate.feedback, active: false }, occurrences: 0, automationReason: '人工样本已撤回' });
    let error = '';
    const aliasKey = stationKey(candidate.approvedAlias?.name || candidate.suggestion?.alias || candidate.stationName);
    // A second candidate may have reused an alias created by an earlier one.
    // Its final withdrawal must still find the original reversible application.
    const applications = this.stations.candidates().filter(origin => origin.application && !origin.application.rolledBackAt
      && (origin.id === id || origin.application.stationId === candidate.stationId && stationKey(origin.application.alias.name) === aliasKey));
    for (const origin of applications) {
      const { stationId, alias } = origin.application;
      const supported = this.stations.candidates().some(other => other.status === 'approved' && other.stationId === stationId
        && stationKey(other.approvedAlias?.name || other.suggestion?.alias || other.stationName) === stationKey(alias.name) && (!other.feedback || other.feedback.active));
      if (!supported) {
        try {
          this.stations.rollbackAutomaticAlias(origin.id);
          if (origin.feedback?.active === false) this.stations.updateCandidate(origin.id, { status: 'withdrawn', automationReason: '人工样本已撤回，自动别名已回滚' });
        }
        catch (failure) { if (failure.code !== 'AI_CHANGE_CONFLICT') throw failure; error = '反馈已撤回；别名已被人工修改，请管理员核对'; }
      }
    }
    this.stations.updateCandidate(id, { status: 'withdrawn', automationReason: error || '人工样本已撤回' });
  }
  submit(device, body) {
    onlyKeys(body, ['items']);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) fail(400, 'INVALID_FEEDBACK', '每批反馈须为1到20条');
    const accepted = [], rejected = [];
    for (const input of body.items) {
      try {
        this.stations.transaction(() => {
          onlyKeys(input, ['id', 'revision', 'action', 'kind', 'shipmentId', 'stationName', 'otherStationName', 'targetStationId', 'subLocation', 'reason']);
          if (!validId(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !['upsert', 'withdraw'].includes(input.action)) fail(400, 'INVALID_FEEDBACK', '反馈标识、版本或动作无效');
          const old = this.read(device.id, input.id), digest = requestDigest(input);
          if (old && (old.revision > input.revision || old.revision === input.revision && old.action === 'withdraw')) return;
          if (old?.revision === input.revision && input.action === 'upsert') {
            if (old.digest !== digest) fail(409, 'FEEDBACK_CONFLICT', '同版本反馈内容不一致');
            return;
          }
          const value = this.normalize(input, device);
          if (!old && this.db.prepare('SELECT COUNT(*) AS count FROM matching_feedback WHERE device_id=?').get(device.id).count >= 500) fail(429, 'FEEDBACK_LIMIT', '人工反馈已达到容量上限');
          const candidate = value.action === 'upsert' ? this.candidateFor(value) : null;
          this.save(device.id, { ...value, digest, candidateId: candidate?.id || old?.candidateId || '', createdAt: old?.createdAt || this.now(), updatedAt: this.now() });
          if (old?.candidateId && old.candidateId !== candidate?.id) this.refreshOwnership(old.candidateId);
          if (candidate) this.refreshOwnership(candidate.id);
        });
        accepted.push({ id: input.id, revision: input.revision });
      } catch (error) {
        if (!error.status) throw error;
        rejected.push({ id: validId(input?.id) ? input.id : '', revision: Number.isSafeInteger(input?.revision) ? input.revision : 0,
          status: 'rejected', candidateId: '', error: error.code, updatedAt: this.now() });
      }
    }
    if (accepted.length) for (const listener of this.stations.aiQueueListeners) { try { listener(); } catch { /* Durable receipt is independent of workers. */ } }
    const summary = this.summary(device);
    return { accepted, ...summary, items: [...summary.items.filter(item => !rejected.some(value => value.id === item.id)), ...rejected] };
  }
}

import './logistics-rules.js';
import { fail, hash } from './security.mjs';
import { contentJson, safeFailure, aiError } from './station-ai.mjs';
import { LOGISTICS_SYSTEM, validateLogisticsSuggestion, logisticsActionIn as actionIn, logisticsPublicText as publicText, specificLogisticsStation as specificStation } from './logistics-ai-template.mjs';
import { aiCandidateDueAt, nextAiDay } from './ai-policy.mjs';

const engine = globalThis.PickCodeLogistics;
const pickupPoint = /驿站|代收点|自提点|自提站|自提柜|快递柜|智能柜|快递超市|丰巢/u;
const parse = row => row && JSON.parse(row.data);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const QUEUE_LIMIT = 1000, CORPUS_LIMIT = 20000, ACTIVE_AGE = 45 * 86400000;

function probe(description, rules, time = 1) {
  return { station: engine.pickupStation(description, rules), arrival: engine.pickupArrivalEvent(description, '', rules),
    status: engine.eventStatus(description, 'unknown', rules), evidence: engine.pickupEvidence([{ description, time, timePrecision: 'second' }], rules) };
}

function regression(candidate, rule, current, shipments) {
  const combined = [rule, ...current], station = candidate.expectedStation;
  const negative = ['预计', '尚未', '未能', '没有', '还没', '将', '准备', '等待', '正在', '请快递员', '要求快递员', '下一站', '退回后', '已改派后'];
  for (const prefix of negative) {
    const sample = prefix + candidate.fragment;
    if (engine.test(rule, sample).arrival || engine.pickupEvidence([{ time: 1, description: sample }], combined).arrivalAt) return false;
  }
  for (const sample of [`催取提醒：${candidate.fragment}`, `再次通知：${candidate.fragment}`]) {
    if (engine.test(rule, sample).arrival) return false;
  }
  const fixed = [`已送达幸福服装店`, `已送达家门口`, `已交付给杭州转运中心，下一站${station}`,
    `已暂存至杭州分拣中心，取件点${station}`, `请您到${station}领取`, `包裹仍在${station}`, `已签收：本人已签收`];
  for (const sample of [...fixed, ...engine.defaults().map(item => item.sample), ...current.filter(item => item.enabled).map(item => item.sample)]) {
    if (!equal(probe(sample, current), probe(sample, combined))) return false;
  }
  let count = 0;
  for (const shipment of shipments) {
    const events = shipment.logisticsEvents || [];
    count += events.length;
    if (count > CORPUS_LIMIT) return false;
    for (const event of events) {
      const before = probe(event.description, current, event.time), after = probe(event.description, combined, event.time);
      if (equal(before, after)) continue;
      if (shipment.picked || shipment.pickupCompletion?.autoPicked || shipment.hidden || shipment.deleted || shipment.status === 'signed'
        || before.arrival || before.status === 'signed' || before.station && before.station !== station
        || after.station !== station || !after.arrival || !event.description.includes(candidate.fragment)) return false;
    }
    const before = engine.pickupEvidence(events, current), after = engine.pickupEvidence(events, combined);
    if (!equal(before, after) && (before.arrivalAt || before.station && before.station !== station
      || after.station !== station || !after.arrivalAt)) return false;
  }
  return true;
}

export class LogisticsAiJobs {
  constructor({ stations, rules, store, assistance, now = Date.now, automaticEvents = true, allowAutomatic = () => true }) {
    this.stations = stations; this.rules = rules; this.store = store; this.db = store.db; this.assistance = assistance;
    this.now = now; this.automaticEvents = automaticEvents; this.running = null; this.closed = false; this.generation = 0;
    this.allowAutomatic = allowAutomatic;
    this.db.exec(`CREATE TABLE IF NOT EXISTS logistics_ai_candidates (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logistics_ai_state (id INTEGER PRIMARY KEY CHECK(id=1), last_run_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO logistics_ai_state VALUES(1,0);`);
    this.unsubscribe = stations.onAiConfigChange(({ channelId }) => {
      if (channelId && channelId !== this.stations.aiConfig().channelId && channelId !== this.context?.channelId) return;
      this.generation++; this.controller?.abort(aiError('AI_CONFIG_CHANGED'));
      if (this.ready()) this.intake({ shipments: this.cached() });
      this.schedule();
    });
    this.unsubscribeStations = stations.onStationRulesChange?.(() => {
      if (this.ready()) this.intake({ shipments: this.cached() });
      this.schedule();
    });
    if (this.ready()) this.intake({ shipments: this.cached() });
    this.schedule();
  }
  ready() {
    if (this.closed) return false;
    const config = this.stations.aiConfig();
    return !!(config.enabled && config.logisticsEnabled && config.channelEnabled && config.hasApiKey && config.channelId && config.channelName && config.baseUrl && config.model);
  }
  cached() { return this.db.prepare('SELECT data FROM shipments ORDER BY id LIMIT 10001').all().map(parse); }
  candidates() { return this.db.prepare('SELECT data FROM logistics_ai_candidates ORDER BY rowid DESC').all().map(parse)
    .map(candidate => ({ ...candidate, suggestion: candidate.rule, automationReason: candidate.error })); }
  candidate(id) {
    const candidate = parse(this.db.prepare('SELECT data FROM logistics_ai_candidates WHERE id=?').get(id));
    if (!candidate) fail(404, 'NOT_FOUND', '物流建议不存在');
    return candidate;
  }
  active(context) { return !this.closed && this.ready() && context.generation === this.generation && !context.signal.aborted && context.channelId === this.stations.aiConfig().channelId; }
  update(id, fields, context) {
    if (this.closed || context && !this.active(context)) throw aiError(this.closed ? 'SERVICE_STOPPING' : 'AI_CONFIG_CHANGED');
    const candidate = { ...this.candidate(id), ...fields, updatedAt: this.now() };
    this.db.prepare('UPDATE logistics_ai_candidates SET data=? WHERE id=?').run(JSON.stringify(candidate), id);
    return candidate;
  }
  eligibleShipment(shipment) {
    if (shipment.picked || shipment.pickupCompletion?.autoPicked || shipment.hidden || shipment.deleted || shipment.archived || shipment.logisticsState !== 'ok') return false;
    if (shipment.status === 'signed' && !engine.catalogPickupEvidence(shipment.logisticsEvents, this.stations.stationRules().stations, this.rules.read().rules).arrivalAt) return false;
    const account = this.store.account(shipment.accountId), order = this.store.order(shipment.orderId);
    if (!account?.enabled || !order || order.hidden || order.deleted || order.archived) return false;
    const override = typeof order.dateOverride === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(order.dateOverride) ? Date.parse(`${order.dateOverride}T00:00:00+08:00`) : 0;
    const date = override || order.orderDate || order.firstSeenAt;
    return Number.isSafeInteger(date) && date > this.now() - ACTIVE_AGE && date <= this.now();
  }
  eligibleTime(time) { return Number.isSafeInteger(time) && time > this.now() - ACTIVE_AGE && time <= this.now(); }
  automaticAllowed(shipment) { return this.allowAutomatic(shipment, 'arrival_time') || this.allowAutomatic(shipment, 'logistics_detail'); }
  candidateAllowed(candidate, shipments = this.cached()) {
    return shipments.some(shipment => shipment.logisticsEvents?.some(event => event.time === candidate.eventTime && event.description?.includes(candidate.fragment))
      && this.automaticAllowed(shipment));
  }
  sourcePresent(candidate, shipments) {
    return this.eligibleTime(candidate.eventTime) && shipments.some(shipment => shipment.logisticsEvents?.some(event => event.time === candidate.eventTime && event.description.includes(candidate.fragment))
      && this.eligibleShipment(shipment) && this.automaticAllowed(shipment));
  }
  backing(station, shipments) {
    if (this.stations.stationRules().stations.some(item => [item.name, ...item.aliases.map(alias => alias.name)].includes(station))) return true;
    return shipments.some(item => item.station === station && item.stationSource === 'locker'
      && ['locker_arrival', 'locker_created'].includes(item.arrivalAtSource) && item.arrivalAt > 0
      && this.eligibleTime(item.arrivalAt) && this.eligibleShipment(item));
  }
  intake(snapshot) {
    const result = { accepted: 0, duplicates: 0, rejected: 0 };
    if (!this.ready()) return result;
    const rules = this.rules.read().rules;
    const names = this.stations.stationRules().stations.flatMap(item => [item.name, ...item.aliases.map(alias => alias.name)]).filter(specificStation).sort((a, b) => b.length - a.length);
    let count = this.candidates().length, inspected = 0;
    for (const shipment of snapshot?.shipments || []) {
      if (!this.eligibleShipment(shipment) || !this.automaticAllowed(shipment)) continue;
      for (const event of shipment.logisticsEvents || []) {
        if (++inspected > CORPUS_LIMIT) break;
        if (!this.eligibleTime(event.time) || typeof event.description !== 'string') continue;
        for (const part of event.description.split(/[，,。；;！？!?\n\r]/u)) {
          const action = actionIn.exec(part);
          if (!action) continue;
          const tail = part.slice(action.index + action[0].length);
          const known = [shipment.station, ...names].filter(specificStation).find(name => tail.startsWith(name));
          const expectedStation = known || tail.split(/请|等待|待取件|取件码|取货码|电话/u)[0].trim();
          if (!specificStation(expectedStation)) { result.rejected++; continue; }
          const fragment = part.slice(action.index, action.index + action[0].length + expectedStation.length);
          if (!publicText(fragment, 200)) { result.rejected++; continue; }
          const localRule = { id: 'intake', name: '本地证据', enabled: true, kind: 'arrival', starts: [action[0]], end: '', keywords: [expectedStation], sample: fragment, expectedStation, origin: 'manual' };
          let preview;
          try { preview = engine.test(localRule, event.description); } catch { result.rejected++; continue; }
          if (!preview.arrival || preview.station !== expectedStation) { result.rejected++; continue; }
          const existing = engine.pickupEvidence([event], rules);
          if (existing.arrivalAt && existing.station === expectedStation) continue;
          const backed = this.backing(expectedStation, [shipment]);
          if (!backed) this.stations.enqueue([{ id: `logistics-station-${hash(expectedStation).slice(0, 32)}`,
            stationName: expectedStation, fragment: expectedStation, source: 'platform' }], { source: 'platform' });
          const id = `logistics-${hash(JSON.stringify([fragment, expectedStation])).slice(0, 32)}`;
          const previous = parse(this.db.prepare('SELECT data FROM logistics_ai_candidates WHERE id=?').get(id));
          if (previous) {
            if (['pending', 'failed', 'review'].includes(previous.status) && event.time > previous.eventTime) this.update(id, { eventTime: event.time });
            if (previous.status === 'review' && ['NO_STATION_EVIDENCE', 'NO_ACTIVE_EVIDENCE'].includes(previous.reason) && this.backing(expectedStation, [shipment])) {
              this.update(id, { status: 'pending', eventPending: true, reason: '', error: '' });
            }
            result.duplicates++; continue;
          }
          if (count >= QUEUE_LIMIT) { result.rejected++; continue; }
          const candidate = { id, kind: 'logistics_rule', fragment, expectedStation, source: 'platform', status: backed ? 'pending' : 'review', eventPending: backed,
            reason: backed ? '' : 'NO_STATION_EVIDENCE', eventTime: event.time, attempts: 0, retryAt: 0,
            error: backed ? '' : '尚无已确认的公开站点依据，未发送给AI', rule: null, evidence: [], createdAt: this.now(), updatedAt: this.now(), appliedAt: 0, rolledBackAt: 0, applyCheckedKey: '' };
          this.db.prepare('INSERT INTO logistics_ai_candidates VALUES(?,?)').run(id, JSON.stringify(candidate)); count++; result.accepted++;
        }
      }
      if (inspected > CORPUS_LIMIT) break;
    }
    this.schedule(); return result;
  }
  checkKey() { return `${this.rules.read().revision}:${this.stations.revision}:${this.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision}`; }
  work() {
    const config = this.stations.aiConfig(), key = this.checkKey(), shipments = this.cached();
    return this.candidates().reverse().filter(candidate => this.candidateAllowed(candidate, shipments) && (candidate.status === 'review' && candidate.rule && config.autoApply && candidate.applyCheckedKey !== key
      || ['pending', 'failed'].includes(candidate.status) && candidate.attempts < 3 && candidate.retryAt <= this.now()))
      .sort((a, b) => Number(b.status === 'review') - Number(a.status === 'review'));
  }
  nextRunAt() {
    const last = this.db.prepare('SELECT last_run_at FROM logistics_ai_state WHERE id=1').get().last_run_at;
    return last ? last + this.stations.aiConfig().intervalMinutes * 60000 : 0;
  }
  schedule() {
    clearTimeout(this.scheduled); this.scheduled = null;
    if (!this.automaticEvents || !this.ready() || this.running) return;
    const config = this.stations.aiConfig(), key = this.checkKey(), shipments = this.cached(), all = this.candidates().filter(candidate => this.candidateAllowed(candidate, shipments));
    const review = config.autoApply && all.some(candidate => candidate.status === 'review' && candidate.rule && candidate.applyCheckedKey !== key);
    const pending = all.filter(candidate => ['pending', 'failed'].includes(candidate.status) && candidate.attempts < 3);
    if (!review && !pending.length) return;
    let due = review ? this.now() : Math.min(...pending.map(candidate => aiCandidateDueAt(candidate, this.nextRunAt(), config.nextEventAt)));
    if (!review && config.usageToday >= config.dailyLimit) {
      due = Math.max(due, nextAiDay(this.now()));
    }
    this.scheduled = setTimeout(() => { this.scheduled = null; this.runDue(); }, Math.min(2147483647, Math.max(0, due - this.now()))).unref();
  }
  runDue({ candidateIds } = {}) {
    const response = (code, extra = {}) => ({ accepted: code === 'AI_ACCEPTED', code, running: !!this.running, ...extra });
    if (this.closed) return response('SERVICE_STOPPING');
    if (this.running) return response('AI_RUNNING');
    if (!this.ready()) return response('AI_AUTOMATIC_DISABLED');
    const work = this.work().filter(candidate => !candidateIds || candidateIds.includes(candidate.id)), reviews = work.filter(candidate => candidate.status === 'review');
    if (!work.length) { this.schedule(); return response('AI_NO_PENDING'); }
    const config = this.stations.aiConfig();
    if (!reviews.length && config.usageToday >= config.dailyLimit) { this.schedule(); return response('AI_DAILY_LIMIT'); }
    const due = work.filter(candidate => candidate.status === 'review' || aiCandidateDueAt(candidate, this.nextRunAt(), config.nextEventAt) <= this.now());
    if (!due.length) { this.schedule(); return response('AI_NOT_DUE', { retryAt: Math.min(...work.map(candidate => aiCandidateDueAt(candidate, this.nextRunAt(), config.nextEventAt))) }); }
    this.controller = new AbortController();
    const context = this.context = { candidateIds: due.map(candidate => candidate.id), generation: this.generation, channelId: config.channelId, signal: this.controller.signal };
    this.running = Promise.resolve().then(() => this.run(context)).finally(() => { this.running = null; this.context = null; this.controller = null; this.schedule(); });
    this.running.catch(() => {});
    return response('AI_ACCEPTED', { queued: work.length });
  }
  async call(candidate, context) {
    let onAbort;
    const aborted = new Promise((_, reject) => { onAbort = () => reject(aiError('AI_CONFIG_CHANGED')); context.signal.addEventListener('abort', onAbort, { once: true }); });
    try {
      return await Promise.race([this.assistance.call(context.channelId, [{ role: 'system', content: LOGISTICS_SYSTEM },
        { role: 'user', content: JSON.stringify({ fragment: candidate.fragment, expectedStation: candidate.expectedStation }) }], { signal: context.signal }), aborted]);
    } finally { context.signal.removeEventListener('abort', onAbort); }
  }
  apply(candidate, context) {
    if (!this.active(context) || !this.stations.aiConfig().autoApply) return false;
    const current = this.rules.read(), shipments = this.cached();
    const valid = candidate.rule && this.backing(candidate.expectedStation, shipments) && pickupPoint.test(candidate.expectedStation)
      && this.sourcePresent(candidate, shipments) && shipments.length <= 10000 && regression(candidate, candidate.rule, current.rules, shipments);
    if (!valid) { this.update(candidate.id, { applyCheckedKey: this.checkKey(), error: '建议缺少独立站点依据或未通过本地安全回归，请人工核对' }, context); return false; }
    if (current.rules.some(rule => rule.id === candidate.rule.id)) {
      this.update(candidate.id, { applyCheckedKey: this.checkKey(), error: '同编号规则已存在，请人工核对' }, context); return false;
    }
    if (!this.active(context) || !this.stations.aiConfig().autoApply) return false;
    this.db.exec('SAVEPOINT logistics_ai_apply');
    try {
      this.rules.save({ revision: current.revision, rules: [candidate.rule, ...current.rules] });
      this.update(candidate.id, { status: 'applied', appliedAt: this.now(), error: '', appliedRule: candidate.rule }, context);
      this.db.exec('RELEASE logistics_ai_apply'); return true;
    } catch (error) { this.db.exec('ROLLBACK TO logistics_ai_apply'); this.db.exec('RELEASE logistics_ai_apply'); throw error; }
  }
  async run(context) {
    const counts = { analyzed: 0, applied: 0, failed: 0 };
    let marked = false;
    for (const original of this.work().filter(candidate => context.candidateIds.includes(candidate.id))) {
      if (!this.active(context)) break;
      let candidate = this.candidate(original.id), called = false;
      const attemptsBefore = candidate.attempts;
      try {
        if (candidate.status === 'review') { if (this.apply(candidate, context)) counts.applied++; continue; }
        if (!this.sourcePresent(candidate, this.cached())) {
          this.update(candidate.id, { status: 'review', reason: 'NO_ACTIVE_EVIDENCE', error: '原始包裹已不在启用账号的近期未完成记录中，未发送给AI' }, context); continue;
        }
        if (this.stations.aiConfig().usageToday >= this.stations.aiConfig().dailyLimit) break;
        if (!marked) {
          if (this.nextRunAt() <= this.now()) this.db.prepare('UPDATE logistics_ai_state SET last_run_at=? WHERE id=1').run(this.now());
          this.stations.markAiRun({ event: true }); marked = true;
        }
        this.update(candidate.id, { eventPending: false }, context);
        called = true;
        const response = await this.call(candidate, context);
        if (!this.active(context) || !['pending', 'failed'].includes(this.candidate(candidate.id).status)) continue;
        if (!this.candidateAllowed(candidate)) {
          this.update(candidate.id, { status: 'review', reason: 'LOCAL_RETRIES_REQUIRED', attempts: candidate.attempts + 1,
            retryAt: 0, error: '来源已不符合自动识别条件，未采纳本次建议' }, context); continue;
        }
        candidate = this.candidate(candidate.id);
        if (!this.sourcePresent(candidate, this.cached())) {
          this.update(candidate.id, { status: 'review', reason: 'NO_ACTIVE_EVIDENCE', error: '原始包裹已不在启用账号的近期未完成记录中，未采纳AI结果' }, context); continue;
        }
        const suggestion = validateLogisticsSuggestion(contentJson(response), candidate);
        candidate = this.update(candidate.id, { ...suggestion, status: 'review', attempts: candidate.attempts + 1, retryAt: 0, error: '' }, context);
        counts.analyzed++;
        if (this.stations.aiConfig().autoApply && this.apply(candidate, context)) counts.applied++;
      } catch (error) {
        if (!this.active(context) || !['pending', 'failed', 'review'].includes(this.candidate(candidate.id).status)) break;
        const failure = safeFailure(error), quota = failure.code === 'AI_DAILY_LIMIT';
        const localApplyFailure = !!candidate.rule;
        const invalid = failure.code === 'AI_INVALID_RESULT' || localApplyFailure;
        this.update(candidate.id, { status: invalid ? 'review' : 'failed', attempts: attemptsBefore + (called && !quota ? 1 : 0),
          applyCheckedKey: localApplyFailure ? this.checkKey() : '', retryAt: invalid ? 0 : this.now() + this.stations.aiConfig().intervalMinutes * 60000,
          error: localApplyFailure ? '当前规则版本、容量或保存校验发生变化，建议保留待核对' : failure.message }, context);
        counts.failed++; if (quota) break;
      }
    }
    return counts;
  }
  history() {
    const current = this.rules.read().rules;
    return this.candidates().filter(candidate => candidate.appliedAt).map(candidate => ({ id: candidate.id, kind: 'logistics_rule',
      summary: `物流规则：${candidate.expectedStation}`, status: candidate.rolledBackAt ? 'rolled_back' : 'applied', appliedAt: candidate.appliedAt,
      rolledBackAt: candidate.rolledBackAt, canRollback: !candidate.rolledBackAt && current.some(rule => rule.id === candidate.appliedRule?.id && equal(rule, candidate.appliedRule)) }));
  }
  rollback(id) {
    if (this.closed) throw aiError('SERVICE_STOPPING');
    const candidate = this.candidate(id), current = this.rules.read();
    const installed = current.rules.find(rule => rule.id === candidate.appliedRule?.id);
    if (!candidate.appliedAt || candidate.rolledBackAt || !installed || !equal(installed, candidate.appliedRule)) fail(409, 'AI_ROLLBACK_CONFLICT', '规则已被人工修改或撤回，未覆盖当前规则');
    this.db.exec('SAVEPOINT logistics_ai_rollback');
    try {
      this.rules.save({ revision: current.revision, rules: current.rules.filter(rule => rule.id !== installed.id) });
      this.update(id, { status: 'rolled_back', rolledBackAt: this.now(), error: '' });
      this.db.exec('RELEASE logistics_ai_rollback');
    } catch (error) { this.db.exec('ROLLBACK TO logistics_ai_rollback'); this.db.exec('RELEASE logistics_ai_rollback'); throw error; }
    return this.history().find(item => item.id === id);
  }
  ignore(id) {
    const candidate = this.candidate(id);
    if (!['pending', 'review', 'failed'].includes(candidate.status)) fail(409, 'CANDIDATE_CLOSED', '已应用规则须使用回滚');
    const result = this.update(id, { status: 'ignored', retryAt: 0, error: '' }); this.schedule(); return result;
  }
  async close() {
    this.closed = true; clearTimeout(this.scheduled); this.unsubscribe(); this.unsubscribeStations?.(); this.controller?.abort(aiError('SERVICE_STOPPING')); await this.running;
  }
}

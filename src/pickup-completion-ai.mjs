import { fail, hash } from './security.mjs';
import { aiError, contentJson, safeFailure } from './station-ai.mjs';
import { aiCandidateDueAt, nextAiDay } from './ai-policy.mjs';
import { builtinPickupCompletionRules, detectPickupCompletion } from './pickup-completion.mjs';
import { PICKUP_COMPLETION_SYSTEM, completionFragment, completionNegativeSamples, validateCompletionSuggestion } from './pickup-completion-ai-template.mjs';

const parse = row => row && JSON.parse(row.data);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ACTIVE_AGE = 45 * 86400000, QUEUE_LIMIT = 1000, CORPUS_LIMIT = 20000;
const monitorExamples = { recipient_signed: ['本人已签收', '收件人已签收'], user_collected: ['用户已取走', '收件人领取成功'] };

export class PickupCompletionAi {
  constructor({ store, completionStore, stations, assistance, now = Date.now, automaticEvents = true }) {
    Object.assign(this, { store, completionStore, stations, assistance, now, automaticEvents });
    this.db = store.db; this.running = null; this.closed = false; this.generation = 0;
    this.db.exec(`CREATE TABLE IF NOT EXISTS pickup_completion_ai_candidates(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pickup_completion_ai_state(id INTEGER PRIMARY KEY CHECK(id=1),last_run_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO pickup_completion_ai_state VALUES(1,0);`);
    this.unsubscribe = stations.onAiConfigChange(() => this.configChanged());
    this.configChanged();
  }
  cached() { return this.db.prepare('SELECT data FROM shipments ORDER BY id LIMIT 10001').all().map(parse); }
  candidates() { return this.db.prepare('SELECT data FROM pickup_completion_ai_candidates ORDER BY rowid DESC').all().map(parse); }
  candidate(id) {
    const value = parse(this.db.prepare('SELECT data FROM pickup_completion_ai_candidates WHERE id=?').get(id));
    if (!value) fail(404, 'NOT_FOUND', '取件监测建议不存在');
    return value;
  }
  update(id, fields) {
    const value = { ...this.candidate(id), ...fields, updatedAt: this.now() };
    this.db.prepare('UPDATE pickup_completion_ai_candidates SET data=? WHERE id=?').run(JSON.stringify(value), id); return value;
  }
  ready() {
    const local = this.completionStore.config(), config = this.stations.aiConfig();
    return !this.closed && local.enabled && local.aiEnabled && config.enabled && config.channelEnabled && config.hasApiKey
      && !!(config.channelId && config.channelName && config.baseUrl && config.model);
  }
  configChanged() {
    this.generation++; this.controller?.abort(aiError('AI_CONFIG_CHANGED'));
    if (this.ready()) this.intake({ shipments: this.cached() });
    this.schedule();
  }
  eligible(shipment) {
    const state = shipment.pickupCompletion;
    if (shipment.hidden || shipment.deleted || shipment.archived || shipment.logisticsState !== 'ok' || state?.autoPicked
      || state?.manualOverride === 'pending' || shipment.picked && state?.manualOverride !== 'picked') return false;
    const account = this.store.account(shipment.accountId), order = this.store.order(shipment.orderId);
    if (!account?.enabled || !order || order.hidden || order.deleted || order.archived) return false;
    const date = order.dateOverride ? Date.parse(`${order.dateOverride}T00:00:00+08:00`) : order.orderDate || order.firstSeenAt;
    return Number.isSafeInteger(date) && date > this.now() - ACTIVE_AGE && date <= this.now();
  }
  fragments(shipment) {
    if (!this.eligible(shipment)) return [];
    return (shipment.logisticsEvents || []).filter(event => Number.isSafeInteger(event.time) && event.time > this.now() - ACTIVE_AGE && event.time <= this.now())
      .map(event => ({ ...completionFragment(event.description), eventTime: event.time, sourceFingerprint: hash(JSON.stringify([shipment.id, event.time, event.description])) }))
      .filter(value => value.fragment);
  }
  sourcePresent(candidate, shipments = this.cached()) {
    return shipments.some(shipment => this.fragments(shipment).some(value => value.fragment === candidate.fragment && value.kind === candidate.kind));
  }
  intake(snapshot) {
    const result = { accepted: 0, duplicates: 0, rejected: 0 };
    if (!this.ready()) return result;
    let count = this.candidates().length, inspected = 0;
    for (const shipment of snapshot?.shipments || []) {
      inspected += shipment.logisticsEvents?.length || 0;
      if (inspected > CORPUS_LIMIT) break;
      if (detectPickupCompletion(shipment, { rules: this.completionStore.rules(), now: this.now() }) && !shipment.picked) continue;
      for (const fragment of this.fragments(shipment)) {
        const id = `completion-${hash(fragment.fragment).slice(0, 32)}`, previous = parse(this.db.prepare('SELECT data FROM pickup_completion_ai_candidates WHERE id=?').get(id));
        if (previous) {
          if (previous.retryExhausted && previous.status === 'review' && fragment.eventTime > previous.eventTime && fragment.sourceFingerprint !== previous.sourceFingerprint) {
            this.update(id, { ...fragment, status: 'pending', attempts: 0, retryAt: 0, eventPending: true, retryExhausted: false,
              retryCycles: (previous.retryCycles || 0) + 1, error: '' });
          }
          result.duplicates++; continue;
        }
        if (count >= QUEUE_LIMIT) { result.rejected++; continue; }
        const candidate = { id, ...fragment, source: shipment.picked ? 'manual_trace' : 'uncompleted_trace', status: 'pending', attempts: 0, totalAttempts: 0,
          retryAt: 0, eventPending: true, rule: null, error: '', createdAt: this.now(), updatedAt: this.now(), appliedAt: 0, rolledBackAt: 0 };
        this.db.prepare('INSERT INTO pickup_completion_ai_candidates VALUES(?,?)').run(id, JSON.stringify(candidate)); count++; result.accepted++;
      }
    }
    this.schedule(); return result;
  }
  nextRunAt() {
    const last = this.db.prepare('SELECT last_run_at FROM pickup_completion_ai_state WHERE id=1').get().last_run_at;
    return last ? last + this.stations.aiConfig().intervalMinutes * 60000 : 0;
  }
  work() { return this.candidates().reverse().filter(item => ['pending', 'failed'].includes(item.status) && item.attempts < 3); }
  schedule() {
    clearTimeout(this.scheduled); this.scheduled = null;
    if (!this.automaticEvents || !this.ready() || this.running) return;
    const pending = this.work(), config = this.stations.aiConfig(); if (!pending.length) return;
    let due = Math.min(...pending.map(item => aiCandidateDueAt(item, this.nextRunAt(), config.nextEventAt)));
    if (config.usageToday >= config.dailyLimit) due = Math.max(due, nextAiDay(this.now()));
    this.scheduled = setTimeout(() => { this.scheduled = null; this.runDue(); }, Math.min(2147483647, Math.max(0, due - this.now()))).unref();
  }
  active(context) { return this.ready() && this.generation === context.generation && !context.signal.aborted && context.channelId === this.stations.aiConfig().channelId; }
  runDue() {
    const response = (code, extra = {}) => ({ accepted: code === 'AI_ACCEPTED', code, running: !!this.running, ...extra });
    if (this.closed) return response('SERVICE_STOPPING');
    if (this.running) return response('AI_RUNNING');
    if (!this.ready()) return response('AI_AUTOMATIC_DISABLED');
    const config = this.stations.aiConfig(), work = this.work();
    if (!work.length) return response('AI_NO_PENDING');
    if (config.usageToday >= config.dailyLimit) { this.schedule(); return response('AI_DAILY_LIMIT'); }
    const due = work.filter(item => aiCandidateDueAt(item, this.nextRunAt(), config.nextEventAt) <= this.now());
    if (!due.length) { this.schedule(); return response('AI_NOT_DUE'); }
    this.controller = new AbortController();
    const context = { generation: this.generation, channelId: config.channelId, signal: this.controller.signal, ids: due.map(item => item.id) };
    this.running = Promise.resolve().then(() => this.run(context)).finally(() => { this.running = null; this.controller = null; this.schedule(); });
    this.running.catch(() => {}); return response('AI_ACCEPTED', { queued: due.length });
  }
  regression(candidate, rule, shipments) {
    if (shipments.length > 10000 || shipments.reduce((count, item) => count + (item.logisticsEvents?.length || 0), 0) > CORPUS_LIMIT) return false;
    const rules = this.completionStore.rules(), next = [rule, ...rules], now = this.now();
    const sample = description => ({ logisticsEvents: [{ time: now - 1, description }] });
    if (!detectPickupCompletion(sample(candidate.fragment), { rules: next, now })) return false;
    if (completionNegativeSamples(candidate.fragment).some(description => detectPickupCompletion(sample(description), { rules: next, now }))) return false;
    for (const shipment of shipments) {
      const before = detectPickupCompletion(shipment, { rules, now }), after = detectPickupCompletion(shipment, { rules: next, now });
      if (before && (!after || before.kind !== after.kind || before.eventTime !== after.eventTime)) return false;
      if (!before && after) {
        const source = shipment.logisticsEvents.find(event => event.time === after.eventTime && String(event.description).slice(0, 600) === after.description);
        const semantic = completionFragment(source?.description);
        if (!semantic || semantic.kind !== candidate.kind || semantic.fragment !== candidate.fragment || after.ruleId !== rule.id) return false;
      }
    }
    return true;
  }
  apply(candidate, context) {
    const shipments = this.cached();
    if (!this.active(context) || !this.sourcePresent(candidate, shipments) || !this.regression(candidate, candidate.rule, shipments)) {
      this.update(candidate.id, { status: 'review', error: '原始证据或独立反例与历史回放未通过，请人工核对。' }); return false;
    }
    if (this.completionStore.rules().some(rule => rule.id === candidate.rule.id)) {
      this.update(candidate.id, { status: 'review', error: '同编号规则已存在，请人工核对。' }); return false;
    }
    this.db.exec('SAVEPOINT completion_ai_apply');
    try {
      this.completionStore.saveRule(candidate.rule);
      this.update(candidate.id, { status: 'applied', appliedAt: this.now(), appliedRule: candidate.rule, error: '' });
      this.db.exec('RELEASE completion_ai_apply'); return true;
    } catch (error) { this.db.exec('ROLLBACK TO completion_ai_apply'); this.db.exec('RELEASE completion_ai_apply'); throw error; }
  }
  async run(context) {
    const counts = { analyzed: 0, applied: 0, failed: 0 }; let marked = false;
    for (const id of context.ids) {
      if (!this.active(context)) break;
      let candidate = this.candidate(id), called = false;
      const attemptsBefore = candidate.attempts, totalAttemptsBefore = candidate.totalAttempts || candidate.attempts;
      try {
        if (!this.sourcePresent(candidate)) { this.update(id, { status: 'review', error: '原始领取证据已失效，未发送给AI。' }); continue; }
        if (this.stations.aiConfig().usageToday >= this.stations.aiConfig().dailyLimit) break;
        if (!marked) {
          if (this.nextRunAt() <= this.now()) this.db.prepare('UPDATE pickup_completion_ai_state SET last_run_at=? WHERE id=1').run(this.now());
          this.stations.markAiRun({ event: true }); marked = true;
        }
        this.update(id, { eventPending: false }); called = true;
        const route = this.assistance.defaultRoute?.(context.channelId);
        const response = await this.assistance.call(context.channelId, [{ role: 'system', content: PICKUP_COMPLETION_SYSTEM },
          { role: 'user', content: JSON.stringify({ fragment: candidate.fragment, kind: candidate.kind }) }], { signal: context.signal, ...(route ? { defaultRoute: route } : {}) });
        if (!this.active(context)) break;
        const suggestion = validateCompletionSuggestion(contentJson(response), candidate);
        candidate = this.update(id, { ...suggestion, status: 'review', attempts: candidate.attempts + 1, totalAttempts: totalAttemptsBefore + 1, retryAt: 0, error: '' });
        counts.analyzed++; if (this.apply(candidate, context)) counts.applied++;
      } catch (error) {
        if (!this.active(context)) break;
        const failure = safeFailure(error), quota = failure.code === 'AI_DAILY_LIMIT', invalid = failure.code === 'AI_INVALID_RESULT' || !!candidate.rule;
        const attempts = attemptsBefore + (called && !quota ? 1 : 0), exhausted = attempts >= 3;
        this.update(id, { status: invalid || exhausted ? 'review' : 'failed', attempts, totalAttempts: totalAttemptsBefore + (called && !quota ? 1 : 0), retryExhausted: !invalid && exhausted,
          retryAt: invalid ? 0 : this.now() + this.stations.aiConfig().intervalMinutes * 60000,
          error: invalid ? '建议未通过受限关键词或保存校验，请人工核对。' : exhausted ? '已达到三次重试上限，请核对 AI 渠道与建议。' : failure.message });
        counts.failed++; if (quota) break;
      }
    }
    return counts;
  }
  history() {
    const rules = this.completionStore.rules();
    return this.candidates().filter(item => item.appliedAt).map(item => ({ id: item.id, kind: 'pickup_completion', summary: item.fragment,
      appliedAt: item.appliedAt, rolledBackAt: item.rolledBackAt, status: item.rolledBackAt ? 'rolled_back' : 'applied',
      canRollback: !item.rolledBackAt && rules.some(rule => equal(rule, item.appliedRule)) }));
  }
  rollback(id) {
    const candidate = this.candidate(id);
    if (this.closed) throw aiError('SERVICE_STOPPING');
    if (!this.history().some(item => item.id === id && item.canRollback)) fail(409, 'AI_ROLLBACK_CONFLICT', '规则已更改或回滚，未覆盖当前规则');
    this.db.exec('SAVEPOINT completion_ai_rollback');
    try {
      this.completionStore.removeRule(candidate.appliedRule.id);
      this.update(id, { status: 'rolled_back', rolledBackAt: this.now(), error: '' });
      this.db.exec('RELEASE completion_ai_rollback');
    } catch (error) { this.db.exec('ROLLBACK TO completion_ai_rollback'); this.db.exec('RELEASE completion_ai_rollback'); throw error; }
    return this.history().find(item => item.id === id);
  }
  status() {
    const candidates = this.candidates(), config = this.stations.aiConfig();
    const monitorRules = builtinPickupCompletionRules.flatMap(rule => (rule.id === 'builtin-pdd-out-cabinet-v1' ? ['拼多多节点：已取件（OUT_CABINET_501）'] : monitorExamples[rule.kind]).map((example, index) => ({
      id: `${rule.id}-example-${index + 1}`, kind: rule.kind, keywords: [example], origin: rule.origin, version: rule.version,
      label: rule.id === 'builtin-pdd-out-cabinet-v1' ? '平台已取件 · 结构化证据' : `${rule.kind === 'recipient_signed' ? '本人签收' : '用户领取'} · 内置示例`, isExample: true, enabled: rule.enabled,
    }))).concat(this.completionStore.rules().map(rule => ({ id: rule.id, kind: rule.kind, keywords: rule.keywords, origin: rule.origin, version: rule.version,
      label: rule.origin === 'ai' ? 'AI 追加词组' : '人工词组', isExample: false, enabled: rule.enabled })));
    const recent = this.cached().filter(item => item.pickupCompletion?.autoPicked).sort((a, b) => b.pickupCompletion.completedAt - a.pickupCompletion.completedAt).slice(0, 20)
      .map(item => ({ id: item.id, completedAt: item.pickupCompletion.completedAt, kind: item.pickupCompletion.evidence?.kind,
        fragment: item.pickupCompletion.evidence?.providerStatus === 'OUT_CABINET' ? '拼多多物流节点：已取件' : completionFragment(item.pickupCompletion.evidence?.description)?.fragment || '明确领取证据', manualOverride: item.pickupCompletion.manualOverride }));
    return { candidates, history: this.history(), monitorRules, recent, running: !!this.running, aiReady: !!this.ready(),
      stats: { pending: candidates.filter(item => ['pending', 'failed'].includes(item.status)).length, review: candidates.filter(item => item.status === 'review').length,
        applied: this.history().filter(item => item.status === 'applied').length, dailyLimit: config.dailyLimit, usageToday: config.usageToday } };
  }
  async close() { this.closed = true; clearTimeout(this.scheduled); this.unsubscribe(); this.controller?.abort(aiError('SERVICE_STOPPING')); await this.running; }
}

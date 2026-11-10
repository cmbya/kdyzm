import { setImmediate as yieldTurn } from 'node:timers/promises';
import { hash } from './security.mjs';
import { logisticsEventTimeIssue } from './collector-enrichment.mjs';
import { logisticsActionIn, logisticsPublicText, specificLogisticsStation } from './logistics-ai-template.mjs';

const engine = globalThis.PickCodeLogistics;
const DAY = 86400000, OFFSET = 8 * 3600000, HOUR = 3 * 3600000, LIMIT = 10000;
const parse = row => row && JSON.parse(row.data);
const validTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
const dateKey = time => new Date(time + OFFSET - HOUR).toISOString().slice(0, 10);
const scheduledAt = day => Date.parse(`${day}T03:00:00+08:00`);
const timeShape = text => String(text || '').slice(0, 100).replace(/\d/gu, '#').replace(/[^#年月日时分秒上午下午今天昨前 :：/+.TZ-]/gu, '?');

const sampleKey = (row, revision) => hash(JSON.stringify([row.shipment_data || row.data, row.account_data, row.order_data, revision]));
function sampleUntil(shipment, order, now) {
  const override = typeof order?.dateOverride === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(order.dateOverride)
    ? Date.parse(`${order.dateOverride}T00:00:00+08:00`) : 0;
  const date = override || order?.orderDate || order?.firstSeenAt;
  const boundaries = [Math.floor((now + OFFSET) / DAY) * DAY + DAY - OFFSET, date, date + 45 * DAY,
    shipment.arrivalAt, ...(shipment.logisticsEvents || []).map(event => event.time)].filter(value => value > now);
  return Math.min(...boundaries);
}

export class LogisticsDailyLearning {
  constructor({ store, stations, logisticsAi, now = Date.now, automaticEvents = true }) {
    this.store = store; this.db = store.db; this.stations = stations; this.logisticsAi = logisticsAi;
    this.now = now; this.automaticEvents = automaticEvents; this.closed = false; this.running = null;
    this.sampleCache = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS logistics_daily_runs (day TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logistics_daily_samples (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    this.unsubscribe = stations.onAiConfigChange(() => this.schedule());
    this.schedule();
  }
  ready() { return !this.closed && this.logisticsAi.ready(); }
  read(day) { return parse(this.db.prepare('SELECT data FROM logistics_daily_runs WHERE day=?').get(day)); }
  unfinished(day) {
    return parse(this.db.prepare("SELECT data FROM logistics_daily_runs WHERE day<=? AND json_extract(data,'$.scanStatus')!='complete' ORDER BY day LIMIT 1").get(day));
  }
  save(run) {
    this.db.prepare('INSERT INTO logistics_daily_runs VALUES(?,?) ON CONFLICT(day) DO UPDATE SET data=excluded.data').run(run.day, JSON.stringify(run));
  }
  nextRunAt() {
    const day = dateKey(this.now()), run = this.unfinished(day) || this.read(day);
    return run?.scanStatus === 'complete' ? scheduledAt(day) + DAY : Math.max(scheduledAt(day), run?.retryAt || 0);
  }
  schedule() {
    clearTimeout(this.scheduled); this.scheduled = null;
    if (!this.automaticEvents || !this.ready() || this.running) return;
    this.scheduled = setTimeout(() => { this.scheduled = null; this.runDue(); }, Math.max(0, this.nextRunAt() - this.now())).unref();
  }
  directory() {
    const revision = this.stations.revision;
    if (this.directoryCache?.revision !== revision) this.directoryCache = { revision,
      names: this.stations.stationRules().stations.flatMap(item => [item.name, ...item.aliases.map(alias => alias.name)])
        .filter(specificLogisticsStation).sort((a, b) => b.length - a.length) };
    return this.directoryCache.names;
  }
  inspect(shipment, names = [], collectActions = true) {
    const issues = {}, formats = [], actions = [];
    if (!validTime(shipment.arrivalAt)) issues.missingArrival = true;
    else if (!['second', 'minute'].includes(shipment.arrivalAtPrecision)) issues.unknownPrecision = true;
    if (shipment.arrivalAt > this.now()) issues.timeConflict = true;
    const hint = collectActions && specificLogisticsStation(shipment.station) ? shipment.station : '';
    for (const event of shipment.logisticsEvents || []) {
      const problem = logisticsEventTimeIssue(event, this.now());
      if (problem) {
        issues[problem] = true;
        formats.push({ reason: problem, format: timeShape(event.timeText), result: 'requires_review' });
      }
      if (!collectActions || problem === 'unknownTime' || problem === 'timeConflict' || !this.logisticsAi.eligibleTime(event.time) || typeof event.description !== 'string') continue;
      for (const part of event.description.split(/[，,。；;！？!?\n\r]/u)) {
        const action = logisticsActionIn.exec(part);
        if (!action) continue;
        const tail = part.slice(action.index + action[0].length);
        const known = names.find(name => tail.startsWith(name));
        const station = hint && tail.startsWith(hint) && hint.length >= (known?.length || 0) ? hint
          : known || tail.split(/请|等待|待取件|取件码|取货码|电话/u)[0].trim();
        const fragment = part.slice(action.index, action.index + action[0].length + station.length);
        if (!specificLogisticsStation(station) || !logisticsPublicText(fragment, 200)) continue;
        const rule = { id: 'daily-probe', name: '本地证据', enabled: true, kind: 'arrival', starts: [action[0]], end: '', keywords: [station], sample: fragment, expectedStation: station, origin: 'manual' };
        let preview;
        try { preview = engine.test(rule, event.description); } catch { continue; }
        if (!preview.arrival || preview.station !== station) continue;
        actions.push({ id: `logistics-${hash(JSON.stringify([fragment, station])).slice(0, 32)}`, fragment, station });
      }
    }
    return { issues, formats, actions: [...new Map(actions.map(action => [action.id, action])).values()] };
  }
  async scan(run) {
    const upper = run.upperRow;
    while (this.ready() && run.activeScanned < LIMIT) {
      const rows = this.db.prepare(`SELECT s.rowid AS seq,s.data,a.data AS account_data,o.data AS order_data FROM shipments s
        LEFT JOIN accounts a ON a.id=s.account_id LEFT JOIN orders o ON o.id=json_extract(s.data,'$.orderId')
        WHERE s.rowid>? AND s.rowid<=? ORDER BY s.rowid LIMIT 100`).all(run.cursor, upper);
      if (!rows.length) break;
      const names = this.directory(), revision = `${this.stations.revision}:${this.logisticsAi.rules.read().revision}`;
      const before = structuredClone(run);
      this.db.exec('SAVEPOINT logistics_daily_scan');
      try {
        for (const row of rows) {
          if (run.activeScanned >= LIMIT) break;
          const shipment = parse(row); run.cursor = row.seq; run.scanned++;
          if (!this.logisticsAi.eligibleShipment(shipment) || !shipment.logisticsEvents?.length) {
            this.db.prepare('DELETE FROM logistics_daily_samples WHERE id=?').run(shipment.id); continue;
          }
          run.activeScanned++;
          const fingerprint = hash(JSON.stringify([shipment.arrivalAt, shipment.arrivalAtPrecision, shipment.station,
            shipment.logisticsEvents, this.stations.revision]));
          const previous = parse(this.db.prepare('SELECT data FROM logistics_daily_samples WHERE id=?').get(shipment.id));
          if (previous?.fingerprint === fingerprint && !previous.issues.timeConflict) continue;
          run.changed++;
          const sample = { id: shipment.id, fingerprint, observedDay: run.day, sourceKey: sampleKey(row, revision),
            validUntil: sampleUntil(shipment, row.order_data && JSON.parse(row.order_data), this.now()), ...this.inspect(shipment, names) };
          for (const action of sample.actions) if (!run.newGroupIds.includes(action.id)) run.newGroupIds.push(action.id);
          this.db.prepare('INSERT INTO logistics_daily_samples VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(shipment.id, JSON.stringify(sample));
        }
        this.save(run); this.db.exec('RELEASE logistics_daily_scan');
      } catch (error) {
        this.db.exec('ROLLBACK TO logistics_daily_scan'); this.db.exec('RELEASE logistics_daily_scan');
        Object.assign(run, before); throw error;
      }
      await yieldTurn();
    }
    if (!this.ready()) return;
    const samples = this.db.prepare('SELECT data FROM logistics_daily_samples').all().map(parse)
      .filter(sample => { const shipment = this.store.shipment(sample.id); return shipment && this.logisticsAi.eligibleShipment(shipment) && this.logisticsAi.automaticAllowed(shipment); });
    const groups = new Map();
    for (const sample of samples) {
      if (!Object.keys(sample.issues).length) continue;
      for (const action of sample.actions) {
        const group = groups.get(action.id) || { ...action, shipments: new Set() };
        group.shipments.add(sample.id); groups.set(action.id, group);
      }
    }
    const selected = [...groups.values()].filter(group => group.shipments.size >= 2 && run.newGroupIds.includes(group.id));
    const ids = [...new Set(selected.flatMap(group => [...group.shipments]))];
    const shipments = ids.map(id => this.store.shipment(id)).filter(Boolean);
    run.missingArrivalIds = shipments.filter(shipment => !validTime(shipment.arrivalAt)).map(shipment => shipment.id);
    // Existing intake owns privacy, station backing, candidate validation and scheduling.
    if (shipments.length) this.logisticsAi.intake({ shipments: shipments.map(shipment => ({ ...shipment,
      logisticsEvents: shipment.logisticsEvents.filter(event => !['unknownTime', 'timeConflict'].includes(logisticsEventTimeIssue(event, this.now())))
        .flatMap(event => selected.filter(group => group.shipments.has(shipment.id) && event.description.includes(group.fragment))
          .map(group => ({ ...event, description: group.fragment }))) })) });
    const candidates = this.logisticsAi.candidates();
    run.candidateIds = selected.map(group => group.id).filter(id => candidates.some(candidate => candidate.id === id));
    for (const id of run.candidateIds) this.logisticsAi.update(id, { dailyRunDay: run.day });
    run.highFrequencyGroups = selected.length;
    run.truncated = run.activeScanned >= LIMIT && run.cursor < upper;
    run.scanStatus = 'complete'; run.scanCompletedAt = this.now();
    this.save(run);
    if (run.candidateIds.length && this.ready()) {
      const result = this.logisticsAi.runDue({ candidateIds: run.candidateIds });
      run.aiCode = result.code; this.save(run);
      if (this.logisticsAi.running) await this.logisticsAi.running;
    }
  }
  runDue() {
    const response = code => ({ accepted: code === 'DAILY_ACCEPTED', code, running: !!this.running });
    if (this.closed) return response('SERVICE_STOPPING');
    if (!this.ready()) return response('AI_AUTOMATIC_DISABLED');
    if (this.running) return response('DAILY_RUNNING');
    const day = dateKey(this.now());
    let run = this.unfinished(day) || this.read(day);
    if (run?.scanStatus === 'complete') return response('DAILY_ALREADY_RUN');
    if (run?.retryAt > this.now()) return response('DAILY_NOT_DUE');
    const previous = parse(this.db.prepare('SELECT data FROM logistics_daily_runs WHERE day<? ORDER BY day DESC LIMIT 1').get(day));
    const cursor = previous?.truncated ? previous.cursor : 0;
    run ||= { day, dueAt: scheduledAt(day), startedAt: this.now(), scanStatus: 'running', scanCompletedAt: 0,
      upperRow: this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM shipments').get().value,
      total: this.db.prepare('SELECT COUNT(*) AS value FROM shipments WHERE rowid>?').get(cursor).value,
      cursor, scanned: 0, activeScanned: 0, changed: 0, newGroupIds: [], candidateIds: [], missingArrivalIds: [], highFrequencyGroups: 0, aiCode: '', error: '' };
    run.error = ''; run.retryAt = 0; this.save(run); this.currentRunDay = run.day;
    this.running = Promise.resolve().then(() => this.scan(run)).catch(() => {
      run.error = '每日物流检查未完成，将从已保存进度继续'; run.retryAt = this.now() + 60000; this.save(run);
    }).finally(() => { this.running = null; this.currentRunDay = null; this.schedule(); });
    return response('DAILY_ACCEPTED');
  }
  diagnostics(run) {
    const now = this.now(), revision = `${this.stations.revision}:${this.logisticsAi.rules.read().revision}`;
    const key = `${this.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision}:${revision}:${run.day}:${run.scanned}:${run.changed}:${run.scanStatus}`;
    if (this.diagnosticsCache?.key === key && now < this.diagnosticsCache.validUntil) return this.diagnosticsCache.result;
    const issues = { missingArrival: 0, unknownTime: 0, unknownPrecision: 0, timeConflict: 0 }, formats = new Map();
    let unconfirmedCount = 0, backfilledCount = 0, validUntil = Infinity;
    const missing = new Set(run.missingArrivalIds);
    const rows = this.db.prepare(`SELECT d.data,s.data AS shipment_data,a.data AS account_data,o.data AS order_data
      FROM logistics_daily_samples d JOIN shipments s ON s.id=d.id
      LEFT JOIN accounts a ON a.id=s.account_id LEFT JOIN orders o ON o.id=json_extract(s.data,'$.orderId')`).all();
    for (const row of rows) {
      const sample = parse(row), sourceKey = sampleKey(row, revision);
      let current = this.sampleCache.get(sample.id);
      if (current?.sourceKey !== sourceKey || now >= current.validUntil) {
        const shipment = JSON.parse(row.shipment_data);
        current = sample.sourceKey === sourceKey && now < sample.validUntil ? { ...sample, eligible: true, arrivalAt: shipment.arrivalAt }
          : { sourceKey, validUntil: sampleUntil(shipment, row.order_data && JSON.parse(row.order_data), now),
            eligible: this.logisticsAi.eligibleShipment(shipment), arrivalAt: shipment.arrivalAt, ...this.inspect(shipment, [], false) };
        this.sampleCache.set(sample.id, current);
      }
      validUntil = Math.min(validUntil, current.validUntil);
      if (missing.has(sample.id) && validTime(current.arrivalAt)) backfilledCount++;
      if (!current.eligible) continue;
      if (Object.keys(current.issues).length) unconfirmedCount++;
      for (const key of Object.keys(current.issues)) issues[key]++;
      for (const format of new Map(current.formats.map(item => [JSON.stringify(item), item])).values()) {
        const key = JSON.stringify(format), group = formats.get(key) || { ...format, count: 0 };
        group.count++; formats.set(key, group);
      }
    }
    const result = { unconfirmedCount, backfilledCount, issues, timeFormats: [...formats.values()].sort((a, b) => b.count - a.count).slice(0, 50) };
    this.diagnosticsCache = { key, validUntil, result };
    return result;
  }
  summary() {
    const run = this.currentRunDay ? this.read(this.currentRunDay) : parse(this.db.prepare('SELECT data FROM logistics_daily_runs ORDER BY day DESC LIMIT 1').get());
    const output = { enabled: this.ready(), timezone: 'Asia/Shanghai', hour: 3, nextRunAt: this.nextRunAt(), running: !!this.running,
      timeFormatLearning: 'unsupported_requires_review', lastRun: null };
    if (!run) return output;
    const candidates = this.logisticsAi.candidates().filter(candidate => run.candidateIds.includes(candidate.id));
    const states = { pending: 0, failed: 0, review: 0, applied: 0, ignored: 0, rolled_back: 0 };
    for (const candidate of candidates) if (Object.hasOwn(states, candidate.status)) states[candidate.status]++;
    const processedCount = candidates.filter(candidate => candidate.attempts > 0 || ['applied', 'rolled_back'].includes(candidate.status)).length;
    const aiStatus = states.pending ? 'queued' : states.failed ? candidates.some(candidate => candidate.status === 'failed' && candidate.attempts < 3) ? 'waiting_retry' : 'requires_review'
      : states.review ? 'awaiting_review' : candidates.length ? 'complete' : 'no_candidates';
    const { newGroupIds, candidateIds, missingArrivalIds, upperRow, cursor, ...publicRun } = run;
    output.lastRun = { ...publicRun, aiStatus, candidateCount: candidates.length, processedCount, states,
      learnedRules: candidates.filter(candidate => candidate.rule).length, appliedRules: states.applied,
      ...this.diagnostics(run) };
    return output;
  }
  async close() { this.closed = true; clearTimeout(this.scheduled); this.unsubscribe(); await this.running; }
}

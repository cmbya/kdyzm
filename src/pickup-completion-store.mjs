import { builtinPickupCompletionRules, detectPickupCompletion, effectivePicked, pickupCompletionState, validatePickupCompletionRule } from './pickup-completion.mjs';
import { fail, onlyKeys } from './security.mjs';

export class PickupCompletionStore {
  constructor({ store, now = Date.now }) {
    this.store = store; this.db = store.db; this.now = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS pickup_completion_config (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      INSERT OR IGNORE INTO pickup_completion_config VALUES(1,'{"version":1,"enabled":true,"aiEnabled":true,"revision":1}');
      CREATE TABLE IF NOT EXISTS pickup_completion_rules (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    store.pickupCompletion = this;
    this.migrate();
    this.recalculate({ startup: true });
  }
  config() { return JSON.parse(this.db.prepare('SELECT data FROM pickup_completion_config WHERE id=1').get().data); }
  rules() { return this.db.prepare('SELECT data FROM pickup_completion_rules ORDER BY id').all().map(row => JSON.parse(row.data)); }
  atomic(fn) {
    const name = `pickup_completion_${this.sequence = (this.sequence || 0) + 1}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); this.db.exec(`RELEASE ${name}`); return result; }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error; }
  }
  bump() {
    const config = { ...this.config(), revision: this.config().revision + 1 };
    this.db.prepare('UPDATE pickup_completion_config SET data=? WHERE id=1').run(JSON.stringify(config));
    this.store.revision();
    return config;
  }
  saveConfig(input) {
    onlyKeys(input, ['enabled', 'aiEnabled']);
    if (Object.values(input).some(value => typeof value !== 'boolean')) fail(400, 'INVALID_INPUT', '自动取件开关必须是布尔值');
    return this.atomic(() => {
      const old = this.config();
      if (Object.entries(input).every(([key, value]) => old[key] === value)) return old;
      this.db.prepare('UPDATE pickup_completion_config SET data=? WHERE id=1').run(JSON.stringify({ ...old, ...input }));
      this.bump(); this.recalculate(); return this.config();
    });
  }
  saveRule(input) {
    const rule = validatePickupCompletionRule(input);
    return this.atomic(() => {
      if (this.rules().length >= 100 && !this.rules().some(old => old.id === rule.id)) fail(400, 'PICKUP_COMPLETION_RULE_LIMIT', '自动取件规则已达到上限');
      this.db.prepare('INSERT INTO pickup_completion_rules VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(rule.id, JSON.stringify(rule));
      this.bump(); this.recalculate(); return rule;
    });
  }
  removeRule(id) {
    return this.atomic(() => {
      if (!this.db.prepare('DELETE FROM pickup_completion_rules WHERE id=?').run(id).changes) return { changed: 0 };
      this.bump(); return this.recalculate({ removedRuleId: id });
    });
  }
  migrate() {
    this.atomic(() => {
      const latest = new Map(), byId = new Map();
      for (const row of this.db.prepare('SELECT rowid,device_id,id,data FROM operations ORDER BY rowid').all()) {
        const operation = JSON.parse(row.data);
        if (!['pick', 'restore', 'resumeAutoPickup'].includes(operation.action) || operation.status === 'superseded') continue;
        const reference = `${row.device_id}:${row.id}`;
        byId.set(reference, { ...operation, reference });
        // Legacy clients applied in receive order; preserve the actual last accepted decision.
        latest.set(operation.shipmentId, { ...operation, reference });
      }
      let changed = false;
      for (const row of this.db.prepare('SELECT data FROM shipments').all()) {
        const shipment = JSON.parse(row.data);
        if (shipment.pickupCompletion?.version === 1) {
          if (Object.hasOwn(shipment, 'pickupManualAction') && Object.hasOwn(shipment, 'pickupConfirmedAt')) continue;
          const operation = byId.get(shipment.pickupManualOperation);
          // Only an exact persisted operation proves the time of a legacy manual confirmation.
          shipment.pickupManualAction = operation && operation.occurredAt === shipment.pickupManualAt ? operation.action : '';
          shipment.pickupConfirmedAt = shipment.pickupManualAction === 'pick' ? operation.pickedAt ?? operation.occurredAt : 0;
          this.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(shipment), shipment.id); changed = true;
          continue;
        }
        const operation = latest.get(shipment.id), state = pickupCompletionState(shipment);
        if (operation) state.manualOverride = operation.action === 'pick' ? 'picked' : operation.action === 'restore' ? 'pending' : '';
        Object.assign(shipment, { pickupCompletion: state, picked: effectivePicked(state), pickupManualAt: operation?.occurredAt || (shipment.picked ? shipment.manualAt || 0 : 0),
          pickupManualOperation: operation?.reference || '', pickupManualAction: operation?.action || '',
          pickupConfirmedAt: operation?.action === 'pick' ? operation.pickedAt ?? operation.occurredAt : 0 });
        this.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(shipment), shipment.id); changed = true;
      }
      if (changed) this.store.revision();
    });
  }
  project(shipment, { startup = false, removedRuleId, rules = this.rules(), config = this.config() } = {}) {
    const state = pickupCompletionState(shipment), prior = state.evidence;
    const enabledRules = [...builtinPickupCompletionRules, ...rules].filter(rule => rule.enabled);
    const priorValid = prior && enabledRules.some(rule => rule.id === prior.ruleId && rule.version === prior.ruleVersion);
    const projectedEvents = [...(shipment.logisticsEvents || []), ...(prior ? [{ ...prior, time: prior.eventTime }] : [])];
    const evidence = detectPickupCompletion({ ...shipment, logisticsEvents: projectedEvents }, { rules, now: this.now() });
    if (state.autoPicked && (!priorValid || (!evidence && config.enabled))) {
      state.autoPicked = false; state.completedAt = 0; state.evidence = null;
    }
    const eligible = !shipment.hidden && !shipment.deleted && !(startup && shipment.picked && !prior);
    // A rollback must retract its own projection, even if a built-in also recognizes that event.
    if (config.enabled && eligible && evidence && (!removedRuleId || prior?.ruleId !== removedRuleId)) {
      state.autoPicked = true; state.completedAt = evidence.eventTime; state.evidence = evidence;
    }
    return { ...shipment, pickupCompletion: state, picked: effectivePicked(state) };
  }
  recalculate(options = {}) {
    return this.atomic(() => {
      const rules = this.rules(), config = this.config(); let changed = 0;
      for (const row of this.db.prepare('SELECT data FROM shipments').all()) {
        const old = JSON.parse(row.data), shipment = this.project(old, { ...options, rules, config });
        if (JSON.stringify(shipment.pickupCompletion) === JSON.stringify(old.pickupCompletion) && shipment.picked === old.picked) continue;
        this.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(shipment), shipment.id); changed++;
      }
      if (changed) this.store.revision();
      return { changed };
    });
  }
}

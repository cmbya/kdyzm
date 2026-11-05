import './logistics-rules.js';
import { fail, onlyKeys } from './security.mjs';

const engine = globalThis.PickCodeLogistics;

export class LogisticsRuleStore {
  constructor(db, now = Date.now, { onRulesChanged } = {}) {
    this.db = db;
    this.now = now;
    this.onRulesChanged = onRulesChanged;
    db.exec(`CREATE TABLE IF NOT EXISTS logistics_rule_settings (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, rules TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    db.prepare('INSERT OR IGNORE INTO logistics_rule_settings VALUES(1,1,?,?)').run(JSON.stringify(engine.defaults()), now());
  }
  read() {
    const row = this.db.prepare('SELECT revision,rules FROM logistics_rule_settings WHERE id=1').get();
    return { revision: row.revision, rules: JSON.parse(row.rules), defaults: engine.defaults() };
  }
  save(body) {
    onlyKeys(body, ['revision', 'rules']);
    if (!Number.isSafeInteger(body.revision) || body.revision < 1) fail(400, 'INVALID_LOGISTICS_RULE', '规则版本不正确，请重新加载');
    let rules;
    try { rules = engine.validateRules(body.rules); }
    catch (error) { fail(400, 'INVALID_LOGISTICS_RULE', error.message); }
    const savepoint = `logistics_rule_write_${this.writeSequence = (this.writeSequence || 0) + 1}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const saved = this.db.prepare('UPDATE logistics_rule_settings SET revision=revision+1,rules=?,updated_at=? WHERE id=1 AND revision=?')
        .run(JSON.stringify(rules), this.now(), body.revision);
      if (!saved.changes) fail(409, 'LOGISTICS_RULE_CONFLICT', '规则已被其他管理员更新，请重新加载后再编辑');
      this.onRulesChanged?.(rules);
      this.db.exec(`RELEASE ${savepoint}`);
      return this.read();
    } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); throw error; }
  }
  test(body) {
    onlyKeys(body, ['rule', 'sample']);
    try { return engine.test(body.rule, body.sample); }
    catch (error) { fail(400, 'INVALID_LOGISTICS_RULE', error.message); }
  }
}

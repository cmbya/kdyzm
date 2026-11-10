import { randomUUID } from 'node:crypto';
import { fail, hash, onlyKeys, secret, text } from './security.mjs';

const metadata = row => row ? { id: row.id, name: row.name, createdAt: row.created_at, revokedAt: row.revoked_at } : null;

export class DiagnosticAccess {
  constructor({ store, now = Date.now }) {
    Object.assign(this, { store, db: store.db, now });
    this.db.exec(`CREATE TABLE IF NOT EXISTS diagnostic_credentials (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      created_at INTEGER NOT NULL, revoked_at INTEGER);`);
  }
  create(body) {
    onlyKeys(body, ['name']);
    const name = text(body.name, '诊断凭据名称', 80);
    if (/[\u0000-\u001f\u007f]/u.test(name)) fail(400, 'INVALID_INPUT', '诊断凭据名称格式不正确');
    return this.store.transaction(() => {
      if (this.db.prepare('SELECT COUNT(*) AS count FROM diagnostic_credentials WHERE revoked_at IS NULL').get().count >= 10)
        fail(409, 'DIAGNOSTIC_TOKEN_LIMIT', '最多保留10个有效诊断凭据，请先撤销不再使用的凭据');
      const token = `pcdiag_${secret()}`;
      const credential = { id: randomUUID(), name, createdAt: this.now(), revokedAt: null };
      this.db.prepare('INSERT INTO diagnostic_credentials(id,token_hash,name,created_at,revoked_at) VALUES(?,?,?,?,NULL)')
        .run(credential.id, hash(token), name, credential.createdAt);
      return { token, credential };
    });
  }
  list() {
    return this.db.prepare('SELECT id,name,created_at,revoked_at FROM diagnostic_credentials ORDER BY rowid DESC').all().map(metadata);
  }
  revoke(id) {
    id = text(id, '诊断凭据ID', 80);
    this.db.prepare('UPDATE diagnostic_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(this.now(), id);
    return { revoked: true };
  }
  authenticate(token) {
    if (typeof token !== 'string' || token.length !== 50 || !/^pcdiag_[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    return metadata(this.db.prepare('SELECT id,name,created_at,revoked_at FROM diagnostic_credentials WHERE token_hash=? AND revoked_at IS NULL').get(hash(token)));
  }
}

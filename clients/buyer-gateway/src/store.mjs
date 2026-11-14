import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { check } from './errors.mjs';

// One process owns the database. All writes are synchronous and encrypted before
// SQLite sees them, including WAL pages. Back up the encryption key separately.
export class Store {
  constructor(path, key) {
    check(Buffer.isBuffer(key) && key.length === 32, 'invalid_storage_key');
    this.key = key;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(kind, id)
      );`);
  }
  put(kind, id, owner, value) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([kind, id, owner])));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const packed = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET owner=excluded.owner,value=excluded.value')
      .run(kind, id, owner, packed);
  }
  decode(row) {
    if (!row) return null;
    const bytes = Buffer.from(row.value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(JSON.stringify([row.kind, row.id, row.owner])));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
  }
  get(kind, id, owner) {
    const row = this.db.prepare('SELECT * FROM records WHERE kind=? AND id=?').get(kind, id);
    return row && (owner === undefined || row.owner === owner) ? this.decode(row) : null;
  }
  list(kind, owner) {
    return this.db.prepare('SELECT * FROM records WHERE kind=? AND owner=? ORDER BY rowid').all(kind, owner).map(row => this.decode(row));
  }
  delete(kind, id) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

export class Locks {
  pending = new Map();
  async run(key, action) {
    const previous = this.pending.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.pending.set(key, current);
    await previous;
    try { return await action(); }
    finally { release(); if (this.pending.get(key) === current) this.pending.delete(key); }
  }
}

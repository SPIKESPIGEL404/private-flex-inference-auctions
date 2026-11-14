// TEST-ONLY SQLite feasibility harness. It is NOT the Market cash ledger and
// cannot dispatch, credit cash, or broadcast. P1 must implement the owning seams.
import { DatabaseSync } from 'node:sqlite';
import { canonical, hash, requireThat } from '../contract.mjs';
export class Harness {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS budget(id TEXT PRIMARY KEY, cap INTEGER NOT NULL, held INTEGER NOT NULL DEFAULT 0 CHECK(held>=0 AND held<=cap));
      CREATE TABLE IF NOT EXISTS reservation(id TEXT PRIMARY KEY, task TEXT NOT NULL, fingerprint TEXT NOT NULL, amount INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenge(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS presentation(hash TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consumption(movement TEXT PRIMARY KEY, order_ref TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS purpose(order_ref TEXT PRIMARY KEY, movement TEXT UNIQUE NOT NULL);
    `);
  }
  close() { this.db.close(); }
  transaction(f) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const v = f(); this.db.exec('COMMIT'); return v; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  reserve({ task, call, fingerprint, amount }) {
    requireThat(Number.isSafeInteger(amount) && amount > 0, 'invalid_budget_amount');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM reservation WHERE id=?').get(call);
      if (old) { requireThat(old.task === task && old.fingerprint === fingerprint && old.amount === amount, 'reservation_conflict'); return old; }
      const change = this.db.prepare('UPDATE budget SET held=held+? WHERE id=? AND held+?<=cap').run(amount, task, amount);
      requireThat(change.changes === 1, 'budget_exceeded');
      this.db.prepare('INSERT INTO reservation VALUES(?,?,?,?)').run(call, task, fingerprint, amount);
      return { task, call, amount };
    });
  }
  putChallenge(c) { this.db.prepare('INSERT INTO challenge VALUES(?,?)').run(c.id, canonical(c)); }
  async loadChallenge(id) { const r = this.db.prepare('SELECT body FROM challenge WHERE id=?').get(id); return r && JSON.parse(r.body); }
  async journalPresentation(c) { this.db.prepare('INSERT OR IGNORE INTO presentation VALUES(?,?)').run(hash(c), canonical(c)); }
  async consumeVerifiedPayment(v) {
    const result = this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM consumption WHERE movement=?').get(v.movementKey);
      if (old) { requireThat(old.order_ref === v.orderRef, 'movement_already_consumed'); return { committed: true, projectionReady: !v.late, orderRef: old.order_ref }; }
      this.db.prepare('INSERT INTO consumption VALUES(?,?,?)').run(v.movementKey, v.orderRef, canonical(v));
      if (this.failBeforePurpose) throw new Error('controlled_rollback');
      this.db.prepare('INSERT INTO purpose VALUES(?,?)').run(v.orderRef, v.movementKey);
      return { committed: true, projectionReady: !v.late, orderRef: v.orderRef };
    });
    if (this.loseCommitAck) { this.loseCommitAck = false; throw new Error('controlled_lost_commit_ack'); }
    return result;
  }
}

import { randomBytes, createHash } from 'node:crypto';
import { check } from './errors.mjs';
import { verifyMessage } from './near.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export class Auth {
  constructor(store, rpc, origin, now = Date.now) { Object.assign(this, { store, rpc, origin, now }); }
  challenge() {
    const pending = this.store.list('challenge', '');
    for (const challenge of pending) if (challenge.expiresAt <= this.now()) this.store.delete('challenge', challenge.id);
    check(pending.filter(challenge => challenge.expiresAt > this.now()).length < 2000, 'login_capacity_exceeded', 429);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + 5 * 60_000;
    const payload = { nonce: randomBytes(32).toString('base64'), recipient: new URL(this.origin).host,
      message: JSON.stringify({ action: 'Sign in to Private Market', origin: this.origin, network: 'mainnet', expires_at: new Date(expiresAt).toISOString(), session_nonce: randomBytes(16).toString('base64url') }) };
    this.store.put('challenge', digest(token), '', { id: digest(token), payload, expiresAt });
    return { token, payload, expiresAt };
  }
  async verify(token, signed) {
    check(typeof token === 'string', 'login_required', 401);
    const id = digest(token), challenge = this.store.get('challenge', id);
    check(challenge && challenge.expiresAt > this.now(), 'login_challenge_expired', 401);
    // Consume before awaiting RPC: concurrent/replayed signatures cannot log in.
    this.store.delete('challenge', id);
    check(typeof signed?.accountId === 'string' && typeof signed?.publicKey === 'string' && typeof signed?.signature === 'string', 'invalid_signature', 401);
    verifyMessage(challenge.payload, signed.publicKey, signed.signature);
    await this.rpc.fullAccess(signed.accountId, signed.publicKey);
    const owner = { type: 'near', account_id: signed.accountId, public_key: signed.publicKey };
    const session = randomBytes(32).toString('base64url');
    this.store.put('session', digest(session), owner.account_id, { owner, expiresAt: this.now() + 8 * 60 * 60_000 });
    return { token: session, owner };
  }
  owner(token) {
    const session = typeof token === 'string' ? this.store.get('session', digest(token)) : null;
    check(session && session.expiresAt > this.now(), 'login_required', 401);
    return session.owner;
  }
  logout(token) { if (typeof token === 'string') this.store.delete('session', digest(token)); }
}

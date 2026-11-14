import { createHash, createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { check, GatewayError } from './errors.mjs';

export const accountPattern = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const uint = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const string = value => { const b = Buffer.from(value); return Buffer.concat([uint(b.length), b]); };

export function nep413Hash({ message, nonce, recipient }) {
  const bytes = Buffer.from(nonce, 'base64');
  check(bytes.length === 32, 'invalid_nonce');
  // NEP-413 Borsh payload: tag, message, nonce[32], recipient, callbackUrl=None.
  return createHash('sha256').update(Buffer.concat([
    uint(2 ** 31 + 413), string(message), bytes, string(recipient), Buffer.from([0]),
  ])).digest();
}

export function verifyMessage(payload, publicKey, signature) {
  try {
    check(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(publicKey), 'invalid_public_key');
    const raw = Buffer.from(bs58.decode(publicKey.slice(8)));
    check(typeof signature === 'string' && signature.length <= 140, 'invalid_signature');
    const sig = /^(?:0x)?[0-9a-f]{128}$/i.test(signature)
      ? Buffer.from(signature.replace(/^0x/i, ''), 'hex')
      : /^[A-Za-z0-9+/]{86}==$/.test(signature) ? Buffer.from(signature, 'base64')
        : Buffer.from(bs58.decode(signature));
    check(raw.length === 32 && sig.length === 64, 'invalid_signature');
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    check(verify(null, nep413Hash(payload), key, sig), 'invalid_signature', 401);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError('invalid_signature', 401);
  }
}

export class NearRpc {
  constructor(url, fetcher = fetch) { this.url = url; this.fetcher = fetcher; }
  async call(method, params) {
    const response = await this.fetcher(this.url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'buyer-gateway', method, params }),
    });
    check(response.ok, 'near_rpc_unavailable', 502);
    const text = await response.text();
    check(text.length <= 256 * 1024, 'near_rpc_invalid_response', 502);
    const body = JSON.parse(text);
    check(!body.error && body.result, 'near_rpc_refused', 502);
    return body.result;
  }
  async fullAccess(accountId, publicKey) {
    check(accountPattern.test(accountId), 'invalid_account');
    const key = await this.call('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
    check(key.permission === 'FullAccess', 'owner_key_not_full_access', 403);
  }
  async view(contract, method, args) {
    const result = await this.call('query', { request_type: 'call_function', finality: 'final', account_id: contract,
      method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    return JSON.parse(Buffer.from(result.result).toString());
  }
  async fundingTransaction(owner, tokenContract, deposit, amount) {
    check(accountPattern.test(deposit.deposit_address), 'unsupported_deposit_address', 409);
    const registered = await this.view(tokenContract, 'storage_balance_of', { account_id: deposit.deposit_address });
    const actions = [];
    if (!registered) {
      const bounds = await this.view(tokenContract, 'storage_balance_bounds', {});
      check(/^\d{1,30}$/.test(bounds?.min), 'invalid_storage_cost', 502);
      // Refuse unexpectedly expensive storage instead of silently increasing cost.
      check(BigInt(bounds.min) <= 10n ** 23n, 'storage_cost_too_high', 409);
      actions.push({ type: 'FunctionCall', params: { methodName: 'storage_deposit', args: { account_id: deposit.deposit_address, registration_only: true }, gas: '30000000000000', deposit: bounds.min } });
    }
    const args = { receiver_id: deposit.deposit_address, amount, ...(deposit.memo ? { memo: deposit.memo } : {}) };
    actions.push({ type: 'FunctionCall', params: { methodName: 'ft_transfer', args, gas: '30000000000000', deposit: '1' } });
    return { signerId: owner.account_id, receiverId: tokenContract, actions };
  }
}

import { readFile, stat, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import bs58 from 'bs58';
import { hash, requireThat, uint } from '../contract.mjs';

export const NETWORKS = Object.freeze({
  testnet: { origin: 'https://testnet-api.outlayer.ai', contract: 'outlayer.testnet' },
  mainnet: { origin: 'https://api.outlayer.ai', contract: 'outlayer.near' },
});
export class WalletError extends Error {
  constructor(code, { status = 0, requestId = null, txHash = null, definiteRefusal = false } = {}) {
    super(code); Object.assign(this, { status, requestId, txHash, definiteRefusal });
  }
}
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function publicKey(value) {
  requireThat(typeof value === 'string' && value.startsWith('ed25519:'), 'invalid_wallet_public_key');
  const raw = value.slice(8);
  const bytes = /^[0-9a-f]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(bs58.decode(raw));
  requireThat(bytes.length === 32, 'invalid_wallet_public_key');
  return { hex: bytes.toString('hex'), base58: 'ed25519:' + bs58.encode(bytes) };
}
export function signatureBase64(value) {
  requireThat(typeof value === 'string' && value.startsWith('ed25519:'), 'invalid_wallet_signature');
  const bytes = Buffer.from(bs58.decode(value.slice(8)));
  requireThat(bytes.length === 64, 'invalid_wallet_signature');
  return bytes.toString('base64');
}
// Credentials are read from a private directory at use time, never put into an
// operation/config document. A reference is an opaque filename, not a path.
export class FileCredentials {
  constructor(directory) { this.directory = resolve(directory); }
  async put(ref, value) {
    requireThat(/^[a-zA-Z0-9_-]{1,96}$/.test(ref) && uuid(value.walletId)
      && /^wk_[a-zA-Z0-9_-]{16,256}$/.test(value.apiKey), 'invalid_wallet_credentials');
    await mkdir(this.directory,{recursive:true,mode:0o700});
    requireThat(((await stat(this.directory)).mode&0o077)===0,'wallet_credential_directory_must_be_private');
    const file=await open(resolve(this.directory,ref+'.json'),'wx',0o600);
    try { await file.writeFile(JSON.stringify(value));await file.sync(); } finally { await file.close(); }
    // Registration may become fundable after this returns. Persist the new
    // directory entry too, before committing its ready binding in PostgreSQL.
    const directory=await open(this.directory,'r');
    try {await directory.sync();} finally {await directory.close();}
  }
  async get(ref) {
    requireThat(typeof ref === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(ref), 'invalid_credential_reference');
    const file = resolve(this.directory, ref + '.json'), info = await stat(file);
    requireThat(info.isFile() && (info.mode & 0o077) === 0, 'wallet_credentials_must_be_private');
    const value = JSON.parse(await readFile(file, 'utf8'));
    requireThat(uuid(value.walletId) && /^wk_[a-zA-Z0-9_-]{16,256}$/.test(value.apiKey), 'invalid_wallet_credentials');
    return value;
  }
}
export class OutLayer {
  constructor({ network, credentials, fetcher = fetch, origin, controlled = false }) {
    requireThat(NETWORKS[network], 'invalid_wallet_network');
    const url = new URL(origin ?? NETWORKS[network].origin);
    requireThat(url.origin === (origin ?? NETWORKS[network].origin) && !url.username && !url.password
      && (url.origin === NETWORKS[network].origin || (controlled && url.protocol === 'http:' && url.hostname === '127.0.0.1')), 'untrusted_outlayer_origin');
    Object.assign(this, { network, credentials, fetcher, origin: url.origin });
  }
  async request(ref, path, body, operationKey) {
    const secret = ref ? await this.credentials.get(ref) : null;
    const headers = { 'content-type': 'application/json', ...(secret ? { authorization: 'Bearer ' + secret.apiKey } : {}) };
    if (operationKey) headers['X-Idempotency-Key'] = operationKey;
    let response;
    try {
      response = await this.fetcher(this.origin + path, { method: body === undefined ? 'GET' : 'POST',
        headers, redirect: 'error', signal: AbortSignal.timeout(80_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new WalletError('wallet_transport_unknown'); }
    requireThat(response.body, 'wallet_empty_response_unknown');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new WalletError('wallet_response_limit_unknown'); }
      chunks.push(value);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new WalletError('wallet_invalid_response_unknown'); }
    // Never include upstream text or exception objects in logs: either can
    // contain credentials or request headers.
    if (!response.ok) {
      const code = ['policy_denied', 'wallet_frozen', 'onchain_tx_failed', 'invalid_api_key', 'operation_limit_reached'].includes(data.error)
        ? data.error : 'wallet_operation_unknown';
      throw new WalletError(code, { status: response.status, requestId: uuid(data.request_id) ? data.request_id : null,
        txHash: data.tx_hash ?? null, definiteRefusal: response.status === 403 && ['policy_denied', 'wallet_frozen'].includes(code) });
    }
    return data;
  }
  async identity(binding) {
    const secret = await this.credentials.get(binding.credentialRef);
    requireThat(secret.walletId === binding.walletId, 'wallet_credential_binding_mismatch');
    const data = await this.request(binding.credentialRef, '/wallet/v1/address?chain=near');
    const key = publicKey(data.public_key);
    requireThat(data.wallet_id === binding.walletId && data.chain === 'near' && data.address === binding.payer
      && data.asset_account_id == null && data.executor_account_id === binding.payer
      && key.hex === binding.payer && key.base58 === binding.publicKey, 'wallet_account_binding_mismatch');
    return data;
  }
  transfer(binding, transfer, key) {
    requireThat(uint(transfer.amount) > 0n && typeof transfer.to === 'string', 'invalid_native_transfer');
    return this.request(binding.credentialRef, '/wallet/v1/transfer', { to: transfer.to, amount: transfer.amount }, key);
  }
  register() { return this.request(null,'/register',{}); }
  status(binding, id) {
    requireThat(uuid(id), 'invalid_original_request_id');
    return this.request(binding.credentialRef, '/wallet/v1/requests/' + id);
  }
  sign(binding, payload) { return this.request(binding.credentialRef, '/wallet/v1/sign-message', payload); }
  encrypt(binding, policy) {
    return this.request(binding.credentialRef, '/wallet/v1/encrypt-policy', { wallet_id: binding.walletId, ...policy });
  }
  signPolicy(binding, encryptedData, caller) {
    return this.request(binding.credentialRef, '/wallet/v1/sign-policy', { encrypted_data: encryptedData, caller });
  }
}

export function paymentPolicy({ merchant, realm, maximumYocto }) {
  requireThat(/^[a-z0-9.-]{1,128}$/.test(realm) && uint(maximumYocto) > 0n, 'invalid_payment_policy');
  return { rules: { transaction_types: ['transfer'], allowed_tokens: ['native'],
    addresses: { mode: 'whitelist', list: [merchant] }, limits: { per_transaction: { native: maximumYocto } } },
  capabilities: Object.fromEntries(['raw_sign', 'swap', 'cross_chain_withdraw', 'limit_order', 'confidential', 'payment_check', 'intents_call', 'evm_sign', 'solana_sign']
    .map(name => [name, { allowed: false }]).concat([['sign_message', { allowed: true, allowed_recipients: [realm] }]])) };
}
export async function contractView(rpc, contract, method, args) {
  const value = await rpc.call('query', { request_type: 'call_function', account_id: contract,
    method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), finality: 'final' });
  requireThat(Array.isArray(value.result) && value.result.length <= 128 * 1024, 'invalid_policy_view');
  return JSON.parse(Buffer.from(value.result).toString('utf8'));
}
export async function verifyPolicy({ binding, rpc, api, contract = NETWORKS[rpc.network].contract }) {
  requireThat(binding.network === rpc.network && binding.policy?.controller && binding.policy.version > 0, 'policy_binding_required');
  await api.identity(binding);
  const policy = await contractView(rpc, contract, 'get_wallet_policy', { wallet_pubkey: 'ed25519:' + publicKey(binding.publicKey).hex });
  requireThat(policy && policy.owner === binding.policy.controller && policy.version === binding.policy.version
    && hash(policy.encrypted_data) === binding.policy.encryptedHash && policy.locked === false && policy.frozen === false, 'wallet_policy_changed_or_frozen');
  return policy;
}

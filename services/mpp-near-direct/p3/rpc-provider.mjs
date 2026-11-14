import { JsonRpcProvider } from 'near-api-js';
import { NearRpc } from '../near.mjs';
import { hash, requireThat } from '../contract.mjs';

// Retain the official transaction/query codec while using the trusted, bounded
// transport. The SDK's default fetch has no request timeout and retries sends;
// this adapter leaves retry/recovery to the original-operation journal.
export class BoundedNativeProvider extends JsonRpcProvider {
  constructor(rpc) { super({ url: rpc.url }, { retries: 1 }); this.rpc = rpc; }
  sendJsonRpc(method, params) { return this.rpc.call(method, params); }
}

// Acceptance reads can tolerate a transient public-RPC failure. Broadcasts are
// deliberately excluded: only the original-operation executor may retry them.
export class TestnetAcceptanceRpc extends NearRpc {
  constructor(store) { super({ url: 'https://archival-rpc.testnet.fastnear.com', network: 'testnet' }); this.store = store; }
  async transaction(txHash, payer) {
    if (!this.networkVerified) await this.call('status', []);
    return this.call('tx', { tx_hash: txHash, sender_account_id: payer, wait_until: 'FINAL' });
  }
  async call(method, params) {
    if (method !== 'status' && !this.networkVerified) await this.call('status', []);
    const reads = ['status', 'query', 'block', 'tx'];
    const historical = (method === 'tx' && params.wait_until === 'FINAL')
      || (method === 'block' && typeof params.block_id === 'string')
      || (method === 'query' && params.request_type === 'view_access_key' && typeof params.block_id === 'string');
    const cacheId = historical ? hash(['testnet', method, params]) : null;
    const cached = cacheId && this.store?.get('testnet-final-rpc', cacheId, 'testnet-rpc');
    if (cached) return cached.result;
    for (let attempt = 0; ; attempt++) {
      try {
        let result;
        if (method === 'status') {
          const response = await this.fetcher(this.url + '/status', { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12000) });
          requireThat(response.ok && response.body, 'rpc_unavailable_unknown');
          const chunks = []; let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length; requireThat(size <= 1024 * 1024, 'rpc_response_too_large_unknown'); chunks.push(chunk);
          }
          result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } else result = await super.call(method, params);
        if (method === 'status') { requireThat(result.chain_id === 'testnet', 'network_mismatch'); this.networkVerified = true; }
        const immutable = (method === 'tx' && result.final_execution_status === 'FINAL'
          && result.transaction?.hash === params.tx_hash && result.transaction?.signer_id === params.sender_account_id)
          || (method === 'block' && result.header?.hash === params.block_id)
          || (method === 'query' && result.block_hash === params.block_id);
        if (cacheId && immutable) this.store?.put('testnet-final-rpc', cacheId, 'testnet-rpc', { source: this.url, result });
        return result;
      }
      catch (error) {
        if (!reads.includes(method) || attempt >= 2 || error.message === 'network_mismatch') throw error;
        await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 250 : 750));
      }
    }
  }
}

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { NearRpc } from '../near.mjs';
import { requireThat, account, hash } from '../contract.mjs';

// Read-only: no signer, private-key loader, broadcaster or provider invocation.
export async function fundingPreflight(document, rpc) {
  requireThat(document.network === 'mainnet' && rpc.network === 'mainnet'
    && Array.isArray(document.wallets) && document.wallets.length === 3
    && document.wallets.every(w => ['merchant', 'agent-1', 'agent-2'].includes(w.role)
      && account.test(w.account) && w.fundNear === '0.01')
    && new Set(document.wallets.map(w => w.account)).size === 3
    && new Set(document.wallets.map(w => w.role)).size === 3, 'invalid_funding_plan');
  const status = await rpc.call('status', []);
  requireThat(status.chain_id === document.network, 'network_mismatch');
  const wallets = await Promise.all(document.wallets.map(async w => {
    try {
      const v = await rpc.call('query', { request_type: 'view_account', finality: 'final', account_id: w.account });
      requireThat(typeof v.amount === 'string' && /^\d+$/.test(v.amount)
        && typeof v.block_hash === 'string', 'invalid_native_balance');
      return { ...w, state: BigInt(v.amount) >= 10n ** 22n ? 'funded' : 'below_plan',
        balanceYocto: v.amount, blockHash: v.block_hash };
    } catch {
      // Missing account and RPC outage are both insufficient evidence. Never
      // infer a zero balance or safe-to-retry transfer from either response.
      return { ...w, state: 'unverified', balanceYocto: null, blockHash: null };
    }
  }));
  return { version: 1, network: document.network, planHash: hash(document), observedAtMs: Date.now(),
    wallets, funded: wallets.every(w => w.state === 'funded'),
    realPayments: 0, providerInvocations: 0, deploymentAttempted: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const document = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const rpc = new NearRpc({ url: 'https://rpc.mainnet.near.org', network: 'mainnet' });
  console.log(JSON.stringify(await fundingPreflight(document, rpc), null, 2));
}

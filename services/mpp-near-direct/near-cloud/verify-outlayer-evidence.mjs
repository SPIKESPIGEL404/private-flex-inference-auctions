// Fresh read-only RPC audit. Does not open wallet/API credential files or the
// financial database; no signing, broadcast, or provider invocation is possible.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Credential } from 'mppx';
import { auditEvidence } from './verify-evidence.mjs';
import { TestnetAcceptanceRpc } from '../p3/rpc-provider.mjs';
import { contractView, publicKey } from '../p3/outlayer.mjs';
import { hash, requireThat, uint } from '../contract.mjs';

export async function auditOutlayer(directory, rpc = new TestnetAcceptanceRpc()) {
  const cases = [];
  for (const id of ['agent-a', 'agent-b']) {
    const evidence = JSON.parse(readFileSync(join(directory, id + '-evidence.json'), 'utf8'));
    const raw = readFileSync(join(directory, id + '-response.sse')), binding = evidence.walletBinding;
    const credential = Credential.deserialize(evidence.paymentCredential);
    requireThat(binding.network === 'testnet' && binding.agentId === id && publicKey(binding.publicKey).hex === binding.payer
      && credential.challenge.request.payer === binding.payer && credential.challenge.request.refundTo === binding.payer
      && credential.payload.publicKey === binding.publicKey, 'independent_outlayer_wallet_binding_required');
    const audit = await auditEvidence(evidence, rpc);
    const answer = raw.toString('utf8').split(/\r?\n/).filter(line => line.startsWith('data:') && line.slice(5).trim().startsWith('{'))
      .flatMap(line => JSON.parse(line.slice(5)).choices ?? []).map(c => typeof c.delta?.content === 'string' ? c.delta.content : '').join('').trim();
    requireThat(hash(raw) === evidence.responseDigest && hash(raw) === evidence.order.financialReceipt.document.responseHash
      && answer === '4' && evidence.answer === answer && evidence.taskCompleted, 'task_response_audit_failed');
    requireThat(uint(audit.principal.P) + uint(audit.agentGasActualYocto) <= uint(evidence.agentBudgetYocto), 'agent_budget_audit_failed');
    const policy = await contractView(rpc, 'outlayer.testnet', 'get_wallet_policy', { wallet_pubkey: 'ed25519:' + binding.payer });
    requireThat(policy.owner === binding.policy.controller && policy.version === binding.policy.version && policy.frozen === true
      && policy.locked === false && hash(policy.encrypted_data) === binding.policy.encryptedHash, 'final_frozen_policy_audit_failed');
    cases.push({ agentId: id, accountId: binding.payer, walletId: binding.walletId, answer, taskCompleted: true,
      usage: evidence.usage, ...audit, budgetYocto: evidence.agentBudgetYocto, frozenPolicyVerified: true });
  }
  requireThat(new Set(cases.map(c => c.accountId)).size === 2 && new Set(cases.map(c => c.walletId)).size === 2
    && new Set(cases.map(c => c.paymentTxHash)).size === 2 && new Set(cases.map(c => c.refundTxHash)).size === 2, 'two_independent_cases_required');
  return { version: 1, scope: 'fresh-read-only-outlayer-cloud-chain-financial-and-task-audit', passed: true, network: 'testnet',
    rpcUrl: rpc.url, persistentRpcCache: false, agentPrivateKeysRead: 0, apiKeysRead: 0, broadcasts: 0, providerCalls: 0,
    providerInvoiceVerified: false, browserWalletIntegration: false, cases };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await auditOutlayer(process.argv[2]);
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
}

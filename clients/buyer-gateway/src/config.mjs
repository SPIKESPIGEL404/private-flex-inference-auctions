import { resolve } from 'node:path';
import { check } from './errors.mjs';
import { accountPattern } from './near.mjs';

export function configFromEnv(env = process.env) {
  const origin = env.BUYER_APP_ORIGIN ?? 'http://127.0.0.1:4173';
  const url = new URL(origin);
  check(url.origin === origin && (url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))), 'invalid_app_origin');
  check(/^[0-9a-f]{64}$/i.test(env.BUYER_STORAGE_KEY ?? ''), 'storage_key_required');
  const rpcUrl = env.NEAR_RPC_URL ?? 'https://rpc.mainnet.near.org';
  check(new URL(rpcUrl).protocol === 'https:', 'invalid_rpc_url');
  const apiUrl = env.NEAR_INTENTS_AGENT_API_URL ?? 'https://api.agentsonintents.com';
  check(new URL(apiUrl).protocol === 'https:', 'invalid_agent_api_url');
  const tokenContract = env.BUYER_TOKEN_CONTRACT ?? 'usdt.tether-token.near';
  // Initial rollout only accepts reviewed NEAR six-decimal stablecoins.
  check(['usdt.tether-token.near', '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'].includes(tokenContract), 'unsupported_funding_asset');
  const port = Number(env.PORT ?? '4180');
  check(Number.isInteger(port) && port > 0 && port <= 65535, 'invalid_port');
  if (env.BUYER_MERCHANT_ACCOUNT) check(accountPattern.test(env.BUYER_MERCHANT_ACCOUNT), 'invalid_merchant_account');
  if (env.BUYER_OWNER_TERMS_URL) check(new URL(env.BUYER_OWNER_TERMS_URL).protocol === 'https:', 'invalid_owner_terms_url');
  return { origin, port, host: env.HOST ?? '127.0.0.1', storageKey: Buffer.from(env.BUYER_STORAGE_KEY, 'hex'),
    dbPath: resolve(env.BUYER_DATABASE ?? '.state/buyer.sqlite'), rpcUrl, apiUrl,
    apiKey: env.NEAR_INTENTS_AGENT_API_KEY ?? '', apiConfigured: !!env.NEAR_INTENTS_AGENT_API_KEY,
    merchantAccount: env.BUYER_MERCHANT_ACCOUNT, tokenContract, assetId: `nep141:${tokenContract}`,
    ownerTermsUrl: env.BUYER_OWNER_TERMS_URL ?? null, outlayerTermsUrl: 'https://app.outlayer.ai/terms', acceptanceVersion: 'agent-wallet-setup-v1',
    symbol: tokenContract === 'usdt.tether-token.near' ? 'USDT' : 'USDC',
    fundingEnabled: env.BUYER_WALLET_FUNDING_ENABLED === '1',
    staticDir: resolve(env.BUYER_STATIC_DIR ?? '../market-playground/dist') };
}

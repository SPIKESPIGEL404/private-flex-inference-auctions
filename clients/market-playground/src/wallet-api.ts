import type { NearConnector, NearWalletBase, SignedMessage, EventMap, SignAndSendTransactionsParams } from '@hot-labs/near-connect';

export interface Owner { type: 'near'; account_id: string; public_key: string }
export interface GatewayConfig {
  configured: boolean; network: 'mainnet'; symbol: string; assetId: string; decimals: 6;
  maxBuyers: number; maxTotal: string; grantDays: number; merchantAccount: string | null;
  fundingEnabled: boolean; procurementReady: boolean; termsUrl: string;
  ownerTermsUrl: string | null; outlayerTermsUrl: string; acceptanceVersion: string;
}
export interface WalletBuyer {
  id: string; number: number; agentId: string | null; wallet: string | null;
  phase: 'create_pending' | 'grant_pending' | 'policy_pending' | 'funding_pending' | 'ready'; availableRaw: string;
  grantExpiresAt: string | null; operationStatus: string | null; failureCode: string | null;
  deposit: { correlationId: string; status: string; address: string | null; memo: string | null;
    minAmount: string | null; expiresAt: string | null; refundTo: string | null; failureCode: string | null } | null;
}
export interface Allocation {
  id: string; ownerAccount: string; ownerPublicKey: string; createdAt: string; assetId: string; symbol: string;
  totalRaw: string; perAgentRaw: string; remainderRaw: string; buyers: WalletBuyer[];
  fundingAttempt: { status: string; hashes: string[] } | null;
  fundingEnabled: boolean; procurementReady: boolean; ready: boolean;
}
interface Signing {
  buyerId: string; correlationId: string; type: 'agent_create' | 'grant_issue'; expiresAt: string;
  preview: { summary: string; policy?: unknown };
  intent: { standard: 'nep366'; payload: Parameters<NearWalletBase['signDelegateActions']>[0]['delegateActions'][number] }
    | { standard: 'nep413'; payload: { nonce: string; message: string; recipient: string } };
}
export interface WalletState {
  config: GatewayConfig | null; owner: Owner | null; allocations: Allocation[];
  busy: boolean; loading: boolean; message: string; error: string; signing: Signing | null;
}
const explanations: Record<string, string> = {
  gateway_not_configured: 'Wallet service is not configured by the host yet.',
  owner_key_not_full_access: 'Choose the full-access Ed25519 key in your NEAR wallet.',
  original_owner_key_required: 'Use the same wallet key that created these agents.',
  login_required: 'Connect your NEAR wallet to continue.',
  invalid_signature: 'The wallet signature could not be verified. Reconnect to try again.',
  wallet_funding_disabled: 'Funding is disabled for this release. No transfer was requested.',
  procurement_not_ready: 'Real inference procurement is not connected yet. No payment was made.',
  funding_already_started: 'A funding attempt already exists. Refresh its status; do not send again.',
  owner_intent_expired: 'This unsigned request expired. This release needs operator reconciliation before preparing a replacement.',
  allocation_conflict: 'This funding plan already exists with different inputs. Restore the saved plan.',
};
export class ApiError extends Error {
  constructor(readonly code: string) { super(explanations[code] ?? code.replaceAll('_', ' ')); }
}
export async function gateway<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch('/buyer-api' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    cache: 'no-store', redirect: 'error', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); }
  catch { throw new ApiError('wallet_service_unreachable'); }
  let value;
  try { value = await response.json(); } catch { throw new ApiError('wallet_service_unreachable'); }
  if (!response.ok) throw new ApiError(typeof value.error === 'string' ? value.error : 'wallet_service_error');
  return value as T;
}
export const tokenAmount = (raw: string) => `${BigInt(raw) / 1_000_000n}.${String(BigInt(raw) % 1_000_000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')}`;
const bytes = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));

// Only public wallet information is kept here. API keys and grant tokens have no
// frontend representation. The server cookie is HttpOnly and never read by JS.
export class WalletController {
  private state: WalletState = { config: null, owner: null, allocations: [], busy: false, loading: true, message: '', error: '', signing: null };
  private listeners = new Set<() => void>();
  private connector?: NearConnector;
  private stopRequested = false;
  private epoch = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(value: Partial<WalletState>) { this.state = { ...this.state, ...value }; for (const fn of this.listeners) fn(); }
  private allocation(plan: Allocation) {
    this.update({ allocations: [...this.state.allocations.filter(p => p.id !== plan.id), plan].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) });
  }
  async load() {
    const epoch = this.epoch;
    try {
      const [config, session] = await Promise.all([gateway<GatewayConfig>('/config'), gateway<{ owner: Owner | null; allocations: Allocation[] }>('/session')]);
      if (epoch === this.epoch) this.update({ config, ...session, error: '', loading: false });
    } catch (error) {
      if (epoch === this.epoch) this.update({ loading: false, error: error instanceof Error ? error.message : 'Wallet service unavailable.' });
    }
  }
  private async getConnector() {
    if (!this.connector) {
      const { NearConnector } = await import('@hot-labs/near-connect');
      this.connector = new NearConnector({ network: 'mainnet', autoConnect: false,
        features: { signInAndSignMessage: true, signDelegateActions: true, signMessage: true, signAndSendTransactions: true } });
      this.connector.on('wallet:signOut', () => { this.stopRequested = true; this.epoch++;
        this.update({ owner: null, allocations: [], signing: null }); void gateway('/auth/logout', {}).catch(() => {}); });
      this.connector.on('wallet:signIn', event => {
        if (this.state.owner && !event.accounts.some(account => account.accountId === this.state.owner?.account_id)) {
          this.stopRequested = true; this.epoch++;
          this.update({ owner: null, allocations: [], signing: null });
          void gateway('/auth/logout', {}).catch(() => {});
        }
      });
    }
    return this.connector;
  }
  private async action(message: string, fn: () => Promise<void>) {
    if (this.state.busy) return;
    this.update({ busy: true, message, error: '' });
    try { await fn(); }
    catch (error) { this.update({ error: error instanceof Error ? error.message : 'Wallet action failed.' }); }
    finally { this.update({ busy: false, message: '', signing: null }); }
  }
  async connect() {
    await this.action('Connecting and verifying your wallet…', async () => {
      const challenge = await gateway<{ message: string; recipient: string; nonce: string }>('/auth/challenge', {});
      const connector = await this.getConnector();
      let signed: SignedMessage | undefined;
      const handler = (event: EventMap['wallet:signInAndSignMessage']) => { signed = event.accounts[0]?.signedMessage; };
      connector.on('wallet:signInAndSignMessage', handler);
      try { await connector.connect({ signMessageParams: { ...challenge, nonce: bytes(challenge.nonce) } }); }
      finally { connector.off('wallet:signInAndSignMessage', handler); }
      if (!signed) throw new ApiError('wallet_did_not_sign_login');
      const result = await gateway<{ owner: Owner }>('/auth/verify', signed);
      this.epoch++; this.update({ owner: result.owner, allocations: [] });
      await this.load();
    });
  }
  async disconnect() {
    this.stopRequested = true; this.epoch++;
    this.update({ owner: null, allocations: [], signing: null });
    // End the server session even when the wallet extension refuses sign-out.
    try { await gateway('/auth/logout', {}); }
    catch { this.update({ error: 'Disconnected locally. The server session could not be closed; reconnect before continuing.' }); }
    finally { try { await this.connector?.disconnect(); } catch { /* Session is already closed. */ } }
  }
  stop() { this.stopRequested = true; }
  async refresh(id: string) {
    await this.action('Reconciling wallet state…', async () => { this.allocation(await gateway<Allocation>(`/allocations/${id}`)); });
  }
  async create(buyers: Array<{ id: string; number: number }>, total: string) {
    let planId: string | undefined;
    await this.action('Saving your allocation…', async () => {
      if (!this.state.owner) throw new ApiError('login_required');
      const storageKey = `private-market.plan.${this.state.owner.account_id}.${buyers.map(b => b.id).join('.')}.${total}`;
      let requestId = sessionStorage.getItem(storageKey);
      if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem(storageKey, requestId); }
      const plan = await gateway<Allocation>('/allocations', { requestId, buyers, total, acceptance: this.state.config?.acceptanceVersion });
      this.allocation(plan); planId = plan.id;
    });
    if (planId) await this.authorize(planId);
  }
  private async wallet(owner: Owner) {
    const { wallet, accounts } = await (await this.getConnector()).getConnectedWallet();
    if (!accounts.some(account => account.accountId === owner.account_id)) throw new ApiError('connect_original_wallet');
    return wallet;
  }
  async authorize(id: string) {
    await this.action('Preparing wallet authorization…', async () => {
      const owner = this.state.owner, epoch = this.epoch;
      if (!owner) throw new ApiError('login_required');
      this.stopRequested = false;
      const wallet = await this.wallet(owner);
      this.allocation(await gateway<Allocation>(`/allocations/${id}/recover`, {}));
      for (let step = 0; step < 180 && !this.stopRequested && epoch === this.epoch; step++) {
        const result = await gateway<{ plan: Allocation; signing: Signing | null }>(`/allocations/${id}/prepare`, {});
        if (epoch !== this.epoch) return;
        this.allocation(result.plan);
        if (result.plan.buyers.every(buyer => ['funding_pending', 'ready'].includes(buyer.phase))) return;
        if (!result.signing) {
          this.update({ message: 'Waiting for the signed operation to settle…' });
          await new Promise(resolve => setTimeout(resolve, 1500)); continue;
        }
        const signing = result.signing;
        this.update({ signing, message: `Confirm ${signing.type === 'agent_create' ? 'wallet creation' : 'payment authorization'} in your wallet…` });
        let proof: { signature: string } | { signedDelegate: string };
        if (signing.intent.standard === 'nep366') {
          const signed = await wallet.signDelegateActions({ signerId: owner.account_id, delegateActions: [signing.intent.payload] });
          proof = { signedDelegate: signed.signedDelegateActions[0] };
        } else {
          const payload = signing.intent.payload;
          const signed = await wallet.signMessage({ ...payload, nonce: bytes(payload.nonce), signerId: owner.account_id });
          if (signed.publicKey !== owner.public_key || signed.accountId !== owner.account_id) throw new ApiError('original_owner_key_required');
          proof = { signature: signed.signature };
        }
        if (epoch !== this.epoch) return;
        // The backend saves this exact signature before forwarding it upstream.
        this.allocation(await gateway<Allocation>(`/allocations/${id}/submit`, { buyerId: signing.buyerId, correlationId: signing.correlationId, ...proof }));
        this.update({ signing: null });
      }
    });
  }
  async prepareDeposits(id: string) {
    await this.action('Preparing deposit addresses…', async () => { this.allocation(await gateway<Allocation>(`/allocations/${id}/deposits`, {})); });
  }
  async fund(id: string) {
    await this.action('Confirm the transfers in your wallet…', async () => {
      const owner = this.state.owner, epoch = this.epoch;
      if (!owner) throw new ApiError('login_required');
      const wallet = await this.wallet(owner);
      const funding = await gateway<{ attemptId: string; transactions: SignAndSendTransactionsParams['transactions'] }>(`/allocations/${id}/funding`, { acceptance: this.state.config?.acceptanceVersion });
      let hashes: string[] = [];
      try {
        const outcomes = await wallet.signAndSendTransactions({ signerId: owner.account_id, transactions: funding.transactions });
        hashes = outcomes.map(outcome => outcome.transaction.hash);
      } finally {
        if (epoch === this.epoch) {
          // Empty hashes mean an unresolved attempt, never permission to resend.
          this.allocation(await gateway<Allocation>(`/allocations/${id}/funding-report`, { attemptId: funding.attemptId, hashes }));
        }
      }
      if (epoch === this.epoch) this.allocation(await gateway<Allocation>(`/allocations/${id}`));
    });
  }
}

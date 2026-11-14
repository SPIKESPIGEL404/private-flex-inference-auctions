import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Buyer } from './model';
import { parseBudget } from './model';
import { tokenAmount, WalletController } from './wallet-api';

export function WalletSetup({ controller, buyers, onClose }: { controller: WalletController; buyers: Buyer[]; onClose: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [total, setTotal] = useState('0.30');
  const [consent, setConsent] = useState(false);
  const [fundConsent, setFundConsent] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => () => controller.stop(), [controller]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    // Wallet connectors mount their own popup outside this dialog. A native
    // modal makes that popup inert, so yield the top layer while signing.
    element.close();
    if (state.busy) element.show(); else element.showModal();
  }, [state.busy]);
  const plan = state.allocations.at(-1);
  const parsed = parseBudget(total);
  const each = parsed ? Math.floor(parsed / buyers.length) : 0;
  const authorized = plan?.buyers.every(buyer => ['funding_pending', 'ready'].includes(buyer.phase));
  const depositsReady = plan?.buyers.every(buyer => buyer.deposit?.address && buyer.deposit.status === 'PENDING_DEPOSIT');
  return <><div className="wallet-backdrop" aria-hidden="true" />
    <dialog className="wallet-dialog" ref={dialog} aria-labelledby="wallet-title" onCancel={() => { controller.stop(); onClose(); }}>
    <div className="dialog-heading"><h1 id="wallet-title">agent wallets</h1>
      <button className="close-button" aria-label="Close wallet setup" onClick={() => { controller.stop(); onClose(); }}>×</button></div>
    <p className="wallet-notice">Wallet setup is available in this release. Inference procurement is still being connected; run and funding are disabled by default.</p>
    {!state.owner ? <>
      <p>Connect your NEAR wallet to own each agent and approve its spending rules. Your wallet keeps your private key.</p>
      <button className="solid-button" disabled={state.busy || state.loading} onClick={() => void controller.connect()}>connect NEAR wallet</button>
    </> : <>
      <div className="wallet-owner"><span>owner</span><span>{state.owner.account_id}</span></div>
      {!plan ? <form onSubmit={event => { event.preventDefault(); if (consent && each > 0) void controller.create(buyers.map(({ id, number }) => ({ id, number })), total); }}>
        <label htmlFor="wallet-total">total principal <span>{state.config?.symbol ?? 'stablecoin'} · NEAR</span></label>
        <input id="wallet-total" value={total} onChange={event => setTotal(event.target.value)} inputMode="decimal" required />
        <dl className="key-list"><dt>independent wallets</dt><dd>{buyers.length}</dd>
          <dt>principal per agent</dt><dd>{tokenAmount(String(each))} {state.config?.symbol}</dd>
          <dt>remainder in your wallet</dt><dd>{tokenAmount(String(parsed ? parsed - each * buyers.length : 0))}</dd>
          <dt>authorization expires</dt><dd>7 days</dd>
          <dt>payment recipient</dt><dd className="break-word">{state.config?.merchantAccount ?? 'not configured'}</dd></dl>
        <p>Each agent may pay the displayed Market recipient or withdraw to your owner account, within its signed cap. Each creation and authorization needs its own signature. Gas and any token storage are additional.</p>
        <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
          <span>I accept the spending rules, <a href={state.config?.ownerTermsUrl ?? undefined} target="_blank" rel="noreferrer">Owner Terms ↗</a> and <a href={state.config?.outlayerTermsUrl} target="_blank" rel="noreferrer">OutLayer Terms ↗</a>.
            This is an experimental mainnet beta; all funds or access may be lost.</span></label>
        <div className="dialog-footer"><button className="solid-button" disabled={!consent || each <= 0 || state.busy || !state.config?.configured}>prepare wallets</button></div>
      </form> : <>
        <dl className="key-list"><dt>total principal</dt><dd>{tokenAmount(plan.totalRaw)} {plan.symbol}</dd>
          <dt>principal per agent</dt><dd>{tokenAmount(plan.perAgentRaw)} {plan.symbol}</dd>
          <dt>remainder retained</dt><dd>{tokenAmount(plan.remainderRaw)} {plan.symbol}</dd></dl>
        <ol className="wallet-progress">{plan.buyers.map(buyer => <li key={buyer.id}>
          <div><strong>buyer-{String(buyer.number).padStart(2, '0')}</strong><span>{buyer.phase.replaceAll('_', ' ')}</span></div>
          <small>{buyer.wallet ?? buyer.agentId ?? 'not created'}</small>
          <small>available: {tokenAmount(buyer.availableRaw)} {plan.symbol}</small>
          {buyer.operationStatus && <small>{buyer.operationStatus}{buyer.failureCode ? ` · ${buyer.failureCode}` : ''}</small>}
          {buyer.deposit && <small>deposit: {buyer.deposit.status} · {buyer.deposit.address ?? 'address pending'}</small>}
        </li>)}</ol>
        {state.signing && <details open className="wallet-preview"><summary>{state.signing.preview.summary}</summary>
          <pre>{JSON.stringify(state.signing.preview.policy ?? state.signing.intent.payload, null, 2)}</pre></details>}
        {plan.fundingAttempt && <p>Funding was requested. Refresh to reconcile chain and deposit state. Do not send the same allocation again. Closing or cancelling a wallet prompt does not prove that no transaction was sent.</p>}
        {plan.fundingEnabled && authorized && !plan.fundingAttempt && <>
          <p>Funding is enabled by the host. This release cannot buy inference and has no withdrawal UI. Failed route refunds go to the agent balance.</p>
          <label className="checkbox-label"><input type="checkbox" checked={fundConsent} onChange={event => setFundConsent(event.target.checked)} />
            <span>I accept the Owner and OutLayer Terms and the experimental mainnet risk of losing funds or access. I want to fund these wallets, including the gas and storage shown by my wallet.</span></label>
        </>}
        <div className="dialog-footer wallet-actions">
          <button className="outline-button" disabled={state.busy} onClick={() => void controller.refresh(plan.id)}>refresh status</button>
          {!authorized && <button className="solid-button" disabled={state.busy} onClick={() => void controller.authorize(plan.id)}>continue authorization</button>}
          {authorized && !plan.fundingEnabled && <button className="solid-button" disabled>funding disabled</button>}
          {authorized && plan.fundingEnabled && !plan.fundingAttempt && (!depositsReady
            ? <button className="solid-button" disabled={state.busy || !fundConsent} onClick={() => void controller.prepareDeposits(plan.id)}>prepare deposits</button>
            : <button className="solid-button" disabled={state.busy || !fundConsent} onClick={() => void controller.fund(plan.id)}>fund {plan.buyers.length} wallets</button>)}
        </div>
      </>}
      <p className="wallet-session-note">Disconnecting ends this web session. It pauses new purchases; it does not revoke existing grants.</p>
    </>}
    {state.message && <p role="status">{state.message}</p>}
    {state.busy && <button className="preview-link" onClick={() => controller.stop()}>stop after current operation</button>}
    {state.error && <p className="form-error" role="alert">{state.error}</p>}
    {!state.config?.configured && !state.loading && <p className="form-error">The host must configure the wallet gateway and Market recipient before creating agents.</p>}
  </dialog></>;
}

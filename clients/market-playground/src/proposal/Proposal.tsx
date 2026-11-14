import {useEffect, useRef, useState} from 'react';
import {SiteHeader} from '../SiteHeader';
import './proposal.css';

const source = 'https://github.com/SPIKESPIGEL404/private-flex-inference-auctions';
const comparisonEvidence = `${source}/blob/febd7ec4c24c9aff343e185578b7f948a53b1266/docs/acceptance/2026-11-14-chutes-live.md`;
const modes = [
  {id: 'save', label: 'Save', deadline: 60, description: 'Allow more time. Select the lowest eligible service price.'},
  {id: 'balanced', label: 'Balanced', deadline: 25, description: 'Keep the next task step moving, within the same model contract.'},
  {id: 'urgent', label: 'Finish sooner', deadline: 10, description: 'Prefer an earlier estimated result. Model requirements and the cap still apply.'},
] as const;
// Synthetic inputs for an explanatory UI, not claims about a real provider.
const offers = [
  {id: 'different', name: 'Smaller model', cost: 4, seconds: 5, identityMatches: false, evidenceMeetsPolicy: false},
  {id: 'claim', name: 'Name-only claim', cost: 6, seconds: 8, identityMatches: true, evidenceMeetsPolicy: false},
  {id: 'qualified-a', name: 'Qualified route A', cost: 12, seconds: 18, identityMatches: true, evidenceMeetsPolicy: true},
  {id: 'qualified-b', name: 'Qualified route B', cost: 24, seconds: 6, identityMatches: true, evidenceMeetsPolicy: true},
];
const deliveries = [
  {id: 'matching', label: 'Matching delivery'},
  {id: 'swapped', label: 'Wrong response binding'},
  {id: 'missing', label: 'Missing evidence'},
] as const;

function DecisionExplorer() {
  const [mode, setMode] = useState<(typeof modes)[number]['id']>('balanced');
  const [cap, setCap] = useState(30);
  const [delivery, setDelivery] = useState<(typeof deliveries)[number]['id']>('matching');
  const policy = modes.find(item => item.id === mode)!;
  const selected = offers.find(offer => offer.identityMatches && offer.evidenceMeetsPolicy
    && offer.cost <= cap && offer.seconds <= policy.deadline);
  const acceptance = !selected ? 'No purchase to accept.' : delivery === 'swapped' ? 'Reject the delivered response.'
    : delivery === 'missing' ? 'Pending evidence. Do not accept.' : 'Accept under the illustrated policy.';

  return <div className="p-explorer">
    <div className="p-explorer-top"><span>MODEL CONTRACT → PURCHASE → ACCEPTANCE</span><span className="p-tag">Synthetic example</span></div>
    <div className="p-example-contract"><strong>Fixed model contract</strong><p>Qwen3.8-27B · pinned revision · FP8 · complete effective input · required evidence and response binding.</p>
      <small>Quotes and policy verdicts below are synthetic. This page runs no live attestation or model verification.</small></div>
    <div className="p-explorer-controls">
      <fieldset className="p-preferences"><legend>01 / Set the agent’s preference</legend>
        <div className="p-segment">{modes.map(item => <button key={item.id} type="button" aria-pressed={mode === item.id} onClick={() => setMode(item.id)}>{item.label}</button>)}</div>
        <p>{policy.description}</p>
      </fieldset>
      <div className="p-budget"><label htmlFor="quote-cap">02 / Service cap for this call <output htmlFor="quote-cap">${(cap / 1000).toFixed(3)}</output></label>
        <input id="quote-cap" type="range" min="4" max="30" step="1" value={cap} onChange={event => setCap(Number(event.target.value))} aria-valuetext={`$${(cap / 1000).toFixed(3)}`} />
        <div className="p-range-labels"><span>$0.004</span><span>$0.030</span></div>
      </div>
    </div>
    <div className="p-quote-table"><table><caption>Model identity and required evidence qualify supply before cost and timing are compared.</caption>
      <thead><tr><th scope="col">Illustrative supply</th><th scope="col">Call price</th><th scope="col">Est. complete</th><th scope="col">Decision</th></tr></thead>
      <tbody>{offers.map(offer => {
        const chosen = selected === offer;
        const reason = !offer.identityMatches ? 'Wrong model' : !offer.evidenceMeetsPolicy ? 'Insufficient evidence'
          : offer.cost > cap ? 'Over budget' : offer.seconds > policy.deadline ? 'Too late' : chosen ? 'Selected' : 'Eligible';
        return <tr key={offer.id} className={chosen ? 'p-chosen' : ''}><th scope="row"><span className="p-quote-dot" />{offer.name}</th><td>${(offer.cost / 1000).toFixed(3)}</td><td>~{offer.seconds}s</td><td>{chosen ? '↳ ' : ''}{reason}</td></tr>;
      })}</tbody></table></div>
    <div className="p-decision" role="status" aria-live="polite"><span className={selected ? 'p-indicator' : 'p-indicator p-idle'} />
      <div><strong>{selected ? `Select ${selected.name.replace('Qualified', 'qualified')} at $${(selected.cost / 1000).toFixed(3)}.` : 'No eligible quote. Wait or stop.'}</strong>
        <p>{selected ? `Illustrated policy passes first; then apply the $${(cap / 1000).toFixed(3)} cap and ${policy.deadline}s estimate threshold.` : 'A lower price or greater urgency cannot authorize a different model or missing evidence.'}</p></div>
    </div>
    <fieldset className="p-delivery"><legend>03 / Inspect an illustrative delivery</legend>
      <div className="p-segment">{deliveries.map(item => <button key={item.id} type="button" disabled={!selected} aria-pressed={delivery === item.id} onClick={() => setDelivery(item.id)}>{item.label}</button>)}</div>
      <div className={`p-acceptance ${selected && delivery === 'matching' ? 'p-acceptance-match' : ''}`} role="status" aria-live="polite"><span className="p-indicator p-idle" /><div><strong>{acceptance}</strong><p>{!selected ? 'The model contract stays fixed while the agent waits.' : delivery === 'swapped' ? 'The delivered result is not bound to the purchased request. A valid quote or payment receipt cannot repair this mismatch.' : delivery === 'missing' ? 'Qualification before purchase does not replace the required evidence for the delivered result.' : 'The fixture supplies the required delivery binding. This simulated verdict does not establish model fidelity for either real deployment.'}</p></div></div>
    </fieldset>
    <p className="p-footnote">Hypothetical service prices exclude payment gas; timing estimates are not guarantees. The example makes no provider calls or payments and does not implement settlement or refunds.</p>
  </div>;
}

export default function Proposal({active, address}: {active: boolean; address: string}) {
  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active || !location.hash) return;
    let id: string;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const target = document.getElementById(id);
    if (target && content.current?.contains(target)) target.scrollIntoView({block: 'start'});
  }, [active, address]);

  return <div className="app-shell proposal">
    <a className="p-skip" href="#thesis">Skip to proposal</a>
    <header className="app-header"><SiteHeader view="proposal"><span className="preview-link">NEAR hackathon</span></SiteHeader>
      <div className="sessionbar proposal-sections"><span className="session-name">[proposal]</span>
        <nav aria-label="Proposal sections"><a href="#thesis">overview</a><a href="#contract">contract</a><a href="#decision">purchase</a><a href="#evidence">evidence</a><a href="#near">NEAR</a><a href="#roadmap">roadmap</a></nav>
      </div>
    </header>
    <main className="proposal-content" ref={content} tabIndex={-1} aria-label="Proposal">
      <div className="proposal-document">
      <section className="p-hero" id="thesis" aria-labelledby="proposal-title">
        <div className="p-eyebrow"><span className="p-indicator" />NEAR HACKATHON / MODEL FIDELITY<span className="p-draft">Product thesis · scoped prototype</span></div>
        <h1 id="proposal-title">Let agents buy inference<br /><span>they can verify.</span></h1>
        <div className="p-hero-bottom"><p>Agents optimize <em>cost and timing within an explicit model contract.</em> The owner fixes the model requirements and the evidence needed for acceptance.</p>
          <a href="#decision" className="solid-button p-primary">Explore a purchase <span aria-hidden="true">↓</span></a></div>
        <div className="p-hero-line"><span>THE THESIS</span><p>Autonomous procurement should preserve model fidelity from authorization through delivery.</p></div>
      </section>

      <section className="p-section p-system" id="contract" aria-labelledby="contract-title">
        <div className="p-section-heading"><span className="p-index">01 / THE MODEL PROMISE</span><h2 id="contract-title">The model contract<br />comes first.</h2><p>An autonomous buyer needs more than an attractive price. It needs a way to establish that the purchased inference meets its authorized model and execution requirements.</p></div>
        <div className="p-contract-grid">
          <article><span>IDENTITY</span><h3>Which model?</h3><p>Specify the permitted model, revision, quantization and any adapters.</p></article>
          <article><span>EXECUTION</span><h3>Under which rules?</h3><p>Bind effective input, context handling, generation parameters and allowed conversions.</p></article>
          <article><span>EVIDENCE</span><h3>What must be checked?</h3><p>Fix the evidence policy and its trust assumptions before choosing supply.</p></article>
          <article><span>DELIVERY</span><h3>Which result?</h3><p>Bind the actual returned response to the purchased request and its stated coverage.</p></article>
        </div>
        <ol className="p-flow p-contract-flow">
          <li><span className="p-step">01</span><h3>Define the contract</h3><p>The owner authorizes model requirements, evidence, task budget and time limits.</p><span className="p-flow-code">requirements stay explicit</span></li>
          <li><span className="p-step">02</span><h3>Qualify supply</h3><p>Check identity and the required evidence. Exclude incompatible or unsupported offers.</p><span className="p-flow-code">fidelity before comparison</span></li>
          <li><span className="p-step">03</span><h3>Procure within limits</h3><p>Choose, wait, revise the bid or stop. Preserve the authorized model and privacy policy.</p><span className="p-flow-code">cost × time within policy</span></li>
          <li><span className="p-step">04</span><h3>Accept the delivery</h3><p>Check the returned result and required binding before reporting policy acceptance.</p><span className="p-flow-code">evidence follows the result</span></li>
        </ol>
        <p className="p-caption">Model names, payment receipts and deployment attestations each carry specific claims. Acceptance must follow the actual evidence policy. Model fidelity does not guarantee a factually correct answer or a successful task.</p>
      </section>

      <section className="p-section" id="decision" aria-labelledby="decision-title">
        <div className="p-section-heading"><span className="p-index">02 / EXPLORE PROCUREMENT AND ACCEPTANCE</span><h2 id="decision-title">Optimize the purchase.<br />Preserve the model promise.</h2><p>Lower the budget, increase urgency or change the delivery scenario. The required model and evidence remain fixed throughout.</p></div>
        <DecisionExplorer />
      </section>

      <section className="p-section" id="evidence" aria-labelledby="evidence-title">
        <div className="p-section-heading"><span className="p-index">03 / CURRENT PATHS AND EVIDENCE</span><h2 id="evidence-title">Existing NEAR APIs.<br />A GPU TEE comparison.</h2><p>We use NEAR’s existing inference API and a separately deployed GPU TEE model as two paths for studying procurement and its verification boundaries. Their evidence has separate scopes.</p></div>
        <div className="p-benefits p-paths">
          <article><span className="p-product">NEAR AI / EXISTING API</span><h3>Compatibility with<br />available inference.</h3><p>Recorded native NEAR AI calls demonstrate API procurement with test-credit buyers. We currently assume access to the existing inference API only.</p>
            <ul><li><strong>Available today.</strong> Native model calls, original usage and provider invoice records.</li><li><strong>Evidence by policy.</strong> Evaluate the route’s actual deployment and response evidence for the buyer’s requirements.</li><li><strong>Current integration.</strong> NEAR-side market quotes, scheduling priority and cache control are future collaboration work.</li></ul>
            <a href={`${source}/blob/main/docs/acceptance/2026-11-11-market-batch-c.md`} target="_blank" rel="noreferrer">Recorded API acceptance ↗</a>
          </article>
          <article><span className="p-product">SELF-DEPLOYED / GPU TEE</span><h3>A controlled model<br />comparison path.</h3><p>The recorded Chutes deployment pins Qwen3.8-27B-FP8 and checks hardware evidence and an encrypted invocation path.</p>
            <ul><li><strong>Recorded checks.</strong> CPU/GPU attestation, encrypted native frames and model revision metadata.</li><li><strong>Identity assumption.</strong> The association with the model revision comes from the authenticated provider control plane.</li><li><strong>Remaining binding.</strong> Independently proving loaded weights and a complete per-request model execution receipt remains outstanding.</li></ul>
            <a href={comparisonEvidence} target="_blank" rel="noreferrer">Scoped deployment record ↗</a>
          </article>
        </div>
        <div className="p-evidence-note"><strong>Evidence is scoped to its recorded release.</strong><p>The GPU TEE record is a historical live run, not live acceptance of every subsequent build. The integrated agent demonstration uses real task runtimes and tools with fixture model replies and chain receipts. These records do not establish one connected, funded agent loop with complete model fidelity.</p></div>
        <p className="p-caption">Hardware attestation, encrypted transport, model identity and response binding should remain distinct in the UI. An unavailable required check stays unverified. Full arithmetic inference proofs remain separate R&D.</p>
      </section>

      <section className="p-section" id="near" aria-labelledby="near-title">
        <div className="p-section-heading"><span className="p-index">04 / BENEFITS FOR NEAR</span><h2 id="near-title">Trusted supply for Cloud.<br />Bounded delegation in Gateway.</h2><p>The proposed integration connects autonomous demand to model requirements that buyers can inspect and enforce through an explicit acceptance policy.</p></div>
        <div className="p-benefits">
          <article><span className="p-product">NEAR AI CLOUD</span><h3>Become eligible supply<br />for autonomous buyers.</h3><p>Agents can purchase within a model contract and an owner’s limits. NEAR could natively expose the model identity and evidence those buyers require.</p>
            <ul><li><strong>Demand with explicit requirements.</strong> Keep model fidelity, cost, timing and privacy attached to each purchase.</li><li><strong>A native next step.</strong> Connect model/deployment identity, request/response evidence and procurement terms inside Cloud.</li><li><strong>Allocation experiments.</strong> Later test priority and cache-aware serving with NEAR-controlled admission. Measure revenue and efficiency benefits.</li></ul>
            <a href="https://near.ai/" target="_blank" rel="noreferrer">Cloud today ↗</a>
          </article>
          <article><span className="p-product">NEAR AI GATEWAY</span><h3>Delegate the purchase.<br />Keep the model requirements.</h3><p>A future Gateway integration could bring the owner’s model policy and task budget into the coding tools they already use.</p>
            <ul><li><strong>Policy-preserving choices.</strong> Optimize among authorized models and routes; obtain new authorization for changes outside that scope.</li><li><strong>Task-wide pacing.</strong> Manage spend across exploration, tools, retries and final verification; retain budget for later steps.</li><li><strong>Inspectable acceptance.</strong> Explain supply eligibility, what was checked and why a delivery is accepted, pending or rejected.</li></ul>
            <a href="https://gateway.near.ai/" target="_blank" rel="noreferrer">Gateway today ↗</a>
          </article>
        </div>
        <div className="p-integration"><span>PROPOSED PROCUREMENT PATH</span><p>Owner’s model contract <b>→</b> Gateway + agent buyer <b>→</b> our MPP Proxy / Market <b>→</b> eligible inference <b>→</b> delivery acceptance</p><small>Gateway product integration is proposed. Upstream NEAR AI requests retain existing credentials and account billing; native NEAR payments in our design go to our merchant.</small></div>
        <div className="p-payment-heading"><span className="p-product">FUNDING AND PAYMENT DESIGN</span><span className="p-tag">Live qualification pending</span></div>
        <ol className="p-payments"><li><span>FUND</span><h3>Prepare each agent</h3><p>Use supported Intents/1Click routes during setup or authorized replenishment to fund its NEAR account.</p></li><li><span>BUY</span><h3>Purchase within authority</h3><p>The agent pays our merchant native NEAR principal and payment gas. The payment receipt retains its financial meaning.</p></li><li><span>RECOVER</span><h3>Preserve the original order</h3><p>Reconcile usage and unresolved payments. Refund unused principal under the order terms; the merchant pays refund gas.</p></li></ol>
        <p className="p-caption">A private Market also protects purchase limits, balances and order conditions. Confidentiality supports the transaction; model fidelity supplies the acceptance requirements.</p>
      </section>

      <section className="p-section p-test" id="roadmap" aria-labelledby="roadmap-title">
        <span className="p-index">05 / THE COLLABORATION PATH</span>
        <div className="p-test-heading"><h2 id="roadmap-title">Prove the purchase.<br /><span>Bring the model contract to NEAR.</span></h2><p>Use today’s API and GPU TEE comparison to establish requirements and expose evidence gaps. The next collaboration is native support inside NEAR AI.</p></div>
        <ol className="p-roadmap">
          <li><span>01 / CURRENT WORK</span><h3>Procurement and comparison</h3><p>Existing NEAR API access, the separate GPU TEE deployment and controlled agent tooling each retain their recorded acceptance scope.</p></li>
          <li><span>02 / NEXT VALIDATION</span><h3>Complete the qualified loop</h3><p>Qualify native payments and real model tasks. Define supported fidelity policies and close the required model/result bindings; leave stronger unsupported policies unverified.</p></li>
          <li><span>03 / WITH NEAR</span><h3>Native model contracts</h3><p>Expose model and deployment identity, response evidence and purchasable service terms. Then evaluate priority allocation and cache reuse where Cloud controls execution.</p></li>
        </ol>
        <div className="p-metrics"><div><span>FIDELITY</span><h3>Correct qualification and acceptance</h3><p>Reject wrong model/revision/quantization, altered effective input and unrelated delivery evidence under the selected policy.</p></div><div><span>AGENT VALUE</span><h3>Cost and useful task completion</h3><p>Track task-wide spend, gas, failed attempts and time to usable results; assess answer quality separately.</p></div><div><span>CLOUD EXPERIMENT</span><h3>Value-aware allocation</h3><p>Hold model contracts fixed. Compare priority outcomes, cache reuse and serving overhead; measure provider economics separately.</p></div></div>
        <p className="p-question">The question for NEAR: can model fidelity become an enforceable condition of autonomous procurement, alongside better allocation of inference capacity?</p>
        <p className="p-pilot">Future allocation experiments should compare arrival order, cache-only order, bid-only order and cache-aware bidding. Under light load, avoid unnecessary batching delay. Model fidelity and authorized cache sharing remain constraints throughout.</p>
      </section>

      <section className="p-closing"><span className="p-index">BUILD WITH US</span><h2>Let agents optimize the purchase.<br />Make the model promise enforceable.</h2><div><a className="solid-button p-primary" href="/">Open the playground <span aria-hidden="true">↗</span></a><a href={`${source}/blob/main/docs/specs/2026-11-14-agent-mpp-inference-integration.md`} target="_blank" rel="noreferrer">Read the integration contract ↗</a></div><p>An independent BitRouter hackathon proposal. Gateway integration and NEAR-native market support are proposed.</p></section>
    <footer className="p-footer"><span>private market / bitrouter</span><span>NEAR HACKATHON · NOV 2026</span><a href="#thesis">Back to thesis ↑</a></footer>
      </div>
    </main>
  </div>;
}

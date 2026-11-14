import {useState} from 'react';
import './proposal.css';

const source = 'https://github.com/SPIKESPIGEL404/private-flex-inference-auctions';
const modes = [
  {id: 'save', label: 'Save', deadline: 60, description: 'Allow more time. Choose the lowest eligible quote.'},
  {id: 'balanced', label: 'Balanced', deadline: 25, description: 'Keep the next tool step moving, within the same spending cap.'},
  {id: 'urgent', label: 'Finish sooner', deadline: 10, description: 'Require an earlier estimated result. The budget still comes first.'},
] as const;
const offers = [
  {name: 'Flexible', cost: 6, seconds: 45},
  {name: 'Standard', cost: 12, seconds: 18},
  {name: 'Available now', cost: 24, seconds: 6},
];

function DecisionExplorer() {
  const [mode, setMode] = useState<(typeof modes)[number]['id']>('balanced');
  const [cap, setCap] = useState(30);
  const policy = modes.find(item => item.id === mode)!;
  const selected = offers.find(offer => offer.cost <= cap && offer.seconds <= policy.deadline);

  return <div className="p-explorer">
    <div className="p-explorer-top"><span>PROCUREMENT SANDBOX</span><span className="p-tag">Illustrative quotes</span></div>
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
    <div className="p-quote-table"><table><caption>Same hypothetical model and bounded request. Private routes only.</caption><thead><tr><th scope="col">Supply quote</th><th scope="col">Call price</th><th scope="col">Est. complete</th><th scope="col">Decision</th></tr></thead>
      <tbody>{offers.map(offer => {
        const chosen = selected === offer;
        const reason = offer.cost > cap ? 'Over budget' : offer.seconds > policy.deadline ? 'Too late' : chosen ? 'Selected' : 'Eligible';
        return <tr key={offer.name} className={chosen ? 'p-chosen' : ''}><th scope="row"><span className="p-quote-dot" />{offer.name}</th><td>${(offer.cost / 1000).toFixed(3)}</td><td>~{offer.seconds}s</td><td>{chosen ? '↳ ' : ''}{reason}</td></tr>;
      })}</tbody></table></div>
    <div className="p-decision" role="status" aria-live="polite"><span className={selected ? 'p-indicator' : 'p-indicator p-idle'} />
      <div><strong>{selected ? `Select ${selected.name.toLowerCase()} at $${(selected.cost / 1000).toFixed(3)}.` : 'No eligible quote. Wait or stop.'}</strong>
        <p>{selected ? `Lowest price within the $${(cap / 1000).toFixed(3)} cap and ${policy.deadline}s estimate threshold.` : 'Urgency cannot increase the cap or relax the private-route requirement.'}</p></div>
    </div>
    <p className="p-footnote">Hypothetical service prices, excluding payment gas. Estimates are not delivery guarantees. This policy illustration makes no provider calls or payments.</p>
  </div>;
}

export default function Proposal() {
  return <div className="proposal">
    <a className="p-skip" href="#thesis">Skip to proposal</a>
    <header className="p-header"><a href="/" className="p-brand" aria-label="Private Market home"><span aria-hidden="true">↗</span> private market<span className="p-brand-by">/ bitrouter</span></a>
      <nav aria-label="Main navigation"><a href="/">playground</a><a href="/proposal" aria-current="page">proposal</a><a href={source} target="_blank" rel="noreferrer">source ↗</a></nav>
    </header>
    <main id="thesis">
      <section className="p-hero" aria-labelledby="proposal-title">
        <div className="p-eyebrow"><span className="p-indicator" />NEAR HACKATHON / PROPOSAL 01<span className="p-draft">Product direction · controlled prototype</span></div>
        <h1 id="proposal-title">Give agents a budget.<br /><span>Let them buy inference.</span></h1>
        <div className="p-hero-bottom"><p>An agent knows what it needs to do next. Let it decide <em>when to buy, what to spend, and when to wait</em>—within its owner’s limits.</p>
          <a href="#near" className="p-primary">Why this matters to NEAR <span aria-hidden="true">↓</span></a></div>
        <div className="p-hero-line"><span>THE THESIS</span><p>A private procurement layer can turn NEAR AI’s model supply into demand that agents can act on.</p></div>
      </section>

      <section className="p-section p-system" aria-labelledby="system-title">
        <div className="p-section-heading"><span className="p-index">01 / THE MISSING LOOP</span><h2 id="system-title">From a model endpoint<br />to an agent that can buy.</h2><p>A model API answers a request. A procurement loop decides whether to accept the offered terms before that request runs.</p></div>
        <ol className="p-flow">
          <li><span className="p-step">01</span><h3>Owner authorizes</h3><p>A task, an agent budget, allowed models and a deadline.</p><span className="p-flow-code">bounded authority</span></li>
          <li><span className="p-step">02</span><h3>Agent chooses</h3><p>Compare eligible quotes. Accept, wait, revise the bid or stop.</p><span className="p-flow-code">cost × time × policy</span></li>
          <li><span className="p-step">03</span><h3>Market executes</h3><p>Reserve funds and supply, then call the provider’s native API.</p><span className="p-flow-code">one original execution</span></li>
          <li><span className="p-step">04</span><h3>Task continues</h3><p>Meter usage, settle the order and feed the result into the next tool step.</p><span className="p-flow-code">recover before repurchasing</span></li>
        </ol>
        <p className="p-caption">The buyer’s policy, the Market’s admission rules and the provider’s execution are separate responsibilities.</p>
      </section>

      <section className="p-section" id="near" aria-labelledby="near-title">
        <div className="p-section-heading"><span className="p-index">02 / WHY NEAR</span><h2 id="near-title">More useful demand for Cloud.<br />More agency in Gateway.</h2><p>Two proposed integration points. One bounded purchasing loop.</p></div>
        <div className="p-benefits">
          <article><span className="p-product">NEAR AI CLOUD</span><h3>Give flexible demand<br />a way to reach supply.</h3><p>Agents can express a spending cap and a willingness to wait. Cloud could expose bounded offers for supported models and turn eligible capacity into purchases.</p>
            <ul><li><strong>Additional consumption.</strong> A funded agent can purchase the next authorized step without a new manual checkout.</li><li><strong>Capacity-aware offers.</strong> Test whether patient work can use otherwise idle capacity; no utilization gain is assumed.</li><li><strong>Native serving.</strong> Preserve the provider API and its upstream billing; procurement sits above execution.</li></ul>
            <a href="https://near.ai/" target="_blank" rel="noreferrer">Cloud today ↗</a>
          </article>
          <article><span className="p-product">NEAR AI GATEWAY</span><h3>Give familiar tools<br />a purchasing policy.</h3><p>NEAR’s macOS Gateway already brings its models into coding tools. A future integration could let an owner authorize a task budget and delegate bounded procurement.</p>
            <ul><li><strong>Task-level controls.</strong> Choose save, balanced or urgent; pause purchasing or change limits explicitly.</li><li><strong>Visible decisions.</strong> Explain why a call waited, what it cost and which evidence was actually checked.</li><li><strong>Policy continuity.</strong> Keep model and privacy requirements when price, supply or urgency changes.</li></ul>
            <a href="https://gateway.near.ai/" target="_blank" rel="noreferrer">Gateway today ↗</a>
          </article>
        </div>
        <div className="p-integration"><span>PROPOSED PATH</span><p>Existing coding tool <b>→</b> Gateway + buyer policy <b>→</b> our MPP Proxy / private Market <b>→</b> NEAR AI Cloud</p><small>Upstream NEAR AI access still uses its existing credentials and account billing. This is not a claim that NEAR’s official API accepts native NEAR per call.</small></div>
        <div className="p-payment-heading"><span className="p-product">PAYMENT DESIGN</span><span className="p-tag">G1 / P3 qualification pending</span></div>
        <ol className="p-payments"><li><span>FUND</span><h3>Prepare each agent</h3><p>Use supported Intents/1Click routes to fund the agent’s NEAR account during setup or authorized replenishment.</p></li><li><span>BUY</span><h3>Purchase on NEAR</h3><p>Pay our merchant through the MPP flow. The agent pays native NEAR principal and payment gas; no cross-chain swap per call.</p></li><li><span>RECOVER</span><h3>Keep the original order</h3><p>Reconcile usage and unresolved payments. Return the unused principal; the merchant pays refund gas.</p></li></ol>
      </section>

      <section className="p-section" id="decision" aria-labelledby="decision-title">
        <div className="p-section-heading"><span className="p-index">03 / EXPLORE THE DECISION</span><h2 id="decision-title">Urgency is a preference.<br />The budget is a boundary.</h2><p>Try a tighter cap or an earlier result threshold. When nothing qualifies, the agent must be able to wait or stop.</p></div>
        <DecisionExplorer />
      </section>

      <section className="p-section p-boundaries" aria-labelledby="trust-title">
        <div className="p-section-heading"><span className="p-index">04 / PRIVATE BY CONTRACT</span><h2 id="trust-title">Make the trust boundary<br />part of the purchase.</h2><p>Buyer limits can reveal willingness to pay. A private Market aims to protect those limits as well as balances and order conditions.</p></div>
        <div className="p-trust-rows">
          <article><span>01</span><div><h3>Market privacy</h3><p>Verify the Market deployment and channel before sending purchase limits. Protecting the Market does not also attest the provider’s GPU.</p></div><span className="p-tag">Separate boundary</span></article>
          <article><span>02</span><div><h3>Inference evidence</h3><p>Keep NEAR’s deployment evidence and exact response-signature checks distinct. A Cloud HTTP gateway signature authenticates that gateway’s bytes; it does not alone establish which model executed.</p></div><a href="https://docs.near.ai/cloud/verification/cloud-api/response-signatures" target="_blank" rel="noreferrer" aria-label="Read NEAR response signature documentation">NEAR docs ↗</a></article>
          <article><span>03</span><div><h3>Agent authority</h3><p>Separate wallets, task budgets and unresolved liabilities. A retry resumes the original operation; it must not silently buy a second inference.</p></div><span className="p-tag">Owner stays in control</span></article>
        </div>
        <p className="p-caption">Incognito and private model routes have different protections. A cheaper quote must not silently relax the owner’s requirements. Full arithmetic inference proofs remain separate R&D.</p>
      </section>

      <section className="p-section" id="evidence" aria-labelledby="evidence-title">
        <div className="p-section-heading"><span className="p-index">05 / WHAT EXISTS</span><h2 id="evidence-title">A working procurement core.<br />An honest next milestone.</h2><p>These are separate bodies of evidence, not one connected live-money demonstration.</p></div>
        <div className="p-evidence">
          <article><span className="p-status p-done">RECORDED REAL INFERENCE</span><h3>Native NEAR AI calls</h3><p>The November 11 batch completed native inference for three test buyers. Provider usage and invoices were recorded; the Market used test credit.</p><a href={`${source}/blob/main/docs/acceptance/2026-11-11-market-batch-c.md`} target="_blank" rel="noreferrer">Batch C evidence ↗</a></article>
          <article><span className="p-status p-controlled">CONTROLLED P2</span><h3>Agents, tools, budgets</h3><p>Two real fx sessions, tool continuation, purchasing decisions and durable Market accounting. Model responses and chain receipts are fixtures.</p><a href={`${source}/blob/main/docs/acceptance/2026-11-14-agent-mpp-p2.md`} target="_blank" rel="noreferrer">P2 evidence ↗</a></article>
          <article><span className="p-status p-next">NEXT / G1 + P3</span><h3>The real funded loop</h3><p>Qualify agent-paid NEAR principal and payment gas, real model tasks, usage settlement, refunds and recovery. Gateway integration is proposed.</p><a href={`${source}/blob/main/docs/specs/2026-11-14-agent-mpp-p3-run-plan.md`} target="_blank" rel="noreferrer">Acceptance plan ↗</a></article>
        </div>
      </section>

      <section className="p-section p-test" aria-labelledby="test-title">
        <span className="p-index">06 / THE EXPERIMENT TO RUN WITH NEAR</span>
        <div className="p-test-heading"><h2 id="test-title">Prove the loop.<br /><span>Then test the economics.</span></h2><p>Start with two funded agents and one supported tool-capable model. Compare the same workloads and limits under fixed procurement and adaptive purchasing.</p></div>
        <div className="p-metrics"><div><span>01 / BUYER</span><h3>Cost per completed task</h3><p>Include failed attempts, gas and refunds; track task quality separately.</p></div><div><span>02 / EXPERIENCE</span><h3>Time to usable result</h3><p>Include waiting and payment overhead; report TTFT separately.</p></div><div><span>03 / CLOUD</span><h3>Additional served work</h3><p>Measure utilization and net revenue with real capacity and demand.</p></div></div>
        <p className="p-question">Open hypothesis: can flexible demand improve Cloud economics while staying useful to the agent and preserving its privacy policy?</p>
        <p className="p-pilot"><strong>A pilot with NEAR:</strong> one supported tool-capable model, meaningful supply offers and a bounded real-payment trial. If the offers have identical price and delivery conditions, we can test budget control, but cannot establish a market-efficiency benefit.</p>
      </section>

      <section className="p-closing"><span className="p-index">BUILD WITH US</span><h2>NEAR brings models and the user entry point.<br />We’re building the purchasing loop.</h2><div><a className="p-primary" href="/">Open the playground <span aria-hidden="true">↗</span></a><a href={`${source}/blob/main/docs/specs/2026-11-14-agent-mpp-inference-integration.md`} target="_blank" rel="noreferrer">Read the integration contract ↗</a></div><p>An independent BitRouter hackathon proposal. No NEAR partnership or product integration is implied.</p></section>
    </main>
    <footer className="p-footer"><span>private market / bitrouter</span><span>NEAR HACKATHON · NOV 2026</span><a href="#thesis">Back to thesis ↑</a></footer>
  </div>;
}

import type {ReactNode} from 'react';

export function SiteHeader({view, children}: {view: 'try' | 'proposal'; children?: ReactNode}) {
  return <div className="topbar">
    <a className="wordmark" href="/" aria-label="Private Market"><span className="brand-mark" aria-hidden="true">∕</span> private market</a>
    <nav className="main-navigation" aria-label="Main navigation">
      <a href="/" aria-current={view === 'try' ? 'page' : undefined}>try</a>
      <a href="/proposal" aria-current={view === 'proposal' ? 'page' : undefined}>proposal</a>
      <a className="source-link" href="https://github.com/SPIKESPIGEL404/private-flex-inference-auctions" target="_blank" rel="noreferrer">source ↗</a>
    </nav>
    <div className="header-controls">{children}</div>
  </div>;
}

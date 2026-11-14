import {lazy, Suspense, useEffect, useRef, useState} from 'react';
import type {MouseEvent} from 'react';
import Proposal from './proposal/Proposal';

const Workspace = lazy(() => import('./App'));
const isProposal = () => /^\/proposal\/?$/.test(location.pathname);

export default function Playground() {
  const [proposal, setProposal] = useState(isProposal);
  const [visitedWorkspace, setVisitedWorkspace] = useState(() => !isProposal());
  const [visitedProposal, setVisitedProposal] = useState(isProposal);
  const [address, setAddress] = useState(() => location.pathname + location.hash);
  const root = useRef<HTMLDivElement>(null);
  const previousView = useRef(proposal);

  useEffect(() => {
    const sync = () => {
      const next = isProposal();
      setProposal(next);
      if (next) setVisitedProposal(true); else setVisitedWorkspace(true);
      setAddress(location.pathname + location.hash);
    };
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  useEffect(() => {
    document.title = proposal ? 'Model fidelity in autonomous procurement · Private Market' : 'private market / playground';
    if (previousView.current !== proposal) {
      root.current?.querySelector<HTMLAnchorElement>('.route-view:not([hidden]) [aria-current="page"]')?.focus({preventScroll: true});
      previousView.current = proposal;
    }
  }, [proposal]);

  function navigate(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
    const url = new URL(anchor.href);
    if (url.origin !== location.origin || !['/', '/proposal', '/proposal/'].includes(url.pathname)) return;
    // Keep native anchors and section history inside the mounted reading pane.
    if (url.pathname === location.pathname && url.hash) return;
    event.preventDefault();
    const next = url.pathname !== '/';
    if (url.href !== location.href) history.pushState(null, '', url);
    if (next) setVisitedProposal(true); else setVisitedWorkspace(true);
    setProposal(next);
    setAddress(url.pathname + url.hash);
  }

  return <div className="playground" ref={root} onClick={navigate}>
    {visitedWorkspace && <div className="route-view" hidden={proposal}>
      <Suspense fallback={<div className="workspace-empty" role="status">loading workspace…</div>}>
        <Workspace active={!proposal} />
      </Suspense>
    </div>}
    {visitedProposal && <div className="route-view" hidden={!proposal}>
      <Proposal active={proposal} address={address} />
    </div>}
  </div>;
}

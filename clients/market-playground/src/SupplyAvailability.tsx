import {useEffect, useState} from 'react';

type SupplyState = 'ready' | 'warming' | 'offline' | 'unavailable' | 'unknown';
const labels: Record<SupplyState, string> = {ready: 'provider ready', warming: 'warming up', offline: 'provider offline', unavailable: 'provider unavailable', unknown: 'readiness unknown'};
export function SupplyAvailability({controlled = false}: {controlled?: boolean}) {
  const [state, setState] = useState<SupplyState>('unknown');
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch('/buyer-api/supply', {cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)])});
        if (!response.ok) throw new Error('supply unavailable');
        const supply = await response.json(), now = Date.now();
        if (supply.version !== 1 || supply.provider !== 'chutes' || supply.model !== 'qwen3.8-27b' || !Object.hasOwn(labels, supply.state)
          || !Number.isSafeInteger(supply.observedAtMs) || !Number.isSafeInteger(supply.expiresAtMs) || supply.observedAtMs > now + 1000
          || supply.expiresAtMs <= now || supply.expiresAtMs - supply.observedAtMs > 60000) throw new Error('stale supply');
        if (!disposed) setState(supply.state);
      } catch { if (!disposed) setState('unknown'); }
      finally { if (!disposed) timer = setTimeout(() => void poll(), 15000); }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, []);
  return <aside className="supply-availability" aria-label="Self-hosted Chutes availability">
    {controlled && <p role="status">Controlled Market uses a simulated seller. Capacity renews after confirmed completion; temporary shortages wait within the task limit. Chutes readiness below is independent.</p>}
    <details>
      <summary><span className="supply-availability-name">Chutes / self-hosted Qwen3.8-27B</span>{' '}
        <span className="supply-readiness" role="status">{labels[state]}{controlled ? ' · separate provider' : ''}</span>{' '}
        <span>Idle shutdown after ~1 hour · Cold start ~10 minutes</span></summary>
      <p>After an automatic shutdown, allow about 10 minutes for the GPU replica to start before running a timed comparison. Startup time is an estimate and may vary. Readiness reflects the provider observation; Market capacity and payment authorization are checked separately.</p>
    </details>
  </aside>;
}

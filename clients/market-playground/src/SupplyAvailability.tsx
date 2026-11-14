export function SupplyAvailability() {
  return <aside className="supply-availability" aria-label="Self-hosted Chutes availability">
    <details>
      <summary><span className="supply-availability-name">Chutes / self-hosted Qwen3.8-27B</span>{' '}
        <span>Auto shutdown after ~1 hour · Cold start ~10 minutes</span></summary>
      <p>After an automatic shutdown, allow about 10 minutes for the GPU replica to start before running a timed comparison. Startup time is an estimate and may vary.</p>
    </details>
  </aside>;
}

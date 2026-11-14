import {useCallback, useEffect, useState} from 'react';

export type AttestationStatus = 'verified' | 'failed' | 'not_checked' | 'controlled_local';

export interface AttestationResult {
  status: AttestationStatus;
  compose_hash: string | null;
  catalog_policy_digest: string | null;
  workload_keyset_digest: string | null;
  tls_pinned: boolean | null;
  quote_type: string | null;
  checked_at: string;
}

const KEYS = [
  'status', 'compose_hash', 'catalog_policy_digest', 'workload_keyset_digest',
  'tls_pinned', 'quote_type', 'checked_at',
] as const;

function isAttestationResult(value: unknown): value is AttestationResult {
  if (!value || typeof value !== 'object') return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== [...KEYS].sort().join(',')) return false;
  const v = value as Record<string, unknown>;
  return typeof v.status === 'string' && typeof v.checked_at === 'string';
}

function statusLabel(status: AttestationStatus): string {
  if (status === 'verified') return 'Market deployment verified';
  if (status === 'controlled_local') return 'controlled local stack';
  if (status === 'failed') return 'verification failed';
  return 'not checked';
}

function shortHash(value: string | null): string {
  if (!value) return '—';
  if (value.length <= 20) return value;
  return value.slice(0, 10) + '…' + value.slice(-8);
}

export function AttestationPanel() {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AttestationResult | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch('/buyer-api/attestation', {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      });
      const value = await response.json();
      if (!response.ok || !isAttestationResult(value)) {
        setResult({
          status: 'failed',
          compose_hash: null,
          catalog_policy_digest: null,
          workload_keyset_digest: null,
          tls_pinned: null,
          quote_type: null,
          checked_at: new Date().toISOString(),
        });
        return;
      }
      setResult(value);
    } catch {
      setResult({
        status: 'failed',
        compose_hash: null,
        catalog_policy_digest: null,
        workload_keyset_digest: null,
        tls_pinned: null,
        quote_type: null,
        checked_at: new Date().toISOString(),
      });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const status = result?.status ?? 'not_checked';
  const failed = status === 'failed';
  const showFields = status === 'verified' || status === 'controlled_local';

  return (
    <section className={`provider-stats attestation-panel ${open ? 'stats-expanded' : ''}`} aria-label="Market deployment and channel">
      <div className="stats-heading">
        <button className="stats-heading-toggle" aria-expanded={open} onClick={() => setOpen(old => !old)}>
          {open ? '⌄' : '›'} Market deployment and channel
        </button>
        <span className={`attestation-status ${failed ? 'is-failed' : ''} ${status === 'verified' ? 'is-verified' : ''} ${status === 'controlled_local' ? 'is-local' : ''}`}>
          {result ? statusLabel(status) : (busy ? 'checking…' : 'not checked')}
        </span>
        <button className="outline-button attestation-reverify" disabled={busy} onClick={() => void load()}>
          {busy ? 'checking…' : 'Re-verify'}
        </button>
      </div>
      {open && (
        <div className="attestation-body">
          {failed && <p className="attestation-failed" role="status">verification failed</p>}
          {showFields && result && (
            <dl className="attestation-fields">
              <div><dt>compose hash</dt><dd title={result.compose_hash ?? undefined}>{shortHash(result.compose_hash)}</dd></div>
              <div><dt>catalog policy digest</dt><dd title={result.catalog_policy_digest ?? undefined}>{shortHash(result.catalog_policy_digest)}</dd></div>
              <div><dt>workload keyset digest</dt><dd title={result.workload_keyset_digest ?? undefined}>{shortHash(result.workload_keyset_digest)}</dd></div>
              <div><dt>TLS key pinned</dt><dd>{result.tls_pinned == null ? '—' : result.tls_pinned ? 'yes' : 'no'}</dd></div>
              <div><dt>quote type</dt><dd>{result.quote_type ?? '—'}</dd></div>
              <div><dt>checked at</dt><dd>{result.checked_at}</dd></div>
            </dl>
          )}
          {!showFields && !failed && result && (
            <dl className="attestation-fields">
              <div><dt>checked at</dt><dd>{result.checked_at}</dd></div>
            </dl>
          )}
          <p className="attestation-footnote">
            This browser cannot pin the TLS key or check the TDX quote. Values come from the gateway verifier run.
          </p>
        </div>
      )}
    </section>
  );
}

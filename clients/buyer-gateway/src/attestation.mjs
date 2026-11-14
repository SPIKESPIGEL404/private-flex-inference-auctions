/** Read-only Market deployment verification for the playground panel. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MIN_INTERVAL_MS = 10_000;
const RUN_TIMEOUT_MS = 15_000;

const EMPTY_FIELDS = {
  compose_hash: null,
  catalog_policy_digest: null,
  workload_keyset_digest: null,
  tls_pinned: null,
  quote_type: null,
};

function publicShape(status, checkedAt, fields = EMPTY_FIELDS) {
  return {
    status,
    compose_hash: fields.compose_hash ?? null,
    catalog_policy_digest: fields.catalog_policy_digest ?? null,
    workload_keyset_digest: fields.workload_keyset_digest ?? null,
    tls_pinned: fields.tls_pinned ?? null,
    quote_type: fields.quote_type ?? null,
    checked_at: checkedAt,
  };
}

export function createAttestationHandler({
  policyPath = null,
  verifyDeployment = null,
  now = Date.now,
}) {
  let inFlight = null;
  let lastResult = null;
  let lastStartedAt = 0;

  async function runVerify() {
    const started = now();
    lastStartedAt = started;
    const checkedAt = new Date(started).toISOString();
    try {
      if (!policyPath) {
        lastResult = publicShape('not_checked', checkedAt);
        return lastResult;
      }
      const raw = JSON.parse(await readFile(policyPath, 'utf8'));
      const verify = verifyDeployment ?? defaultVerify;
      const result = await Promise.race([
        verify(raw),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('timeout')), RUN_TIMEOUT_MS);
        }),
      ]);
      if (!result || typeof result !== 'object' || typeof result.status !== 'string') {
        lastResult = publicShape('failed', checkedAt);
        return lastResult;
      }
      if (result.status === 'failed') {
        lastResult = publicShape('failed', result.checked_at || checkedAt);
        return lastResult;
      }
      lastResult = publicShape(result.status, result.checked_at || checkedAt, result);
      return lastResult;
    } catch {
      lastResult = publicShape('failed', checkedAt);
      return lastResult;
    }
  }

  return {
    async get() {
      const at = now();
      if (inFlight) return inFlight;
      if (lastResult && at - lastStartedAt < MIN_INTERVAL_MS) {
        // Same checked_at as the prior real run — not presented as a new check.
        return lastResult;
      }
      inFlight = runVerify().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

async function defaultVerify(policy) {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../market-buyer/verify-deployment.mjs'),
  ).href;
  const { verifyMarketDeployment } = await import(moduleUrl);
  return verifyMarketDeployment(policy);
}

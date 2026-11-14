# Fixed-supply comparison: first implementation slice

The comparison keeps NEAR AI Cloud fixed token pricing (A), the same self-hosted
Qwen deployment at fixed prices (B), and that self-hosted deployment at dynamic
prices (C) as distinct arms. This slice implements the A/B **operator harness**
and the private NEAR SDK bridge. C, autonomous agent wallet payment, task-quality
evaluation and the public comparison UI are not enabled by this slice.

Both arms buy through the existing signed Market Chat Completions endpoint. The
runner cannot replace its production hardware/catalog/TLS verifier. Each arm uses
its own reviewed, single-product Market catalog; this avoids introducing a new
cross-provider routing or billing API. There is no direct provider fallback.

## What is frozen

`services/inference-comparison/core.mjs` freezes the exact NEAR public model
`Qwen/Qwen3.8-27B`, current decimal token rates, cache-read rates, catalog digest,
observation time and expiry. A scheduled price transition shortens expiry. Tiered
prices are rejected until implemented. All monetary arithmetic uses integers:
Market rates are **microUSD per million tokens**. USD/token conversion multiplies
by 10^12 and must be exactly representable.

An immutable plan includes the common text messages, temperature 0, optional seed,
output cap (at most 512), per-arm budget (at most $1), owner, deadline and both
price versions. The reviewed plan hash must be supplied again to run. The runner
verifies every catalog candidate's offering and service rates, validity, native
model and local bridge against the frozen arm before loading buyer credentials.
The catalog's exact file digest must be independently accepted by the attestation
policy. Existing policies need an explicit `acceptedPolicyDigests` migration;
learning a digest from an unverified endpoint is not supported.

B uses the pinned Chutes checkpoint and the operator's explicit fixed prices.
Matching B's rates to A is a useful control. A's checkpoint revision is explicitly
unverified: a shared Qwen name and FP8 metadata do not prove equivalent weights,
context limits, serving parameters or hardware. Current common requests are text
only. No benchmark-quality or causal pricing claim follows from this harness.

## NEAR bridge

The bridge uses `@nearai/inference-sdk` 0.3.0, Node >=24.22.1, E2EE, the Node TLS
binding, and `UpToDate` TCB policies. It consumes the complete native stream and
requires a verified **provider_tee** response signature before releasing bytes to
Market. Gateway-only signatures do not qualify. This trusts the SDK/vendor's
verification policy; it does not establish a reproducible model/checkpoint proof.

It binds IPv4 loopback, requires a private local bearer secret, and accepts only
the reviewed request digest. A durable encrypted intent precedes each paid invoke.
Verified results replay exact bytes. Pending, disconnected or unverifiable results
remain Unknown and never invoke again. Unknown intents retain their budget and
call reservation. A bounded call count and conservative tariff-based reservation
are enforced across restarts. These are **estimates**, not provider-enforced dollar
caps: catalog changes, unexpected provider input accounting and provider billing
remain independent risks requiring operator acceptance and invoice verification.

The NEAR key stays in a private server file; it is never a buyer credential or
part of the public catalog. Native signed buyer headers are removed by Market.
The project pays the upstream account bill. This is not an agent-paid MPP flow.

## Install and prepare (zero inference calls)

Use Node >=24.22.1 without changing the machine's default version.

```sh
npm ci --ignore-scripts --prefix services/inference-comparison
npm ci --ignore-scripts --prefix clients/market-buyer
node services/inference-comparison/cli.mjs snapshot /absolute/private/near-tariff.json
node services/inference-comparison/cli.mjs prepare /absolute/private/input.json /absolute/private/comparison.json
```

`input.json` example (choose future times within both frozen tariff expiries):

```json
{
  "nearTariffFile": "/absolute/private/near-tariff.json",
  "ownerAccount": "judge.near",
  "budgetPerArmMicro": "10000",
  "deadlineMs": 1800000060000,
  "request": {
    "messages": [{"role": "user", "content": "Return the number 42."}],
    "temperature": 0,
    "max_completion_tokens": 64
  },
  "selfHostedTariff": {
    "rates": {"input": "40000", "cache_input": "18000", "output": "1350000"},
    "modelRevisionRef": "Qwen/Qwen3.8-27B-FP8@017b9c7af6b5689d5dd426a76e0bc077eb5ca20a",
    "observedAtMs": 1800000000000,
    "expiresAtMs": 1800003600000
  }
}
```

Prepare the self-hosted gateway with the existing [Chutes runbook](chutes-gateway.md).
Its fixed seller rates must match B's snapshot; historical test rates do not
become the baseline automatically. Do not apply/redeploy a Chute implicitly.

For A, use a locally pinned tokenizer plan, private NEAR API key file, and the
printed comparison hash:

```sh
python deploy/chutes/prepare_near_comparison.py \
  --comparison-plan /absolute/private/comparison.json \
  --reviewed-plan-hash REVIEWED_HASH \
  --tokenizer-plan /absolute/private/chutes/plan.json \
  --api-key-file /absolute/private/near.key \
  --bridge-port 8092 --tokenizer-port 8093 \
  --output /absolute/private/near-run
node services/inference-comparison/near-bridge.mjs /absolute/private/near-run/bridge.json
python deploy/chutes/tokenizer.py --plan /absolute/private/near-run/tokenizer-plan.json --port 8093
```

Run the services separately. Tokenizer artifact hashes are checked; reusing a
candidate tokenizer does not assert that NEAR uses the same template. Registration
must precede paid calibration using the existing `init-live-deploy` command with
offline buyer public keys and bearer digests. Configure `PRIVATE_MARKET_SELLER_KEY`
from `near-run/local-secret`, and keep `PRIVATE_MARKET_PUBLIC_MODEL` unset for A
(the existing single-model public guard is specific to the Chutes alias).

After reviewing the prepared plan and upstream estimate, calibration is explicit:

```sh
node services/inference-comparison/cli.mjs calibrate \
  /absolute/private/near-run /absolute/private/near-state/state.json REVIEWED_HASH
private-market-host-p2 qualify-live /absolute/private/near-state /absolute/private/near-run/measurement.json
```

Calibration is a real paid invoke. It writes an intent first and requires a
verified bridge response. `qualify-live` must reject mismatched local/native input
counts, missing terminal usage or contradictory output bounds. No calibrated
throughput is invented. Preserve an incomplete calibration intent for diagnosis;
do not create a new operation to bypass Unknown. Review the resulting catalog,
compose, boot measurements and TLS policy before enabling production purchases.

## Run and recover

The private runner configuration is mode 0600 and contains an encrypted journal
key; keep both the journal and key backed up privately. Each arm supplies paths:

```json
{
  "storePath": "/absolute/private/comparison.sqlite",
  "storageKey": "REPLACE_WITH_64_HEX_DIGITS",
  "arms": {
    "A": {
      "policyFile": "/absolute/private/a-policy.json",
      "catalogFile": "/absolute/private/a-catalog.json",
      "credentialFile": "/absolute/private/a-buyer-token",
      "signingKeyFile": "/absolute/private/a-buyer-ed25519.key"
    },
    "B": {
      "policyFile": "/absolute/private/b-policy.json",
      "catalogFile": "/absolute/private/b-catalog.json",
      "credentialFile": "/absolute/private/b-buyer-token",
      "signingKeyFile": "/absolute/private/b-buyer-ed25519.key"
    }
  }
}
```

```sh
node services/inference-comparison/cli.mjs run \
  /absolute/private/runner.json /absolute/private/comparison.json REVIEWED_HASH /absolute/private/result.json
node services/inference-comparison/cli.mjs report \
  /absolute/private/runner.json /absolute/private/comparison.json /absolute/private/recovered-result.json
```

The journal stores original response bytes encrypted. Public report projection
excludes content and private configuration. A failed arm does not hide the other
arm's outcome. Unknown/dispatching arms are held without any new purchase;
`report` is read-only and works after price expiry. Re-running a complete arm
returns its journal result. Output files use exclusive creation to avoid replacing
evidence. One process should own each journal; SQLite atomic claims also prevent
two cooperating runners from dispatching the same arm.

Reports distinguish native inference completion from **task success** (currently
null). A/B currently run sequentially, A then B: this is wiring acceptance, not a
counterbalanced performance experiment. Cache state is provider-managed and cache
hits are observed only if reported. Buyer first-token/completion times include
Market and verification delays. Because NEAR buffers until signature verification,
buyer TTFT cannot be relabeled raw provider TTFT. Tariff estimates, authoritative
buyer charges, provider invoices and native-chain transfers are separate fields;
missing evidence remains null. Market heads are retained privately for later
settlement integration; their availability alone is not proof of a charge.

## Remaining integration

1. Accept both real suppliers and invoices on reviewed deployments with a bounded
   operator-funded run. Current controlled tests establish wiring, not live TEE or
   model-quality acceptance.
2. Add C using seller asks, capacity and Market-owned frozen clearing terms. Buyer
   bids must not be presented as settlement prices or guaranteed speed.
3. Adapt #10's comparison presentation and aggregate telemetry to these original
   request/result records. Global GPU metrics are context, not per-task attribution.
4. Connect autonomous native-wallet MPP payment and task-success evaluation. The
   existing public playground remains the controlled P2 experience until accepted.

Run local checks:

```sh
npm test --prefix services/inference-comparison
npm test --prefix clients/market-buyer
python -m unittest discover -s deploy/chutes -p 'test_*.py'
```

SDK transitive dependencies currently report three low-severity audit findings
through the pinned verifier dependency. No compatible upstream fix is advertised;
we do not override cryptographic dependencies merely to make the audit count zero.

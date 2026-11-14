// Owned local acceptance only. Never imported by the production CLI/executor.
import { readFile, writeFile } from "node:fs/promises";
import { startNearBridge } from "../near-bridge.mjs";
import { ComparisonRunner, publicReport } from "../runner.mjs";
import { validateMarketCatalog } from "../market-executor.mjs";
import {
  freezeNearTariff,
  freezeSelfHostedTariff,
  prepareComparison,
  digest,
} from "../core.mjs";
import { catalog, request, stream } from "./helpers.mjs";
import {
  readSigningKey,
  signPurchase,
  jcsBytes,
  freshNonce,
} from "../../../clients/market-buyer/purchase-sign.mjs";
const [action, path] = process.argv.slice(2),
  read = async (file) => JSON.parse(await readFile(file));
if (action === "plan") {
  const now = Date.now(),
    nearTariff = freezeNearTariff(catalog(), { observedAtMs: now });
  const selfHostedTariff = freezeSelfHostedTariff({
    rates: nearTariff.rates,
    modelRevisionRef: "controlled-qwen-revision",
    observedAtMs: now,
    expiresAtMs: now + 600000,
  });
  const plan = prepareComparison({
    request,
    nearTariff,
    selfHostedTariff,
    budgetPerArmMicro: "10000",
    deadlineMs: now + 300000,
    ownerAccount: "controlled.near",
    now,
  });
  await writeFile(path, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
} else if (action === "bridge") {
  const config = await read(path),
    calls = [];
  const bridge = await startNearBridge(config, {
    client: {
      async fetch(_url, init) {
        calls.push(JSON.parse(init.body));
        await writeFile(config.callsFile, JSON.stringify(calls), {
          mode: 0o600,
        });
        return new Response(stream(), {
          headers: { "content-type": "text/event-stream" },
        });
      },
      async verifyResponse(id) {
        return { id, signatureKind: "provider_tee" };
      },
    },
  });
  console.log(JSON.stringify({ url: bridge.url, controlledSdk: true }));
  process.once("SIGINT", () => void bridge.close().then(() => process.exit(0)));
} else if (action === "run") {
  const config = await read(path),
    plan = await read(config.planFile);
  const runner = new ComparisonRunner(config, {
    executor: async (c, { arm, deadlineMs }) => {
      const raw = await readFile(c.catalogFile),
        policyDigest = "sha256:" + digest(raw);
      validateMarketCatalog(
        raw,
        { acceptedPolicyDigests: [policyDigest] },
        arm,
        deadlineMs,
      );
      const key = await readSigningKey(c.signingKeyFile);
      return {
        identity: {
          marketVerified: false,
          scope: "owned-loopback-controlled-only",
        },
        async dispatch({ body, idempotencyKey, signal }) {
          const wire = jcsBytes(body),
            signature = signPurchase({
              seed: key.seed,
              publicKey: key.publicKey,
              body: wire,
              idempotencyKey,
              keyset: policyDigest,
              nonce: freshNonce(),
              ts: Math.floor(Date.now() / 1000),
            });
          return fetch(c.baseURL + "/chat/completions", {
            method: "POST",
            redirect: "error",
            signal,
            headers: {
              authorization: "Bearer " + c.token,
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
              ...signature.headers,
            },
            body: wire,
          });
        },
        async head(id) {
          const r = await fetch(c.baseURL + "/requests/" + id, {
            headers: { authorization: "Bearer " + c.token },
          });
          if (!r.ok) throw Error("head_unavailable");
          return r.json();
        },
        async close() {},
      };
    },
  });
  try {
    const report = publicReport(await runner.run(plan, plan.planHash));
    await writeFile(config.reportFile, JSON.stringify(report), { mode: 0o600 });
    console.log(
      JSON.stringify({
        states: Object.fromEntries(
          Object.entries(report.arms).map(([id, r]) => [id, r.state]),
        ),
        hardwareVerified: false,
      }),
    );
  } finally {
    runner.close();
  }
} else throw Error("controlled_action_required");

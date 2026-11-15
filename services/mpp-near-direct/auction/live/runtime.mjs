import { execFileSync } from "node:child_process";
import { readFile, stat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { JsonRpcProvider } from "near-api-js";
import { Store } from "../../../../clients/buyer-gateway/src/store.mjs";
import { AuctionMarket } from "../market.mjs";
import { startMainnetAuctionServer } from "../server.mjs";
import { FileCredentials, OutLayer } from "../../p3/outlayer.mjs";
import { NativeSender } from "../../p3/native-sender.mjs";
import { NearRpc } from "../../near.mjs";
import { sdkClient } from "../../../inference-comparison/near-bridge.mjs";
import { hash, requireThat as check, uint } from "../../contract.mjs";
import { validateLivePlan, validateFx } from "./policy.mjs";
import { liveAdmission, recordFx } from "./admission.mjs";
import { AuctionWallet } from "./wallet.mjs";
import { AuctionSetup } from "./setup.mjs";
import { NearCloudProvider } from "./provider.mjs";

async function privateText(path) {
  const s = await stat(path);
  check(s.isFile() && (s.mode & 0o077) === 0, "private_runtime_file_required");
  return (await readFile(path, "utf8")).trim();
}
export async function launch(config) {
  const { plan, planHash } = validateLivePlan(config.plan, {
    allowExpired: true,
  });
  check(
    config.reviewedPlanHash === planHash &&
      process.env.ENABLE_BOUNDED_MAINNET === planHash,
    "explicit_mainnet_plan_gate_required",
  );
  check(
    config.rpcUrl === plan.rpcUrl &&
      new URL(config.rpcUrl).protocol === "https:" &&
      !new URL(config.rpcUrl).username &&
      !new URL(config.rpcUrl).password,
    "trusted_rpc_required",
  );
  execFileSync(
    config.hostBinary ?? "/usr/local/bin/private-market-host-p2",
    ["verify-auction-schema", config.owningStateDirectory],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        DATABASE_URL: await privateText(config.databaseUrlFile),
        REDIS_URL: config.redisUrl ?? "redis://127.0.0.1:26379",
        PRIVATE_MARKET_NEAR_DIRECT_P1: "controlled",
        PRIVATE_MARKET_AUCTION: plan.mode,
      },
    },
  );
  const data = resolve(config.dataDirectory);
  await mkdir(data, { recursive: true, mode: 0o700 });
  check(
    (await stat(data)).mode % 512 === 448,
    "private_mainnet_directory_required",
  );
  // One process owns the dedicated merchant's signed-byte SQLite journal. A
  // second runtime is fenced before starting workers or signing anything.
  const pool = new pg.Pool({
    connectionString: await privateText(config.databaseUrlFile),
    max: 16,
  });
  const lease = await pool.connect();
  if (
    !(await lease.query("SELECT pg_try_advisory_lock(2461114002) AS acquired"))
      .rows[0].acquired
  ) {
    lease.release();
    await pool.end();
    throw Error("mainnet_runtime_already_running");
  }
  lease.on("error", () => process.exit(1));
  let market, app, store;
  try {
    await pool.query(
      "INSERT INTO mpp_direct_live_plan VALUES(true,$1) ON CONFLICT DO NOTHING",
      [plan],
    );
    check(
      hash(
        (await pool.query("SELECT plan FROM mpp_direct_live_plan")).rows[0]
          .plan,
      ) === planHash,
      "immutable_mainnet_plan_changed",
    );
    const rpc = new NearRpc({ url: config.rpcUrl, network: "mainnet" });
    check(
      (await rpc.call("status", [])).chain_id === "mainnet",
      "mainnet_rpc_required",
    );
    const credentials = new FileCredentials(
        resolve(data, "wallet-credentials"),
      ),
      api = new OutLayer({ network: "mainnet", credentials });
    store = new Store(
      resolve(data, "merchant-effects.sqlite"),
      Buffer.from(await privateText(config.storageKeyFile), "hex"),
    );
    const refundSender = new NativeSender({
      store,
      provider: new JsonRpcProvider({ url: config.rpcUrl }),
      rpc,
      accountId: plan.merchant,
      secretKey: await privateText(config.merchantKeyFile),
      maxTotalYocto: plan.merchantMaximumYocto,
      gasCapYocto: plan.merchantGasReserveYocto,
      storagePriceYocto: plan.storagePriceYocto,
    });
    // Fresh sourced FX snapshots are append-only; they never rewrite an order.
    const refreshFx = async () => {
      const fx = JSON.parse(await readFile(config.fxFile, "utf8"));
      validateFx(fx);
      check(fx.source === plan.fxSource, "reviewed_fx_source_required");
      await recordFx(pool, fx);
    };
    await refreshFx().catch(() => {});
    market = new AuctionMarket({
      pool,
      config: {
        mode: plan.mode,
        network: plan.network,
        livePlan: plan,
        reviewedPlanHash: planHash,
        realBroadcastEnabled: true,
        service: plan.service,
        merchant: plan.merchant,
        realm: plan.realm,
        capacity: 1,
        rule: "first-price-v1",
        windowMs: 1000,
        paymentWindowMs: 45000,
        admissionWindowMs: 90000,
        minRevisionIntervalMs: 1000,
        secret: await privateText(config.marketSecretFile),
      },
      live: liveAdmission({ plan }),
    });
    await market.initialize();
    const wallet = new AuctionWallet({ market, api, rpc, refundSender }),
      setup = new AuctionSetup({ market, api, rpc, credentials, wallet });
    const apiKey = await privateText(config.nearAiKeyFile),
      client = await sdkClient(apiKey);
    const provider = new NearCloudProvider({
      market,
      client,
      catalog: async () => {
        const r = await fetch("https://cloud-api.near.ai/v1/model/list", {
          headers: { authorization: "Bearer " + apiKey },
          redirect: "error",
          signal: AbortSignal.timeout(12000),
        });
        check(r.ok, "provider_catalog_unavailable");
        const raw = await r.text();
        check(raw.length < 1024 * 1024, "catalog_limit");
        return JSON.parse(raw);
      },
    });
    await provider.initialize();
    await pool.query(
      "INSERT INTO mpp_direct_live_payment_budget VALUES(true,$1,0) ON CONFLICT DO NOTHING",
      [plan.maximumProviderCalls],
    );
    check(
      (
        await pool.query(
          "SELECT maximum_calls FROM mpp_direct_live_payment_budget",
        )
      ).rows[0].maximum_calls === plan.maximumProviderCalls,
      "mainnet_payment_limit_changed",
    );
    let checking = false;
    const readiness = async () => {
      if (checking) return;
      checking = true;
      try {
        const tariff = await provider.preflight();
        const [access, account] = await Promise.all([
          rpc.call("query", {
            request_type: "view_access_key",
            account_id: plan.merchant,
            public_key: refundSender.publicKey,
            finality: "final",
          }),
          rpc.call("query", {
            request_type: "view_account",
            account_id: plan.merchant,
            finality: "final",
          }),
        ]);
        check(
          access.permission === "FullAccess",
          "merchant_refund_key_required",
        );
        const liability = (
          await pool.query(
            "SELECT COALESCE(sum(principal-charged-refunded),0)::text AS amount FROM mpp_direct_auction_allocations WHERE payment='confirmed'",
          )
        ).rows[0].amount;
        const available =
          uint(account.amount) -
          uint(account.locked) -
          BigInt(account.storage_usage) * uint(plan.storagePriceYocto);
        check(
          available >=
            uint(liability) +
              BigInt(plan.maximumProviderCalls) *
                uint(plan.merchantGasReserveYocto) +
              uint(plan.gasFloorYocto),
          "merchant_refund_readiness_insufficient",
        );
        const at = Date.now();
        await pool.query(
          "INSERT INTO mpp_direct_live_supply VALUES(true,true,$1,$2,$3) ON CONFLICT(singleton) DO UPDATE SET ready=excluded.ready,observed_ms=excluded.observed_ms,expires_ms=excluded.expires_ms,evidence=excluded.evidence",
          [
            at,
            Math.min(at + 30000, tariff.expiresAtMs),
            {
              source: "near-ai-cloud-sdk-preflight-v1",
              priceVersion: tariff.priceVersion,
              providerRevisionVerified: false,
              merchantRefundKey: refundSender.publicKey,
            },
          ],
        );
      } catch (e) {
        await pool.query(
          "INSERT INTO mpp_direct_live_supply VALUES(true,false,$1,$1,$2) ON CONFLICT(singleton) DO UPDATE SET ready=false,observed_ms=excluded.observed_ms,expires_ms=excluded.expires_ms,evidence=excluded.evidence",
          [Date.now(), { status: "not_ready" }],
        );
      } finally {
        checking = false;
      }
    };
    await readiness();
    app = await startMainnetAuctionServer({
      market,
      wallet,
      provider,
      setup,
      uiOrigin: plan.origin,
      port: config.backendPort ?? 4180,
    });
    const timer = setInterval(
      () => void Promise.allSettled([refreshFx(), readiness()]),
      15000,
    );
    return {
      market,
      app,
      plan,
      planHash,
      async close() {
        clearInterval(timer);
        await app.close();
        while (checking) await new Promise((r) => setTimeout(r, 10));
        lease.release();
        await pool.end();
        store.close();
      },
    };
  } catch (e) {
    if (app) await app.close();
    lease.release();
    await pool.end();
    store?.close();
    throw e;
  }
}

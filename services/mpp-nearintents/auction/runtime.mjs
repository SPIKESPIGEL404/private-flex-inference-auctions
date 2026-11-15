import { execFileSync } from "node:child_process";
import { readFile, stat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { auctionPlan } from "./plan.mjs";
import { NI_MODE, NearintentsAuctionRail } from "./rail.mjs";
import { NearintentsAuctionWallet } from "./wallet.mjs";
import { NearintentsAuctionSetup } from "./setup.mjs";
import { sourceChain } from "./source.mjs";
import { FileJournal } from "../chat/journal.mjs";
import { check, digest } from "../chat/config.mjs";
import { AuctionMarket } from "../../mpp-near-direct/auction/market.mjs";
import { startNearintentsAuctionServer } from "../../mpp-near-direct/auction/server.mjs";
import {
  liveAdmission,
  recordFx,
} from "../../mpp-near-direct/auction/live/admission.mjs";
import {
  referenceFx,
  REFERENCE_FX_SOURCE,
} from "../../mpp-near-direct/auction/live/reference-fx.mjs";
import { validateFx } from "../../mpp-near-direct/auction/live/policy.mjs";
import { NearCloudProvider } from "../../mpp-near-direct/auction/live/provider.mjs";
import { ProjectProbe } from "../../mpp-near-direct/auction/live/project-probe.mjs";
import { sdkClient } from "../../inference-comparison/near-bridge.mjs";
import { Store } from "../../../clients/buyer-gateway/src/store.mjs";
const privateText = async (p) => {
  check((await stat(p)).mode % 512 === 384, "private_runtime_file_required");
  return (await readFile(p, "utf8")).trim();
};

export async function launchNearintentsAuction(config) {
  const { plan, planHash } = auctionPlan(config.plan);
  check(
    plan.mode === "live" &&
      config.reviewedPlanHash === planHash &&
      process.env.ENABLE_NEARINTENTS_AUCTION === planHash,
    "explicit_nearintents_auction_gate_required",
  );
  check(
    plan.fxSource === REFERENCE_FX_SOURCE,
    "reviewed_reference_fx_required",
  );
  const databaseUrl = await privateText(config.databaseUrlFile);
  // Verify the unchanged owning Market schema, installed in auction mode. The
  // adapter's separate immutable metadata schema is fingerprinted by the rail.
  execFileSync(
    config.hostBinary ?? "/usr/local/bin/private-market-host-p2",
    ["verify-auction-schema", config.owningStateDirectory],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        REDIS_URL: config.redisUrl ?? "redis://127.0.0.1:26379",
        PRIVATE_MARKET_NEAR_DIRECT_P1: "controlled",
        PRIVATE_MARKET_AUCTION: "bounded-mainnet-v1",
      },
    },
  );
  const pool = new Pool({ connectionString: databaseUrl, max: 16 }),
    lease = await pool.connect();
  if (
    !(await lease.query("SELECT pg_try_advisory_lock(2461115003) AS acquired"))
      .rows[0].acquired
  ) {
    lease.release();
    await pool.end();
    throw Error("nearintents_runtime_already_running");
  }
  lease.on("error", () => process.exit(1));
  let app,
    store,
    timer,
    checking = false;
  try {
    const data = resolve(config.dataDirectory);
    await mkdir(data, { recursive: true, mode: 0o700 });
    check(
      ((await stat(data)).mode & 0o077) === 0,
      "private_nearintents_directory_required",
    );
    const journal = new FileJournal(resolve(data, "agent-wallets"));
    await journal.initialize();
    const secret = await privateText(config.marketSecretFile),
      jwt = config.oneClickJwtFile
        ? await privateText(config.oneClickJwtFile)
        : undefined;
    const rail = new NearintentsAuctionRail({
      pool,
      config: plan,
      secret,
      jwt,
    });
    await rail.initialize();
    const instance = (
      await pool.query(
        "SELECT instance_id FROM nearintents_auction_configuration",
      )
    ).rows[0].instance_id;
    const binding = await journal.get("runtime-binding");
    if (binding)
      check(
        binding.instance === instance && binding.planHash === planHash,
        "original_wallet_journal_database_binding_required",
      );
    else {
      check(
        !(await pool.query("SELECT FROM nearintents_auction_agents LIMIT 1"))
          .rowCount,
        "original_wallet_journal_required",
      );
      await journal.put("runtime-binding", { instance, planHash });
    }
    const key = await privateText(config.nearAiKeyFile),
      keyFingerprint = digest(key),
      base = liveAdmission({ plan, keyFingerprint });
    const live = {
      ...base,
      scope: NI_MODE,
      ready: async (db, at) =>
        !(
          await db.query(
            "SELECT FROM mpp_direct_auction_allocations WHERE refundable>0 LIMIT 1",
          )
        ).rowCount && (await base.ready(db, at)),
    };
    const market = new AuctionMarket({
      pool,
      config: {
        mode: NI_MODE,
        paymentMethod: "nearintents",
        billing: "auction-fixed-request-v1",
        network: "mainnet",
        realBroadcastEnabled: true,
        livePlan: plan,
        reviewedPlanHash: planHash,
        merchant: plan.merchant,
        realm: plan.realm,
        service: plan.service,
        capacity: 1,
        rule: "first-price-v1",
        windowMs: 1000,
        paymentWindowMs: plan.paymentWindowMs,
        admissionWindowMs: plan.admissionWindowMs,
        minRevisionIntervalMs: 1000,
        secret,
      },
      live,
      paymentRail: rail,
    });
    await market.initialize();
    const source = sourceChain(plan);
    await source.balance("0x0000000000000000000000000000000000000000");
    let setup;
    const wallet = new NearintentsAuctionWallet({
      market,
      rail,
      journal,
      keys: (id) => setup.keys(id),
      source: (payer) => source.balance(payer),
      config: plan,
    });
    setup = new NearintentsAuctionSetup({
      market,
      wallet,
      journal,
      source,
      config: plan,
    });
    const client = await sdkClient(key),
      provider = new NearCloudProvider({
        market,
        client,
        keyFingerprint,
        catalog: async () => {
          const r = await fetch("https://cloud-api.near.ai/v1/model/list", {
            headers: { authorization: "Bearer " + key },
            redirect: "error",
            signal: AbortSignal.timeout(12000),
          });
          check(r.ok, "provider_catalog_unavailable");
          const text = await r.text();
          check(text.length < 1024 * 1024, "provider_catalog_too_large");
          return JSON.parse(text);
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
      "immutable_payment_cap_changed",
    );
    store = new Store(
      resolve(data, "project-probe.sqlite"),
      Buffer.from(await privateText(config.storageKeyFile), "hex"),
    );
    const probe = new ProjectProbe({
      pool,
      store,
      plan,
      planHash,
      keyFingerprint,
      client,
    });
    await pool.query(
      "INSERT INTO mpp_direct_live_supply VALUES(true,false,$1,$1,$2) ON CONFLICT(singleton) DO UPDATE SET ready=false,expires_ms=excluded.expires_ms",
      [Date.now(), { status: "startup_preflight" }],
    );
    const refresh = async () => {
      if (checking) return;
      checking = true;
      try {
        const fx = await referenceFx();
        validateFx(fx);
        await recordFx(pool, fx);
        const tariff = await provider.preflight(),
          access = await probe.ensure(tariff);
        check(access?.verified, "provider_key_probe_required");
        const at = Date.now();
        await pool.query(
          "INSERT INTO mpp_direct_live_supply VALUES(true,true,$1,$2,$3) ON CONFLICT(singleton) DO UPDATE SET ready=true,observed_ms=excluded.observed_ms,expires_ms=excluded.expires_ms,evidence=excluded.evidence",
          [
            at,
            Math.min(at + 30000, tariff.expiresAtMs),
            {
              source: "near-cloud-attested-key-probe",
              responseId: access.responseId,
              actualMicro: access.actualMicro,
            },
          ],
        );
      } catch {
        await pool.query(
          "UPDATE mpp_direct_live_supply SET ready=false,expires_ms=$1 WHERE singleton",
          [Date.now()],
        );
      } finally {
        checking = false;
      }
    };
    app = await startNearintentsAuctionServer({
      market,
      wallet,
      provider,
      setup,
      uiOrigin: plan.origin,
      port: config.backendPort ?? 4180,
    });
    void refresh();
    timer = setInterval(() => void refresh(), 15000);
    return {
      market,
      app,
      plan,
      planHash,
      async close() {
        clearInterval(timer);
        await app.close();
        while (checking) await new Promise((r) => setTimeout(r, 10));
        store.close();
        lease.release();
        await pool.end();
      },
    };
  } catch (e) {
    clearInterval(timer);
    if (app) await app.close();
    store?.close();
    lease.release();
    await pool.end();
    throw e;
  }
}

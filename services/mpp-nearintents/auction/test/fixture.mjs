import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import { AuctionMarket } from "../../../mpp-near-direct/auction/market.mjs";
import { freezeClass } from "../../../mpp-near-direct/auction/contracts.mjs";
import { startAuctionServer } from "../../../mpp-near-direct/auction/server.mjs";
import { controlledAdapters } from "../../../mpp-near-direct/auction/test/controlled-adapters.mjs";
import { hash } from "../../../mpp-near-direct/contract.mjs";
import { NearintentsAuctionRail } from "../rail.mjs";
import { NearintentsAuctionWallet } from "../wallet.mjs";
import { NearintentsAuctionSetup } from "../setup.mjs";
import { auctionPlan } from "../plan.mjs";
import { FileJournal } from "../../chat/journal.mjs";
import { check } from "../../chat/config.mjs";
export const OWNER = "judge.testnet",
  FUNDER = "0x2222222222222222222222222222222222222222",
  TOKEN = "controlled-owner-token";

export async function fixture({
  databaseUrl,
  origin = "http://127.0.0.1:4173",
  port = 0,
  reset = true,
  autoOwner = false,
  quoteTimeEstimate = 0,
  providerWrap = (x) => x,
} = {}) {
  check(databaseUrl, "isolated_auction_database_required");
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  if (reset) {
    await pool.query(
      "DROP TABLE IF EXISTS nearintents_auction_configuration,nearintents_auction_store,nearintents_auction_agents,nearintents_auction_credentials,nearintents_auction_funding CASCADE",
    );
    await pool.query(
      "DROP FUNCTION IF EXISTS nearintents_funding_guard() CASCADE",
    );
    await pool.query(
      "TRUNCATE mpp_direct_auction_state,mpp_direct_auction_budgets,mpp_direct_auction_agents,mpp_direct_auction_grants,mpp_direct_auction_bids,mpp_direct_auction_commands,mpp_direct_auction_revisions,mpp_direct_auction_rounds,mpp_direct_auction_allocations,mpp_direct_auction_operations,mpp_direct_auction_movements,mpp_direct_auction_events CASCADE",
    );
  }
  const counters = { quotes: 0, transfers: 0, rebroadcasts: 0, exits: 0 },
    quotes = new Map(),
    receipts = new Map(),
    balances = new Map(),
    nonces = new Map(),
    funding = new Map();
  let settlement = "SUCCESS";
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const u = new URL(req.url, "http://fixture");
    if (u.pathname === "/v0/tokens")
      return send(200, [
        {
          assetId: "source-usdc",
          blockchain: "arb",
          decimals: 6,
          symbol: "USDC",
          contractAddress: "0x1111111111111111111111111111111111111111",
        },
        {
          assetId: "wrapped-near",
          blockchain: "near",
          decimals: 24,
          symbol: "wNEAR",
          contractAddress: "wrap.near",
        },
      ]);
    if (u.pathname === "/v0/quote") {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      check(
        body.swapType === "EXACT_OUTPUT" &&
          !body.dry &&
          body.destinationAsset === "wrapped-near",
        "fixture_quote_contract",
      );
      const address = "0x" + String(++counters.quotes).padStart(40, "0"),
        amount = String(
          (BigInt(body.amount) * 2000000n + 10n ** 24n - 1n) / 10n ** 24n +
            100n,
        );
      const quote = {
        depositAddress: address,
        amountIn: amount,
        minAmountIn: amount,
        deadline: body.deadline,
        timeEstimate: quoteTimeEstimate,
      };
      quotes.set(address, { quote, request: body, hash: null });
      return send(200, { quote, quoteRequest: body });
    }
    if (u.pathname === "/v0/deposit/submit") return send(200, {});
    if (u.pathname === "/v0/status") {
      const q = quotes.get(u.searchParams.get("depositAddress"));
      return send(
        200,
        q?.hash
          ? {
              status: settlement,
              swapDetails: {
                originChainTxHashes: [{ hash: q.hash }],
                destinationChainTxHashes: [
                  {
                    hash:
                      "fixture-near-delivery-" +
                      q.quote.depositAddress.slice(-8),
                  },
                ],
              },
            }
          : { status: "PENDING_DEPOSIT" },
      );
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port,
    now = Date.now();
  const { plan } = auctionPlan({
    mode: "controlled",
    origin,
    realm: "ni-auction-controlled",
    merchant: "merchant.near",
    originAsset:
      "eip155:42161/erc20:0x1111111111111111111111111111111111111111",
    tokenDecimals: 6,
    tokenSymbol: "USDC",
    gasSymbol: "ETH",
    oneClickBaseUrl: base,
    sourceRpcUrl: base,
    maximumAmountIn: "1000000",
    maximumTotalAmountIn: "4000000",
    maximumGasWei: "100000000000000",
    maximumTotalGasWei: "400000000000000",
    principalCapYocto: "100000000000000000000000",
    ownerBudgetNano: "100000000",
    agentBudgetNano: "50000000",
    callCapMicro: "10000",
    providerMaximumMicro: "10000",
    maximumProviderCalls: 16,
    maximumAgents: 8,
    deadlineMs: now + 3600000,
    paymentWindowMs: 10000,
    admissionWindowMs: 20000,
    settlementTimeout: 1,
    pollInterval: 5,
    fxSource: "controlled-fx",
    service: freezeClass({
      model: "m/external",
      checkpoint: "fixture-v1",
      quantization: "none",
      tokenizer: "fixture-tokenizer",
      template: "fixture-template",
      engine: "fixture-v1",
      capacityPoolId: "single-seller-1",
      minInputTokens: 1,
      maxInputTokens: 32000,
      maxOutputTokens: 512,
      rates: { input: "40000", cache_input: "18000", output: "1350000" },
      fee: { version: "flat-plus-bps-v1", flatMicro: "1", bps: "100" },
      delivery: "verified-complete-response-v1",
      features: "text-and-bash-v1",
    }),
  });
  const config = {
    mode: "controlled",
    network: "testnet",
    realBroadcastEnabled: false,
    paymentMethod: "nearintents",
    billing: "auction-fixed-request-v1",
    capacity: 1,
    rule: "first-price-v1",
    windowMs: 250,
    paymentWindowMs: plan.paymentWindowMs,
    admissionWindowMs: plan.admissionWindowMs,
    minRevisionIntervalMs: 0,
    secret: "controlled-nearintents-auction-secret-value",
    merchant: plan.merchant,
    realm: plan.realm,
    service: plan.service,
    fx: {
      source: "controlled-fx",
      nanoUsdPerNear: "2000000000",
      observedAtMs: now,
      expiresAtMs: now + 3600000,
    },
  };
  const rail = new NearintentsAuctionRail({
    pool,
    config: plan,
    secret: config.secret,
  });
  await rail.initialize();
  const market = new AuctionMarket({ pool, config, paymentRail: rail });
  await market.initialize();
  const directory = await mkdtemp(join(tmpdir(), "ni-auction-")),
    journal = new FileJournal(directory);
  await journal.initialize();
  const source = {
    async balance(payer) {
      return {
        ...(balances.get(payer.toLowerCase()) ?? {
          sourceAtoms: "0",
          gasWei: "0",
        }),
        blockNumber: "1",
      };
    },
    async fundingProof(f, a) {
      const proof = funding.get(f.tx_hash);
      if (!proof) return null;
      check(
        proof.to.toLowerCase() === a.payer.toLowerCase() &&
          proof.amount === f.amount &&
          proof.kind === f.kind,
        "fixture_funding_conflict",
      );
      return {
        success: true,
        txHash: f.tx_hash,
        amount: f.amount,
        kind: f.kind,
      };
    },
  };
  const clients = (key) => ({
    wallet: {
      async prepareTransactionRequest(input) {
        return {
          to: input.to,
          data: input.data,
          value: input.value,
          nonce: nonces.get(key.address.toLowerCase()) ?? 0,
          gas: 80000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
          chainId: 42161,
          type: "eip1559",
        };
      },
      async signTransaction(input) {
        return privateKeyToAccount(key.privateKey).signTransaction(input);
      },
    },
    public: {
      async getChainId() {
        return 42161;
      },
      async getCode() {
        return undefined;
      },
      async getBalance({ address }) {
        return BigInt((await source.balance(address)).gasWei);
      },
      async readContract({ args }) {
        return BigInt((await source.balance(args[0])).sourceAtoms);
      },
      async sendRawTransaction({ serializedTransaction: raw }) {
        const h = keccak256(raw);
        if (receipts.has(h)) {
          counters.rebroadcasts++;
          return h;
        }
        const tx = parseTransaction(raw),
          from = (
            await recoverTransactionAddress({ serializedTransaction: raw })
          ).toLowerCase();
        check(tx.chainId === 42161, "fixture_source_transaction");
        const isToken =
          tx.to.toLowerCase() === plan.originAsset.split(":").at(-1);
        const target = isToken ? "0x" + tx.data.slice(34, 74) : tx.to,
          amount = isToken
            ? BigInt("0x" + tx.data.slice(-64))
            : BigInt(tx.value),
          q = quotes.get(target.toLowerCase());
        check(
          !q || String(amount) === q.quote.amountIn,
          "fixture_deposit_binding",
        );
        const b = await source.balance(from);
        check(
          (isToken ? BigInt(b.sourceAtoms) >= amount : true) &&
            BigInt(b.gasWei) >= 42000n + (isToken ? 0n : amount),
          "fixture_source_funds",
        );
        balances.set(from, {
          sourceAtoms: String(BigInt(b.sourceAtoms) - (isToken ? amount : 0n)),
          gasWei: String(BigInt(b.gasWei) - 42000n - (isToken ? 0n : amount)),
        });
        if (q) q.hash = h;
        nonces.set(from, tx.nonce + 1);
        if (q) counters.transfers++;
        else {
          counters.exits++;
          const receiver = await source.balance(target);
          balances.set(target.toLowerCase(), {
            sourceAtoms: String(
              BigInt(receiver.sourceAtoms) + (isToken ? amount : 0n),
            ),
            gasWei: String(BigInt(receiver.gasWei) + (isToken ? 0n : amount)),
          });
        }
        receipts.set(h, {
          transactionHash: h,
          status: "success",
          gasUsed: 21000n,
          effectiveGasPrice: 2n,
        });
        return h;
      },
      async waitForTransactionReceipt({ hash }) {
        check(receipts.has(hash), "fixture_receipt_pending");
        return receipts.get(hash);
      },
    },
  });
  let setup;
  const wallet = new NearintentsAuctionWallet({
    market,
    rail,
    journal,
    keys: (id) => setup.keys(id),
    source: (payer) => source.balance(payer),
    config: plan,
    clients,
  });
  setup = new NearintentsAuctionSetup({
    market,
    wallet,
    journal,
    source,
    config: plan,
  });
  const provider = providerWrap((await controlledAdapters(pool)).provider);
  if (reset)
    await pool.query(
      "TRUNCATE fixture_auction_wallet_accounts,fixture_auction_wallet_ops,fixture_auction_provider_ops",
    );
  const auth = autoOwner
    ? {
        owner: () => ({ account_id: OWNER, public_key: "controlled-fixture" }),
        logout() {},
        cancel() {},
      }
    : undefined;
  const app = await startAuctionServer({
    market,
    wallet,
    provider,
    setup,
    ownerTokens: [{ ownerId: "testnet:" + OWNER, tokenHash: hash(TOKEN) }],
    ownerAuth: auth,
    uiOrigin: origin,
    port,
  });
  const api = async (path, body, method, token = TOKEN) => {
    const response = await fetch(app.url + "/buyer-api/" + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        authorization: "Bearer " + token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(Error(data.error?.code ?? "api_failed"), {
        status: response.status,
      });
    return data;
  };
  const f = {
    pool,
    market,
    wallet,
    rail,
    setup,
    journal,
    plan,
    config,
    app,
    api,
    counters,
    quotes,
    balances,
    receipts,
    source,
    provider,
    set settlement(value) {
      settlement = value;
    },
    fund(to, kind, amount) {
      const b = balances.get(to.toLowerCase()) ?? {
        sourceAtoms: "0",
        gasWei: "0",
      };
      const field = kind === "token" ? "sourceAtoms" : "gasWei";
      b[field] = String(BigInt(b[field]) + BigInt(amount));
      balances.set(to.toLowerCase(), b);
      const hash = "0x" + String(funding.size + 1).padStart(64, "f");
      funding.set(hash, { to, kind, amount });
      return hash;
    },
    async add(operation = "agent-a") {
      const before = (await api("nearintents-wallets")).wallets;
      const after = await api("nearintents-wallets", {
        operation,
        acceptLimits: true,
      });
      const w =
        after.wallets.find((w) => !before.some((x) => x.id === w.id)) ??
        after.wallets[0];
      f.fund(w.address, "token", "2000000");
      f.fund(w.address, "gas", "200000000000000");
      await market.observeFinalBalance(w.id, (payer) => wallet.balance(payer));
      return w;
    },
    async close() {
      await app.close();
      await pool.end();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(directory, { recursive: true, force: true });
    },
  };
  return f;
}

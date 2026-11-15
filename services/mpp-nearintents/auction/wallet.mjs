import { Challenge, Credential, Receipt } from "mppx";
import { Mppx } from "mppx/client";
import { nearintents } from "@defuse-protocol/nearintents-mpp-sdk/client";
import { OneClick, Types } from "@defuse-protocol/nearintents-mpp-sdk";
import { evmPayer } from "../chat/evm-payer.mjs";
import { check, digest, uint } from "../chat/config.mjs";
import { NI_MODE } from "./rail.mjs";

export class NearintentsAuctionWallet {
  durableOriginalOperations = true;
  constructor({ market, rail, journal, keys, source, config, clients }) {
    Object.assign(this, {
      market,
      rail,
      journal,
      keys,
      source,
      config,
      clients,
    });
    this.pool = market.pool;
    this.scope = config.mode === "controlled" ? "controlled-fixture" : NI_MODE;
  }
  async allocation(id) {
    const a = (
      await this.pool.query(
        "SELECT * FROM mpp_direct_auction_allocations WHERE id=$1",
        [id],
      )
    ).rows[0];
    check(a, "unknown_allocation");
    return a;
  }
  async credential(id) {
    return (
      (
        await this.pool.query(
          "SELECT credential FROM nearintents_auction_credentials WHERE allocation_id=$1",
          [id],
        )
      ).rows[0]?.credential ?? null
    );
  }
  async save(a, serialized) {
    this.rail.parse(a, serialized);
    await this.pool.query(
      "INSERT INTO nearintents_auction_credentials VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [a.id, serialized, Date.now()],
    );
    check(
      (await this.credential(a.id)) === serialized,
      "original_payment_conflict",
    );
  }
  async authorizationFor(id) {
    return this.credential(id);
  }
  async createCredential(id) {
    const a = await this.allocation(id),
      old = await this.credential(id);
    if (old) return old;
    return this.journal.locked("auction-payment:" + id, async () => {
      const saved = await this.credential(id);
      if (saved) return saved;
      check(
        !(await this.journal.get("sealed:" + id)),
        "original_payment_sealed",
      );
      await this.market.beginOperation(id, "payment");
      if (
        !(await this.journal.list()).some(
          (r) => r.kind === "evm" && r.operationId === id,
        )
      )
        await this.market.transaction(async (db, _s, at) => {
          const current = await this.market.allocation(db, id);
          check(
            current.execution === "reserved" &&
              at < current.contract.paymentBeforeMs &&
              Number.isFinite(
                current.challenge.request.methodDetails.timeEstimate,
              ) &&
              current.challenge.request.methodDetails.timeEstimate >= 0 &&
              at + current.challenge.request.methodDetails.timeEstimate * 1000 <
                current.contract.paymentBeforeMs &&
              (await this.market.grantPermits(db, current, at)),
            "payment_authorization_closed",
          );
        });
      const key = await this.keys(a.agent_id),
        q = a.challenge.request;
      check(
        key.address === q.methodDetails.refundTo,
        "source_wallet_binding_failed",
      );
      const policy = {
        allowedOriginNetworks: [Types.chainOf(q.currency)],
        allowedCurrencies: [q.currency],
        maxAmountIn: { [q.currency]: this.config.maximumAmountIn },
        maximumTotalAmountIn: this.config.maximumTotalAmountIn,
        expectedDestination: {
          destinationAsset: "near:mainnet/nep141:wrap.near",
          destinationRecipient: this.config.merchant,
          amountOut: String(a.principal),
        },
        expectedRefundTo: key.address,
      };
      const payer = evmPayer({
        privateKey: key.privateKey,
        rpcUrl: this.config.sourceRpcUrl,
        originAsset: q.currency,
        refundTo: key.address,
        maximumGasWei: this.config.maximumGasWei,
        maximumTotalGasWei: this.config.maximumTotalGasWei,
        journal: this.journal,
        policy,
        controlled: this.config.mode === "controlled",
        clients: this.clients?.(key),
        authorize: () =>
          this.market.transaction(async (db, _s, at) => {
            const current = await this.market.allocation(db, id);
            check(
              current.execution === "reserved" &&
                at < current.contract.paymentBeforeMs &&
                at +
                  current.challenge.request.methodDetails.timeEstimate * 1000 <
                  current.contract.paymentBeforeMs &&
                (await this.market.grantPermits(db, current, at)),
              "payment_authorization_closed",
            );
          }),
      });
      const client = Mppx.create({
        polyfill: false,
        methods: [
          nearintents.charge({
            policy,
            sendDeposit: async ({ request }) =>
              payer.payOriginal({ operationId: id, request }),
          }),
        ],
      });
      const c = await client.createCredential(
        new Response(JSON.stringify({}), {
          status: 402,
          headers: { "www-authenticate": Challenge.serialize(a.challenge) },
        }),
      );
      await this.save(a, c);
      return c;
    });
  }
  async verifyPresentation(id, serialized) {
    const a = await this.allocation(id);
    this.rail.parse(a, serialized);
    const original = await this.credential(id);
    check(original === serialized, "original_payment_conflict");
  }
  async settle(id, serialized) {
    let a = await this.allocation(id);
    await this.save(a, serialized);
    const c = this.rail.parse(a, serialized),
      db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,2461115002))",
        [id],
      );
      a = await this.allocation(id);
      if (a.payment === "confirmed") {
        const e = (
          await db.query(
            "SELECT evidence FROM mpp_direct_auction_movements WHERE allocation_id=$1 AND kind='payment'",
            [id],
          )
        ).rows[0]?.evidence;
        check(
          e?.receipt?.originTxHash === c.payload.hash,
          "original_payment_conflict",
        );
        await db.query("COMMIT");
        return e;
      }
      const bid = (
        await db.query(
          "SELECT request_hash FROM mpp_direct_auction_bids WHERE id=$1",
          [a.bid_id],
        )
      ).rows[0];
      const verified = await this.rail.handler(db, {
        ...a,
        payer: a.challenge.request.methodDetails.refundTo,
        requestHash: bid.request_hash,
      })(
        new Request("https://auction.invalid/v1/chat/completions", {
          method: "POST",
          headers: { "Payment-Authorization": serialized },
        }),
      );
      if (verified.status !== 200) {
        await db.query("COMMIT");
        return null;
      }
      const result = await verified.withReceipt(Response.json({})),
        receipt = Receipt.deserialize(result.headers.get("payment-receipt"));
      const q = a.challenge.request,
        network = Types.chainOf(q.currency);
      const e = {
        method: "nearintents",
        movementKey: `nearintents:${network}:${OneClick.canonicalTxHash(c.payload.hash, network)}`,
        orderRef: a.order_id,
        amount: String(a.principal),
        payer: q.methodDetails.refundTo,
        recipient: this.config.merchant,
        network: this.market.config.network,
        marketNetwork: this.market.config.network,
        challengeId: a.challenge.id,
        gasActualYocto: "0",
        sourceAsset: q.currency,
        sourceAmount: q.amount,
        receipt,
        paidAtMs: Date.parse(receipt.timestamp),
        late: Date.now() > a.contract.admissionBeforeMs,
        scope: this.scope,
      };
      // SDK verification may wait on settlement, but holds no auction/grant lock.
      // Acquire the same financial/capacity locks only for the final atomic commit.
      await db.query(
        "SELECT singleton FROM mpp_direct_auction_state WHERE singleton FOR UPDATE",
      );
      await db.query(
        "SELECT id FROM mpp_direct_capacity WHERE id=1 FOR UPDATE",
      );
      const at = Number(
        (
          await db.query(
            "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS at",
          )
        ).rows[0].at,
      );
      await this.market.applyVerifiedPayment(db, id, e, at);
      await this.fault?.("before_payment_commit");
      await db.query("COMMIT");
      return e;
    } catch (e) {
      await db.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      db.release();
    }
  }
  async recoverOriginal(op) {
    const c = await this.credential(op.allocation_id);
    return c ? this.settle(op.allocation_id, c) : null;
  }
  async sealOriginal(op) {
    const id = op.allocation_id,
      c = await this.credential(id);
    if (c) return this.settle(id, c);
    return this.journal.locked("auction-payment:" + id, async () => {
      const effects = await this.journal.list();
      if (effects.some((r) => r.kind === "evm" && r.operationId === id))
        return null;
      await this.journal.put("sealed:" + id, {
        state: "never_sent",
        operationId: op.id,
      });
      // A public 1Click quote can still receive an external deposit. Sealing our
      // signer is not proof that the merchant can never be paid. Keep liability.
      return null;
    });
  }
  async balance(payer) {
    const b = await this.source(payer),
      at = Date.now();
    return {
      source: "nearintents-source-observation-v1",
      network: this.market.config.network,
      payer,
      asset: this.config.originAsset,
      sourceAtoms: String(b.sourceAtoms),
      gasWei: String(b.gasWei),
      blockNumber: String(b.blockNumber),
      observedAtMs: at,
      expiresAtMs: at + 30000,
    };
  }
  async sourceFee(id) {
    const r = (await this.journal.list()).find(
      (r) => r.kind === "evm" && r.operationId === id,
    );
    return r
      ? {
          network: Types.chainOf(this.config.originAsset),
          transactionHash: r.hash,
          state: r.state,
          reservedGasWei: r.gasCapWei,
          actualGasWei:
            r.gasUsed && r.effectiveGasPrice
              ? String(uint(r.gasUsed) * uint(r.effectiveGasPrice))
              : null,
        }
      : null;
  }
}

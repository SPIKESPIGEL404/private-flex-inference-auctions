import { Credential } from "mppx";
import {
  hash,
  requireThat as check,
  uint,
  challengeIdentity,
} from "../../contract.mjs";
import { refundPlan, verifyRefund, verifyBinding } from "../../near.mjs";
import { Wallet } from "../../p3/wallet.mjs";
import { OperationStore } from "../../p3/store.mjs";
import { verifyPolicy } from "../../p3/outlayer.mjs";
import { LIVE_MODE } from "./policy.mjs";

export class AuctionWallet {
  scope = LIVE_MODE;
  durableOriginalOperations = true;
  constructor({ market, api, rpc, refundSender }) {
    Object.assign(this, { market, api, rpc, refundSender });
    this.pool = market.pool;
    this.plan = market.config.livePlan;
    this.store = new OperationStore(this.pool);
    this.wallet = new Wallet({
      store: this.store,
      api,
      rpc,
      policy: (b) => verifyPolicy({ binding: b, rpc, api }),
      authorize: async (f, { db }) => {
        // Same auction lock as revoke/expiry. The send intent commits before the
        // single OutLayer POST, and an unknown payer blocks every later intent.
        await db.query(
          "SELECT singleton FROM mpp_direct_auction_state WHERE singleton FOR UPDATE",
        );
        const a = (
          await db.query(
            "SELECT * FROM mpp_direct_auction_allocations WHERE order_id=$1",
            [f.challenge.request.orderRef],
          )
        ).rows[0];
        const at = Number(
          (
            await db.query(
              "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS at",
            )
          ).rows[0].at,
        );
        check(
          a &&
            a.agent_id === f.userId &&
            a.payment === "pending" &&
            a.execution === "reserved" &&
            at < a.contract.paymentBeforeMs &&
            at < this.plan.deadlineMs &&
            (await market.grantPermits(db, a, at)),
          "payment_authorization_closed",
        );
        check(
          uint(a.principal) <= uint(this.plan.principalCapYocto) &&
            f.gasReserveYocto === this.plan.gasReserveYocto,
          "mainnet_payment_limit_exceeded",
        );
        const row = (
          await db.query(
            `SELECT w.* FROM mpp_direct_p3_wallets w JOIN mpp_direct_live_wallet_agents x ON x.wallet_id=w.id
          WHERE x.agent_id=$1`,
            [a.agent_id],
          )
        ).rows[0];
        check(
          row?.state === "ready" && hash(row.binding) === hash(f.binding),
          "wallet_policy_not_ready",
        );
      },
    });
  }
  async prepare(op) {
    check(
      op.kind === "payment" && op.id === "pay-" + op.binding.orderId,
      "original_payment_required",
    );
    const a = (
      await this.pool.query(
        "SELECT * FROM mpp_direct_auction_allocations WHERE id=$1",
        [op.allocation_id],
      )
    ).rows[0];
    const row = (
      await this.pool.query(
        `SELECT w.binding FROM mpp_direct_p3_wallets w JOIN mpp_direct_live_wallet_agents x ON x.wallet_id=w.id
      WHERE x.agent_id=$1`,
        [a.agent_id],
      )
    ).rows[0];
    check(
      row?.binding && row.binding.payer === a.challenge.request.payer,
      "original_wallet_binding_required",
    );
    return this.wallet.prepare({
      challenge: op.binding.challenge,
      binding: row.binding,
      gasReserveYocto: a.contract.gasCapYocto,
      gasFloorYocto: this.plan.gasFloorYocto,
      nanoUsdPerNear: a.contract.fx.nanoUsdPerNear,
      taskId: (
        await this.pool.query(
          "SELECT task_budget FROM mpp_direct_auction_grants WHERE id=$1",
          [a.grant_id],
        )
      ).rows[0].task_budget,
      userId: a.agent_id,
    });
  }
  async proof(row) {
    if (row?.feeProof)
      await this.market.recordPaymentFee(row.orderRef, row.feeProof);
    if (!row?.proof) return null;
    // A paid transfer without the bound MPP signature must be refunded rather
    // than admitted. Captured principal remains recoverable after revocation.
    return {
      ...row.proof,
      late: row.proof.late || !row.credential || row.gasOverrun === true,
    };
  }
  async authorizationFor(orderId) {
    const row = await this.store.get("near-pay-v1-" + orderId);
    return row?.state === "final" && row.credential
      ? Credential.serialize(row.credential)
      : null;
  }
  async verifyPresentation(orderId, serialized) {
    check(
      typeof serialized === "string" && serialized.length <= 16384,
      "original_payment_credential_required",
    );
    const original = await this.store.get("near-pay-v1-" + orderId);
    let c;
    try {
      c = Credential.deserialize(serialized);
    } catch {
      throw Error("original_payment_credential_required");
    }
    check(
      original?.state === "final" &&
        original.credential &&
        original.proof &&
        c.payload.txHash === original.txHash &&
        c.payload.txHash === original.proof.txHash &&
        challengeIdentity(c.challenge) ===
          challengeIdentity(original.credential.challenge) &&
        hash(c.payload) === hash(original.credential.payload),
      "original_payment_credential_required",
    );
    verifyBinding(c.challenge, c.payload);
    await this.pool.query(
      "INSERT INTO mpp_direct_auction_presentations VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [orderId, hash(serialized), serialized],
    );
  }
  async payOriginal(op) {
    const row = await this.prepare(op);
    check(row.state !== "cancelled", "original_payment_sealed");
    return this.proof(await this.wallet.recover(row.id));
  }
  async recoverOriginal(op) {
    const row = await this.store.get("near-pay-v1-" + op.binding.orderId);
    if (!row || row.state === "prepared" || row.state === "cancelled")
      return null;
    return this.proof(await this.wallet.recover(row.id));
  }
  async sealOriginal(op) {
    const row = await this.prepare(op),
      sealed = await this.wallet.cancel(row.id);
    if (sealed.knownUnsent) return { operationId: op.id, state: "never_sent" };
    return this.proof(await this.wallet.recover(row.id));
  }
  async refundOriginal(op) {
    check(
      op.kind === "refund" && op.id === op.binding.operationId,
      "original_refund_required",
    );
    let plan = (
      await this.pool.query(
        "SELECT plan FROM mpp_direct_live_refund_plans WHERE id=$1",
        [op.id],
      )
    ).rows[0]?.plan;
    if (!plan) {
      const a = (
        await this.pool.query(
          "SELECT * FROM mpp_direct_auction_allocations WHERE id=$1",
          [op.allocation_id],
        )
      ).rows[0];
      check(
        a?.payment === "confirmed" &&
          String(a.refundable) === op.binding.amount,
        "refund_liability_required",
      );
      const candidate = refundPlan({
        orderRef: a.order_id,
        binding: a.challenge.request,
        amount: op.binding.amount,
        refundableYocto: String(a.refundable),
        operationId: op.id,
        createdAtMs: Date.now(),
      });
      await this.pool.query(
        "INSERT INTO mpp_direct_live_refund_plans VALUES($1,$2) ON CONFLICT DO NOTHING",
        [op.id, candidate],
      );
      plan = (
        await this.pool.query(
          "SELECT plan FROM mpp_direct_live_refund_plans WHERE id=$1",
          [op.id],
        )
      ).rows[0].plan;
    }
    const prepared = await this.refundSender.prepare(plan);
    let original = prepared;
    if (prepared.state !== "final") {
      // Query the original hash first; re-broadcasting the identical signed
      // bytes is safe and never creates a new nonce or refund identity.
      try {
        original = await this.refundSender.reconcile(plan.idempotencyKey);
      } catch {
        original = await this.refundSender.broadcast(plan.idempotencyKey);
      }
    }
    check(original.state === "final", "original_refund_unknown");
    const proof = await verifyRefund({
      plan,
      originalSend: {
        operationId: op.id,
        idempotencyKey: plan.idempotencyKey,
        planHash: hash(plan),
        txHash: original.txHash,
      },
      txHash: original.txHash,
      publicKey: this.refundSender.publicKey,
      rpc: this.rpc,
    });
    return {
      ...proof,
      operationId: op.id,
      orderId: plan.orderRef,
      sender: plan.sender,
      gasActualYocto: original.proof.gasActualYocto,
    };
  }
  async balance(payer) {
    check(
      (await this.rpc.call("status", [])).chain_id === "mainnet",
      "mainnet_rpc_required",
    );
    const at = Date.now();
    // Account creation is possible only after funding; unavailable RPC never
    // fabricates credit. Uncreated wallets simply cannot win an allocation.
    const r = await this.rpc.call("query", {
      request_type: "view_account",
      account_id: payer,
      finality: "final",
    });
    check(
      r.block_hash && Number.isSafeInteger(r.storage_usage),
      "final_account_required",
    );
    const available =
      uint(r.amount) -
      uint(r.locked) -
      BigInt(r.storage_usage) * uint(this.plan.storagePriceYocto) -
      uint(this.plan.gasFloorYocto);
    return {
      source: "near-rpc-final-v1",
      network: "mainnet",
      payer,
      availableYocto: String(available > 0n ? available : 0n),
      blockHash: r.block_hash,
      observedAtMs: at,
      expiresAtMs: at + 15000,
    };
  }
}

import { hash, requireThat as check, uint } from "../../contract.mjs";
import { verifyNativeTransfer } from "../../near.mjs";
import {
  paymentPolicy,
  publicKey,
  contractView,
  NETWORKS,
  verifyPolicy,
  uuid,
  WalletError,
} from "../../p3/outlayer.mjs";

// Owner exit is a separate explicit native operation, never a model purchase.
// One active original withdrawal per wallet; lost ACK cannot mint a replacement.
export class OwnerWithdrawal {
  constructor(setup) {
    this.setup = setup;
    Object.assign(this, {
      pool: setup.pool,
      market: setup.market,
      api: setup.api,
      rpc: setup.rpc,
      wallet: setup.wallet,
    });
  }
  async row(owner, id, db = this.pool) {
    const r = (
      await db.query(
        "SELECT * FROM mpp_direct_live_withdrawals WHERE owner_id=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0];
    check(r, "unknown_withdrawal");
    return r;
  }
  view(r) {
    return {
      id: r.id,
      walletId: r.wallet_id,
      state: r.state,
      amount: r.plan.amount,
      recipient: r.plan.recipient,
      txHash: r.tx_hash ?? null,
      gasActualYocto: r.evidence?.gasActualYocto ?? null,
      ...(r.policy_tx
        ? { transaction: r.policy_tx, policyVersion: r.binding.policy.version }
        : {}),
    };
  }
  async closed(db, walletId) {
    const a = (
      await db.query(
        "SELECT agent_id FROM mpp_direct_live_wallet_agents WHERE wallet_id=$1",
        [walletId],
      )
    ).rows[0];
    check(a, "unknown_agent");
    const agent = (
      await db.query(
        "SELECT active FROM mpp_direct_auction_agents WHERE id=$1",
        [a.agent_id],
      )
    ).rows[0];
    check(!agent.active, "stop_agent_before_withdrawal");
    check(
      !(
        await db.query(
          "SELECT id FROM mpp_direct_auction_allocations WHERE agent_id=$1 AND NOT budget_finalized",
          [a.agent_id],
        )
      ).rowCount,
      "original_liabilities_pending",
    );
    check(
      !(
        await db.query(
          "SELECT id FROM mpp_direct_p3_operations WHERE user_id=$1 AND state IN('sending','unknown','review')",
          [a.agent_id],
        )
      ).rowCount,
      "original_payment_unknown",
    );
  }
  async prepare(owner, walletId, input) {
    check(
      input.confirmExit === true &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(input.operation),
      "explicit_owner_exit_required",
    );
    const w = await this.setup.onboarding.row(owner, walletId);
    check(
      w.binding?.policy?.controller === owner,
      "wallet_controller_required",
    );
    // Fence purchases BEFORE any owner policy change. The existing freeze
    // preparation only returns a transaction; the exit installs its own policy.
    await this.setup.freeze(owner, walletId);
    const old = (
      await this.pool.query(
        "SELECT * FROM mpp_direct_live_withdrawals WHERE wallet_id=$1 AND owner_id=$2 AND state NOT IN('final','cancelled')",
        [walletId, owner],
      )
    ).rows[0];
    if (old?.policy_tx) return this.view(old);
    const latest = (
      await this.pool.query(
        "SELECT binding FROM mpp_direct_live_withdrawals WHERE wallet_id=$1 AND owner_id=$2 AND binding IS NOT NULL ORDER BY (plan->>'createdAtMs')::bigint DESC LIMIT 1",
        [walletId, owner],
      )
    ).rows[0];
    const sourceBinding = latest?.binding ?? w.binding;
    let row = old;
    if (!row) {
      const balance = await this.wallet.balance(w.binding.payer),
        amount =
          uint(balance.availableYocto) -
          uint(this.market.config.livePlan.gasReserveYocto);
      check(
        amount > 0n && amount <= 10n ** 23n,
        "withdrawal_balance_unavailable",
      );
      const id = hash(["owner-exit", walletId, input.operation]),
        plan = {
          network: "mainnet",
          payer: w.binding.payer,
          recipient: owner,
          amount: String(amount),
          publicKey: w.binding.publicKey,
          createdAtMs: Date.now(),
          gasCapYocto: this.market.config.livePlan.gasReserveYocto,
        };
      await this.market.transaction(async (db) => {
        await this.closed(db, walletId);
        check(
          Number(
            (
              await db.query(
                "SELECT count(*) FROM mpp_direct_live_withdrawals WHERE wallet_id=$1",
                [walletId],
              )
            ).rows[0].count,
          ) < 8,
          "owner_exit_count_limit",
        );
        await db.query(
          "INSERT INTO mpp_direct_live_withdrawals(id,wallet_id,owner_id,plan,state) VALUES($1,$2,$3,$4,'policy') ON CONFLICT DO NOTHING",
          [id, walletId, owner, plan],
        );
      });
      row = (
        await this.pool.query(
          "SELECT * FROM mpp_direct_live_withdrawals WHERE wallet_id=$1 AND owner_id=$2 ORDER BY (plan->>'createdAtMs')::bigint DESC LIMIT 1",
          [walletId, owner],
        )
      ).rows[0];
      check(row, "original_owner_exit_required");
    }
    const policy = paymentPolicy({
      merchant: owner,
      realm: this.market.config.realm,
      maximumYocto: row.plan.amount,
    });
    policy.capabilities.sign_message = { allowed: false };
    const encrypted = await this.api.encrypt(w.binding, policy),
      signed = await this.api.signPolicy(
        w.binding,
        encrypted.encrypted_base64,
        owner,
      );
    check(
      publicKey("ed25519:" + signed.public_key_hex).base58 ===
        w.binding.publicKey &&
        signed.version === sourceBinding.policy.version + 1 &&
        signed.locked === false &&
        Number.isSafeInteger(signed.valid_until) &&
        signed.valid_until * 1000 > Date.now() &&
        signed.policy_hash === encrypted.policy_hash,
      "owner_exit_policy_binding_mismatch",
    );
    const args = {
      wallet_pubkey: "ed25519:" + signed.public_key_hex,
      encrypted_data: encrypted.encrypted_base64,
      wallet_signature: signed.signature_hex,
      version: signed.version,
      locked: false,
      valid_until: signed.valid_until,
      storage_refund_to: null,
    };
    const deposit = await contractView(
      this.rpc,
      NETWORKS.mainnet.contract,
      "estimate_wallet_policy_cost",
      {
        wallet_pubkey: args.wallet_pubkey,
        encrypted_data: args.encrypted_data,
        storage_refund_to: null,
      },
    );
    uint(deposit);
    const transaction = {
      signerId: owner,
      receiverId: NETWORKS.mainnet.contract,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "store_wallet_policy",
            args,
            gas: "30000000000000",
            deposit,
          },
        },
      ],
    };
    const binding = {
      ...w.binding,
      policy: {
        controller: owner,
        version: signed.version,
        encryptedHash: hash(args.encrypted_data),
        plainHash: hash(policy),
      },
    };
    await this.pool.query(
      "UPDATE mpp_direct_live_withdrawals SET policy=$2,binding=$3,policy_tx=$4 WHERE id=$1 AND policy_tx IS NULL",
      [row.id, policy, binding, transaction],
    );
    await this.pool.query(
      "UPDATE mpp_direct_p3_wallets SET state='exiting' WHERE id=$1",
      [walletId],
    );
    return this.view(await this.row(owner, row.id));
  }
  async confirm(owner, id) {
    const row = await this.row(owner, id);
    check(row.binding && row.policy_tx, "owner_exit_policy_required");
    await verifyPolicy({ binding: row.binding, rpc: this.rpc, api: this.api });
    const current = await this.api.request(
      row.binding.credentialRef,
      "/wallet/v1/policy",
    );
    check(
      hash(current.rules) === hash(row.policy.rules) &&
        hash(current.capabilities) === hash(row.policy.capabilities) &&
        !current.frozen &&
        current.approval == null,
      "owner_exit_policy_readback_mismatch",
    );
    await this.market.transaction(async (db) => {
      await this.closed(db, row.wallet_id);
      await db.query(
        "UPDATE mpp_direct_live_withdrawals SET state='prepared' WHERE id=$1 AND state='policy'",
        [id],
      );
    });
    return this.view(await this.row(owner, id));
  }
  async recover(owner, id, { send = false } = {}) {
    let row = await this.row(owner, id);
    const db = await this.pool.connect();
    let locked = false;
    try {
      // Same cross-process sender lock as inference payments.
      await db.query(
        "SELECT pg_advisory_lock(hashtextextended('outlayer-sender:' || $1,0))",
        [row.plan.payer],
      );
      locked = true;
      row = await this.row(owner, id, db);
      if (["final", "cancelled", "review", "policy"].includes(row.state))
        return this.view(row);
      if (row.state === "prepared") {
        if (!send) return this.view(row);
        await verifyPolicy({
          binding: row.binding,
          rpc: this.rpc,
          api: this.api,
        });
        await db.query("BEGIN");
        try {
          await db.query(
            "SELECT singleton FROM mpp_direct_auction_state WHERE singleton FOR UPDATE",
          );
          await this.closed(db, row.wallet_id);
          await db.query(
            "UPDATE mpp_direct_live_withdrawals SET state='sending' WHERE id=$1 AND state='prepared'",
            [id],
          );
          await db.query("COMMIT");
        } catch (e) {
          await db.query("ROLLBACK");
          throw e;
        }
        // Commit the single POST intent first. Never resend even on ACK loss.
        try {
          const result = await this.api.transfer(
            row.binding,
            { to: row.plan.recipient, amount: row.plan.amount },
            "owner-exit-" + id,
          );
          await this.capture(db, row, result);
        } catch (e) {
          if (e instanceof WalletError && e.definiteRefusal) {
            await db.query(
              "UPDATE mpp_direct_live_withdrawals SET state='cancelled' WHERE id=$1",
              [id],
            );
            return this.view(await this.row(owner, id, db));
          }
          if (e instanceof WalletError && (e.requestId || e.txHash))
            await this.capture(db, row, {
              request_id: e.requestId,
              tx_hash: e.txHash,
              status: "failed",
            });
          else {
            await db.query(
              "UPDATE mpp_direct_live_withdrawals SET state='review' WHERE id=$1",
              [id],
            );
            return this.view(await this.row(owner, id, db));
          }
        }
        row = await this.row(owner, id, db);
      }
      if (!row.tx_hash && row.request_id) {
        await this.capture(
          db,
          row,
          await this.api.status(row.binding, row.request_id),
        );
        row = await this.row(owner, id, db);
      }
      if (!row.tx_hash && !row.request_id) {
        await db.query(
          "UPDATE mpp_direct_live_withdrawals SET state='review' WHERE id=$1",
          [id],
        );
        return this.view(await this.row(owner, id, db));
      }
      if (!row.tx_hash) return this.view(row);
      const tx = await this.rpc.transaction(row.tx_hash, row.plan.payer);
      check(
        Number.isSafeInteger(tx.transaction?.nonce) &&
          tx.transaction.nonce > 0 &&
          tx.transaction.nonce_index == null,
        "ordinary_agent_gas_required",
      );
      const cached = Object.create(this.rpc);
      cached.transaction = async () => tx;
      const proof = await verifyNativeTransfer({
        rpc: cached,
        p: { txHash: row.tx_hash, publicKey: row.plan.publicKey },
        r: {
          ...row.plan,
          orderRef: id,
          issuedAtMs: row.plan.createdAtMs,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        },
        challengeId: id,
      });
      let gas = uint(tx.transaction_outcome.outcome.tokens_burnt);
      for (const r of tx.receipts_outcome) gas += uint(r.outcome.tokens_burnt);
      await db.query(
        "UPDATE mpp_direct_live_withdrawals SET state='final',evidence=$2 WHERE id=$1",
        [
          id,
          {
            ...proof,
            gasPayer: row.plan.payer,
            gasActualYocto: String(gas),
            gasOverrun: gas > uint(row.plan.gasCapYocto),
          },
        ],
      );
      return this.view(await this.row(owner, id, db));
    } finally {
      if (locked)
        await db
          .query(
            "SELECT pg_advisory_unlock(hashtextextended('outlayer-sender:' || $1,0))",
            [row.plan.payer],
          )
          .catch(() => {});
      db.release();
    }
  }
  async capture(db, row, result) {
    check(
      !result.type || result.type === "transfer",
      "owner_exit_operation_type_conflict",
    );
    check(
      [
        "success",
        "processing",
        "failed",
        "needs_review",
        "pending_approval",
        "approved",
      ].includes(result.status),
      "owner_exit_status_unknown",
    );
    const requestId = uuid(result.request_id) ? result.request_id : null,
      txHash = result.tx_hash ?? result.result?.tx_hash ?? null;
    check(
      (!row.request_id || !requestId || row.request_id === requestId) &&
        (!row.tx_hash || !txHash || row.tx_hash === txHash),
      "owner_exit_identity_conflict",
    );
    await db.query(
      "UPDATE mpp_direct_live_withdrawals SET state=$2,request_id=COALESCE(request_id,$3),tx_hash=COALESCE(tx_hash,$4) WHERE id=$1",
      [
        row.id,
        ["needs_review", "pending_approval", "approved"].includes(
          result.status,
        ) ||
        (!requestId && !txHash)
          ? "review"
          : "unknown",
        requestId,
        txHash,
      ],
    );
  }
}

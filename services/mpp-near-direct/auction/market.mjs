import { randomBytes } from "node:crypto";
import { Challenge, Credential } from "mppx";
import {
  METHOD,
  hash,
  challengeIdentity,
  requireThat as check,
  validateRequest,
  uint,
} from "../contract.mjs";
import { verifyPayment } from "../near.mjs";
import { LIVE_MODE, validateLivePlan } from "./live/policy.mjs";
import { TOOL } from "../p2/tool-schema.mjs";
import {
  clearRound,
  settleUsage,
  validateClass,
  YOCTO,
  ceil,
} from "./contracts.mjs";

// This module is the single native-auction writer, not a gateway winner picker.
// All bid membership, grants, native liability, pool ownership, contracts and
// operation intents commit in the owning Market PG transaction. Native signing
// and settlement are outside it. Intents quote creation is bounded HTTP inside
// the allocation transaction; settlement polling never holds the Market lock.
export class AuctionMarket {
  constructor({ pool, config, fault = () => {}, live, paymentRail }) {
    check(
      (config.paymentMethod === "nearintents") === !!paymentRail,
      "explicit_auction_payment_method_required",
    );
    if (config.paymentMethod === "nearintents") {
      check(
        paymentRail?.method === "nearintents" &&
          config.billing === "auction-fixed-request-v1",
        "nearintents_auction_adapter_required",
      );
      paymentRail.validateConfiguration(config, live);
    }
    if (config.mode === LIVE_MODE) {
      const { planHash } = validateLivePlan(config.livePlan, {
        allowExpired: true,
      });
      check(
        config.reviewedPlanHash === planHash &&
          live?.scope === LIVE_MODE &&
          config.network === "mainnet" &&
          config.realBroadcastEnabled === true &&
          config.merchant === config.livePlan.merchant &&
          config.realm === config.livePlan.realm &&
          hash(config.service) === hash(config.livePlan.service),
        "reviewed_mainnet_adapters_required",
      );
    } else if (config.mode !== "bounded-nearintents-auction-v1")
      check(
        config.mode === "controlled" &&
          config.network === "testnet" &&
          config.realBroadcastEnabled === false,
        "real_auction_gate_closed",
      );
    validateClass(config.service);
    check(
      config.service.capacityPoolId === "single-seller-1" &&
        config.capacity === 1,
      "one_exclusive_pool_required",
    );
    check(
      ["first-price-v1", "fifo-v1"].includes(config.rule) &&
        Number.isSafeInteger(config.windowMs) &&
        config.windowMs >= 10 &&
        config.windowMs <= 60000,
      "invalid_round_configuration",
    );
    check(
      typeof config.secret === "string" && config.secret.length >= 32,
      "auction_secret_required",
    );
    check(
      config.paymentWindowMs > 0 &&
        config.paymentWindowMs <= (paymentRail ? 600000 : 120000) &&
        config.admissionWindowMs >= config.paymentWindowMs &&
        config.admissionWindowMs <= (paymentRail ? 900000 : 180000),
      "invalid_payment_windows",
    );
    check(
      config.mode !== "bounded-nearintents-auction-v1" || paymentRail,
      "nearintents_auction_adapter_required",
    );
    Object.assign(this, { pool, config, fault, live, paymentRail });
  }
  async initialize() {
    const { secret, ...publicConfig } = this.config;
    const configuration = { ...publicConfig, secretHash: hash(secret) };
    const now = Date.now(),
      cutoff =
        Math.floor(now / this.config.windowMs) * this.config.windowMs +
        this.config.windowMs;
    await this.pool.query(
      "INSERT INTO mpp_direct_auction_state(singleton,configuration,next_cutoff_ms) VALUES(true,$1,$2) ON CONFLICT DO NOTHING",
      [configuration, cutoff],
    );
    const row = (
      await this.pool.query(
        "SELECT configuration FROM mpp_direct_auction_state WHERE singleton",
      )
    ).rows[0];
    check(
      hash(row.configuration) === hash(configuration),
      "auction_configuration_changed",
    );
  }
  async transaction(fn) {
    for (let attempt = 0; ; attempt++) {
      const db = await this.pool.connect();
      let failed = false;
      try {
        await db.query("BEGIN");
        const state = (
          await db.query(
            "SELECT * FROM mpp_direct_auction_state WHERE singleton FOR UPDATE",
          )
        ).rows[0];
        check(state, "auction_not_initialized");
        // Same physical pool row used by all legacy purchases. The installed source
        // guard rejects legacy acquisitions in this opt-in exclusive auction mode.
        const cap = (
          await db.query(
            "SELECT * FROM mpp_direct_capacity WHERE id=1 FOR UPDATE",
          )
        ).rows[0];
        check(
          cap && !cap.lease_order && cap.admissions === 0,
          "capacity_not_exclusively_owned",
        );
        const at = Number(
          (
            await db.query(
              "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms",
            )
          ).rows[0].ms,
        );
        const result = await fn(db, state, at);
        await this.fault("before_commit");
        await db.query("COMMIT");
        await this.fault("after_commit");
        return result;
      } catch (e) {
        failed = true;
        await db.query("ROLLBACK").catch(() => {});
        if (["40001", "40P01"].includes(e.code) && attempt < 3) continue;
        throw e;
      } finally {
        db.release(failed);
      }
    }
  }
  async authenticate(token) {
    const a = (
      await this.pool.query(
        "SELECT * FROM mpp_direct_auction_agents WHERE credential_hash=$1 AND active",
        [hash(token)],
      )
    ).rows[0];
    check(a, "unauthorized");
    return a;
  }
  async event(db, id, kind, at, value) {
    await db.query(
      "INSERT INTO mpp_direct_auction_events(allocation_id,kind,at_ms,value) VALUES($1,$2,$3,$4)",
      [id, kind, at, value],
    );
  }
  async snapshot(db, at, cutoff) {
    const supplyReady =
      (!this.live || (await this.live.ready(db, at))) &&
      (!this.paymentRail ||
        !(
          await db.query(
            "SELECT FROM mpp_direct_auction_allocations WHERE refundable>0 LIMIT 1",
          )
        ).rowCount);
    const rows = (
      await db.query(
        `SELECT b.*,g.active AS grant_active,g.revision AS grant_revision,g.deadline_ms AS grant_deadline,g.gas_cap_yocto::text,
   g.task_budget,g.call_cap_micro,a.owner_budget,a.agent_budget,a.active AS agent_active,a.payer,a.balance,a.native_reserved::text
   FROM mpp_direct_auction_bids b JOIN mpp_direct_auction_grants g ON g.id=b.grant_id JOIN mpp_direct_auction_agents a ON a.id=b.agent_id
   WHERE b.state='active' AND b.accepted_ms<$1 ORDER BY b.accepted_sequence`,
        [cutoff],
      )
    ).rows;
    const budgets = (
      await db.query(
        "SELECT * FROM mpp_direct_auction_budgets ORDER BY id FOR UPDATE",
      )
    ).rows;
    const balances = Object.fromEntries(
      budgets.map((b) => [
        b.id,
        String(
          BigInt(b.cap_nano) - BigInt(b.reserved_nano) - BigInt(b.spent_nano),
        ),
      ]),
    );
    const bids = rows.map((b) => {
      const balance = b.balance;
      const fresh =
        balance?.source ===
          (this.live ? "near-rpc-final-v1" : "controlled-native-final-v1") &&
        balance.network === this.config.network &&
        balance.payer === b.payer &&
        balance.observedAtMs <= at &&
        at < balance.expiresAtMs;
      balances["wallet:" + b.agent_id] = this.paymentRail
        ? this.paymentRail.spendCapacity(balance, b, at)
        : fresh
          ? String(
              BigInt(balance.availableYocto) > BigInt(b.native_reserved)
                ? BigInt(balance.availableYocto) - BigInt(b.native_reserved)
                : 0n,
            )
          : "0";
      if (this.live) {
        const limit =
          BigInt(this.config.livePlan.principalCapYocto) +
          BigInt(b.gas_cap_yocto);
        if (BigInt(balances["wallet:" + b.agent_id]) > limit)
          balances["wallet:" + b.agent_id] = String(limit);
      }
      const keys = [b.owner_budget, b.agent_budget, b.task_budget];
      return {
        id: b.id,
        revision: String(b.revision),
        state: b.state,
        acceptedAtMs: Number(b.accepted_ms),
        acceptedSequence: String(b.accepted_sequence),
        expiryMs: Number(b.expiry_ms),
        deadlineMs: Number(b.grant_deadline),
        serviceClassVersion: b.service_version,
        bidMultiplier: String(b.bid_multiplier),
        maxTotalMicro: String(b.max_total_micro),
        gasCapYocto: b.gas_cap_yocto,
        budgetKeys: keys,
        walletKey: "wallet:" + b.agent_id,
        authorized:
          supplyReady &&
          (!this.live || at < this.config.livePlan.deadlineMs) &&
          b.grant_active &&
          b.agent_active &&
          Number(b.grant_deadline) > at &&
          keys.every((k) =>
            budgets.some(
              (v) => v.id === k && v.active && Number(v.deadline_ms) > at,
            ),
          ),
      };
    });
    return { bids, balances, rows };
  }
  async advance(db, state, at) {
    if (at < Number(state.next_cutoff_ms)) return null;
    const cutoff = Number(state.next_cutoff_ms),
      snapshot = await this.snapshot(db, at, cutoff);
    const inputs = {
      bids: snapshot.bids,
      balances: snapshot.balances,
      cutoffMs: cutoff,
      clearedAtMs: at,
      capacity: state.capacity_allocation ? 0 : 1,
      service: this.config.service,
      fx: this.live ? await this.live.fx(db, at) : this.config.fx,
      paymentWindowMs: this.config.paymentWindowMs,
      admissionWindowMs: this.config.admissionWindowMs,
      ...(this.paymentRail ? { billing: this.config.billing } : {}),
      rule: this.config.rule,
    };
    const result = clearRound(inputs),
      roundId = hash([this.config.service.serviceClassVersion, cutoff]);
    await db.query(
      "INSERT INTO mpp_direct_auction_rounds VALUES($1,$2,$3,$4,$5,$6)",
      [roundId, cutoff, at, inputs, result, hash(result)],
    );
    for (const winner of result.results.filter((r) => r.outcome === "won")) {
      const b = snapshot.rows.find((b) => b.id === winner.id),
        c = winner.contract;
      // One unpaid allocation per agent, enforced on submission as well as here.
      check(
        !(
          await db.query(
            "SELECT FROM mpp_direct_auction_allocations WHERE agent_id=$1 AND payment IN('not_started','pending','unknown')",
            [b.agent_id],
          )
        ).rowCount,
        "agent_unpaid_allocation_limit",
      );
      const id = hash([roundId, b.id, winner.revision]),
        order = id,
        execution = "exec-" + id,
        payment = "pay-" + id,
        refund = "refund-" + id;
      let challenge;
      if (this.paymentRail)
        challenge = await this.paymentRail.challenge(db, {
          id,
          agentId: b.agent_id,
          payer: b.payer,
          contract: c,
          requestHash: b.request_hash,
        });
      else {
        const request = {
          version: 1,
          network: this.config.network,
          currency: "NEAR",
          decimals: 24,
          amount: c.principalYocto,
          recipient: this.config.merchant,
          payer: (
            await db.query(
              "SELECT payer FROM mpp_direct_auction_agents WHERE id=$1",
              [b.agent_id],
            )
          ).rows[0].payer,
          bindingVersion: (
            await db.query(
              "SELECT binding_version FROM mpp_direct_auction_agents WHERE id=$1",
              [b.agent_id],
            )
          ).rows[0].binding_version,
          orderRef: order,
          termsHash: c.contractHash,
          nativeRequestHash: b.request_hash,
          nonce: randomBytes(32).toString("base64"),
          issuedAtMs: at,
          expiresAtMs: c.paymentBeforeMs,
          signingRecipient: this.config.realm,
        };
        request.refundTo = request.payer;
        validateRequest(request);
        challenge = Challenge.from({
          secretKey: this.config.secret,
          realm: this.config.realm,
          method: METHOD,
          intent: "charge",
          request,
          expires: new Date(c.paymentBeforeMs).toISOString(),
          header: "Payment-Authorization",
        });
      }
      await db.query(
        `INSERT INTO mpp_direct_auction_allocations(id,round_id,bid_id,bid_revision,agent_id,grant_id,grant_revision,contract,challenge,
    order_id,execution_id,payment_operation,refund_operation,principal,reserve_nano) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$1,$10,$11,$12,$13,$14)`,
        [
          id,
          roundId,
          b.id,
          b.revision,
          b.agent_id,
          b.grant_id,
          b.grant_revision,
          c,
          challenge,
          execution,
          payment,
          refund,
          c.principalYocto,
          c.reserveNano,
        ],
      );
      for (const key of [b.owner_budget, b.agent_budget, b.task_budget])
        await db.query(
          "UPDATE mpp_direct_auction_budgets SET reserved_nano=reserved_nano+$2 WHERE id=$1",
          [key, c.reserveNano],
        );
      await db.query(
        "UPDATE mpp_direct_auction_agents SET native_reserved=native_reserved+$2 WHERE id=$1",
        [b.agent_id, String(BigInt(c.principalYocto) + BigInt(c.gasCapYocto))],
      );
      await db.query(
        "INSERT INTO mpp_direct_auction_operations(id,allocation_id,kind,binding) VALUES($1,$2,'payment',$3),($4,$2,'execute',$5)",
        [
          payment,
          id,
          { orderId: order, challenge, gasCapYocto: c.gasCapYocto },
          execution,
          {
            executionId: execution,
            requestHash: b.request_hash,
            contractHash: c.contractHash,
          },
        ],
      );
      await db.query(
        "UPDATE mpp_direct_auction_bids SET state='allocated' WHERE id=$1",
        [b.id],
      );
      await db.query(
        "UPDATE mpp_direct_auction_state SET capacity_allocation=$1 WHERE singleton",
        [id],
      );
      state.capacity_allocation = id;
      await this.event(db, id, "allocated", at, {
        roundId,
        bidId: b.id,
        revision: String(b.revision),
        contractHash: c.contractHash,
      });
    }
    await db.query(
      "UPDATE mpp_direct_auction_bids SET state='expired' WHERE state='active' AND expiry_ms<=$1",
      [at],
    );
    state.next_cutoff_ms =
      Math.floor(at / this.config.windowMs) * this.config.windowMs +
      this.config.windowMs;
    await db.query(
      "UPDATE mpp_direct_auction_state SET next_cutoff_ms=$1 WHERE singleton",
      [state.next_cutoff_ms],
    );
    return { roundId, ...result };
  }
  async clear() {
    return this.transaction((db, state, at) => this.advance(db, state, at));
  }
  validateBody(raw) {
    check(
      typeof raw === "string" && Buffer.byteLength(raw) <= 120 * 1024,
      "invalid_native_request",
    );
    const b = JSON.parse(raw),
      s = this.config.service;
    check(
      b &&
        Object.keys(b).every((k) =>
          [
            "model",
            "messages",
            "max_completion_tokens",
            "max_tokens",
            "temperature",
            "stream",
            "stream_options",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "top_p",
          ].includes(k),
        ),
      "unsupported_native_request",
    );
    check(
      b.model === s.model &&
        Array.isArray(b.messages) &&
        b.messages.length > 0 &&
        b.messages.length <= 64,
      "service_scope_mismatch",
    );
    const max = b.max_completion_tokens ?? b.max_tokens;
    check(
      Number.isSafeInteger(max) && max > 0 && max <= s.maxOutputTokens,
      "unsupported_output_limit",
    );
    check(
      !b.tools ||
        (Array.isArray(b.tools) &&
          b.tools.length === 1 &&
          b.tools[0].function?.name === "bash" &&
          b.tools[0].type === "function" &&
          hash(b.tools[0].function.parameters) === hash(TOOL.inputSchema)),
      "unsupported_tools",
    );
    if (this.live) this.live.qualify(b, raw);
    return b;
  }
  async submit(agentId, input) {
    const {
      operation,
      grantId,
      logicalCallId,
      body,
      requestHash,
      bidMultiplier,
      maxTotalMicro,
      expiryMs,
    } = input;
    check(
      /^[a-zA-Z0-9_-]{1,128}$/.test(operation) &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(logicalCallId),
      "invalid_operation",
    );
    this.validateBody(body);
    check(hash(body) === requestHash, "request_hash_mismatch");
    check(
      uint(bidMultiplier) > 0n &&
        uint(bidMultiplier) <= 100000000n &&
        uint(maxTotalMicro) > 0n,
      "invalid_bid",
    );
    check(Number.isSafeInteger(expiryMs), "invalid_expiry");
    const fingerprint = hash(input);
    return this.transaction(async (db, state, at) => {
      await this.advance(db, state, at);
      const old = (
        await db.query(
          "SELECT * FROM mpp_direct_auction_commands WHERE agent_id=$1 AND operation=$2",
          [agentId, operation],
        )
      ).rows[0];
      if (old) {
        check(old.fingerprint === fingerprint, "idempotency_conflict");
        return old.result;
      }
      const grant = (
        await db.query(
          `SELECT g.*,a.active AS agent_active FROM mpp_direct_auction_grants g JOIN mpp_direct_auction_agents a ON a.id=g.agent_id WHERE g.id=$1 AND g.agent_id=$2`,
          [grantId, agentId],
        )
      ).rows[0];
      check(
        grant?.active && grant.agent_active && Number(grant.deadline_ms) > at,
        "authorization_inactive",
      );
      check(
        expiryMs > at &&
          expiryMs <= Number(grant.deadline_ms) &&
          BigInt(maxTotalMicro) <= BigInt(grant.call_cap_micro),
        "bid_outside_authorization",
      );
      const existing = (
        await db.query(
          "SELECT * FROM mpp_direct_auction_bids WHERE agent_id=$1 AND logical_call=$2",
          [agentId, logicalCallId],
        )
      ).rows[0];
      check(!existing, "logical_call_conflict");
      check(
        !(
          await db.query(
            "SELECT FROM mpp_direct_auction_bids WHERE agent_id=$1 AND state='active' AND expiry_ms>$2",
            [agentId, at],
          )
        ).rowCount,
        "agent_active_bid_limit",
      );
      check(
        !(
          await db.query(
            "SELECT FROM mpp_direct_auction_allocations WHERE agent_id=$1 AND payment IN('not_started','pending','unknown')",
            [agentId],
          )
        ).rowCount,
        "agent_unpaid_allocation_limit",
      );
      const id = hash([agentId, logicalCallId]);
      state.sequence = BigInt(state.sequence) + 1n;
      await db.query(
        `INSERT INTO mpp_direct_auction_bids(id,agent_id,grant_id,logical_call,request_hash,body,service_version,bid_multiplier,max_total_micro,expiry_ms,accepted_sequence,accepted_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          agentId,
          grantId,
          logicalCallId,
          requestHash,
          body,
          this.config.service.serviceClassVersion,
          bidMultiplier,
          maxTotalMicro,
          expiryMs,
          String(state.sequence),
          at,
        ],
      );
      await db.query(
        "UPDATE mpp_direct_auction_state SET sequence=$1 WHERE singleton",
        [String(state.sequence)],
      );
      const result = {
        bidId: id,
        revision: "0",
        state: "waiting",
        logicalCallId,
      };
      await db.query(
        "INSERT INTO mpp_direct_auction_revisions VALUES($1,0,$2)",
        [
          id,
          {
            ...input,
            acceptedSequence: String(state.sequence),
            acceptedAtMs: at,
          },
        ],
      );
      await db.query(
        "INSERT INTO mpp_direct_auction_commands VALUES($1,$2,$3,$4)",
        [agentId, operation, fingerprint, result],
      );
      return result;
    });
  }
  async revise(agentId, bidId, input) {
    check(/^[a-zA-Z0-9_-]{1,128}$/.test(input.operation), "invalid_operation");
    const fingerprint = hash([bidId, input]);
    return this.transaction(async (db, state, at) => {
      await this.advance(db, state, at);
      const old = (
        await db.query(
          "SELECT * FROM mpp_direct_auction_commands WHERE agent_id=$1 AND operation=$2",
          [agentId, input.operation],
        )
      ).rows[0];
      if (old) {
        check(old.fingerprint === fingerprint, "idempotency_conflict");
        return old.result;
      }
      const b = (
        await db.query(
          "SELECT * FROM mpp_direct_auction_bids WHERE id=$1 AND agent_id=$2",
          [bidId, agentId],
        )
      ).rows[0];
      check(
        b && String(b.revision) === input.expectedRevision,
        "revision_conflict",
      );
      check(b.state === "active", "bid_already_frozen");
      check(
        at - Number(b.accepted_ms) >=
          (this.config.minRevisionIntervalMs ?? 100),
        "bid_revision_rate_limit",
      );
      check(
        input.action === "withdraw" ||
          (input.action === "revise" &&
            uint(input.bidMultiplier) > 0n &&
            uint(input.bidMultiplier) <= 100000000n),
        "invalid_bid_control",
      );
      state.sequence = BigInt(state.sequence) + 1n;
      const revision = String(BigInt(b.revision) + 1n),
        status = input.action === "withdraw" ? "withdrawn" : "active";
      await db.query(
        "UPDATE mpp_direct_auction_bids SET revision=$2,bid_multiplier=$3,state=$4,accepted_sequence=$5,accepted_ms=$6 WHERE id=$1",
        [
          bidId,
          revision,
          input.action === "withdraw" ? b.bid_multiplier : input.bidMultiplier,
          status,
          String(state.sequence),
          at,
        ],
      );
      await db.query(
        "UPDATE mpp_direct_auction_state SET sequence=$1 WHERE singleton",
        [String(state.sequence)],
      );
      const result = { bidId, revision, state: status };
      await db.query(
        "INSERT INTO mpp_direct_auction_revisions VALUES($1,$2,$3)",
        [
          bidId,
          revision,
          {
            ...input,
            acceptedAtMs: at,
            acceptedSequence: String(state.sequence),
          },
        ],
      );
      await db.query(
        "INSERT INTO mpp_direct_auction_commands VALUES($1,$2,$3,$4)",
        [agentId, input.operation, fingerprint, result],
      );
      return result;
    });
  }
  async allocation(db, id) {
    const a = (
      await db.query(
        "SELECT * FROM mpp_direct_auction_allocations WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    check(a, "unknown_allocation");
    return a;
  }
  async releaseCapacity(db, a) {
    await db.query(
      "UPDATE mpp_direct_auction_state SET capacity_allocation=NULL WHERE capacity_allocation=$1",
      [a.id],
    );
  }
  async fence(id) {
    return this.transaction(async (db, _state, at) => {
      const a = await this.allocation(db, id);
      if (
        ["executing", "unknown", "result_available", "failed"].includes(
          a.execution,
        )
      )
        return { state: a.execution, released: false };
      await db.query(
        "UPDATE mpp_direct_auction_allocations SET execution='fenced',generation=generation+1,refundable=CASE WHEN payment='confirmed' THEN principal ELSE 0 END WHERE id=$1",
        [id],
      );
      await this.releaseCapacity(db, a);
      if (a.payment === "confirmed")
        await this.prepareRefund(db, a, at, a.principal);
      await this.event(db, id, "execution_fenced", at, {});
      return { state: "fenced", released: true };
    });
  }
  async expire() {
    const ids = (
      await this.pool.query(
        "SELECT id FROM mpp_direct_auction_allocations WHERE execution IN('reserved','ready') AND (contract->>'admissionBeforeMs')::bigint<=floor(extract(epoch FROM clock_timestamp())*1000)",
      )
    ).rows;
    for (const a of ids) await this.fence(a.id);
  }
  async grantPermits(db, a, at) {
    if (this.live && !(await this.live.ready(db, at))) return false;
    const g = (
      await db.query(
        "SELECT g.*,x.owner_budget,x.agent_budget,x.active AS agent_active FROM mpp_direct_auction_grants g JOIN mpp_direct_auction_agents x ON x.id=g.agent_id WHERE g.id=$1",
        [a.grant_id],
      )
    ).rows[0];
    if (
      (this.live && at >= this.config.livePlan.deadlineMs) ||
      !g?.active ||
      !g.agent_active ||
      String(g.revision) !== String(a.grant_revision) ||
      at >= Number(g.deadline_ms)
    )
      return false;
    const scopes = [g.owner_budget, g.agent_budget, g.task_budget];
    const rows = (
      await db.query(
        "SELECT * FROM mpp_direct_auction_budgets WHERE id=ANY($1)",
        [scopes],
      )
    ).rows;
    return (
      rows.length === 3 &&
      rows.every((b) => b.active && at < Number(b.deadline_ms))
    );
  }
  async operationUnknown(id, kind) {
    return this.transaction(async (db) => {
      const a = await this.allocation(db, id);
      await db.query(
        "UPDATE mpp_direct_auction_operations SET state='unknown' WHERE allocation_id=$1 AND kind=$2 AND state IN('started','unknown')",
        [id, kind],
      );
      if (kind === "payment")
        await db.query(
          "UPDATE mpp_direct_auction_allocations SET payment='unknown' WHERE id=$1 AND payment='pending'",
          [id],
        );
      if (kind === "refund" && a.refunded === "0")
        await db.query(
          "UPDATE mpp_direct_auction_allocations SET settlement='unknown' WHERE id=$1",
          [id],
        );
    });
  }
  async beginOperation(id, kind) {
    return this.transaction(async (db, _state, at) => {
      const a = await this.allocation(db, id),
        op = (
          await db.query(
            "SELECT * FROM mpp_direct_auction_operations WHERE allocation_id=$1 AND kind=$2 FOR UPDATE",
            [id, kind],
          )
        ).rows[0];
      check(op, "unknown_operation");
      if (op.state !== "prepared") return { operation: op, action: "recover" };
      if (kind === "payment") {
        const grant = (
          await db.query(
            "SELECT * FROM mpp_direct_auction_grants WHERE id=$1",
            [a.grant_id],
          )
        ).rows[0];
        check(
          a.execution === "reserved" &&
            at < a.contract.paymentBeforeMs &&
            (await this.grantPermits(db, a, at)),
          "payment_authorization_closed",
        );
        if (this.live)
          check(
            (
              await db.query(
                "UPDATE mpp_direct_live_payment_budget SET calls=calls+1 WHERE singleton AND calls<maximum_calls RETURNING calls",
              )
            ).rowCount === 1,
            "mainnet_payment_count_exhausted",
          );
        await db.query(
          "UPDATE mpp_direct_auction_allocations SET payment='pending' WHERE id=$1",
          [id],
        );
      }
      await db.query(
        "UPDATE mpp_direct_auction_operations SET state='started' WHERE id=$1",
        [op.id],
      );
      await this.event(db, id, kind + "_intent_started", at, {
        operation: op.id,
      });
      return {
        operation: { ...op, state: "started" },
        action: "send_original",
      };
    });
  }
  async paymentProof(agentId, id, serialized, rpc) {
    const a = (
      await this.pool.query(
        "SELECT * FROM mpp_direct_auction_allocations WHERE id=$1 AND agent_id=$2",
        [id, agentId],
      )
    ).rows[0];
    check(a, "unknown_allocation");
    check(
      typeof serialized === "string" && serialized.length <= 16384,
      "invalid_credential",
    );
    const credential = Credential.deserialize(serialized);
    check(
      challengeIdentity(credential.challenge) ===
        challengeIdentity(a.challenge),
      "challenge_mismatch",
    );
    await this.pool.query(
      "INSERT INTO mpp_direct_auction_presentations VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [id, hash(serialized), serialized],
    );
    const evidence = await verifyPayment({
      credential,
      expectedChallenge: a.challenge,
      rpc,
    });
    const tx = await rpc.transaction(evidence.txHash, evidence.payer);
    const gas =
      uint(tx.transaction_outcome.outcome.tokens_burnt) +
      tx.receipts_outcome.reduce(
        (n, r) => n + uint(r.outcome.tokens_burnt),
        0n,
      );
    return this.acceptVerifiedPayment(id, {
      ...evidence,
      gasActualYocto: String(gas),
    });
  }
  // Trusted chain verifier / owned controlled adapter only. Never accepts public JSON as proof.
  async recordPaymentFee(id, e) {
    return this.transaction(async (db, _state, at) => {
      const a = await this.allocation(db, id);
      check(
        e.orderRef === a.order_id && e.gasPayer === a.challenge.request.payer,
        "payment_fee_binding_mismatch",
      );
      uint(e.gasActualYocto);
      check(
        a.gas_actual == null || String(a.gas_actual) === e.gasActualYocto,
        "original_payment_fee_conflict",
      );
      if (a.gas_actual != null) return;
      await db.query(
        "UPDATE mpp_direct_auction_allocations SET gas_actual=$2 WHERE id=$1",
        [id, e.gasActualYocto],
      );
      if (uint(e.gasActualYocto) > uint(a.contract.gasCapYocto)) {
        await db.query(
          `UPDATE mpp_direct_auction_budgets SET active=false WHERE id IN
          (SELECT owner_budget FROM mpp_direct_auction_agents WHERE id=$1 UNION ALL
           SELECT agent_budget FROM mpp_direct_auction_agents WHERE id=$1 UNION ALL
           SELECT task_budget FROM mpp_direct_auction_grants WHERE id=$2)`,
          [a.agent_id, a.grant_id],
        );
      }
      await this.event(db, id, "payment_fee_observed", at, {
        gasActualYocto: e.gasActualYocto,
        principal: "unresolved_by_fee_proof",
      });
    });
  }
  async acceptVerifiedPayment(id, e) {
    return this.transaction((db, _state, at) =>
      this.applyVerifiedPayment(db, id, e, at),
    );
  }
  async applyVerifiedPayment(db, id, e, at) {
    const a = await this.allocation(db, id),
      r = a.challenge.request;
    if (this.paymentRail) await this.paymentRail.validateEvidence(db, a, e);
    else
      check(
        e.orderRef === a.order_id &&
          e.amount === String(a.principal) &&
          e.network === r.network &&
          e.payer === r.payer &&
          e.recipient === r.recipient &&
          e.challengeId === a.challenge.id,
        "payment_binding_mismatch",
      );
    const gasOverrun =
      !this.paymentRail &&
      uint(e.gasActualYocto) > uint(a.contract.gasCapYocto);
    check(
      a.gas_actual == null || String(a.gas_actual) === e.gasActualYocto,
      "original_payment_fee_conflict",
    );
    const old = (
      await db.query(
        "SELECT * FROM mpp_direct_auction_movements WHERE identity=$1",
        [e.movementKey],
      )
    ).rows[0];
    if (old) {
      check(
        old.allocation_id === id && hash(old.evidence) === hash(e),
        "movement_already_consumed",
      );
      return this.view(a);
    }
    check(a.payment !== "confirmed", "original_payment_already_confirmed");
    await db.query(
      "INSERT INTO mpp_direct_auction_movements VALUES($1,$2,'payment',$3)",
      [e.movementKey, id, e],
    );
    const grant = (
      await db.query("SELECT * FROM mpp_direct_auction_grants WHERE id=$1", [
        a.grant_id,
      ])
    ).rows[0];
    const runnable =
      !gasOverrun &&
      a.execution === "reserved" &&
      !e.late &&
      at < a.contract.admissionBeforeMs &&
      (await this.grantPermits(db, a, at));
    await db.query(
      "UPDATE mpp_direct_auction_allocations SET payment='confirmed',gas_actual=$2,execution=$3,refundable=$4 WHERE id=$1",
      [
        id,
        e.gasActualYocto,
        runnable ? "ready" : "fenced",
        runnable ? "0" : String(a.principal),
      ],
    );
    await db.query(
      "UPDATE mpp_direct_auction_operations SET state='confirmed',result=$2 WHERE id=$1",
      [a.payment_operation, e],
    );
    if (gasOverrun) {
      await db.query(
        `UPDATE mpp_direct_auction_budgets SET active=false WHERE id IN
          (SELECT a.owner_budget FROM mpp_direct_auction_agents a WHERE a.id=$1 UNION ALL
           SELECT a.agent_budget FROM mpp_direct_auction_agents a WHERE a.id=$1 UNION ALL
           SELECT g.task_budget FROM mpp_direct_auction_grants g WHERE g.id=$2)`,
        [a.agent_id, a.grant_id],
      );
      await this.event(db, id, "gas_overrun_frozen", at, {
        actual: e.gasActualYocto,
        reserved: a.contract.gasCapYocto,
      });
    }
    if (!runnable) {
      await this.releaseCapacity(db, a);
      await this.prepareRefund(db, a, at, String(a.principal));
    }
    await this.event(db, id, "payment_confirmed", at, {
      movement: e.movementKey,
      late: !runnable,
    });
    return this.status(a.agent_id, id, db);
  }
  async proveNotSent(id, operationEvidence) {
    return this.transaction(async (db, _state, at) => {
      const a = await this.allocation(db, id);
      check(
        a.execution === "fenced" &&
          a.payment !== "confirmed" &&
          operationEvidence.operationId === a.payment_operation &&
          operationEvidence.state === "never_sent",
        "original_payment_not_proven_closed",
      );
      check(!a.gas_actual || a.gas_actual === "0", "payment_gas_unknown");
      await db.query(
        "UPDATE mpp_direct_auction_allocations SET payment='proven_not_sent',settlement='settled',gas_actual=0 WHERE id=$1",
        [id],
      );
      await db.query(
        "UPDATE mpp_direct_auction_operations SET state='proven_not_sent',result=$2 WHERE id=$1",
        [a.payment_operation, operationEvidence],
      );
      await this.finalizeBudget(
        db,
        { ...a, payment: "proven_not_sent", gas_actual: "0" },
        0n,
        at,
      );
      return { closed: true };
    });
  }
  async claimExecution(id) {
    return this.transaction(async (db, state, at) => {
      const a = await this.allocation(db, id),
        grant = (
          await db.query(
            "SELECT * FROM mpp_direct_auction_grants WHERE id=$1",
            [a.grant_id],
          )
        ).rows[0];
      check(
        a.execution === "ready" &&
          a.payment === "confirmed" &&
          state.capacity_allocation === id &&
          at < a.contract.admissionBeforeMs &&
          (await this.grantPermits(db, a, at)),
        "execution_fenced",
      );
      const claim = hash(randomBytes(32).toString("hex")),
        generation = String(BigInt(a.generation) + 1n);
      await db.query(
        "UPDATE mpp_direct_auction_allocations SET execution='executing',dispatch_claim=$2,generation=$3 WHERE id=$1",
        [id, claim, generation],
      );
      await db.query(
        "UPDATE mpp_direct_auction_operations SET state='started',result=$2 WHERE id=$1",
        [a.execution_id, { claim, generation }],
      );
      const bid = (
        await db.query("SELECT body FROM mpp_direct_auction_bids WHERE id=$1", [
          a.bid_id,
        ])
      ).rows[0];
      await this.event(db, id, "execution_claimed", at, { generation });
      return {
        executionId: a.execution_id,
        claim,
        generation,
        body: bid.body,
        contract: a.contract,
      };
    });
  }
  async executionUnknown(id, claim) {
    return this.transaction(async (db, _state, at) => {
      const a = await this.allocation(db, id);
      check(
        a.dispatch_claim === claim &&
          ["executing", "unknown"].includes(a.execution),
        "execution_fenced",
      );
      await db.query(
        "UPDATE mpp_direct_auction_allocations SET execution='unknown' WHERE id=$1",
        [id],
      );
      await this.event(db, id, "execution_unknown", at, {});
    });
  }
  async finishExecution(id, { claim, generation, result, usage }) {
    check(
      Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024,
      "native_response_too_large",
    );
    return this.transaction(async (db, _state, at) => {
      const a = await this.allocation(db, id);
      check(
        a.dispatch_claim === claim && String(a.generation) === generation,
        "execution_fenced",
      );
      if (a.result) {
        check(
          hash(a.result) === hash(result) && hash(a.usage) === hash(usage),
          "original_result_conflict",
        );
        return this.view(a);
      }
      check(["executing", "unknown"].includes(a.execution), "execution_fenced");
      const financial = settleUsage(a.contract, usage);
      await db.query(
        "UPDATE mpp_direct_auction_allocations SET execution='result_available',result=$2,usage=$3,financial=$4,charged=$5,refundable=$6,settlement=$7 WHERE id=$1",
        [
          id,
          result,
          usage,
          financial,
          financial.actualPrincipalYocto,
          financial.refundYocto,
          financial.refundYocto === "0" ? "settled" : "refund_pending",
        ],
      );
      await db.query(
        "UPDATE mpp_direct_auction_operations SET state='confirmed',result=$2 WHERE id=$1",
        [a.execution_id, { resultHash: hash(result), usage }],
      );
      await this.releaseCapacity(db, a);
      if (financial.refundYocto !== "0")
        await this.prepareRefund(db, a, at, financial.refundYocto);
      else
        await this.finalizeBudget(
          db,
          a,
          BigInt(financial.actualPrincipalYocto),
          at,
        );
      await this.event(db, id, "usable_result", at, {
        resultHash: hash(result),
      });
      return this.status(a.agent_id, id, db);
    });
  }
  async failExecution(id, { claim, generation, reason }) {
    // Trusted provider adapter only: a durably closed, never-dispatched intent,
    // a verified response outside the frozen contract, or an explicit terminal
    // HTTP authorization/billing refusal. Never a timeout.
    check(
      [
        "provider_never_sent",
        "verified_contract_breach",
        "provider_refused",
      ].includes(reason),
      "definite_execution_failure_required",
    );
    return this.transaction(async (db, _state, at) => {
      const a = await this.allocation(db, id);
      check(
        a.dispatch_claim === claim && String(a.generation) === generation,
        "execution_fenced",
      );
      if (a.execution === "failed") return this.view(a);
      check(["executing", "unknown"].includes(a.execution), "execution_fenced");
      await db.query(
        "UPDATE mpp_direct_auction_allocations SET execution='failed',refundable=principal WHERE id=$1",
        [id],
      );
      await db.query(
        "UPDATE mpp_direct_auction_operations SET state='confirmed',result=$2 WHERE id=$1",
        [a.execution_id, { failure: reason }],
      );
      await this.releaseCapacity(db, a);
      await this.prepareRefund(db, a, at, String(a.principal));
      await this.event(db, id, reason, at, {});
      return this.status(a.agent_id, id, db);
    });
  }
  async prepareRefund(db, a, at, amount) {
    if (BigInt(amount) === 0n) return;
    const binding = {
      operationId: a.refund_operation,
      orderId: a.order_id,
      network: a.challenge.request.network,
      sender: a.challenge.request.recipient,
      recipient: a.challenge.request.refundTo,
      amount: String(amount),
      bindingVersion: a.challenge.request.bindingVersion,
      contractHash: a.contract.contractHash,
    };
    await db.query(
      "INSERT INTO mpp_direct_auction_operations(id,allocation_id,kind,binding) VALUES($1,$2,'refund',$3) ON CONFLICT(id) DO NOTHING",
      [a.refund_operation, a.id, binding],
    );
    await db.query(
      "UPDATE mpp_direct_auction_allocations SET settlement='refund_pending' WHERE id=$1",
      [a.id],
    );
  }
  async acceptVerifiedRefund(id, e) {
    return this.transaction(async (db, _state, at) => {
      const a = await this.allocation(db, id),
        op = (
          await db.query(
            "SELECT * FROM mpp_direct_auction_operations WHERE id=$1",
            [a.refund_operation],
          )
        ).rows[0];
      check(
        op &&
          e.operationId === op.id &&
          e.orderId === a.order_id &&
          e.sender === op.binding.sender &&
          e.recipient === op.binding.recipient &&
          e.amount === op.binding.amount &&
          e.network === op.binding.network,
        "refund_binding_mismatch",
      );
      const old = (
        await db.query(
          "SELECT * FROM mpp_direct_auction_movements WHERE identity=$1",
          [e.movementKey],
        )
      ).rows[0];
      if (old) {
        check(
          old.allocation_id === id && hash(old.evidence) === hash(e),
          "movement_already_consumed",
        );
        return this.view(a);
      }
      check(
        a.refunded === "0" && BigInt(e.amount) === BigInt(a.refundable),
        "refund_exceeds_liability",
      );
      await db.query(
        "INSERT INTO mpp_direct_auction_movements VALUES($1,$2,'refund',$3)",
        [e.movementKey, id, e],
      );
      await db.query(
        "UPDATE mpp_direct_auction_allocations SET refunded=refundable,refundable=0,settlement='refund_confirmed' WHERE id=$1",
        [id],
      );
      await db.query(
        "UPDATE mpp_direct_auction_operations SET state='confirmed',result=$2 WHERE id=$1",
        [op.id, e],
      );
      await this.finalizeBudget(db, a, BigInt(a.charged), at);
      await this.event(db, id, "refund_confirmed", at, {
        movement: e.movementKey,
      });
      return this.status(a.agent_id, id, db);
    });
  }
  async finalizeBudget(db, a, charged, at) {
    if (a.budget_finalized) return;
    const spent = ceil(
      (charged + uint(a.gas_actual ?? "0")) *
        uint(a.contract.fx.nanoUsdPerNear),
      YOCTO,
    );
    // A chain effect cannot be undone by rejecting its accounting. Unexpected
    // gas is recorded as an overrun; it never increases future authorization.
    const overrun =
      spent > BigInt(a.reserve_nano) ? spent - BigInt(a.reserve_nano) : 0n;
    const keys = (
      await db.query(
        "SELECT g.task_budget,a.owner_budget,a.agent_budget FROM mpp_direct_auction_grants g JOIN mpp_direct_auction_agents a ON a.id=g.agent_id WHERE g.id=$1",
        [a.grant_id],
      )
    ).rows[0];
    for (const key of Object.values(keys))
      await db.query(
        "UPDATE mpp_direct_auction_budgets SET reserved_nano=reserved_nano-$2,spent_nano=spent_nano+$3,overrun_nano=overrun_nano+$4,active=active AND $4::bigint=0 WHERE id=$1",
        [key, a.reserve_nano, String(spent), String(overrun)],
      );
    await db.query(
      "UPDATE mpp_direct_auction_allocations SET budget_finalized=true WHERE id=$1",
      [a.id],
    );
    await this.event(db, a.id, "budget_finalized", at, {
      spentNano: String(spent),
    });
  }
  async observeFinalBalance(agentId, reader) {
    // The trusted chain adapter reads AFTER capturing the terminal operations it
    // will acknowledge. A newer completion remains conservatively reserved.
    const agent = (
      await this.pool.query(
        "SELECT * FROM mpp_direct_auction_agents WHERE id=$1",
        [agentId],
      )
    ).rows[0];
    check(agent, "unknown_agent");
    const terminal = (
      await this.pool.query(
        "SELECT id,contract FROM mpp_direct_auction_allocations WHERE agent_id=$1 AND budget_finalized AND NOT wallet_reflected",
        [agentId],
      )
    ).rows;
    const started = Date.now(),
      balance = await reader(agent.payer);
    if (this.paymentRail)
      this.paymentRail.validateBalance(balance, agent, started);
    else
      check(
        balance.source ===
          (this.live ? "near-rpc-final-v1" : "controlled-native-final-v1") &&
          balance.network === this.config.network &&
          balance.payer === agent.payer &&
          balance.observedAtMs >= started &&
          balance.expiresAtMs > balance.observedAtMs,
        "not_final_native_balance",
      );
    if (!this.paymentRail) uint(balance.availableYocto);
    return this.transaction(async (db) => {
      let released = 0n;
      for (const a of terminal) {
        const updated = await db.query(
          "UPDATE mpp_direct_auction_allocations SET wallet_reflected=true WHERE id=$1 AND budget_finalized AND NOT wallet_reflected RETURNING id",
          [a.id],
        );
        if (updated.rowCount)
          released +=
            BigInt(a.contract.principalYocto) + BigInt(a.contract.gasCapYocto);
      }
      await db.query(
        "UPDATE mpp_direct_auction_agents SET balance=$2,native_reserved=native_reserved-$3 WHERE id=$1",
        [agentId, balance, String(released)],
      );
    });
  }
  async revoke(agentId, grantId, expectedRevision) {
    return this.transaction(async (db, _state, at) => {
      const g = (
        await db.query(
          "SELECT * FROM mpp_direct_auction_grants WHERE id=$1 AND agent_id=$2",
          [grantId, agentId],
        )
      ).rows[0];
      check(g && String(g.revision) === expectedRevision, "revision_conflict");
      await db.query(
        "UPDATE mpp_direct_auction_grants SET active=false,revision=revision+1 WHERE id=$1",
        [grantId],
      );
      await db.query(
        "UPDATE mpp_direct_auction_bids SET state='withdrawn' WHERE grant_id=$1 AND state='active'",
        [grantId],
      );
      const pending = (
        await db.query(
          "SELECT * FROM mpp_direct_auction_allocations WHERE grant_id=$1 AND execution IN('reserved','ready')",
          [grantId],
        )
      ).rows;
      for (const a of pending) {
        await db.query(
          "UPDATE mpp_direct_auction_allocations SET execution='fenced',generation=generation+1,refundable=CASE WHEN payment='confirmed' THEN principal ELSE 0 END WHERE id=$1",
          [a.id],
        );
        await this.releaseCapacity(db, a);
        if (a.payment === "confirmed")
          await this.prepareRefund(db, a, at, a.principal);
      }
      return {
        grantId,
        revision: String(BigInt(g.revision) + 1n),
        active: false,
      };
    });
  }
  async createGrant(agentId, input) {
    if (this.live)
      check(
        uint(input.callCapMicro) <= uint(this.config.livePlan.callCapMicro),
        "mainnet_call_cap_exceeded",
      );
    check(/^[a-zA-Z0-9_-]{1,128}$/.test(input.operation), "invalid_operation");
    check(
      Object.keys(input).every((k) =>
        [
          "agentId",
          "operation",
          "budgetNano",
          "callCapMicro",
          "deadlineMs",
        ].includes(k),
      ),
      "unsupported_authorization_field",
    );
    const budget = uint(input.budgetNano),
      cap = uint(input.callCapMicro);
    check(
      budget > 0n &&
        budget <= (1n << 63n) - 1n &&
        cap > 0n &&
        cap <= 100000n &&
        Number.isSafeInteger(input.deadlineMs),
      "invalid_authorization",
    );
    const fingerprint = hash(["create-grant", input]);
    return this.transaction(async (db, _state, at) => {
      const old = (
        await db.query(
          "SELECT * FROM mpp_direct_auction_commands WHERE agent_id=$1 AND operation=$2",
          [agentId, input.operation],
        )
      ).rows[0];
      if (old) {
        check(old.fingerprint === fingerprint, "idempotency_conflict");
        return old.result;
      }
      const agent = (
        await db.query(
          "SELECT * FROM mpp_direct_auction_agents WHERE id=$1 AND active",
          [agentId],
        )
      ).rows[0];
      check(agent, "unknown_agent");
      const parents = (
        await db.query(
          "SELECT * FROM mpp_direct_auction_budgets WHERE id=ANY($1) FOR UPDATE",
          [[agent.owner_budget, agent.agent_budget]],
        )
      ).rows;
      check(
        parents.length === 2 &&
          parents.every(
            (b) =>
              b.active &&
              budget <= BigInt(b.cap_nano) &&
              input.deadlineMs <= Number(b.deadline_ms),
          ),
        "authorization_outside_parent",
      );
      check(
        input.deadlineMs > at + this.config.admissionWindowMs &&
          input.deadlineMs <= at + (this.paymentRail ? 3600000 : 180000),
        "invalid_authorization_deadline",
      );
      const count = (
        await db.query(
          "SELECT count(*) FROM mpp_direct_auction_grants WHERE agent_id=$1 AND active AND deadline_ms>$2",
          [agentId, at],
        )
      ).rows[0].count;
      check(Number(count) < 16, "authorization_count_limit");
      const id = hash(["grant", agentId, input.operation]),
        taskBudget = "task-" + id;
      await db.query(
        "INSERT INTO mpp_direct_auction_budgets(id,kind,owner_id,agent_id,cap_nano,deadline_ms) VALUES($1,'task',$2,$3,$4,$5)",
        [
          taskBudget,
          agent.owner_id,
          agentId,
          input.budgetNano,
          input.deadlineMs,
        ],
      );
      await db.query(
        "INSERT INTO mpp_direct_auction_grants(id,agent_id,task_budget,call_cap_micro,gas_cap_yocto,deadline_ms) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          agentId,
          taskBudget,
          input.callCapMicro,
          this.paymentRail
            ? "0"
            : this.live
              ? this.config.livePlan.gasReserveYocto
              : "1000000000000000000",
          input.deadlineMs,
        ],
      );
      const result = {
        id,
        agentId,
        revision: "0",
        deadlineMs: input.deadlineMs,
      };
      await db.query(
        "INSERT INTO mpp_direct_auction_commands VALUES($1,$2,$3,$4)",
        [agentId, input.operation, fingerprint, result],
      );
      return result;
    });
  }
  view(a) {
    return {
      allocationId: a.id,
      agentId: a.agent_id,
      authorizationId: a.grant_id,
      bidId: a.bid_id,
      bidRevision: String(a.bid_revision),
      orderId: a.order_id,
      contract: a.contract,
      challenge: a.challenge,
      executionState: a.execution,
      paymentState: a.payment,
      settlementState: a.settlement,
      result: a.result,
      financial: a.financial,
      principal: {
        prepaid: String(a.principal),
        charged: String(a.charged),
        refundPending: String(a.refundable),
        refunded: String(a.refunded),
      },
      gasActualYocto: a.gas_actual,
      ...(this.paymentRail
        ? {
            paymentMethod: "nearintents",
            billing: this.config.billing,
            usageRebate: false,
            gasActualYocto: null,
            sourceFeesSeparate: true,
          }
        : {}),
    };
  }
  async status(agentId, id, db = this.pool) {
    const a = (
      await db.query(
        "SELECT * FROM mpp_direct_auction_allocations WHERE id=$1 AND agent_id=$2",
        [id, agentId],
      )
    ).rows[0];
    check(a, "unknown_allocation");
    return this.view(a);
  }
  async bidStatus(agentId, id) {
    const b = (
      await this.pool.query(
        "SELECT * FROM mpp_direct_auction_bids WHERE id=$1 AND agent_id=$2",
        [id, agentId],
      )
    ).rows[0];
    check(b, "unknown_bid");
    const a = (
      await this.pool.query(
        "SELECT * FROM mpp_direct_auction_allocations WHERE bid_id=$1",
        [id],
      )
    ).rows[0];
    const last = (
      await this.pool.query(
        `SELECT r.id,r.cutoff_ms::text,x.value FROM mpp_direct_auction_rounds r,
   LATERAL jsonb_array_elements(r.result->'results') x WHERE x.value->>'id'=$1 ORDER BY r.cutoff_ms DESC LIMIT 1`,
        [id],
      )
    ).rows[0];
    return a
      ? this.view(a)
      : {
          bidId: id,
          revision: String(b.revision),
          state:
            b.state === "active"
              ? Date.now() >= Number(b.expiry_ms)
                ? "expired"
                : "waiting"
              : b.state,
          lastRound: last
            ? { id: last.id, cutoffMs: last.cutoff_ms, ...last.value }
            : null,
        };
  }
}

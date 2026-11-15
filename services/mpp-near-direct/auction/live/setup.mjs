import { randomBytes } from "node:crypto";
import { hash, requireThat as check, uint, account } from "../../contract.mjs";
import { verifyNativeTransfer } from "../../near.mjs";
import { OwnerWithdrawal } from "./withdraw.mjs";
import { Onboarding } from "../../p3/onboarding.mjs";

export class AuctionSetup {
  constructor({ market, api, rpc, credentials, wallet }) {
    Object.assign(this, { market, api, rpc, credentials, wallet });
    this.pool = market.pool;
    this.plan = market.config.livePlan;
    this.withdrawals = new OwnerWithdrawal(this);
    this.onboarding = new Onboarding({
      pool: this.pool,
      api,
      rpc,
      credentials,
      merchant: this.plan.merchant,
      realm: this.plan.realm,
      maximumYocto: this.plan.principalCapYocto,
    });
  }
  open() {
    check(Date.now() < this.plan.deadlineMs, "mainnet_run_closed");
  }
  async list(owner) {
    const rows = (
      await this.pool.query(
        `SELECT w.id,w.state,w.binding,x.agent_id FROM mpp_direct_p3_wallets w LEFT JOIN mpp_direct_live_wallet_agents x ON x.wallet_id=w.id WHERE w.owner_id=$1 ORDER BY w.created_ms`,
        [owner],
      )
    ).rows;
    const funding = (
      await this.pool.query(
        "SELECT id,wallet_id,amount::text,tx_hash,state FROM mpp_direct_live_funding WHERE owner_id=$1 ORDER BY created_ms",
        [owner],
      )
    ).rows;
    const withdrawals = (
      await this.pool.query(
        "SELECT id FROM mpp_direct_live_withdrawals WHERE owner_id=$1 ORDER BY (plan->>'createdAtMs')::bigint",
        [owner],
      )
    ).rows;
    return {
      withdrawals: await Promise.all(
        withdrawals.map(async (r) =>
          this.withdrawals.view(await this.withdrawals.row(owner, r.id)),
        ),
      ),
      readiness: {
        ready: await this.market.live.ready(this.pool, Date.now()),
        newPurchasesOpen: Date.now() < this.plan.deadlineMs,
      },
      network: "mainnet",
      deadlineMs: this.plan.deadlineMs,
      limits: {
        ownerBudgetNano: this.plan.ownerBudgetNano,
        agentBudgetNano: this.plan.agentBudgetNano,
        callCapMicro: this.plan.callCapMicro,
        gasReserveYocto: this.plan.gasReserveYocto,
        principalCapYocto: this.plan.principalCapYocto,
        fundingCapYocto: this.plan.fundingCapYocto,
      },
      wallets: rows.map((r) => ({
        id: r.id,
        state: r.state,
        agentId: r.agent_id ?? null,
        payer: r.binding?.payer ?? null,
        policyInstalled: !!r.binding?.policy,
      })),
      funding,
    };
  }
  async create(owner, input) {
    this.open();
    check(
      account.test(owner) &&
        input.acceptLimits === true &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(input.operation),
      "owner_limits_acceptance_required",
    );
    const id = hash(["auction-wallet", owner, input.operation]);
    const db = await this.pool.connect();
    try {
      // Registration is an unfunded external operation, serialized separately
      // from the financial auction. Unknown registrations consume their slot.
      await db.query("SELECT pg_advisory_lock(2461114001)");
      const n = Number(
        (await db.query("SELECT count(*) FROM mpp_direct_p3_wallets")).rows[0]
          .count,
      );
      const exists = (
        await db.query(
          "SELECT id FROM mpp_direct_p3_wallets WHERE id=$1 AND owner_id=$2",
          [id, owner],
        )
      ).rowCount;
      check(exists || n < this.plan.maximumAgents, "mainnet_agent_limit");
      await this.onboarding.create(owner, id);
    } finally {
      await db.query("SELECT pg_advisory_unlock(2461114001)").catch(() => {});
      db.release();
    }
    return this.list(owner);
  }
  async confirm(owner, id) {
    this.open();
    await this.onboarding.confirmPolicy(owner, id);
    const row = await this.onboarding.row(owner, id),
      agent = "agent-" + id,
      ownerScope = "mainnet:" + owner;
    await this.market.transaction(async (db, _state, at) => {
      check(at < this.plan.deadlineMs, "mainnet_run_closed");
      const ob = "owner-" + hash(ownerScope),
        ab = "agent-budget-" + id;
      await db.query(
        `INSERT INTO mpp_direct_auction_budgets(id,kind,owner_id,cap_nano,deadline_ms) VALUES($1,'owner',$2,$3,$4) ON CONFLICT DO NOTHING`,
        [ob, ownerScope, this.plan.ownerBudgetNano, this.plan.deadlineMs],
      );
      await db.query(
        `INSERT INTO mpp_direct_auction_budgets(id,kind,owner_id,agent_id,cap_nano,deadline_ms) VALUES($1,'agent',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [
          ab,
          ownerScope,
          agent,
          this.plan.agentBudgetNano,
          this.plan.deadlineMs,
        ],
      );
      await db.query(
        `INSERT INTO mpp_direct_auction_agents(id,owner_id,credential_hash,payer,binding_version,owner_budget,agent_budget,balance)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          agent,
          ownerScope,
          hash(randomBytes(32).toString("hex")),
          row.binding.payer,
          row.binding.version,
          ob,
          ab,
          {
            source: "near-rpc-final-v1",
            network: "mainnet",
            payer: row.binding.payer,
            availableYocto: "0",
            observedAtMs: at,
            expiresAtMs: at,
          },
        ],
      );
      await db.query(
        "INSERT INTO mpp_direct_live_wallet_agents VALUES($1,$2) ON CONFLICT DO NOTHING",
        [id, agent],
      );
      // No reusable agent bearer is exposed. All browser operations require the
      // owner cookie and exact ownership; the model receives only transport.
    });
    return this.list(owner);
  }
  async freeze(owner, id) {
    const map = (
      await this.pool.query(
        `SELECT x.agent_id FROM mpp_direct_live_wallet_agents x JOIN mpp_direct_p3_wallets w ON w.id=x.wallet_id WHERE w.id=$1 AND w.owner_id=$2`,
        [id, owner],
      )
    ).rows[0];
    if (map)
      await this.market.transaction(async (db, _state, at) => {
        await db.query(
          "UPDATE mpp_direct_auction_agents SET active=false WHERE id=$1",
          [map.agent_id],
        );
        await db.query(
          "UPDATE mpp_direct_auction_bids SET state='withdrawn' WHERE agent_id=$1 AND state='active'",
          [map.agent_id],
        );
        const pending = (
          await db.query(
            "SELECT * FROM mpp_direct_auction_allocations WHERE agent_id=$1 AND execution IN('reserved','ready')",
            [map.agent_id],
          )
        ).rows;
        for (const a of pending) {
          await db.query(
            "UPDATE mpp_direct_auction_allocations SET execution='fenced',generation=generation+1,refundable=CASE WHEN payment='confirmed' THEN principal ELSE 0 END WHERE id=$1",
            [a.id],
          );
          await this.market.releaseCapacity(db, a);
          if (a.payment === "confirmed")
            await this.market.prepareRefund(db, a, at, String(a.principal));
        }
      });
    return { transaction: await this.onboarding.freezeTransaction(owner, id) };
  }
  async prepareFunding(owner, id, input) {
    this.open();
    const row = await this.onboarding.row(owner, id);
    check(
      row.state === "ready" && row.binding?.policy?.controller === owner,
      "wallet_policy_not_ready",
    );
    check(
      /^[a-zA-Z0-9_-]{1,64}$/.test(input.operation) &&
        uint(input.amount) > 0n &&
        uint(input.amount) <= uint(this.plan.fundingCapYocto),
      "bounded_funding_required",
    );
    const operation = hash(["funding", owner, id, input.operation]);
    const db = await this.pool.connect();
    let r;
    try {
      await db.query("BEGIN");
      await db.query(
        "SELECT id FROM mpp_direct_p3_wallets WHERE id=$1 FOR UPDATE",
        [id],
      );
      r = (
        await db.query("SELECT * FROM mpp_direct_live_funding WHERE id=$1", [
          operation,
        ])
      ).rows[0];
      if (r)
        check(String(r.amount) === input.amount, "funding_operation_conflict");
      else {
        const total = (
          await db.query(
            "SELECT COALESCE(sum(amount),0)::text AS amount FROM mpp_direct_live_funding WHERE wallet_id=$1",
            [id],
          )
        ).rows[0].amount;
        check(
          uint(total) + uint(input.amount) <= uint(this.plan.fundingCapYocto),
          "wallet_total_funding_cap_exceeded",
        );
        r = (
          await db.query(
            "INSERT INTO mpp_direct_live_funding(id,wallet_id,owner_id,amount,state,created_ms) VALUES($1,$2,$3,$4,'pending',$5) RETURNING *",
            [operation, id, owner, input.amount, Date.now()],
          )
        ).rows[0];
      }
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
    return {
      id: r.id,
      state: r.state,
      transaction: {
        signerId: owner,
        receiverId: row.binding.payer,
        actions: [{ type: "Transfer", params: { deposit: String(r.amount) } }],
      },
    };
  }
  async reconcileFunding(owner, id, input) {
    const row = (
      await this.pool.query(
        "SELECT * FROM mpp_direct_live_funding WHERE id=$1 AND owner_id=$2",
        [id, owner],
      )
    ).rows[0];
    check(
      row &&
        typeof input.txHash === "string" &&
        /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(input.txHash),
      "original_funding_hash_required",
    );
    const w = await this.onboarding.row(owner, row.wallet_id);
    await this.pool.query(
      "UPDATE mpp_direct_live_funding SET tx_hash=$2 WHERE id=$1 AND (tx_hash IS NULL OR tx_hash=$2)",
      [id, input.txHash],
    );
    const current = (
      await this.pool.query(
        "SELECT * FROM mpp_direct_live_funding WHERE id=$1",
        [id],
      )
    ).rows[0];
    check(current.tx_hash === input.txHash, "original_funding_hash_conflict");
    if (current.state !== "final") {
      const tx = await this.rpc.transaction(input.txHash, owner);
      const proof = await verifyNativeTransfer({
        rpc: this.rpc,
        p: { txHash: input.txHash, publicKey: tx.transaction.public_key },
        r: {
          network: "mainnet",
          payer: owner,
          recipient: w.binding.payer,
          amount: String(row.amount),
          orderRef: id,
          issuedAtMs: Number(row.created_ms),
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        },
        challengeId: id,
      });
      await this.pool.query(
        "UPDATE mpp_direct_live_funding SET state='final',evidence=$2 WHERE id=$1",
        [id, proof],
      );
    }
    return this.list(owner);
  }
  async handle(owner, path, method, input) {
    if (path === "/market-api/live-wallets" && method === "GET")
      return this.list(owner);
    if (path === "/market-api/live-wallets" && method === "POST")
      return this.create(owner, input);
    const m = path.match(
      /^\/market-api\/live-wallets\/([a-f0-9]{64})\/(policy|confirm|freeze|funding|withdrawal)$/,
    );
    if (m && method === "POST") {
      if (m[2] === "policy") {
        this.open();
        return this.onboarding.preparePolicy(owner, m[1]);
      }
      if (m[2] === "confirm") return this.confirm(owner, m[1]);
      if (m[2] === "withdrawal")
        return this.withdrawals.prepare(owner, m[1], input);
      if (m[2] === "freeze") return this.freeze(owner, m[1]);
      return this.prepareFunding(owner, m[1], input);
    }
    const exit = path.match(
      /^\/market-api\/live-withdrawals\/([a-f0-9]{64})\/(confirm|send|recover)$/,
    );
    if (exit && method === "POST")
      return exit[2] === "confirm"
        ? this.withdrawals.confirm(owner, exit[1])
        : this.withdrawals.recover(owner, exit[1], {
            send: exit[2] === "send",
          });
    const f = path.match(
      /^\/market-api\/live-funding\/([a-f0-9]{64})\/reconcile$/,
    );
    if (f && method === "POST")
      return this.reconcileFunding(owner, f[1], input);
    throw Error("not_found");
  }
}

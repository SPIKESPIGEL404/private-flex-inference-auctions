import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hash } from "../../mpp-near-direct/contract.mjs";
import { check, digest, uint } from "../chat/config.mjs";
import { exitOriginal, publicExit } from "./exit.mjs";

export class NearintentsAuctionSetup {
  constructor({ market, wallet, journal, config, source }) {
    Object.assign(this, { market, wallet, journal, config, source });
    this.pool = market.pool;
  }
  ownerScope(owner) {
    return this.market.config.network + ":" + owner;
  }
  async keys(id) {
    const k = await this.journal.get("agent-key:" + id);
    check(
      k && privateKeyToAccount(k.privateKey).address === k.address,
      "original_agent_key_required",
    );
    return k;
  }
  async list(owner) {
    const rows = (
      await this.pool.query(
        `SELECT a.id,a.payer,a.active,a.balance FROM mpp_direct_auction_agents a JOIN nearintents_auction_agents n ON n.agent_id=a.id WHERE a.owner_id=$1 ORDER BY n.created_ms`,
        [this.ownerScope(owner)],
      )
    ).rows;
    return {
      paymentMethod: "nearintents",
      billing: "auction-fixed-request-v1",
      mode: this.config.mode,
      chainId: 42161,
      token: {
        asset: this.config.originAsset,
        address: this.config.originAsset.split(":").at(-1),
        symbol: "USDC",
        decimals: 6,
      },
      gasSymbol: "ETH",
      deadlineMs: this.config.deadlineMs,
      limits: {
        maximumAmountIn: this.config.maximumAmountIn,
        maximumTotalAmountIn: this.config.maximumTotalAmountIn,
        maximumGasWei: this.config.maximumGasWei,
        maximumTotalGasWei: this.config.maximumTotalGasWei,
        principalCapYocto: this.config.principalCapYocto,
        ownerBudgetNano: this.config.ownerBudgetNano,
        agentBudgetNano: this.config.agentBudgetNano,
        callCapMicro: this.config.callCapMicro,
      },
      wallets: rows.map((a) => ({
        id: a.id,
        address: a.payer,
        active: a.active,
        balance: a.balance,
        agentId: a.id,
      })),
      funding: (
        await this.pool.query(
          `SELECT * FROM nearintents_auction_funding WHERE owner_id=$1 ORDER BY created_ms DESC`,
          [this.ownerScope(owner)],
        )
      ).rows,
      exits: (await this.journal.list())
        .filter(
          (r) =>
            r.purpose === "owner-exit" && r.owner === this.ownerScope(owner),
        )
        .map(publicExit),
    };
  }
  async create(owner, input) {
    check(
      input?.acceptLimits === true &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(input.operation) &&
        Date.now() < this.config.deadlineMs,
      "explicit_wallet_caps_required",
    );
    const scope = this.ownerScope(owner),
      id = digest(["nearintents-agent", scope, input.operation]);
    await this.market.transaction(async (db, _s, at) => {
      const existing = (
        await db.query(
          "SELECT agent_id FROM nearintents_auction_agents WHERE owner_id=$1 AND operation=$2",
          [scope, input.operation],
        )
      ).rows[0];
      if (existing) return;
      check(
        Number(
          (await db.query("SELECT count(*) FROM nearintents_auction_agents"))
            .rows[0].count,
        ) < this.config.maximumAgents,
        "global_agent_limit",
      );
      check(
        Number(
          (
            await db.query(
              "SELECT count(*) FROM nearintents_auction_agents WHERE owner_id=$1",
              [scope],
            )
          ).rows[0].count,
        ) < 2,
        "owner_agent_limit",
      );
      let key = await this.journal.get("agent-key:" + id);
      if (!key) {
        const privateKey = generatePrivateKey();
        key = { privateKey, address: privateKeyToAccount(privateKey).address };
        await this.journal.put("agent-key:" + id, key);
      }
      const ob = digest(["ni-owner-budget", scope]),
        ab = digest(["ni-agent-budget", id]);
      await db.query(
        "INSERT INTO mpp_direct_auction_budgets(id,kind,owner_id,cap_nano,deadline_ms) VALUES($1,'owner',$2,$3,$4) ON CONFLICT DO NOTHING",
        [ob, scope, this.config.ownerBudgetNano, this.config.deadlineMs],
      );
      await db.query(
        "INSERT INTO mpp_direct_auction_budgets(id,kind,owner_id,agent_id,cap_nano,deadline_ms) VALUES($1,'agent',$2,$3,$4,$5)",
        [ab, scope, id, this.config.agentBudgetNano, this.config.deadlineMs],
      );
      const balance = {
        source: "nearintents-source-observation-v1",
        network: this.market.config.network,
        payer: key.address,
        asset: this.config.originAsset,
        sourceAtoms: "0",
        gasWei: "0",
        observedAtMs: at,
        expiresAtMs: at,
      };
      await db.query(
        "INSERT INTO mpp_direct_auction_agents(id,owner_id,credential_hash,payer,binding_version,owner_budget,agent_budget,balance) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          scope,
          hash(generatePrivateKey()),
          key.address,
          digest([key.address, this.config]),
          ob,
          ab,
          balance,
        ],
      );
      await db.query(
        "INSERT INTO nearintents_auction_agents VALUES($1,$2,$3,$4,$5)",
        [id, input.operation, scope, key.address, at],
      );
    });
    return this.list(owner);
  }
  async owned(owner, id) {
    const r = (
      await this.pool.query(
        "SELECT * FROM mpp_direct_auction_agents WHERE id=$1 AND owner_id=$2",
        [id, this.ownerScope(owner)],
      )
    ).rows[0];
    check(r, "unknown_agent");
    return r;
  }
  async freeze(owner, id) {
    await this.owned(owner, id);
    await this.market.transaction(async (db) => {
      await db.query(
        "UPDATE mpp_direct_auction_agents SET active=false WHERE id=$1",
        [id],
      );
      await db.query(
        "UPDATE mpp_direct_auction_bids SET state='withdrawn' WHERE agent_id=$1 AND state='active'",
        [id],
      );
    });
    for (const a of (
      await this.pool.query(
        "SELECT id FROM mpp_direct_auction_allocations WHERE agent_id=$1 AND execution IN('reserved','ready')",
        [id],
      )
    ).rows)
      await this.market.fence(a.id);
    return this.list(owner);
  }
  async funding(owner, id, input) {
    const a = await this.owned(owner, id);
    check(
      (Date.now() < this.config.deadlineMs ||
        (input.kind === "gas" && !a.active)) &&
        (a.active || input.kind === "gas") &&
        ["token", "gas"].includes(input.kind) &&
        uint(input.amount) > 0n &&
        /^0x[a-fA-F0-9]{40}$/.test(input.from) &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(input.operation),
      "bounded_funding_required",
    );
    const op = digest(["ni-funding", id, input.operation]),
      cap =
        input.kind === "token"
          ? this.config.maximumTotalAmountIn
          : String(
              uint(this.config.maximumTotalGasWei) +
                8n * uint(this.config.maximumGasWei),
            );
    await this.market.transaction(async (db) => {
      const old = (
        await db.query(
          "SELECT * FROM nearintents_auction_funding WHERE id=$1",
          [op],
        )
      ).rows[0];
      if (old) {
        check(
          old.amount === input.amount &&
            old.kind === input.kind &&
            old.source_address === input.from,
          "funding_operation_conflict",
        );
        return;
      }
      check(
        !(
          await db.query(
            "SELECT FROM nearintents_auction_funding WHERE agent_id=$1 AND state='pending'",
            [id],
          )
        ).rowCount,
        "original_funding_unresolved",
      );
      const total = (
        await db.query(
          "SELECT coalesce(sum(amount),0)::text AS n FROM nearintents_auction_funding WHERE agent_id=$1 AND kind=$2 AND state NOT IN('failed','cancelled')",
          [id, input.kind],
        )
      ).rows[0].n;
      check(
        uint(total) + uint(input.amount) <= uint(cap),
        "funding_cap_exceeded",
      );
      await db.query(
        "INSERT INTO nearintents_auction_funding(id,agent_id,owner_id,source_address,kind,amount,state,created_ms) VALUES($1,$2,$3,$4,$5,$6,'pending',$7)",
        [
          op,
          id,
          this.ownerScope(owner),
          input.from,
          input.kind,
          input.amount,
          Date.now(),
        ],
      );
    });
    return {
      id: op,
      to: a.payer,
      kind: input.kind,
      amount: input.amount,
      chainId: 42161,
      tokenAddress: this.config.originAsset.split(":").at(-1),
    };
  }
  async reconcileFunding(owner, id, input) {
    const f = (
      await this.pool.query(
        "SELECT * FROM nearintents_auction_funding WHERE id=$1 AND owner_id=$2",
        [id, this.ownerScope(owner)],
      )
    ).rows[0];
    check(
      f && /^0x[a-fA-F0-9]{64}$/.test(input.txHash),
      "original_funding_hash_required",
    );
    await this.pool.query(
      "UPDATE nearintents_auction_funding SET tx_hash=$2 WHERE id=$1 AND(tx_hash IS NULL OR tx_hash=$2)",
      [id, input.txHash],
    );
    const old = (
      await this.pool.query(
        "SELECT * FROM nearintents_auction_funding WHERE id=$1",
        [id],
      )
    ).rows[0];
    check(old.tx_hash === input.txHash, "original_funding_hash_conflict");
    if (old.state === "pending") {
      const a = await this.owned(owner, f.agent_id),
        proof = await this.source.fundingProof(old, a);
      if (proof)
        await this.pool.query(
          "UPDATE nearintents_auction_funding SET state=$2,evidence=$3 WHERE id=$1",
          [id, proof.success ? "confirmed" : "failed", proof],
        );
    }
    await this.market
      .observeFinalBalance(f.agent_id, (payer) => this.wallet.balance(payer))
      .catch(() => {});
    return this.list(owner);
  }
  async cancelFunding(owner, id, input) {
    check(input.walletRejected === true, "explicit_wallet_rejection_required");
    const r = await this.pool.query(
      "UPDATE nearintents_auction_funding SET state='cancelled' WHERE id=$1 AND owner_id=$2 AND state='pending' AND tx_hash IS NULL RETURNING id",
      [id, this.ownerScope(owner)],
    );
    check(r.rowCount === 1, "original_funding_requires_reconciliation");
    return this.list(owner);
  }
  async recoverFunding() {
    if (Date.now() - (this.lastFundingCheck ?? 0) < 3000) return;
    this.lastFundingCheck = Date.now();
    for (const f of (
      await this.pool.query(
        "SELECT * FROM nearintents_auction_funding WHERE state='pending' AND tx_hash IS NOT NULL LIMIT 32",
      )
    ).rows)
      await this.reconcileFunding(
        f.owner_id.slice(this.market.config.network.length + 1),
        f.id,
        { txHash: f.tx_hash },
      ).catch(() => {});
  }
  async handle(owner, path, method, input) {
    if (path === "/market-api/nearintents-wallets")
      return method === "GET" ? this.list(owner) : this.create(owner, input);
    const action = path.match(
      /^\/market-api\/nearintents-wallets\/([a-f0-9]{64})\/(freeze|funding)$/,
    );
    if (action && method === "POST")
      return action[2] === "freeze"
        ? this.freeze(owner, action[1])
        : this.funding(owner, action[1], input);
    const exit = path.match(
      /^\/market-api\/nearintents-wallets\/([a-f0-9]{64})\/exit$/,
    );
    if (exit && method === "POST") {
      await this.owned(owner, exit[1]);
      const result = await exitOriginal({
        market: this.market,
        config: this.config,
        journal: this.journal,
        key: await this.keys(exit[1]),
        agentId: exit[1],
        owner: this.ownerScope(owner),
        input,
        clients: this.wallet.clients?.(await this.keys(exit[1])),
      });
      await this.market
        .observeFinalBalance(exit[1], (payer) => this.wallet.balance(payer))
        .catch(() => {});
      return result;
    }
    const reconcile = path.match(
      /^\/market-api\/nearintents-funding\/([a-f0-9]{64})\/reconcile$/,
    );
    if (reconcile && method === "POST")
      return this.reconcileFunding(owner, reconcile[1], input);
    const cancel = path.match(
      /^\/market-api\/nearintents-funding\/([a-f0-9]{64})\/cancel$/,
    );
    if (cancel && method === "POST")
      return this.cancelFunding(owner, cancel[1], input);
    throw Error("not_found");
  }
}

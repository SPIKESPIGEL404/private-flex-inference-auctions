// Public owner authentication is independent from controlled payment fixtures.
import bs58 from "bs58";
import { randomUUID, createPublicKey, verify } from "node:crypto";
import { Auth } from "../../../clients/buyer-gateway/src/auth.mjs";
import { Store } from "../../../clients/buyer-gateway/src/store.mjs";
import { NearRpc } from "../../../clients/buyer-gateway/src/near.mjs";
import { hash, requireThat } from "../contract.mjs";
export class PublicWorkspace {
  constructor(config, pool) {
    this.pool = pool;
    this.origin = config.origin;
    this.rpc = new NearRpc(config.rpcUrl ?? "https://rpc.mainnet.near.org");
    this.store = new Store(
      config.storePath,
      Buffer.from(config.storageKey, "hex"),
    );
    this.auth = new Auth(
      this.store,
      new NearRpc(config.rpcUrl ?? "https://rpc.mainnet.near.org"),
      config.origin,
    );
  }
  async provision(account) {
    const db = await this.pool.connect(),
      owner = "mainnet:" + account;
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "public-workspace-provision",
      ]);
      const existing = (
        await db.query(
          "SELECT user_id FROM mpp_direct_agents WHERE owner_id=$1",
          [owner],
        )
      ).rows;
      if (existing.length) {
        requireThat(existing.length === 2, "owner_allocation_incomplete");
        await db.query("COMMIT");
        return owner;
      }
      const slots = (
        await db.query(
          "SELECT * FROM mpp_direct_agents WHERE owner_id IS NULL AND agent_id LIKE 'public-%' ORDER BY agent_id LIMIT 2 FOR UPDATE",
        )
      ).rows;
      requireThat(slots.length === 2, "public_demo_capacity_reached");
      for (let i = 0; i < slots.length; i++) {
        const a = slots[i],
          id = randomUUID(),
          task = "task-" + id,
          at = Date.now();
        await db.query(
          "UPDATE mpp_direct_agents SET owner_id=$2 WHERE user_id=$1",
          [a.user_id, owner],
        );
        await db.query(
          "INSERT INTO mpp_direct_p2_agent_limits(user_id,budget_nano) VALUES($1,20000000)",
          [a.user_id],
        );
        await db.query(
          "INSERT INTO mpp_direct_tasks(id,user_id,budget_nano,hard_bid_nano,call_cap_nano,deadline_ms) VALUES($1,$2,10000000,3000000,3000000,$3)",
          [task, a.user_id, at + 604800000],
        );
        const prompt =
          "Compute the sum of numbers.txt, write result.txt, and verify the result.";
        await db.query(
          "INSERT INTO mpp_direct_p2_sessions(id,user_id,task_id,prompt,workspace,created_ms) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            a.user_id,
            task,
            prompt,
            {
              "/workspace/task.txt": prompt,
              "/workspace/numbers.txt": i === 0 ? "3\n7\n32\n" : "5\n5\n9\n",
            },
            at,
          ],
        );
      }
      await db.query("COMMIT");
      return owner;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  wallets(owner) {
    return this.store.get("native-wallets", hash(owner), owner)?.agents ?? [];
  }
  async register(owner, agents) {
    requireThat(
      Array.isArray(agents) && agents.length === 2,
      "invalid_native_wallets",
    );
    const ids = (
      await this.pool.query(
        "SELECT agent_id FROM mpp_direct_agents WHERE owner_id=$1",
        [owner],
      )
    ).rows
      .map((x) => x.agent_id)
      .sort();
    requireThat(
      JSON.stringify(agents.map((x) => x.id).sort()) === JSON.stringify(ids),
      "wrong_native_agents",
    );
    for (const a of agents) {
      requireThat(
        typeof a.publicKey === "string" &&
          a.publicKey.startsWith("ed25519:") &&
          typeof a.signature === "string" &&
          a.signature.length <= 100,
        "invalid_native_key",
      );
      const raw = Buffer.from(bs58.decode(a.publicKey.slice(8))),
        sig = Buffer.from(a.signature, "base64");
      requireThat(
        raw.length === 32 &&
          a.address === raw.toString("hex") &&
          sig.length === 64,
        "invalid_native_key",
      );
      const message = JSON.stringify({
        action: "register-agent-wallet",
        origin: this.origin,
        network: "mainnet",
        owner,
        id: a.id,
        address: a.address,
      });
      const key = createPublicKey({
        format: "der",
        type: "spki",
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          raw,
        ]),
      });
      requireThat(
        verify(null, Buffer.from(message), key, sig),
        "invalid_native_key_proof",
      );
    }
    requireThat(
      new Set(agents.map((a) => a.address)).size === 2,
      "duplicate_native_wallet",
    );
    const clean = agents
      .map(({ id, address, publicKey }) => ({ id, address, publicKey }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const previous = this.wallets(owner);
    requireThat(
      !previous.length || JSON.stringify(previous) === JSON.stringify(clean),
      "native_wallets_already_registered_restore_backup",
    );
    this.store.put("native-wallets", hash(owner), owner, { agents: clean });
    return clean;
  }
  operations(owner) {
    return this.store.list("native-operation", owner);
  }
  async begin(owner, input) {
    requireThat(
      /^[a-zA-Z0-9_-]{1,96}$/.test(input.id) &&
        ["fund", "withdraw"].includes(input.kind) &&
        /^[1-9][0-9]{0,25}$/.test(input.amount),
      "invalid_native_operation",
    );
    requireThat(
      input.kind !== "fund" || BigInt(input.amount) <= 10n ** 23n,
      "native_funding_cap",
    );
    const wallet = this.wallets(owner).find((a) => a.id === input.agentId);
    requireThat(wallet, "unknown_native_wallet");
    const account = owner.slice("mainnet:".length),
      old = this.store.get("native-operation", hash([owner, input.id]), owner);
    if (old) {
      requireThat(
        old.agentId === input.agentId &&
          old.amount === input.amount &&
          old.kind === input.kind &&
          old.hash === (input.hash ?? null),
        "native_operation_conflict",
      );
      return old;
    }
    requireThat(
      input.kind !== "withdraw" ||
        (typeof input.bytes === "string" && input.bytes.length < 8192),
      "original_signed_bytes_required",
    );
    const block = await this.rpc.call("block", { finality: "final" });
    requireThat(
      Number.isSafeInteger(block.header.height),
      "invalid_native_block",
    );
    const operation = {
      id: input.id,
      agentId: input.agentId,
      amount: input.amount,
      kind: input.kind,
      state: "pending",
      hash: input.hash ?? null,
      preparedHeight: block.header.height,
      ...(input.kind === "withdraw" ? { bytes: input.bytes } : {}),
      sender: input.kind === "fund" ? account : wallet.address,
      recipient: input.kind === "fund" ? wallet.address : account,
    };
    requireThat(
      !operation.hash || /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(operation.hash),
      "invalid_native_hash",
    );
    // No await inside this transaction: two tabs cannot both clear the hold.
    return this.store.transaction(() => {
      const again = this.store.get(
        "native-operation",
        hash([owner, input.id]),
        owner,
      );
      if (again) {
        requireThat(
          JSON.stringify(again) === JSON.stringify(operation),
          "native_operation_conflict",
        );
        return again;
      }
      requireThat(
        !this.operations(owner).some(
          (o) => o.agentId === input.agentId && o.state === "pending",
        ),
        "original_native_transfer_pending",
      );
      requireThat(
        !operation.hash ||
          !this.operations(owner).some((o) => o.hash === operation.hash),
        "native_hash_already_used",
      );
      this.store.put(
        "native-operation",
        hash([owner, operation.id]),
        owner,
        operation,
      );
      return operation;
    });
  }
  async reconcile(owner, id, input) {
    const o = this.store.get("native-operation", hash([owner, id]), owner);
    requireThat(o, "unknown_native_operation");
    if (o.state !== "pending") return o;
    const candidate = o.hash ?? input.hash;
    requireThat(
      typeof candidate === "string" &&
        /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(candidate),
      "original_native_hash_required",
    );
    requireThat(
      !o.hash || !input.hash || o.hash === input.hash,
      "native_hash_conflict",
    );
    requireThat(
      !this.operations(owner).some((x) => x.id !== id && x.hash === candidate),
      "native_hash_already_used",
    );
    const tx = await this.rpc.call("tx", {
      tx_hash: candidate,
      sender_account_id: o.sender,
      wait_until: "FINAL",
    });
    requireThat(
      tx.final_execution_status === "FINAL",
      "native_transfer_not_final",
    );
    const t = tx.transaction;
    requireThat(
      t?.hash === candidate &&
        t.signer_id === o.sender &&
        t.receiver_id === o.recipient &&
        t.actions?.length === 1 &&
        t.actions[0]?.Transfer?.deposit === o.amount,
      "native_transfer_mismatch",
    );
    const block = await this.rpc.call("block", {
      block_id: tx.transaction_outcome.block_hash,
    });
    requireThat(
      block.header.height > o.preparedHeight,
      "native_transfer_predates_operation",
    );
    requireThat(
      typeof tx.status?.SuccessValue === "string" || tx.status?.Failure,
      "native_transfer_status_unknown",
    );
    return this.store.transaction(() => {
      const latest = this.store.get(
        "native-operation",
        hash([owner, id]),
        owner,
      );
      if (latest.state !== "pending") return latest;
      requireThat(
        !latest.hash || latest.hash === candidate,
        "native_hash_conflict",
      );
      requireThat(
        !this.operations(owner).some(
          (x) => x.id !== id && x.hash === candidate,
        ),
        "native_hash_already_used",
      );
      const result = {
        ...latest,
        hash: candidate,
        state: typeof tx.status?.SuccessValue === "string" ? "final" : "failed",
      };
      this.store.put("native-operation", hash([owner, id]), owner, result);
      return result;
    });
  }
  bindHash(owner, id, input) {
    requireThat(
      typeof input.hash === "string" &&
        /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(input.hash),
      "invalid_native_hash",
    );
    const key = hash([owner, id]),
      o = this.store.get("native-operation", key, owner);
    requireThat(o, "unknown_native_operation");
    requireThat(!o.hash || o.hash === input.hash, "native_hash_conflict");
    requireThat(
      !this.operations(owner).some((x) => x.id !== id && x.hash === input.hash),
      "native_hash_already_used",
    );
    const result = { ...o, hash: input.hash };
    this.store.put("native-operation", key, owner, result);
    return result;
  }
  owner(token) {
    return "mainnet:" + this.auth.owner(token).account_id;
  }
  close() {
    this.store.close();
  }
}

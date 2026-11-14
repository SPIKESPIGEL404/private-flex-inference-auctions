// Owned local fixtures only. Never enable these in a real-chain/provider server.
import { hash } from "../../contract.mjs";
export async function controlledAdapters(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS fixture_auction_wallet_accounts(id text PRIMARY KEY,amount numeric(39,0) NOT NULL CHECK(amount>=0));
  CREATE TABLE IF NOT EXISTS fixture_auction_wallet_ops(id text PRIMARY KEY,binding text NOT NULL,result jsonb NOT NULL);
  CREATE TABLE IF NOT EXISTS fixture_auction_provider_ops(id text PRIMARY KEY,binding text NOT NULL,result jsonb NOT NULL)`);
  async function walletOperation(op, kind) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(91420261114)");
      const fingerprint = hash(op.binding),
        old = (
          await db.query(
            "SELECT * FROM fixture_auction_wallet_ops WHERE id=$1",
            [op.id],
          )
        ).rows[0];
      if (old) {
        if (old.binding !== fingerprint)
          throw Error("fixture_wallet_operation_conflict");
        if (old.result.state === "never_sent")
          throw Error("original_operation_sealed_never_sent");
        await db.query("COMMIT");
        return old.result;
      }
      const r = kind === "payment" ? op.binding.challenge.request : op.binding;
      const sender = kind === "payment" ? r.payer : r.sender,
        recipient = kind === "payment" ? r.recipient : r.recipient;
      const gas = "500000000000000000";
      await db.query(
        "UPDATE fixture_auction_wallet_accounts SET amount=amount-$2 WHERE id=$1",
        [sender, String(BigInt(r.amount) + BigInt(gas))],
      );
      await db.query(
        "UPDATE fixture_auction_wallet_accounts SET amount=amount+$2 WHERE id=$1",
        [recipient, r.amount],
      );
      const result =
        kind === "payment"
          ? {
              movementKey: "controlled-native:" + op.id,
              orderRef: r.orderRef,
              amount: r.amount,
              network: r.network,
              payer: r.payer,
              recipient: r.recipient,
              challengeId: op.binding.challenge.id,
              gasActualYocto: gas,
              late: Date.now() > r.expiresAtMs,
              scope: "controlled-fixture",
            }
          : {
              ...r,
              operationId: op.id,
              movementKey: "controlled-refund:" + op.id,
              gasActualYocto: gas,
              scope: "controlled-fixture",
            };
      await db.query(
        "INSERT INTO fixture_auction_wallet_ops VALUES($1,$2,$3)",
        [op.id, fingerprint, result],
      );
      await db.query("COMMIT");
      return result;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  const wallet = {
    scope: "controlled-fixture",
    durableOriginalOperations: true,
    async sealOriginal(op) {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await db.query("SELECT pg_advisory_xact_lock(91420261114)");
        const existing = (
          await db.query(
            "SELECT result FROM fixture_auction_wallet_ops WHERE id=$1",
            [op.id],
          )
        ).rows[0];
        const result = existing?.result ?? {
          operationId: op.id,
          state: "never_sent",
        };
        if (!existing)
          await db.query(
            "INSERT INTO fixture_auction_wallet_ops VALUES($1,$2,$3)",
            [op.id, hash(op.binding), result],
          );
        await db.query("COMMIT");
        return result;
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      } finally {
        db.release();
      }
    },
    async payOriginal(op) {
      return walletOperation(op, "payment");
    },
    async refundOriginal(op) {
      return walletOperation(op, "refund");
    },
    async recoverOriginal(op) {
      return (
        (
          await pool.query(
            "SELECT result FROM fixture_auction_wallet_ops WHERE id=$1",
            [op.id],
          )
        ).rows[0]?.result ?? null
      );
    },
    async balance(payer) {
      return {
        source: "controlled-native-final-v1",
        network: "testnet",
        payer,
        availableYocto: (
          await pool.query(
            "SELECT amount::text FROM fixture_auction_wallet_accounts WHERE id=$1",
            [payer],
          )
        ).rows[0].amount,
        observedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60000,
      };
    },
  };
  const provider = {
    scope: "controlled-fixture",
    async executeOriginal(permit) {
      const fingerprint = hash(permit.body),
        old = (
          await pool.query(
            "SELECT * FROM fixture_auction_provider_ops WHERE id=$1",
            [permit.executionId],
          )
        ).rows[0];
      if (old) {
        if (old.binding !== fingerprint)
          throw Error("fixture_execution_conflict");
        return old.result;
      }
      const request = JSON.parse(permit.body),
        tool = request.messages.some((m) => m.role === "tool");
      const command = `awk '{s+=$1;n++} END {printf "{\\"sum\\":%d,\\"count\\":%d}\\n",s,n}' /workspace/numbers.txt > /workspace/result.json; cat /workspace/result.json`;
      const id = "controlled-" + permit.executionId,
        frame = (choices, usage) =>
          "data: " +
          JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: 1,
            model: request.model,
            choices,
            ...(usage ? { usage } : {}),
          }) +
          "\n\n";
      const delta = tool
        ? { role: "assistant", content: "Verified the JSON artifact." }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "tool-" + permit.executionId,
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command }),
                },
              },
            ],
          };
      const output = tool ? 10 : 100;
      const result = {
        result: {
          sse:
            frame([{ index: 0, delta, finish_reason: null }]) +
            frame([
              {
                index: 0,
                delta: {},
                finish_reason: tool ? "stop" : "tool_calls",
              },
            ]) +
            frame([], {
              prompt_tokens: 200,
              completion_tokens: output,
              total_tokens: 200 + output,
            }) +
            "data: [DONE]\n\n",
          scope: "controlled-fixture",
        },
        usage: { input: "200", cached: "0", output: String(output) },
      };
      await pool.query(
        "INSERT INTO fixture_auction_provider_ops VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [permit.executionId, fingerprint, result],
      );
      return (
        await pool.query(
          "SELECT result FROM fixture_auction_provider_ops WHERE id=$1",
          [permit.executionId],
        )
      ).rows[0].result;
    },
    async recoverOriginal(executionId) {
      return (
        (
          await pool.query(
            "SELECT result FROM fixture_auction_provider_ops WHERE id=$1",
            [executionId],
          )
        ).rows[0]?.result ?? null
      );
    },
  };
  return { wallet, provider };
}

export async function seedBrowserFixture(pool) {
  const now = Date.now();
  await pool.query(
    `TRUNCATE mpp_direct_auction_state,mpp_direct_auction_budgets,mpp_direct_auction_agents,mpp_direct_auction_grants,mpp_direct_auction_bids,mpp_direct_auction_commands,mpp_direct_auction_revisions,mpp_direct_auction_rounds,mpp_direct_auction_allocations,mpp_direct_auction_operations,mpp_direct_auction_movements,mpp_direct_auction_presentations,mpp_direct_auction_events CASCADE`,
  );
  for (const [id, kind, agent] of [
    ["owner", "owner", null],
    ["agent-a", "agent", "a"],
    ["agent-b", "agent", "b"],
    ["task-a", "task", "a"],
    ["task-b", "task", "b"],
  ])
    await pool.query(
      "INSERT INTO mpp_direct_auction_budgets(id,kind,owner_id,agent_id,cap_nano,deadline_ms) VALUES($1,$2,'owner-1',$3,100000000,$4)",
      [id, kind, agent, now + 600000],
    );
  for (const id of ["a", "b"]) {
    await pool.query(
      "INSERT INTO mpp_direct_auction_agents(id,owner_id,credential_hash,payer,binding_version,owner_budget,agent_budget,balance) VALUES($1,'owner-1',$2,$3,'binding-1','owner',$4,$5)",
      [
        id,
        hash("token-" + id),
        id + ".testnet",
        "agent-" + id,
        {
          source: "controlled-native-final-v1",
          network: "testnet",
          payer: id + ".testnet",
          availableYocto: "1000000000000000000000000",
          observedAtMs: now,
          expiresAtMs: now + 60000,
        },
      ],
    );
    await pool.query(
      "INSERT INTO mpp_direct_auction_grants(id,agent_id,task_budget,call_cap_micro,gas_cap_yocto,deadline_ms) VALUES($1,$2,$3,100000,1000000000000000000,$4)",
      ["grant-" + id, id, "task-" + id, now + 600000],
    );
  }
}

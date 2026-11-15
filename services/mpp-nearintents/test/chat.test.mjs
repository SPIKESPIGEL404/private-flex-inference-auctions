import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  readFile,
  writeFile,
  stat,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { configuration, admit } from "../chat/config.mjs";
import { validateResult } from "../chat/provider.mjs";
import { evmPayer } from "../chat/evm-payer.mjs";
import { FileJournal } from "../chat/journal.mjs";
import { config, BODY, ORIGIN, policy } from "./chat-fixture.mjs";

test("bounded live configuration pins the official settlement endpoint and input/output contract", () => {
  const cfg = config(
    "http://127.0.0.1:1234",
    "http://127.0.0.1:1234/v1/chat/completions",
  );
  assert.equal(admit(BODY, cfg).outputLimit, 128);
  assert.throws(
    () => admit(JSON.stringify({ ...JSON.parse(BODY), max_tokens: 9999 }), cfg),
    /explicit_output_limit_required/,
  );
  assert.throws(
    () => admit(JSON.stringify({ ...JSON.parse(BODY), stream: true }), cfg),
    /terminal_usage_required/,
  );
  assert.throws(
    () => configuration({ ...cfg, mode: "live" }, "x".repeat(32)),
    /invalid_endpoint|official_settlement_required/,
  );
  assert.throws(
    () => configuration({ ...cfg, billing: "pretend-metered" }, "x".repeat(32)),
    /fixed_request_contract_required/,
  );
});
test("provider truncation, identity changes and excess usage cannot become delivered results", () => {
  const terms = {
    model: "test/qwen",
    maxInputTokens: 32000,
    maxOutputTokens: 128,
  };
  const chunk = {
    id: "response-1",
    model: terms.model,
    choices: [
      { index: 0, delta: { content: "answer" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  };
  const stream = "data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n";
  assert.equal(
    validateResult(stream, "text/event-stream", terms, true).completion_tokens,
    1,
  );
  assert.throws(
    () =>
      validateResult(
        stream.replace("data: [DONE]", ""),
        "text/event-stream",
        terms,
        true,
      ),
    /incomplete_provider_stream/,
  );
  assert.throws(
    () =>
      validateResult(
        stream.replace("test/qwen", "wrong-model"),
        "text/event-stream",
        terms,
        true,
      ),
    /unexpected_provider_identity/,
  );
  assert.throws(
    () =>
      validateResult(
        stream,
        "text/event-stream",
        { ...terms, maxOutputTokens: 0 },
        true,
      ),
    /usage_outside_request_contract/,
  );
});

test("EVM payer persists real signed bytes before broadcast and recovers a lost ACK using the same nonce", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "evm-outbox-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new FileJournal(directory);
  await journal.initialize();
  const privateKey = "0x" + "01".repeat(32),
    account = privateKeyToAccount(privateKey);
  let prepares = 0,
    signs = 0,
    confirmations = 0;
  const broadcast = [];
  const clients = {
    wallet: {
      async prepareTransactionRequest(input) {
        prepares++;
        return {
          to: input.to,
          data: input.data,
          value: input.value,
          gas: 80000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
          nonce: 7,
          chainId: 42161,
          type: "eip1559",
        };
      },
      async signTransaction(input) {
        signs++;
        return account.signTransaction(input);
      },
    },
    public: {
      async getChainId() {
        return 42161;
      },
      async sendRawTransaction({ serializedTransaction }) {
        // The durable signed outbox must exist before even this first effect.
        const row = (await journal.list()).find((r) => r.kind === "evm");
        assert.equal(row.signed, serializedTransaction);
        assert.equal(row.nonce, 7);
        broadcast.push(serializedTransaction);
        throw Error("lost_broadcast_ack");
      },
      async waitForTransactionReceipt({ hash }) {
        if (++confirmations === 1) throw Error("receipt_timeout");
        return {
          transactionHash: hash,
          status: "success",
          gasUsed: 50000n,
          effectiveGasPrice: 2n,
        };
      },
    },
  };
  const options = {
    privateKey,
    rpcUrl: "http://127.0.0.1:1234",
    originAsset: ORIGIN,
    refundTo: account.address,
    maximumGasWei: "200000",
    maximumTotalGasWei: "200000",
    policy: policy(),
    journal,
    controlled: true,
    clients,
  };
  const request = {
    currency: ORIGIN,
    amount: "1100",
    recipient: "0x" + "03".repeat(20),
    methodDetails: {
      depositMemo: null,
      refundTo: account.address,
      ...policy().expectedDestination,
    },
  };
  await assert.rejects(
    evmPayer(options).payOriginal({ operationId: "call-1", request }),
    /receipt_timeout/,
  );
  const hash = await evmPayer(options).payOriginal({
    operationId: "call-1",
    request,
  });
  assert.equal(prepares, 1);
  assert.equal(signs, 1);
  assert.equal(broadcast.length, 2);
  assert.equal(broadcast[0], broadcast[1]);
  assert.equal(keccak256(broadcast[0]), hash);
  const tx = parseTransaction(broadcast[0]);
  assert.equal(tx.nonce, 7);
  assert.equal(tx.chainId, 42161);
  assert.equal(
    tx.to.toLowerCase(),
    "0x1111111111111111111111111111111111111111",
  );
  await assert.rejects(
    evmPayer(options).payOriginal({
      operationId: "call-1",
      request: { ...request, amount: "1101" },
    }),
    /original_deposit_conflict/,
  );
  await assert.rejects(
    evmPayer(options).payOriginal({ operationId: "call-2", request }),
    /source_gas_above_total_cap/,
  );
});
test("gas cap and source wallet binding fail before signing or broadcast", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "evm-cap-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new FileJournal(directory);
  await journal.initialize();
  const privateKey = "0x" + "01".repeat(32),
    account = privateKeyToAccount(privateKey);
  let signed = 0;
  const clients = {
    public: { getChainId: async () => 42161 },
    wallet: {
      prepareTransactionRequest: async () => ({ gas: 100n, gasPrice: 10n }),
      signTransaction: async () => {
        signed++;
        throw Error("must_not_sign");
      },
    },
  };
  const opts = {
    privateKey,
    rpcUrl: "http://127.0.0.1:1234",
    originAsset: ORIGIN,
    refundTo: account.address,
    maximumGasWei: "1",
    maximumTotalGasWei: "1",
    policy: policy(),
    journal,
    controlled: true,
    clients,
  };
  const request = {
    currency: ORIGIN,
    amount: "1100",
    recipient: "0x" + "03".repeat(20),
    methodDetails: {
      depositMemo: null,
      refundTo: account.address,
      ...policy().expectedDestination,
    },
  };
  await assert.rejects(
    evmPayer(opts).payOriginal({ operationId: "call-1", request }),
    /source_gas_above_agent_cap/,
  );
  assert.equal(signed, 0);
  await assert.rejects(
    evmPayer(opts).payOriginal({
      operationId: "bad-price",
      request: { ...request, amount: "2001" },
    }),
    /source_amount_above_agent_cap/,
  );
  await assert.rejects(
    evmPayer(opts).payOriginal({
      operationId: "bad-merchant",
      request: {
        ...request,
        methodDetails: {
          ...request.methodDetails,
          destinationRecipient: "wrong.near",
        },
      },
    }),
    /signer_merchant_binding_failed/,
  );
  assert.throws(
    () => evmPayer({ ...opts, refundTo: "0x" + "04".repeat(20) }),
    /agent_signer_binding_failed/,
  );
});
test("journal refuses a concurrent or crash-left wallet lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "journal-lock-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = new FileJournal(directory);
  await journal.initialize();
  await mkdir(journal.path("agent") + ".lock", { mode: 0o700 });
  await assert.rejects(
    journal.locked("agent", () => {
      throw Error("must_not_pay");
    }),
    /original_wallet_operation_locked/,
  );
});
test("agent CLI creates an unfunded private wallet, prints a secret-free plan and refuses unapproved live startup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = promisify(execFile),
    cli = fileURLToPath(new URL("../chat/agent.mjs", import.meta.url));
  const walletFile = join(directory, "wallet.json");
  const generated = await run(process.execPath, [cli, "keygen", walletFile]);
  const wallet = JSON.parse(await readFile(walletFile, "utf8"));
  assert.equal((await stat(walletFile)).mode & 0o077, 0);
  assert.equal(JSON.parse(generated.stdout).funded, false);
  const cfg = JSON.parse(
    await readFile(
      new URL("../chat/agent.example.json", import.meta.url),
      "utf8",
    ),
  );
  cfg.walletFile = walletFile;
  cfg.refundTo = privateKeyToAccount(wallet.privateKey).address;
  cfg.policy.expectedRefundTo = cfg.refundTo;
  const path = join(directory, "agent.json");
  await writeFile(path, JSON.stringify(cfg), { mode: 0o600 });
  const planned = await run(process.execPath, [cli, path, "--plan"]);
  assert.match(JSON.parse(planned.stdout).planHash, /^[a-f0-9]{64}$/);
  assert.equal(planned.stdout.includes(wallet.privateKey), false);
  assert.equal(planned.stdout.includes(wallet.token), false);
  await assert.rejects(
    run(process.execPath, [cli, path], {
      env: { ...process.env, ENABLE_NEARINTENTS_AGENT: "" },
    }),
    /reviewed_agent_payment_plan_required/,
  );
});

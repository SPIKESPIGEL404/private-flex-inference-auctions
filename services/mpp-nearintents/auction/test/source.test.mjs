import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, encodeEventTopics } from "viem";
import { sourceChain } from "../source.mjs";
const from = "0x" + "11".repeat(20),
  to = "0x" + "22".repeat(20),
  token = "0x" + "33".repeat(20),
  hash = "0x" + "44".repeat(32);
const abi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
];
test("funding reconciliation verifies source transaction, exact recipient/amount and delivered ERC20 log", async () => {
  let logs = [
    {
      address: token,
      topics: encodeEventTopics({
        abi,
        eventName: "Transfer",
        args: { from, to },
      }),
      data: "0x" + 1000n.toString(16).padStart(64, "0"),
    },
  ];
  const client = {
    getChainId: async () => 42161,
    getTransaction: async () => ({
      hash,
      from,
      to: token,
      value: 0n,
      input: encodeFunctionData({
        abi,
        functionName: "transfer",
        args: [to, 1000n],
      }),
    }),
    getTransactionReceipt: async () => ({
      transactionHash: hash,
      status: "success",
      blockNumber: 10n,
      blockHash: "0x" + "f".repeat(64),
      logs,
    }),
  };
  const s = sourceChain(
      { originAsset: "eip155:42161/erc20:" + token },
      { client },
    ),
    f = { tx_hash: hash, source_address: from, kind: "token", amount: "1000" };
  assert.equal((await s.fundingProof(f, { payer: to })).success, true);
  logs = [];
  await assert.rejects(
    s.fundingProof(f, { payer: to }),
    /source_funding_delivery_not_proven/,
  );
  await assert.rejects(
    s.fundingProof({ ...f, amount: "1001" }, { payer: to }),
    /source_funding_binding_conflict/,
  );
});
test("a reverted funding command still binds its exact target and amount", async () => {
  let target = to;
  const s = sourceChain(
    { originAsset: "eip155:42161/erc20:" + token },
    {
      client: {
        getChainId: async () => 42161,
        getTransaction: async () => ({
          hash,
          from,
          to: target,
          value: 1000n,
          input: "0x",
        }),
        getTransactionReceipt: async () => ({
          transactionHash: hash,
          status: "reverted",
          blockNumber: 10n,
          logs: [],
        }),
      },
    },
  );
  const f = {
    tx_hash: hash,
    source_address: from,
    kind: "gas",
    amount: "1000",
  };
  assert.equal((await s.fundingProof(f, { payer: to })).success, false);
  target = token;
  await assert.rejects(
    s.fundingProof(f, { payer: to }),
    /source_funding_binding_conflict/,
  );
  target = to;
  await assert.rejects(
    s.fundingProof({ ...f, amount: "1001" }, { payer: to }),
    /source_funding_binding_conflict/,
  );
});
test("source observation reads token and gas at one block and rejects another RPC chain", async () => {
  let network = 42161;
  const blocks = [];
  const s = sourceChain(
    { originAsset: "eip155:42161/erc20:" + token },
    {
      client: {
        getChainId: async () => network,
        getBlockNumber: async () => 12n,
        readContract: async (x) => {
          blocks.push(x.blockNumber);
          return 123n;
        },
        getBalance: async (x) => {
          blocks.push(x.blockNumber);
          return 456n;
        },
      },
    },
  );
  assert.deepEqual(await s.balance(to), {
    sourceAtoms: "123",
    gasWei: "456",
    blockNumber: "12",
  });
  assert.deepEqual(blocks, [12n, 12n]);
  network = 1;
  await assert.rejects(s.balance(to), /source_rpc_chain_mismatch/);
});

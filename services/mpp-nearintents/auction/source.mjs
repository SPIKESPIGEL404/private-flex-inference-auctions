import {
  createPublicClient,
  http,
  decodeFunctionData,
  parseEventLogs,
} from "viem";
import { check } from "../chat/config.mjs";
const tokenAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
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
export function sourceChain(config, { client } = {}) {
  const rpc =
      client ??
      createPublicClient({
        transport: http(config.sourceRpcUrl, { retryCount: 0, timeout: 10000 }),
      }),
    contract = config.originAsset.split(":").at(-1),
    same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
  return {
    async balance(payer) {
      check((await rpc.getChainId()) === 42161, "source_rpc_chain_mismatch");
      const blockNumber = await rpc.getBlockNumber();
      const [sourceAtoms, gasWei] = await Promise.all([
        rpc.readContract({
          address: contract,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [payer],
          blockNumber,
        }),
        rpc.getBalance({ address: payer, blockNumber }),
      ]);
      return {
        sourceAtoms: String(sourceAtoms),
        gasWei: String(gasWei),
        blockNumber: String(blockNumber),
      };
    },
    async fundingProof(f, a) {
      check((await rpc.getChainId()) === 42161, "source_rpc_chain_mismatch");
      let tx, receipt;
      try {
        [tx, receipt] = await Promise.all([
          rpc.getTransaction({ hash: f.tx_hash }),
          rpc.getTransactionReceipt({ hash: f.tx_hash }),
        ]);
      } catch {
        return null;
      }
      check(
        same(tx.hash, f.tx_hash) &&
          same(tx.from, f.source_address) &&
          same(receipt.transactionHash, f.tx_hash),
        "source_funding_binding_conflict",
      );
      if (f.kind === "gas")
        check(
          same(tx.to, a.payer) &&
            String(tx.value) === f.amount &&
            (tx.input === "0x" || !tx.input),
          "source_funding_binding_conflict",
        );
      else {
        check(
          same(tx.to, contract) && BigInt(tx.value) === 0n,
          "source_funding_binding_conflict",
        );
        const call = decodeFunctionData({ abi: tokenAbi, data: tx.input });
        check(
          call.functionName === "transfer" &&
            same(call.args[0], a.payer) &&
            String(call.args[1]) === f.amount,
          "source_funding_binding_conflict",
        );
      }
      // A failed transaction still has to be the original funding command.
      // Otherwise an unrelated revert could incorrectly close a pending intent.
      if (receipt.status !== "success")
        return {
          success: false,
          txHash: f.tx_hash,
          blockNumber: String(receipt.blockNumber),
        };
      if (f.kind !== "gas") {
        const logs = parseEventLogs({
          abi: tokenAbi,
          eventName: "Transfer",
          logs: receipt.logs,
        });
        check(
          logs.some(
            (l) =>
              same(l.address, contract) &&
              same(l.args.from, f.source_address) &&
              same(l.args.to, a.payer) &&
              String(l.args.value) === f.amount,
          ),
          "source_funding_delivery_not_proven",
        );
      }
      return {
        success: true,
        txHash: f.tx_hash,
        blockNumber: String(receipt.blockNumber),
        blockHash: receipt.blockHash,
        sourceAddress: tx.from,
        recipient: a.payer,
        amount: f.amount,
        kind: f.kind,
      };
    },
  };
}

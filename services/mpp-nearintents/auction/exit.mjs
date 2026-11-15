import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { check, digest, uint } from "../chat/config.mjs";
const abi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
];
export async function exitOriginal({
  market,
  config,
  journal,
  key,
  agentId,
  owner,
  input,
  clients,
}) {
  check(
    input &&
      ["token", "gas"].includes(input.kind) &&
      /^0x[a-fA-F0-9]{40}$/.test(input.recipient) &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(input.operation),
    "bounded_owner_exit_required",
  );
  const walletKey = digest([42161, key.address.toLowerCase()]),
    operationId = "owner-exit-" + digest([agentId, input.operation]),
    id = `evm:${walletKey}:${operationId}`,
    binding = digest([agentId, owner, input.kind, input.recipient]);
  return journal.locked("evm:" + walletKey, async () => {
    await market.transaction(async (db) => {
      const a = (
        await db.query(
          "SELECT active FROM mpp_direct_auction_agents WHERE id=$1 AND owner_id=$2",
          [agentId, owner],
        )
      ).rows[0];
      check(a && !a.active, "freeze_agent_before_exit");
    });
    const account = privateKeyToAccount(key.privateKey),
      chain = {
        id: 42161,
        name: "Arbitrum",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [config.sourceRpcUrl] } },
      };
    const publicClient =
        clients?.public ??
        createPublicClient({
          chain,
          transport: http(config.sourceRpcUrl, { retryCount: 0 }),
        }),
      walletClient =
        clients?.wallet ??
        createWalletClient({
          account,
          chain,
          transport: http(config.sourceRpcUrl, { retryCount: 0 }),
        });
    check(
      (await publicClient.getChainId()) === 42161,
      "source_rpc_chain_mismatch",
    );
    let row = await journal.get(id);
    check(!row || row.binding === binding, "original_owner_exit_conflict");
    if (!row) {
      const all = (await journal.list()).filter(
        (r) => r.kind === "evm" && r.walletKey === walletKey,
      );
      check(
        !all.some((r) => r.state !== "confirmed" && r.state !== "failed"),
        "original_wallet_transfer_unresolved",
      );
      check(
        all.filter((r) => r.purpose === "owner-exit").length < 8,
        "owner_exit_count_limit",
      );
      const token = config.originAsset.split(":").at(-1).toLowerCase();
      let amount = 0n,
        transaction;
      if (input.kind === "token") {
        const balances = await publicClient.readContract({
          address: token,
          abi: [
            {
              type: "function",
              name: "balanceOf",
              stateMutability: "view",
              inputs: [{ name: "account", type: "address" }],
              outputs: [{ type: "uint256" }],
            },
          ],
          functionName: "balanceOf",
          args: [key.address],
        });
        amount = BigInt(balances);
        check(amount > 0n, "no_source_tokens_to_exit");
        transaction = {
          to: token,
          data: encodeFunctionData({
            abi,
            functionName: "transfer",
            args: [input.recipient, amount],
          }),
        };
      } else {
        const code = await publicClient.getCode({ address: input.recipient });
        check(!code || code === "0x", "ordinary_evm_exit_recipient_required");
        transaction = { to: input.recipient, value: 0n };
      }
      let prepared = await walletClient.prepareTransactionRequest({
        ...transaction,
        account,
        chain,
      });
      const gasCap =
        BigInt(prepared.gas) *
        BigInt(prepared.maxFeePerGas ?? prepared.gasPrice);
      check(
        gasCap > 0n && gasCap <= uint(config.maximumGasWei),
        "owner_exit_gas_above_cap",
      );
      const available = await publicClient.getBalance({ address: key.address });
      if (input.kind === "gas") {
        check(available > gasCap, "no_source_gas_to_exit");
        amount = available - gasCap;
        prepared = { ...prepared, value: amount };
      } else check(available >= gasCap, "owner_exit_gas_required");
      const signed = await walletClient.signTransaction(prepared);
      row = {
        kind: "evm",
        purpose: "owner-exit",
        walletKey,
        operationId,
        command: input.operation,
        binding,
        agentId,
        owner,
        exitKind: input.kind,
        recipient: input.recipient,
        amount: String(amount),
        amountIn: "0",
        asset: config.originAsset,
        gasCapWei: String(gasCap),
        signed,
        hash: keccak256(signed),
        nonce: prepared.nonce,
        state: "signed",
      };
      await journal.put(id, row);
    }
    if (!["confirmed", "failed"].includes(row.state)) {
      try {
        await publicClient.sendRawTransaction({
          serializedTransaction: row.signed,
        });
      } catch {}
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: row.hash,
        confirmations: 1,
        timeout: 120000,
      });
      check(
        receipt.transactionHash.toLowerCase() === row.hash.toLowerCase(),
        "original_owner_exit_receipt_conflict",
      );
      row = {
        ...row,
        state: receipt.status === "success" ? "confirmed" : "failed",
        gasUsed: String(receipt.gasUsed),
        effectiveGasPrice: String(receipt.effectiveGasPrice),
      };
      await journal.put(id, row);
    }
    return publicExit(row);
  });
}
export const publicExit = (r) => ({
  operation: r.command,
  id: r.operationId,
  agentId: r.agentId,
  kind: r.exitKind,
  recipient: r.recipient,
  amount: r.amount,
  state: r.state,
  txHash: r.hash,
  gasWei:
    r.gasUsed && r.effectiveGasPrice
      ? String(uint(r.gasUsed) * uint(r.effectiveGasPrice))
      : null,
});

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Types } from "@defuse-protocol/nearintents-mpp-sdk";
import { check, digest, endpoint, uint } from "./config.mjs";

const transfer = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
];
export function evmPayer({
  privateKey,
  rpcUrl,
  originAsset,
  refundTo,
  maximumGasWei,
  maximumTotalGasWei,
  policy,
  journal,
  controlled = false,
  clients,
}) {
  const asset = Types.parseCaip19(originAsset);
  check(
    asset.chain.namespace === "eip155" &&
      ["erc20", "slip44"].includes(asset.assetNamespace),
    "evm_asset_required",
  );
  endpoint(rpcUrl, controlled);
  const account = privateKeyToAccount(privateKey),
    chainId = Number(asset.chain.reference);
  check(
    Number.isSafeInteger(chainId) &&
      chainId > 0 &&
      Types.addressEqual(Types.chainOf(originAsset), account.address, refundTo),
    "agent_signer_binding_failed",
  );
  check(
    uint(maximumGasWei) > 0n && uint(maximumTotalGasWei) >= uint(maximumGasWei),
    "agent_gas_cap_required",
  );
  check(
    policy?.expectedDestination?.destinationAsset &&
      policy.expectedDestination.destinationRecipient &&
      uint(policy.maxAmountIn?.[originAsset]) > 0n,
    "signer_payment_policy_required",
  );
  const chain = {
    id: chainId,
    name: "agent-source",
    nativeCurrency: { name: "Gas", symbol: "GAS", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  const publicClient =
    clients?.public ??
    createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0 }) });
  const walletClient =
    clients?.wallet ??
    createWalletClient({
      account,
      chain,
      transport: http(rpcUrl, { retryCount: 0 }),
    });
  const walletKey = digest([chainId, account.address.toLowerCase()]);
  return {
    durableOriginalOperations: true,
    address: account.address,
    async payOriginal({ operationId, request, signal }) {
      return journal.locked("evm:" + walletKey, async () => {
        signal?.throwIfAborted();
        check(
          (await publicClient.getChainId()) === chainId &&
            Types.assetEqual(request.currency, originAsset),
          "source_chain_or_asset_mismatch",
        );
        check(
          /^0x[a-fA-F0-9]{40}$/.test(request.recipient) &&
            !request.methodDetails.depositMemo,
          "invalid_evm_deposit",
        );
        check(
          uint(request.amount) > 0n &&
            uint(request.amount) <= uint(policy.maxAmountIn[originAsset]),
          "source_amount_above_agent_cap",
        );
        check(
          Types.assetEqual(
            request.methodDetails.destinationAsset,
            policy.expectedDestination.destinationAsset,
          ) &&
            request.methodDetails.destinationRecipient ===
              policy.expectedDestination.destinationRecipient,
          "signer_merchant_binding_failed",
        );
        check(
          Types.addressEqual(
            Types.chainOf(originAsset),
            request.methodDetails.refundTo,
            account.address,
          ),
          "source_refund_address_mismatch",
        );
        check(
          asset.assetNamespace !== "erc20" ||
            /^0x[a-fA-F0-9]{40}$/.test(
              Types.decodeAssetReference(asset.assetReference),
            ),
          "invalid_evm_token_contract",
        );
        const key = `evm:${walletKey}:${operationId}`,
          binding = digest(request);
        let old = await journal.get(key);
        check(!old || old.binding === binding, "original_deposit_conflict");
        if (!old) {
          check(
            !(await journal.list()).some(
              (r) =>
                r.kind === "evm" &&
                r.walletKey === walletKey &&
                r.state !== "confirmed",
            ),
            "original_wallet_transfer_unresolved",
          );
          const amount = uint(request.amount);
          const transaction =
            asset.assetNamespace === "erc20"
              ? {
                  to: Types.decodeAssetReference(asset.assetReference),
                  data: encodeFunctionData({
                    abi: transfer,
                    functionName: "transfer",
                    args: [request.recipient, amount],
                  }),
                }
              : { to: request.recipient, value: amount };
          const prepared = await walletClient.prepareTransactionRequest({
            ...transaction,
            account,
            chain,
          });
          const gasCost =
            BigInt(prepared.gas) *
            BigInt(prepared.maxFeePerGas ?? prepared.gasPrice);
          check(gasCost <= uint(maximumGasWei), "source_gas_above_agent_cap");
          const reservedGas = (await journal.list())
            .filter((r) => r.kind === "evm" && r.walletKey === walletKey)
            .reduce((n, r) => n + uint(r.gasCapWei), 0n);
          check(
            reservedGas + gasCost <= uint(maximumTotalGasWei),
            "source_gas_above_total_cap",
          );
          const signed = await walletClient.signTransaction(prepared),
            hash = keccak256(signed);
          old = {
            kind: "evm",
            walletKey,
            binding,
            operationId,
            signed,
            hash,
            nonce: prepared.nonce,
            gasCapWei: String(gasCost),
            state: "signed",
          };
          await journal.put(key, old);
        }
        if (old.state === "confirmed") return old.hash;
        check(old.state !== "failed", "original_source_transfer_failed");
        // Re-broadcasting these identical signed bytes cannot create a second
        // transfer. No replacement fee, nonce or amount is ever generated.
        try {
          await publicClient.sendRawTransaction({
            serializedTransaction: old.signed,
          });
        } catch {
          /* Observe the original hash even after a lost broadcast ACK. */
        }
        signal?.throwIfAborted();
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: old.hash,
          confirmations: 1,
          timeout: 120000,
        });
        check(
          receipt.transactionHash.toLowerCase() === old.hash.toLowerCase(),
          "original_source_receipt_conflict",
        );
        await journal.put(key, {
          ...old,
          state: receipt.status === "success" ? "confirmed" : "failed",
          gasUsed: String(receipt.gasUsed),
          effectiveGasPrice: String(receipt.effectiveGasPrice),
        });
        check(receipt.status === "success", "original_source_transfer_failed");
        return old.hash;
      });
    },
  };
}

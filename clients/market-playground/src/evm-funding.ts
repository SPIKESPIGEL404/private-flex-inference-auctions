export interface EvmProvider {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
}
export const units = (raw: string, decimals: number) => {
  const n = BigInt(raw),
    scale = 10n ** BigInt(decimals);
  return (
    String(n / scale) +
    "." +
    String(n % scale)
      .padStart(decimals, "0")
      .replace(/0+$/, "")
      .padEnd(2, "0")
  );
};
export function parseUnits(text: string, decimals: number): string {
  if (!new RegExp("^(0|[1-9]\\d*)(\\.\\d{1," + decimals + "})?$").test(text))
    throw Error(
      "Enter a positive amount with at most " + decimals + " decimals.",
    );
  const [a, b = ""] = text.split("."),
    amount =
      BigInt(a) * 10n ** BigInt(decimals) + BigInt(b.padEnd(decimals, "0"));
  if (amount <= 0n) throw Error("Amount must be positive.");
  return String(amount);
}
export async function fundingAccount(provider: EvmProvider, chainId: number) {
  await provider.request({
    method: "eth_requestAccounts",
  });
  const expected = "0x" + chainId.toString(16);
  if (
    BigInt((await provider.request({ method: "eth_chainId" })) as string) !==
    BigInt(chainId)
  )
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: expected }],
    });
  if (
    BigInt((await provider.request({ method: "eth_chainId" })) as string) !==
    BigInt(chainId)
  )
    throw Error("Switch the funding wallet to Arbitrum.");
  // Switching networks can also change the selected account.
  const accounts = (await provider.request({
    method: "eth_accounts",
  })) as string[];
  if (!Array.isArray(accounts) || !/^0x[a-fA-F0-9]{40}$/.test(accounts[0]))
    throw Error("An EVM funding account is required.");
  return accounts[0];
}
export function fundingTransaction({
  from,
  to,
  kind,
  amount,
  tokenAddress,
}: {
  from: string;
  to: string;
  kind: "token" | "gas";
  amount: string;
  tokenAddress: string;
}) {
  if (
    ![from, to, tokenAddress].every((a) => /^0x[a-fA-F0-9]{40}$/.test(a)) ||
    !/^\d+$/.test(amount) ||
    BigInt(amount) <= 0n ||
    BigInt(amount) >= 2n ** 256n
  )
    throw Error("Invalid funding transaction.");
  return kind === "gas"
    ? { from, to, value: "0x" + BigInt(amount).toString(16) }
    : {
        from,
        to: tokenAddress,
        value: "0x0",
        data:
          "0xa9059cbb" +
          to.slice(2).toLowerCase().padStart(64, "0") +
          BigInt(amount).toString(16).padStart(64, "0"),
      };
}

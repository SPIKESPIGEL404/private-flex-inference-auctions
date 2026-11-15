import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fundingAccount,
  fundingTransaction,
  parseUnits,
  units,
} from "../src/evm-funding";
const from = "0x" + "11".repeat(20),
  to = "0x" + "22".repeat(20),
  token = "0x" + "33".repeat(20);
test("USDC and ETH funding preserve independent exact smallest units", () => {
  assert.equal(parseUnits("1.000001", 6), "1000001");
  assert.equal(parseUnits("0.000000000000000001", 18), "1");
  assert.equal(units("42000", 18), "0.000000000000042");
  assert.throws(() => parseUnits("0.0000001", 6));
  assert.throws(() => parseUnits("1e6", 6));
  assert.throws(() => parseUnits("-1", 6));
  const tx = fundingTransaction({
    from,
    to,
    tokenAddress: token,
    kind: "token",
    amount: "1000001",
  });
  assert.equal(tx.to, token);
  assert.equal(tx.value, "0x0");
  assert.equal(
    tx.data,
    "0xa9059cbb" +
      to.slice(2).padStart(64, "0") +
      BigInt(1000001).toString(16).padStart(64, "0"),
  );
  assert.deepEqual(
    fundingTransaction({
      from,
      to,
      tokenAddress: token,
      kind: "gas",
      amount: "1",
    }),
    { from, to, value: "0x1" },
  );
});
test("funding requests a user wallet and verifies the source chain before transfer", async () => {
  const seen: string[] = [];
  let network = "0x1";
  const p = {
    async request({ method }: { method: string }) {
      seen.push(method);
      if (method === "eth_requestAccounts") return [from];
      if (method === "eth_accounts") return [to];
      if (method === "wallet_switchEthereumChain") {
        network = "0xa4b1";
        return null;
      }
      if (method === "eth_chainId") return network;
      throw Error("unexpected_signing");
    },
  };
  assert.equal(await fundingAccount(p, 42161), to);
  assert.deepEqual(seen, [
    "eth_requestAccounts",
    "eth_chainId",
    "wallet_switchEthereumChain",
    "eth_chainId",
    "eth_accounts",
  ]);
  assert.equal(seen.includes("eth_sendTransaction"), false);
});

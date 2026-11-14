import { Auth } from "../../../clients/buyer-gateway/src/auth.mjs";
import { NearRpc } from "../../../clients/buyer-gateway/src/near.mjs";
import { requireThat as check } from "../contract.mjs";
// Reuse ordinary NEP-413 owner login. This volatile store contains authentication
// challenges/cookies only; no agent turns, task instructions or workspaces.
export function ownerAuth({
  origin,
  network = "testnet",
  rpcUrl = "https://rpc.testnet.near.org",
  rpc,
}) {
  const records = new Map();
  const store = {
    get(kind, id) {
      return records.get(kind + ":" + id)?.value ?? null;
    },
    put(kind, id, owner, value) {
      records.set(kind + ":" + id, { kind, owner, value });
    },
    delete(kind, id) {
      records.delete(kind + ":" + id);
    },
    list(kind, owner) {
      return [...records.values()]
        .filter((v) => v.kind === kind && v.owner === owner)
        .map((v) => v.value);
    },
  };
  const reader = rpc ?? new NearRpc(rpcUrl);
  const verified = {
    async fullAccess(accountId, publicKey) {
      if (!rpc) {
        const status = await reader.call("status", []);
        check(status.chain_id === network, "owner_network_mismatch");
      }
      await reader.fullAccess(accountId, publicKey);
    },
  };
  return new Auth(store, verified, origin, Date.now, network);
}

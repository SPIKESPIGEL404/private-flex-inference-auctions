import {
  KeyPair,
  KeyPairSigner,
  JsonRpcProvider,
  createTransaction,
  actions,
  baseDecode,
  baseEncode,
  SignedTransaction,
} from "near-api-js";
import type { KeyPairString } from "near-api-js";
import type {
  NearConnector,
  SignedMessage,
  EventMap,
} from "@hot-labs/near-connect";
import { taskApi } from "./task-api";
export const RPC = "https://rpc.mainnet.near.org";
export const nearAmount = (raw: string) => {
  const n = BigInt(raw);
  return (
    n / 10n ** 24n +
    "." +
    (n % 10n ** 24n)
      .toString()
      .padStart(24, "0")
      .replace(/0+$/, "")
      .padEnd(2, "0")
  );
};
export function parseNear(value: string): string {
  if (!/^(0|[1-9]\d*)(\.\d{1,24})?$/.test(value))
    throw new Error("Enter NEAR with at most 24 decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const n = BigInt(whole) * 10n ** 24n + BigInt(fraction.padEnd(24, "0"));
  if (n <= 0n) throw new Error("Amount must be positive.");
  return String(n);
}
interface Owner {
  account_id: string;
  public_key: string;
}
interface Attempt {
  id: string;
  kind: "fund" | "withdraw";
  amount: string;
  hash?: string;
  bytes?: string;
  state: "pending" | "final" | "failed";
}
export interface LocalAgent {
  id: string;
  address: string;
  publicKey: string;
  secret: KeyPairString;
  backedUp: boolean;
  attempts: Attempt[];
}
interface Vault {
  version: 1;
  network: "mainnet";
  owner: string;
  agents: LocalAgent[];
}
interface Packed {
  iv: string;
  data: string;
}
const b64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const request = <T>(q: IDBRequest<T>) =>
  new Promise<T>((yes, no) => {
    q.onsuccess = () => yes(q.result);
    q.onerror = () => no(q.error);
  });
async function database() {
  return new Promise<IDBDatabase>((yes, no) => {
    const q = indexedDB.open("private-market.native-wallets.v1", 1);
    q.onupgradeneeded = () => q.result.createObjectStore("vaults");
    q.onsuccess = () => yes(q.result);
    q.onerror = () => no(q.error);
  });
}
async function vaultRecord(id: string) {
  const db = await database();
  try {
    return await request(
      db.transaction("vaults").objectStore("vaults").get(id),
    );
  } finally {
    db.close();
  }
}
async function saveRecord(id: string, value: unknown) {
  const db = await database();
  try {
    await new Promise<void>((yes, no) => {
      const tx = db.transaction("vaults", "readwrite");
      tx.objectStore("vaults").put(value, id);
      tx.oncomplete = () => yes();
      tx.onerror = () => no(tx.error);
      tx.onabort = () => no(tx.error);
    });
  } finally {
    db.close();
  }
}
async function encrypt(value: unknown, key: CryptoKey): Promise<Packed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return {
    iv: b64(iv),
    data: b64(
      new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          key,
          new TextEncoder().encode(JSON.stringify(value)),
        ),
      ),
    ),
  };
}
async function decrypt(p: Packed, key: CryptoKey) {
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(p.iv) },
        key,
        unb64(p.data),
      ),
    ),
  );
}
async function passwordKey(password: string, salt: Uint8Array) {
  if (password.length < 12)
    throw new Error("Use a backup password of at least 12 characters.");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new Uint8Array(salt),
      iterations: 310000,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export interface NativeState {
  owner: Owner | null;
  agents: Array<Omit<LocalAgent, "secret">>;
  balances: Record<string, string>;
  busy: boolean;
  error: string;
  message: string;
}
export class NativeWalletController {
  private state: NativeState = {
    owner: null,
    agents: [],
    balances: {},
    busy: false,
    error: "",
    message: "",
  };
  private vault?: Vault;
  private key?: CryptoKey;
  private connector?: NearConnector;
  constructor(
    private readonly dependencies: {
      connector?: () => Promise<NearConnector>;
      provider?: () => JsonRpcProvider;
    } = {},
  ) {}
  private authNetwork: "mainnet" | "testnet" = "mainnet";
  private ownerOnly = false;
  configureAuthentication(network: "mainnet" | "testnet", ownerOnly = false) {
    if (this.authNetwork !== network || this.ownerOnly !== ownerOnly) {
      this.lock();
      this.connector = undefined;
    }
    this.authNetwork = network;
    this.ownerOnly = ownerOnly;
  }
  private provider() {
    return this.dependencies.provider?.() ?? new JsonRpcProvider({ url: RPC });
  }
  private epoch = 0;
  private listeners = new Set<() => void>();
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.state;
  private update(p: Partial<NativeState>) {
    this.state = { ...this.state, ...p };
    for (const f of this.listeners) f();
  }
  private lock() {
    this.epoch++;
    this.vault = undefined;
    this.key = undefined;
    this.update({ owner: null, agents: [], balances: {} });
  }
  private async persist() {
    const vault = this.vault,
      key = this.key,
      e = this.epoch;
    if (!vault || !key) throw new Error("Wallet locked.");
    await saveRecord("mainnet:" + vault.owner, {
      key,
      packed: await encrypt(vault, key),
    });
    if (e === this.epoch)
      this.update({ agents: vault.agents.map(({ secret: _, ...a }) => a) });
  }
  private assertOwner(owner: string, epoch: number) {
    if (
      this.epoch !== epoch ||
      this.state.owner?.account_id !== owner ||
      (this.vault && this.vault.owner !== owner)
    )
      throw new Error("Wallet session changed.");
  }
  private async syncOperations(write = true) {
    const vault = this.vault,
      e = this.epoch;
    if (!vault) return;
    const { operations } = await taskApi<{
      operations: Array<Attempt & { agentId: string }>;
    }>("native-operations");
    this.assertOwner(vault.owner, e);
    for (const a of vault.agents)
      a.attempts = operations
        .filter((o) => o.agentId === a.id)
        .map((o) => {
          const local = a.attempts.find((t) => t.id === o.id);
          if (
            local &&
            (local.kind !== o.kind ||
              local.amount !== o.amount ||
              (local.hash && o.hash && local.hash !== o.hash))
          )
            throw new Error("Original transfer journal conflict.");
          return {
            ...o,
            hash: o.hash ?? local?.hash,
            bytes: o.bytes ?? local?.bytes,
          };
        });
    if (write) await this.persist();
    else this.update({ agents: vault.agents.map(({ secret: _, ...a }) => a) });
  }
  private async action(fn: () => Promise<void>) {
    if (this.state.busy) return;
    this.update({ busy: true, error: "", message: "" });
    const owner = this.state.owner?.account_id,
      e = this.epoch;
    try {
      if (this.ownerOnly) {
        await fn();
        return;
      }
      if (!navigator.locks)
        throw new Error(
          "This wallet flow requires a browser with Web Locks support.",
        );
      await navigator.locks.request(
        "private-market.native:" + (owner ?? "login"),
        async () => {
          if (owner) {
            this.assertOwner(owner, e);
            const record = await vaultRecord("mainnet:" + owner);
            this.assertOwner(owner, e);
            if (record) {
              const vault = await decrypt(record.packed, record.key);
              this.assertOwner(owner, e);
              this.key = record.key;
              this.vault = vault;
              await this.syncOperations();
              this.assertOwner(owner, e);
            }
          }
          await fn();
        },
      );
    } catch (error) {
      if (!owner || this.epoch === e)
        this.update({ error: (error as Error).message });
    } finally {
      this.update({ busy: false });
    }
  }
  async load() {
    const e = this.epoch;
    try {
      const { owner } = await taskApi<{ owner: Owner | null }>("session");
      if (e !== this.epoch) return;
      if (!owner) {
        this.lock();
        return;
      }
      if (this.state.owner?.account_id !== owner.account_id) {
        this.lock();
        this.update({ owner });
        const current = this.epoch;
        if (this.ownerOnly) return;
        const record = await vaultRecord("mainnet:" + owner.account_id);
        this.assertOwner(owner.account_id, current);
        if (record) {
          const vault: Vault = await decrypt(record.packed, record.key);
          this.assertOwner(owner.account_id, current);
          if (vault.owner !== owner.account_id || vault.network !== "mainnet")
            throw new Error("Wallet owner mismatch.");
          this.key = record.key;
          this.vault = vault;
          await this.syncOperations(false);
        }
      }
    } catch (error) {
      if (e === this.epoch) this.update({ error: (error as Error).message });
    }
  }
  private async getConnector() {
    if (this.dependencies.connector) return this.dependencies.connector();
    if (!this.connector) {
      const { NearConnector } = await import("@hot-labs/near-connect");
      this.connector = new NearConnector({
        network: this.authNetwork,
        autoConnect: false,
        features: {
          signInAndSignMessage: true,
          signMessage: true,
          signAndSendTransactions: !this.ownerOnly,
        },
      });
      this.connector.on("wallet:signOut", () => {
        this.lock();
        void taskApi("logout", {}).catch(() => {});
      });
      this.connector.on("wallet:signIn", (event) => {
        if (
          this.state.owner &&
          !event.accounts.some(
            (a) => a.accountId === this.state.owner!.account_id,
          )
        ) {
          this.lock();
          void taskApi("logout", {}).catch(() => {});
        }
      });
    }
    return this.connector;
  }
  async connect() {
    const loginEpoch = this.epoch;
    const active = () => {
      if (this.epoch !== loginEpoch) throw new Error("Login was cancelled.");
    };
    await this.action(async () => {
      active();
      const payload = await taskApi<{
          nonce: string;
          recipient: string;
          message: string;
        }>("auth/challenge", {}),
        connector = await this.getConnector();
      active();
      let signed: SignedMessage | undefined;
      const handler = (event: EventMap["wallet:signInAndSignMessage"]) => {
        signed = event.accounts[0]?.signedMessage;
      };
      connector.on("wallet:signInAndSignMessage", handler);
      try {
        await connector.connect({
          signMessageParams: { ...payload, nonce: unb64(payload.nonce) },
        });
      } finally {
        connector.off("wallet:signInAndSignMessage", handler);
      }
      active();
      if (!signed)
        throw new Error("The wallet did not sign the login message.");
      await taskApi("auth/verify", signed);
      if (this.epoch !== loginEpoch) {
        await taskApi("logout", {});
        throw new Error("Login was cancelled.");
      }
      await this.load();
    });
  }
  async disconnect() {
    this.lock();
    try {
      await taskApi("logout", {});
    } finally {
      try {
        await this.connector?.disconnect();
      } catch {}
    }
  }
  async prepare(ids: string[]) {
    if (this.ownerOnly)
      throw new Error("Native funding is not enabled for this market.");
    await this.action(async () => {
      const owner = this.state.owner,
        e = this.epoch;
      if (!owner) throw new Error("Connect your NEAR wallet first.");
      if (this.vault) {
        if (ids.some((id) => !this.vault!.agents.some((a) => a.id === id)))
          throw new Error(
            "Existing wallet backup does not match these agents. Restore the correct backup.",
          );
        return;
      }
      if (
        (await taskApi<{ agents: unknown[] }>("native-wallets")).agents.length
      )
        throw new Error(
          "Agent wallets already exist for this owner. Restore their encrypted backup before funding.",
        );
      if (await vaultRecord("mainnet:" + owner.account_id))
        throw new Error("Existing vault found. Reload to unlock it.");
      this.assertOwner(owner.account_id, e);
      const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      this.assertOwner(owner.account_id, e);
      this.key = key;
      this.vault = {
        version: 1,
        network: "mainnet",
        owner: owner.account_id,
        agents: ids.map((id) => {
          const key = KeyPair.fromRandom("ed25519"),
            publicKey = key.getPublicKey().toString();
          return {
            id,
            address: hex(baseDecode(publicKey.slice(8))),
            publicKey,
            secret: key.toString(),
            backedUp: false,
            attempts: [],
          };
        }),
      };
      await this.persist();
      this.assertOwner(owner.account_id, e);
      await this.register();
    });
  }
  private async register() {
    if (!this.vault || this.vault.owner !== this.state.owner?.account_id)
      throw new Error("Wallet locked.");
    const owner = "mainnet:" + this.vault.owner;
    const agents = this.vault.agents.map((a) => {
      const message = JSON.stringify({
        action: "register-agent-wallet",
        origin: location.origin,
        network: "mainnet",
        owner,
        id: a.id,
        address: a.address,
      });
      return {
        id: a.id,
        address: a.address,
        publicKey: a.publicKey,
        signature: b64(
          KeyPair.fromString(a.secret).sign(new TextEncoder().encode(message))
            .signature,
        ),
      };
    });
    await taskApi("native-wallets", { agents });
  }
  async backup(password: string) {
    if (this.ownerOnly)
      throw new Error("Native funding is not enabled for this market.");
    await this.action(async () => {
      if (!this.vault) throw new Error("Create local agent wallets first.");
      const owner = this.vault.owner,
        e = this.epoch;
      const salt = crypto.getRandomValues(new Uint8Array(16)),
        key = await passwordKey(password, salt),
        data = {
          version: 1,
          kdf: "PBKDF2-SHA256-310000",
          salt: b64(salt),
          ...(await encrypt(this.vault, key)),
        };
      this.assertOwner(owner, e);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "private-market-" + this.vault.owner + "-wallet-backup.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      for (const a of this.vault.agents) a.backedUp = true;
      await this.persist();
      this.update({
        message: "Encrypted backup downloaded. Keep its password separately.",
      });
    });
  }
  async restore(text: string, password: string, ids: string[]) {
    if (this.ownerOnly)
      throw new Error("Native funding is not enabled for this market.");
    await this.action(async () => {
      const owner = this.state.owner?.account_id,
        e = this.epoch;
      if (!owner) throw new Error("Connect your wallet first.");
      if (this.vault?.agents.some((a) => a.backedUp || a.attempts.length))
        throw new Error(
          "Existing wallets are retained. Use another browser profile to verify a backup.",
        );
      const data = JSON.parse(text);
      if (
        data.version !== 1 ||
        data.kdf !== "PBKDF2-SHA256-310000" ||
        typeof data.data !== "string" ||
        data.data.length > 500000
      )
        throw new Error("Invalid backup.");
      const salt = unb64(data.salt);
      if (salt.length !== 16) throw new Error("Invalid backup.");
      const v: Vault = await decrypt(data, await passwordKey(password, salt));
      this.assertOwner(owner, e);
      if (
        v.version !== 1 ||
        v.network !== "mainnet" ||
        v.owner !== this.state.owner?.account_id ||
        v.agents.length !== ids.length ||
        new Set(v.agents.map((a) => a.id)).size !== ids.length ||
        ids.some((id) => !v.agents.some((a) => a.id === id))
      )
        throw new Error("Backup owner or agents do not match.");
      for (const a of v.agents) {
        const k = KeyPair.fromString(a.secret);
        if (
          k.getPublicKey().toString() !== a.publicKey ||
          hex(baseDecode(a.publicKey.slice(8))) !== a.address
        )
          throw new Error("Backup key mismatch.");
        a.backedUp = true;
      }
      const restoredKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      this.assertOwner(owner, e);
      this.key = restoredKey;
      this.vault = v;
      await this.register();
      this.assertOwner(owner, e);
      await this.syncOperations();
      await this.persist();
    });
  }
  async balances() {
    const e = this.epoch;
    const provider = this.provider();
    const values: Record<string, string> = {};
    for (const a of this.state.agents) {
      try {
        const v = await provider.viewAccount({
          accountId: a.address,
          blockQuery: { finality: "final" },
        });
        values[a.id] = v.amount.toString();
      } catch (err) {
        const text = String(err);
        values[a.id] = /UNKNOWN_ACCOUNT|does not exist|not been created/i.test(
          text,
        )
          ? "uncreated"
          : "unavailable";
      }
    }
    if (e === this.epoch) this.update({ balances: values });
  }
  private agent(id: string) {
    const a = this.vault?.agents.find((a) => a.id === id);
    if (
      !a ||
      !this.state.owner ||
      this.vault?.owner !== this.state.owner.account_id ||
      !a.backedUp
    )
      throw new Error("Create and back up these agent wallets first.");
    if (a.attempts.some((a) => a.state === "pending"))
      throw new Error(
        "Reconcile the original pending transfer before sending again.",
      );
    return a;
  }
  async fund(id: string, amount: string) {
    if (this.ownerOnly)
      throw new Error("Native funding is not enabled for this market.");
    await this.action(async () => {
      const a = this.agent(id),
        raw = parseNear(amount),
        owner = this.state.owner!,
        e = this.epoch;
      if (BigInt(raw) > 10n ** 23n)
        throw new Error("This MVP limits each transfer to 0.1 NEAR.");
      await this.register();
      const connector = await this.getConnector(),
        wallet = await connector.wallet();
      const accounts = await wallet.getAccounts();
      if (!accounts.some((x) => x.accountId === owner.account_id))
        throw new Error("Select the connected owner account in your wallet.");
      const attempt: Attempt = {
        id: crypto.randomUUID(),
        kind: "fund",
        amount: raw,
        state: "pending",
      };
      this.assertOwner(owner.account_id, e);
      await taskApi("native-operations", { ...attempt, agentId: a.id });
      this.assertOwner(owner.account_id, e);
      a.attempts.push(attempt);
      await this.persist();
      this.assertOwner(owner.account_id, e);
      try {
        const result = await wallet.signAndSendTransaction({
          signerId: owner.account_id,
          receiverId: a.address,
          actions: [{ type: "Transfer", params: { deposit: raw } }],
        });
        if (e !== this.epoch) return;
        attempt.hash = result?.transaction?.hash;
        await this.persist();
        this.assertOwner(owner.account_id, e);
        if (attempt.hash)
          await taskApi("native-operations/" + attempt.id + "/hash", {
            hash: attempt.hash,
          });
        this.assertOwner(owner.account_id, e);
        if (attempt.hash) await this.reconcileAttempt(a, attempt);
        else
          throw new Error(
            "Wallet returned no hash. Check wallet history and enter the original transaction hash.",
          );
      } catch {
        if (e === this.epoch)
          throw new Error(
            "Transfer outcome unknown or cancelled. Check wallet history; no automatic retry. Enter the original transaction hash to reconcile.",
          );
      }
      await this.balances();
    });
  }
  private async reconcileAttempt(a: LocalAgent, t: Attempt) {
    if (!t.hash)
      throw new Error(
        "Enter the original transaction hash from wallet history.",
      );
    const owner = this.state.owner!.account_id,
      e = this.epoch;
    await taskApi("native-operations/" + t.id + "/reconcile", { hash: t.hash });
    this.assertOwner(owner, e);
    await this.syncOperations();
  }
  async reconcile(id: string, hash?: string) {
    await this.action(async () => {
      const a = this.vault?.agents.find((a) => a.id === id),
        t = a?.attempts.find((a) => a.state === "pending");
      if (!a || !t) throw new Error("No pending transfer.");
      if (hash) {
        if (t.hash && t.hash !== hash)
          throw new Error("Original transaction hash is immutable.");
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(hash))
          throw new Error("Invalid transaction hash.");
        t.hash = hash;
        await this.persist();
      }
      await this.reconcileAttempt(a, t);
      await this.balances();
    });
  }
  async withdraw(id: string, amount: string) {
    if (this.ownerOnly)
      throw new Error("Native funding is not enabled for this market.");
    await this.action(async () => {
      const a = this.agent(id),
        raw = parseNear(amount),
        owner = this.state.owner!,
        provider = this.provider(),
        e = this.epoch;
      const state = await provider.viewAccount({
        accountId: a.address,
        blockQuery: { finality: "final" },
      });
      if (BigInt(raw) + 2n * 10n ** 21n > BigInt(state.amount))
        throw new Error("Leave at least 0.002 NEAR for storage and gas.");
      const key = KeyPair.fromString(a.secret),
        access = await provider.viewAccessKey({
          accountId: a.address,
          publicKey: a.publicKey,
          finalityQuery: { finality: "final" },
        });
      if (access.permission !== "FullAccess")
        throw new Error("Agent key is not full access.");
      const transaction = createTransaction(
          a.address,
          key.getPublicKey(),
          owner.account_id,
          BigInt(access.nonce) + 1n,
          [actions.transfer(BigInt(raw))],
          baseDecode(access.block_hash),
        ),
        signed = await new KeyPairSigner(key).signTransaction(transaction);
      this.assertOwner(owner.account_id, e);
      const t: Attempt = {
        id: crypto.randomUUID(),
        kind: "withdraw",
        amount: raw,
        hash: baseEncode(signed.txHash),
        bytes: b64(signed.signedTransaction.encode()),
        state: "pending",
      };
      await taskApi("native-operations", {
        id: t.id,
        kind: t.kind,
        amount: t.amount,
        hash: t.hash,
        bytes: t.bytes,
        agentId: a.id,
      });
      this.assertOwner(owner.account_id, e);
      a.attempts.push(t);
      await this.persist();
      this.assertOwner(owner.account_id, e);
      try {
        await provider.sendTransactionUntil(signed.signedTransaction, "FINAL");
        if (e !== this.epoch) return;
        await this.reconcileAttempt(a, t);
      } catch {
        throw new Error(
          "Original withdrawal is pending. Reconcile its saved hash; do not send a replacement.",
        );
      }
      await this.balances();
    });
  }
  async resumeWithdrawal(id: string) {
    if (this.ownerOnly)
      throw new Error("Native funding is not enabled for this market.");
    await this.action(async () => {
      const owner = this.state.owner!.account_id,
        e = this.epoch,
        a = this.vault?.agents.find((a) => a.id === id),
        t = a?.attempts.find(
          (t) => t.state === "pending" && t.kind === "withdraw",
        );
      if (!a || !t?.bytes || !t.hash)
        throw new Error("No original signed withdrawal.");
      const signed = SignedTransaction.decode(unb64(t.bytes)),
        tx = signed.transaction;
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array(tx.encode())),
      );
      if (
        tx.signerId !== a.address ||
        tx.receiverId !== owner ||
        baseEncode(digest) !== t.hash ||
        tx.publicKey.toString() !== a.publicKey ||
        tx.actions.length !== 1 ||
        tx.actions[0].transfer?.deposit.toString() !== t.amount
      )
        throw new Error("Original signed withdrawal mismatch.");
      this.assertOwner(owner, e);
      await this.provider().sendTransactionUntil(signed, "FINAL");
      this.assertOwner(owner, e);
      await this.reconcileAttempt(a, t);
    });
  }
}

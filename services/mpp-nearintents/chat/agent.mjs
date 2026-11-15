import { readFile, stat, writeFile } from "node:fs/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { check, digest } from "./config.mjs";
import { FileJournal } from "./journal.mjs";
import { evmPayer } from "./evm-payer.mjs";
import { paidChatTransport } from "./client.mjs";

const privateFile = async (path) => {
  check(((await stat(path)).mode & 0o077) === 0, "private_agent_file_required");
  return (await readFile(path, "utf8")).trim();
};
if (process.argv[2] === "keygen") {
  const privateKey = generatePrivateKey(),
    token = randomBytes(32).toString("hex");
  await writeFile(
    process.argv[3],
    JSON.stringify({ privateKey, token }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  process.stdout.write(
    JSON.stringify({
      address: privateKeyToAccount(privateKey).address,
      tokenHash: digest(token),
      funded: false,
    }) + "\n",
  );
} else {
  const config = JSON.parse(await privateFile(process.argv[2]));
  const wallet = JSON.parse(await privateFile(config.walletFile));
  const plan = {
    ...config,
    walletFile: undefined,
    sourceAddress: privateKeyToAccount(wallet.privateKey).address,
    tokenHash: digest(wallet.token),
  };
  const planHash = digest(plan);
  if (process.argv.includes("--plan"))
    process.stdout.write(JSON.stringify({ planHash, ...plan }, null, 2) + "\n");
  else {
    check(
      config.controlled === true ||
        process.env.ENABLE_NEARINTENTS_AGENT === planHash,
      "reviewed_agent_payment_plan_required",
    );
    const journal = new FileJournal(config.journalDirectory);
    await journal.initialize();
    const payer = evmPayer({
      ...config,
      privateKey: wallet.privateKey,
      journal,
    });
    const transport = paidChatTransport({
      ...config,
      token: wallet.token,
      payer,
      journal,
    });
    const raw = await readFile(process.argv[3], "utf8");
    const response = await transport.invoke({
      body: raw,
      logicalCallId: process.argv[4],
      signal: AbortSignal.timeout(config.timeoutMs ?? 240000),
    });
    process.stdout.write((await response.text()) + "\n");
    if (!response.ok) process.exitCode = 1;
  }
}

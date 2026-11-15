import { readFile, stat } from "node:fs/promises";
import { check, configuration } from "./config.mjs";
import { httpProvider } from "./provider.mjs";
import { chatPool, startChatServer } from "./server.mjs";

const secretFile = async (path) => {
  check(
    typeof path === "string" && ((await stat(path)).mode & 0o077) === 0,
    "private_secret_file_required",
  );
  return (await readFile(path, "utf8")).trim();
};
const launch = JSON.parse(await readFile(process.argv[2], "utf8"));
const config = JSON.parse(await readFile(launch.paymentConfigFile, "utf8"));
const secret = await secretFile(launch.mppSecretFile);
const { fingerprint } = configuration(config, secret);
if (process.argv.includes("--plan")) {
  process.stdout.write(
    JSON.stringify(
      {
        planHash: fingerprint,
        mode: config.mode,
        billing: config.billing,
        destinationAsset: config.destinationAsset,
        destinationRecipient: config.destinationRecipient,
        agents: config.agents.map((a) => ({
          id: a.id,
          originAsset: a.originAsset,
          refundTo: a.refundTo,
          maximumAmountIn: a.maximumAmountIn,
          maximumTotalAmountIn: a.maximumTotalAmountIn,
        })),
        offers: config.offers,
        maximumCalls: config.maximumCalls,
        maximumProviderMicro: config.maximumProviderMicro,
        deadlineMs: config.deadlineMs,
      },
      null,
      2,
    ) + "\n",
  );
} else {
  check(
    config.mode !== "live" ||
      process.env.ENABLE_NEARINTENTS_CHAT === fingerprint,
    "reviewed_live_chat_plan_required",
  );
  const apiKey = launch.providerApiKeyFile
    ? await secretFile(launch.providerApiKeyFile)
    : undefined;
  const jwt = launch.oneClickJwtFile
    ? await secretFile(launch.oneClickJwtFile)
    : undefined;
  const pool = await chatPool(
    await secretFile(launch.databaseUrlFile),
    config.schema,
  );
  try {
    const app = await startChatServer({
      pool,
      config,
      secret,
      jwt,
      provider: httpProvider({ config, apiKey }),
      port: launch.port ?? 3002,
      enableLive: process.env.ENABLE_NEARINTENTS_CHAT,
    });
    process.stdout.write(
      JSON.stringify({
        ready: true,
        endpoint: app.url,
        mode: config.mode,
        planHash: fingerprint,
      }) + "\n",
    );
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await app.close();
      await pool.end();
    };
    process.once("SIGTERM", () => void close());
    process.once("SIGINT", () => void close());
  } catch (e) {
    await pool.end();
    throw e;
  }
}

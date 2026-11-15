// Offline only: generate a dedicated, unfunded merchant and a reviewable plan.
import { mkdir, open } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  KeyPair,
  baseDecode,
} from "../services/mpp-near-direct/node_modules/near-api-js/lib/index.js";
import { freezeClass } from "../services/mpp-near-direct/auction/contracts.mjs";
import { validateLivePlan } from "../services/mpp-near-direct/auction/live/policy.mjs";
const [directory, inputFile] = process.argv.slice(2);
if (!directory || !inputFile)
  throw Error("usage_private_directory_parameters_json");
const destination = resolve(directory),
  input = JSON.parse(readFileSync(inputFile, "utf8")),
  key = KeyPair.fromRandom("ed25519");
const merchant = Buffer.from(
  baseDecode(key.getPublicKey().toString().slice(8)),
).toString("hex");
const { durationMs, ...parameters } = input;
const { plan, planHash } = validateLivePlan({
  ...parameters,
  merchant,
  deadlineMs: Date.now() + durationMs,
  service: freezeClass(parameters.service),
});
await mkdir(destination, { mode: 0o700 });
async function write(name, value) {
  const f = await open(resolve(destination, name), "wx", 0o600);
  try {
    await f.writeFile(value);
    await f.sync();
  } finally {
    await f.close();
  }
}
await write("merchant-key", key.toString() + "\n");
await write("storage-key", randomBytes(32).toString("hex") + "\n");
await write("market-secret", randomBytes(32).toString("hex") + "\n");
await write(
  "review-plan.json",
  JSON.stringify({ plan, reviewedPlanHash: planHash }, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    planFile: resolve(destination, "review-plan.json"),
    merchant,
    planHash,
    network: "mainnet",
    funded: false,
    broadcast: false,
  }),
);

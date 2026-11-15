// Offline preparation only. Does not query, fund, quote or invoke inference.
import { readFile, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { freezeClass } from "../services/mpp-near-direct/auction/contracts.mjs";
import { auctionPlan } from "../services/mpp-nearintents/auction/plan.mjs";
const [directory, inputFile] = process.argv.slice(2);
if (!directory || !inputFile)
  throw Error("usage_private_new_directory_parameters_json");
const { durationMs, ...parameters } = JSON.parse(
  await readFile(inputFile, "utf8"),
);
if (
  !Number.isSafeInteger(durationMs) ||
  durationMs < 60000 ||
  durationMs > 86400000
)
  throw Error("bounded_run_duration_required");
const { plan, planHash } = auctionPlan({
  ...parameters,
  deadlineMs: Date.now() + durationMs,
  service: freezeClass(parameters.service),
});
if (plan.mode !== "live") throw Error("live_review_plan_required");
const destination = resolve(directory);
await mkdir(destination, { mode: 0o700 });
async function write(name, value) {
  const file = await open(resolve(destination, name), "wx", 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
}
await write("storage-key", randomBytes(32).toString("hex") + "\n");
await write("market-secret", randomBytes(32).toString("hex") + "\n");
await write(
  "review-plan.json",
  JSON.stringify(
    { paymentMethod: "nearintents", plan, reviewedPlanHash: planHash },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    planFile: resolve(destination, "review-plan.json"),
    planHash,
    merchant: plan.merchant,
    funded: false,
    broadcast: false,
  }),
);

import { readFile, writeFile, stat, open } from "node:fs/promises";
import {
  validateComparison,
  freezeNearTariff,
  freezeSelfHostedTariff,
  prepareComparison,
  check,
  digest,
} from "./core.mjs";
import { join } from "node:path";
import { ComparisonRunner, publicReport } from "./runner.mjs";
import { requireSdkRuntime, inspectStream } from "./near-bridge.mjs";
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
async function privateConfig(path) {
  check(
    ((await stat(path)).mode & 0o077) === 0,
    "private_config_permissions_required",
  );
  return read(path);
}
async function save(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
try {
  requireSdkRuntime();
  const [command, ...args] = process.argv.slice(2);
  if (command === "snapshot" && args.length === 1) {
    const response = await fetch("https://cloud-api.near.ai/v1/model/list", {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    check(response.ok, "public_catalog_unavailable");
    const parts = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      check(size <= 2 * 1024 * 1024, "catalog_too_large");
      parts.push(chunk);
    }
    const tariff = freezeNearTariff(JSON.parse(Buffer.concat(parts)));
    await save(args[0], tariff);
    console.log(
      JSON.stringify({
        saved: true,
        priceVersion: tariff.priceVersion,
        inferenceCalls: 0,
      }),
    );
  } else if (command === "prepare" && args.length === 2) {
    const input = await read(args[0]);
    const nearTariff = await read(input.nearTariffFile),
      selfHostedTariff = freezeSelfHostedTariff(input.selfHostedTariff);
    const plan = prepareComparison({ ...input, nearTariff, selfHostedTariff });
    await save(args[1], plan);
    console.log(
      JSON.stringify({
        saved: true,
        planHash: plan.planHash,
        budgetPerArmMicro: plan.budgetPerArmMicro,
        inferenceCalls: 0,
      }),
    );
  } else if (command === "calibrate" && args.length === 3) {
    const [directory, stateFile, reviewedHash] = args,
      prepared = await read(join(directory, "prepared.json"));
    check(prepared.planHash === reviewedHash, "reviewed_plan_hash_required");
    const config = await privateConfig(join(directory, "bridge.json")),
      registrationRaw = await readFile(join(directory, "registration.json")),
      registration = JSON.parse(registrationRaw),
      state = await read(stateFile);
    check(
      state.registration_sha256 === digest(registrationRaw),
      "initialized_registration_mismatch",
    );
    check(
      Date.now() < registration.offer_valid_until_ms,
      "calibration_prices_expired",
    );
    const body = await read(join(directory, "calibration-request.json"));
    await save(join(directory, "calibration-intent.json"), {
      planHash: reviewedHash,
      operation: body.user,
      startedAtMs: Date.now(),
    });
    const startedAtMs = Date.now(),
      response = await fetch(
        "http://127.0.0.1:" + config.port + "/v1/chat/completions",
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(120000),
          headers: {
            authorization: "Bearer " + config.localSecret,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
    check(
      response.status === 200 &&
        response.headers.get("x-near-response-verified") === "true",
      "calibration_unknown_preserve_intent",
    );
    const parts = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      check(size <= 1024 * 1024, "calibration_too_large");
      parts.push(part);
    }
    const raw = Buffer.concat(parts),
      summary = inspectStream(raw),
      endedAtMs = Date.now();
    const finishReason = raw
      .toString()
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:") && l.slice(5).trim() !== "[DONE]")
      .flatMap((l) => JSON.parse(l.slice(5)).choices ?? [])
      .find((c) => c.finish_reason)?.finish_reason;
    const responseFile = join(directory, "calibration.sse");
    await writeFile(responseFile, raw, { flag: "wx", mode: 0o600 });
    await save(join(directory, "measurement.json"), {
      registration_sha256: state.registration_sha256,
      request_sha256: registration.request_sha256,
      response_file: responseFile,
      response_sha256: digest(raw),
      started_at_ms: startedAtMs,
      ended_at_ms: endedAtMs,
      response_model: registration.model,
      finish_reason: finishReason,
      ...Object.fromEntries(
        ["prompt_tokens", "completion_tokens", "total_tokens"].map((k) => [
          k,
          summary.usage[k],
        ]),
      ),
    });
    console.log(
      JSON.stringify({
        saved: true,
        planHash: reviewedHash,
        modelSignatureVerified: true,
        nativePromptCountMatchesLocal:
          summary.usage.prompt_tokens === config.qualifiedInputTokens,
        qualificationStillRequired: true,
      }),
    );
  } else if (
    ["run", "run-b", "recover"].includes(command) &&
    args.length === 4
  ) {
    const [configFile, planFile, reviewedHash, outputFile] = args,
      config = await privateConfig(configFile),
      plan = await read(planFile);
    // Reserve the output path before any paid action. The encrypted journal remains recoverable.
    const output = await open(outputFile, "wx", 0o600);
    let runner;
    try {
      runner = new ComparisonRunner(config);
      check(plan.planHash === reviewedHash, "reviewed_plan_hash_required");
      const report = publicReport(
        command === "run-b"
          ? {
              version: 2,
              planHash: plan.planHash,
              requestHash: plan.requestHash,
              mode: plan.mode,
              arms: {
                B: await runner.enrich(
                  plan,
                  await runner.runArm(validateComparison(plan), "B"),
                ),
              },
            }
          : await runner[command](plan, reviewedHash),
      );
      await output.writeFile(JSON.stringify(report, null, 2) + "\n");
      console.log(
        JSON.stringify({
          saved: true,
          planHash: plan.planHash,
          states: Object.fromEntries(
            Object.entries(report.arms).map(([id, r]) => [id, r.state]),
          ),
        }),
      );
    } finally {
      runner?.close();
      await output.close();
    }
  } else if (command === "reconcile" && args.length === 3) {
    const [configFile, planFile, outputFile] = args,
      config = await privateConfig(configFile),
      plan = await read(planFile);
    const runner = new ComparisonRunner(config);
    try {
      await save(outputFile, publicReport(await runner.reconcile(plan)));
      console.log(JSON.stringify({ saved: true, inferenceCalls: 0 }));
    } finally {
      runner.close();
    }
  } else if (command === "report" && args.length === 3) {
    const [configFile, planFile, outputFile] = args,
      config = await privateConfig(configFile),
      plan = await read(planFile);
    const { planHash, ...body } = plan;
    check(digest(body) === planHash, "comparison_plan_changed");
    const runner = new ComparisonRunner(config);
    try {
      const records = runner.store
        .list("comparison-arm", plan.ownerAccount)
        .filter((r) => r.planHash === planHash);
      const arms = Object.fromEntries(
        records.map((r) => [
          r.armId,
          r.state === "dispatching"
            ? { ...r, state: "unknown", replayBlocked: true }
            : r,
        ]),
      );
      await save(
        outputFile,
        publicReport({
          version: 1,
          planHash,
          requestHash: plan.requestHash,
          mode: plan.mode,
          arms,
        }),
      );
      console.log(JSON.stringify({ saved: true, inferenceCalls: 0 }));
    } finally {
      runner.close();
    }
  } else throw Error("usage_snapshot_prepare_run_report");
} catch (error) {
  const code = /^[a-z][a-z0-9_]+$/.test(error.message)
    ? error.message
    : "comparison_command_failed";
  console.error(JSON.stringify({ error: code, automaticRetry: false }));
  process.exitCode = 1;
}

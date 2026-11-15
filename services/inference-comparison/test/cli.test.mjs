import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeNearTariff } from "../core.mjs";
import { catalog, request } from "./helpers.mjs";
const exec = promisify(execFile),
  cli = new URL("../cli.mjs", import.meta.url).pathname;
test("CLI prepares reviewable private files and rejects wrong hash before verifying or buying", async () => {
  const root = await mkdtemp(join(tmpdir(), "comparison-cli-"));
  try {
    const now = Date.now(),
      tariff = freezeNearTariff(catalog(), { observedAtMs: now });
    await writeFile(join(root, "tariff.json"), JSON.stringify(tariff));
    await writeFile(
      join(root, "input.json"),
      JSON.stringify({
        nearTariffFile: join(root, "tariff.json"),
        ownerAccount: "controlled.near",
        budgetPerArmMicro: "10000",
        deadlineMs: now + 60000,
        taskDurationMs: 20000,
        request,
        selfHostedTariff: {
          rates: tariff.rates,
          modelRevisionRef: "checkpoint",
          observedAtMs: now,
          expiresAtMs: now + 60000,
        },
      }),
    );
    const out = await exec(process.execPath, [
      cli,
      "prepare",
      join(root, "input.json"),
      join(root, "plan.json"),
    ]);
    assert.equal(JSON.parse(out.stdout).inferenceCalls, 0);
    assert.equal((await stat(join(root, "plan.json"))).mode & 0o077, 0);
    const config = join(root, "runner.json");
    await writeFile(
      config,
      JSON.stringify({
        storePath: join(root, "journal.sqlite"),
        storageKey: "a".repeat(64),
        arms: {},
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      exec(process.execPath, [
        cli,
        "run",
        config,
        join(root, "plan.json"),
        "wrong",
        join(root, "result.json"),
      ]),
      (e) => {
        assert.equal(JSON.parse(e.stderr).error, "reviewed_plan_hash_required");
        return true;
      },
    );
    await exec(process.execPath, [
      cli,
      "report",
      config,
      join(root, "plan.json"),
      join(root, "recovered.json"),
    ]);
    const recovered = JSON.parse(await readFile(join(root, "recovered.json")));
    assert.deepEqual(recovered.arms, {});
    assert.equal(recovered.realAgentPayments, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

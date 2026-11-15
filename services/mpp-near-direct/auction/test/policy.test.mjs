import test from "node:test";
import assert from "node:assert/strict";
import { chooseBid } from "../policy.mjs";
import { service, fx, time, price } from "./helpers.mjs";
const choose = (more) =>
  chooseBid({
    policy: "fixed",
    nowMs: time,
    deadlineMs: time + 10000,
    availableNano: "100000000",
    maxTotalMicro: "100000",
    service: service(),
    fx,
    gasCapYocto: "1000000000000000000",
    paymentWindowMs: 1000,
    admissionWindowMs: 2000,
    ...more,
  });
test("Fixed economic bid does not follow increased authorization", () => {
  assert.equal(choose({}).bidMultiplier, "1000000");
  assert.equal(
    choose({ availableNano: "200000000", maxTotalMicro: "200000" })
      .bidMultiplier,
    "1000000",
  );
});
test("step-up increases only after own losses and respects frozen economic ceiling", () => {
  assert.equal(
    choose({ policy: "step-up", lostRounds: 2 }).bidMultiplier,
    "1200000",
  );
  assert.equal(
    choose({ policy: "step-up", lostRounds: 50 }).bidMultiplier,
    "2000000",
  );
});
test("task-aware preserves future maximum liabilities, including payment gas", () => {
  const one = BigInt(price({ bidMultiplier: "1000000" }).reserveNano);
  const r = choose({
    policy: "task-aware",
    lostRounds: 8,
    futureRequiredCalls: 1,
    availableNano: String(one * 2n),
  });
  assert.equal(r.action, "bid");
  assert.ok(
    BigInt(r.bidMultiplier) >= 1000000n && BigInt(r.bidMultiplier) < 1800000n,
  );
  assert.equal(r.futureReserveNano, String(one));
  assert.equal(
    choose({
      policy: "task-aware",
      futureRequiredCalls: 1,
      availableNano: String(one * 2n - 1n),
    }).action,
    "wait",
  );
});
test("urgency cannot bypass deadline, available funds or call cap", () => {
  assert.equal(choose({ deadlineMs: time + 100 }).action, "stop");
  assert.equal(choose({ availableNano: "0" }).action, "wait");
  assert.equal(choose({ maxTotalMicro: "1" }).action, "wait");
});

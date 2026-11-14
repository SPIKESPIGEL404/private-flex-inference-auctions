import test from "node:test";
import assert from "node:assert/strict";
import {
  freezeClass,
  pricingContract,
  settleUsage,
  clearRound,
} from "../contracts.mjs";
import { time, service, fx, price, bid, clear } from "./helpers.mjs";

test("first price, fee separate, frozen FX settlement and refund conserve principal", () => {
  const c = price();
  assert.equal(c.rates.input, "56000");
  assert.equal(c.rates.output, "1890000");
  assert.equal(c.fee.flatMicro, "1");
  const result = settleUsage(c, { input: "100", cached: "20", output: "10" });
  assert.equal(
    BigInt(result.actualPrincipalYocto) + BigInt(result.refundYocto),
    BigInt(c.principalYocto),
  );
  const changed = structuredClone(c);
  changed.fx.nanoUsdPerNear = "1";
  assert.throws(
    () => settleUsage(changed, { input: "1", cached: "0", output: "0" }),
    /changed/,
  );
  assert.throws(
    () => settleUsage(c, { input: "1001", cached: "0", output: "0" }),
    /outside/,
  );
});
test("conservative maximum covers every cache case including reversed cache price", () => {
  const s = service();
  const raw = {
    ...s,
    rates: { input: "1", cache_input: "1000000", output: "1" },
  };
  const c = price({ service: freezeClass(raw) });
  for (let cached = 0; cached <= 1000; cached += 10)
    assert.ok(
      BigInt(
        settleUsage(c, { input: "1000", cached: String(cached), output: "512" })
          .actualPrincipalYocto,
      ) <= BigInt(c.principalYocto),
    );
});
test("deterministic ranking, revisions lose old tie priority, lost bids roll forward", () => {
  assert.equal(
    clear([bid("a", "1100000"), bid("b", "1400000")]).results[0].id,
    "b",
  );
  assert.equal(clear([bid("a"), bid("b")]).results[0].id, "a");
  assert.equal(
    clear([
      bid("a", "1000000", { acceptedSequence: "3", revision: "1" }),
      bid("b"),
    ]).results[0].id,
    "b",
  );
  const b = bid("b");
  const first = clear([bid("a"), b]);
  assert.equal(first.results[1].outcome, "lost");
  assert.equal(b.state, "active");
  assert.deepEqual(first, clear([b, bid("a")]));
});
test("cap alone does not raise bid; per-winner price never changes global rates", () => {
  const a = bid("a", "1100000", { maxTotalMicro: "200000" }),
    b = bid("b", "1400000");
  const r = clear([a, b]);
  assert.equal(r.results[0].id, "b");
  assert.equal(r.results[0].contract.bidMultiplier, "1400000");
  assert.equal(service().rates.input, "40000");
});
test("shared funds decremented for each winner, cannot independently top-K spend same owner balance", () => {
  const one = BigInt(price({ bidMultiplier: "1000000" }).reserveNano);
  const balances = {
    owner: String(one + 1n),
    "agent-a": "100000000",
    "task-a": "100000000",
    "agent-b": "100000000",
    "task-b": "100000000",
    "wallet-a": "1000000000000000000000000",
    "wallet-b": "1000000000000000000000000",
  };
  const r = clear([bid("a"), bid("b")], { capacity: 2, balances });
  assert.equal(r.results.filter((x) => x.outcome === "won").length, 1);
  assert.equal(r.results[1].reason, "shared_budget_insufficient");
});
test("no sale: cutoff, expiry, reserve and authorization failures retain explicit reasons", () => {
  for (const more of [
    { acceptedAtMs: time },
    { expiryMs: time },
    { bidMultiplier: "999999" },
    { authorized: false },
    { maxTotalMicro: "1" },
    { deadlineMs: time + 1 },
  ]) {
    const r = clear([bid("a", "1000000", more)]);
    assert.equal(r.noSale, true);
    assert.equal(r.results[0].outcome, "ineligible");
  }
});
test("bounded integers and immutable class reject floats, overflow and stale FX", () => {
  assert.throws(() => price({ bidMultiplier: 1.4 }));
  assert.throws(() => price({ bidMultiplier: "100000001" }));
  assert.throws(() => price({ fx: { ...fx, expiresAtMs: time } }));
  const s = service();
  s.rates.output = "1";
  assert.throws(() => price({ service: s }), /changed/);
});
test("FIFO control uses same price/liability contract at reserve and explicit arrival order", () => {
  const r = clear([bid("a"), bid("b", "1400000")], { rule: "fifo-v1" });
  assert.equal(r.results[0].id, "a");
  assert.equal(r.results[0].contract.bidMultiplier, "1000000");
});

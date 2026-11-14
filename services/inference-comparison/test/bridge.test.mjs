import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNearBridge, requireSdkRuntime } from "../near-bridge.mjs";
import { digest, MODEL } from "../core.mjs";
import { time, request, tariffs, stream } from "./helpers.mjs";
const secret = "b".repeat(64);
const config = (path = ":memory:") => ({
  localSecret: secret,
  storageKey: "a".repeat(64),
  storePath: path,
  authorizedRequestHash: digest(request),
  maxUpstreamCalls: 2,
  qualifiedInputTokens: 2,
  upstreamBudgetMicro: "10000",
  tariff: tariffs().nearTariff,
});
const body = (id = "1") => ({
  ...request,
  model: MODEL,
  user: "cmp-" + id.repeat(64),
  stream: true,
  stream_options: { include_usage: true },
});
const post = (url, b = body(), key = secret) =>
  fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + key,
      "content-type": "application/json",
    },
    body: JSON.stringify(b),
  });
function client() {
  return {
    calls: 0,
    verified: 0,
    async fetch() {
      this.calls++;
      return new Response(stream(), {
        headers: { "content-type": "text/event-stream" },
      });
    },
    async verifyResponse(id) {
      this.verified++;
      return { id, signatureKind: "provider_tee" };
    },
  };
}
test("supported official SDK runtime is enforced", () => {
  assert.throws(() => requireSdkRuntime("24.7.0"));
  requireSdkRuntime("24.22.1");
});
test("authenticated HTTP result verifies once and replays exact bytes across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "near-cmp-")),
    c = client(),
    cfg = config(join(dir, "private.sqlite"));
  let bridge;
  try {
    bridge = await startNearBridge(cfg, { client: c, now: () => time });
    assert.equal((await post(bridge.url, body(), "invalid")).status, 401);
    let r = await post(bridge.url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-near-response-verified"), "true");
    const raw = await r.text();
    assert.equal(c.calls, 1);
    assert.equal(c.verified, 1);
    await bridge.close();
    bridge = await startNearBridge(cfg, { client: c, now: () => time });
    assert.equal(await (await post(bridge.url)).text(), raw);
    assert.equal(c.calls, 1);
    assert.equal((await post(bridge.url, { ...body(), seed: 9 })).status, 400);
  } finally {
    await bridge?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("signature failure is durable Unknown and never purchases again", async () => {
  const c = client();
  c.verifyResponse = async () => {
    throw new Error("signature");
  };
  const bridge = await startNearBridge(config(), {
    client: c,
    now: () => time,
  });
  try {
    assert.equal((await post(bridge.url)).status, 503);
    const retry = await post(bridge.url);
    assert.equal(retry.status, 409);
    assert.equal((await retry.json()).error, "original_inference_unknown");
    assert.equal(c.calls, 1);
  } finally {
    await bridge.close();
  }
});
test("concurrent duplicate is refused while the original verifies", async () => {
  const c = client(),
    gate = Promise.withResolvers();
  c.verifyResponse = async (id) => {
    await gate.promise;
    return { id, signatureKind: "provider_tee" };
  };
  const bridge = await startNearBridge(config(), {
    client: c,
    now: () => time,
  });
  try {
    const first = post(bridge.url);
    while (!c.calls) await new Promise((r) => setTimeout(r, 2));
    const second = await post(bridge.url);
    assert.equal(second.status, 409);
    gate.resolve();
    assert.equal((await first).status, 200);
    assert.equal(c.calls, 1);
  } finally {
    gate.resolve();
    await bridge.close();
  }
});
test("reviewed request, price expiry and total call bound precede invocation", async () => {
  const c = client(),
    bridge = await startNearBridge(config(), { client: c, now: () => time });
  try {
    assert.equal(
      (await post(bridge.url, { ...body(), temperature: 1 })).status,
      400,
    );
    assert.equal(c.calls, 0);
    assert.equal((await post(bridge.url, body("1"))).status, 200);
    assert.equal((await post(bridge.url, body("2"))).status, 200);
    assert.equal((await post(bridge.url, body("3"))).status, 400);
    assert.equal(c.calls, 2);
  } finally {
    await bridge.close();
  }
  const stale = await startNearBridge(config(), {
    client: c,
    now: () => time + 3600001,
  });
  try {
    assert.equal((await post(stale.url)).status, 400);
    assert.equal(c.calls, 2);
  } finally {
    await stale.close();
  }
});
test("gateway-only signature or invalid terminal never releases native bytes", async () => {
  for (const kind of ["gateway", "badUsage"]) {
    const c = client();
    if (kind === "gateway")
      c.verifyResponse = async (id) => ({ id, signatureKind: "gateway" });
    else
      c.fetch = async () =>
        new Response(stream(MODEL, { badUsage: true }), {
          headers: { "content-type": "text/event-stream" },
        });
    const b = await startNearBridge(config(), { client: c, now: () => time });
    try {
      const r = await post(b.url);
      assert.equal(r.status, 503);
      assert.ok(!(await r.text()).includes("42"));
    } finally {
      await b.close();
    }
  }
});
test("shutdown aborts pending verification, persists Unknown before closing journal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "near-stop-")),
    cfg = config(join(dir, "private.sqlite")),
    c = client(),
    started = Promise.withResolvers();
  c.verifyResponse = async () => {
    started.resolve();
    return new Promise(() => {});
  };
  let b = await startNearBridge(cfg, { client: c, now: () => time });
  try {
    const pending = post(b.url).catch(() => null);
    await started.promise;
    await b.close();
    await pending;
    b = await startNearBridge(cfg, { client: c, now: () => time });
    assert.equal((await post(b.url)).status, 409);
    assert.equal(c.calls, 1);
  } finally {
    await b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

import { readFile } from "node:fs/promises";
import {
  freshNonce,
  readSigningKey,
  signPurchase,
} from "../../clients/market-buyer/purchase-sign.mjs";
import { sealPurchaseRequest } from "../../clients/market-buyer/purchase-e2ee.mjs";
import {
  parseSignedReceiptJson,
  verifySignedReceipt,
} from "../../clients/market-buyer/receipt-verify.mjs";
import { check, digest } from "./core.mjs";
export function validateMarketCatalog(raw, policy, arm, deadlineMs) {
  const policyDigest = "sha256:" + digest(raw);
  check(
    policy.acceptedPolicyDigests.includes(policyDigest),
    "reviewed_catalog_required",
  );
  const catalog = JSON.parse(raw),
    products = catalog.products;
  check(
    products?.length === 1 &&
      products[0].protocol === "chat_completions" &&
      products[0].option.model.model_ref === arm.model,
    "catalog_arm_mismatch",
  );
  const product = products[0];
  check(
    product.candidates?.length > 0 &&
      product.routes?.length > 0 &&
      catalog.strategy?.max_attempts === 1,
    "fixed_supply_required",
  );
  for (const item of product.candidates) {
    const candidate = item.candidate;
    for (const rates of [
      candidate.input.offering.rates,
      candidate.service.rates,
    ])
      check(
        ["input", "cache_input", "output"].every(
          (k) => String(rates[k]) === arm.tariff.rates[k],
        ),
        "catalog_tariff_mismatch",
      );
    check(
      candidate.input.offering.valid_until >= deadlineMs,
      "offer_expires_before_comparison",
    );
  }
  for (const route of product.routes) {
    const url = new URL(route.base_url);
    check(
      url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        Number(url.port) > 0 &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password,
      "verified_local_bridge_required",
    );
    check(
      route.native_model ===
        (arm.id === "A" ? "Qwen/Qwen3.8-27B" : "Qwen/Qwen3.8-27B-FP8"),
      "catalog_native_model_mismatch",
    );
    if (arm.id === "B")
      check(
        route.incarnation === arm.tariff.modelRevisionRef,
        "catalog_revision_mismatch",
      );
  }
  return policyDigest;
}
// Buyer credentials are loaded only after the normal hardware/catalog/TLS verifier.
export async function marketExecutor(config, { arm, deadlineMs }) {
  const { connectMarket, readPolicy } = await import(
    "../../clients/market-buyer/connection.mjs"
  );
  const policy = await readPolicy(config.policyFile);
  const policyDigest = validateMarketCatalog(
    await readFile(config.catalogFile),
    policy,
    arm,
    deadlineMs,
  );
  const connection = await connectMarket({
    ...policy,
    acceptedPolicyDigests: [policyDigest],
  });
  try {
    const token = (await readFile(config.credentialFile, "utf8")).trim(),
      key = await readSigningKey(config.signingKeyFile);
    check(
      token.length > 0 && token.length < 16384,
      "market_credential_required",
    );
    return {
      identity: {
        marketVerified: true,
        upstreamVerified: false,
        composeHash: connection.identity.composeHash,
        keysetDigest: connection.identity.workloadKeysetDigest,
        acceptedCatalogPolicyDigests: policy.acceptedPolicyDigests,
      },
      async dispatch({ body, idempotencyKey, signal }) {
        const sealed = sealPurchaseRequest(body, connection.identity.keyset);
        check(sealed.body.length <= 128 * 1024, "sealed_request_too_large");
        const wire = sealed.body,
          signed = signPurchase({
            seed: key.seed,
            publicKey: key.publicKey,
            body: wire,
            idempotencyKey,
            keyset: connection.identity.workloadKeysetDigest,
            nonce: freshNonce(),
            ts: Math.floor(Date.now() / 1000),
          });
        return connection.fetch(connection.baseURL + "/chat/completions", {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            ...sealed.headers,
            ...signed.headers,
          },
          body: wire,
        });
      },
      async head(id) {
        check(/^[a-zA-Z0-9_-]{1,128}$/.test(id), "invalid_market_request_id");
        const r = await connection.fetch(
          connection.baseURL + "/requests/" + id,
          {
            redirect: "error",
            headers: { authorization: "Bearer " + token },
            signal: AbortSignal.timeout(10000),
          },
        );
        check(r.ok, "market_settlement_unavailable");
        return r.json();
      },
      async receipt(id, idempotencyKey) {
        check(/^[a-zA-Z0-9_-]{1,128}$/.test(id), "invalid_market_request_id");
        const response = await connection.fetch(
          connection.baseURL + "/receipts/" + id + "/signed",
          {
            redirect: "error",
            headers: { authorization: "Bearer " + token },
            signal: AbortSignal.timeout(10000),
          },
        );
        check(response.ok, "signed_receipt_unavailable");
        let size = 0;
        const parts = [];
        for await (const part of response.body) {
          size += part.length;
          check(size <= 256 * 1024, "signed_receipt_too_large");
          parts.push(part);
        }
        const document = parseSignedReceiptJson(
          Buffer.concat(parts).toString("utf8"),
        );
        verifySignedReceipt({
          document,
          requestId: id,
          workloadKeysetDigest: connection.identity.workloadKeysetDigest,
          verifiedKeyset: connection.identity.keyset,
        });
        check(
          document.idempotency_key === idempotencyKey,
          "receipt_original_operation_mismatch",
        );
        return document;
      },
      close: () => connection.close(),
    };
  } catch (e) {
    await connection.close();
    throw e;
  }
}

import { requireThat as check } from "../../contract.mjs";
import { validateFx } from "./policy.mjs";

export const REFERENCE_FX_SOURCE = "https://1click.chaindefuser.com/v0/tokens";
export const REFERENCE_FX_MODE = "oneclick-reference-v1";

// Public reference data only. This never requests a swap, transfers a token,
// sends a credential, or changes the direct-NEAR inference payment route.
export async function referenceFx({ fetcher = fetch, now = Date.now } = {}) {
  const response = await fetcher(REFERENCE_FX_SOURCE, {
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  check(response.ok, "reference_fx_unavailable");
  check(response.body, "reference_fx_unavailable");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw Error("reference_fx_response_limit");
    }
    chunks.push(chunk);
  }
  const tokens = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  check(Array.isArray(tokens), "reference_fx_invalid_catalog");
  const rows = tokens.filter((r) => r?.assetId === "nep141:wrap.near");
  check(
    rows.length === 1 &&
      rows[0].blockchain === "near" &&
      rows[0].decimals === 24 &&
      rows[0].contractAddress === "wrap.near",
    "reference_fx_asset_mismatch",
  );
  const row = rows[0];
  check(
    typeof row.price === "string" ||
      (typeof row.price === "number" && Number.isFinite(row.price)),
    "reference_fx_invalid_price",
  );
  // No floating point multiplication or rounding: reject prices that cannot
  // be represented exactly in integer nanoUSD at the supported precision.
  const decimal = String(row.price).match(
    /^(0|[1-9][0-9]{0,18})(?:\.([0-9]{1,9}))?$/,
  );
  check(decimal, "reference_fx_invalid_price");
  const nano =
    BigInt(decimal[1]) * 1000000000n +
    BigInt((decimal[2] ?? "").padEnd(9, "0"));
  check(
    typeof row.priceUpdatedAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
        row.priceUpdatedAt,
      ),
    "reference_fx_timestamp_required",
  );
  const observedAtMs = Date.parse(row.priceUpdatedAt),
    fetchedAtMs = now();
  // Provider time is authoritative for expiry. Re-fetching an old observation
  // never extends its validity, including after a process restart.
  return validateFx(
    {
      kind: "market-usd-near-v1",
      source: REFERENCE_FX_SOURCE,
      assetId: row.assetId,
      nanoUsdPerNear: String(nano),
      observedAtMs,
      expiresAtMs: observedAtMs + 90000,
      priceUpdatedAt: row.priceUpdatedAt,
      fetchedAtMs,
      referencePriceNotExecutableSwap: true,
    },
    fetchedAtMs,
  );
}

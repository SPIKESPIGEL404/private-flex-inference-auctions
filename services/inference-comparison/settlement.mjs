import { check, integer } from "./core.mjs";
const amount = (value) => {
  check(Number.isSafeInteger(value) && value >= 0, "invalid_receipt_amount");
  return BigInt(value);
};
// Called only after the executor has checked the signature and original operation.
export function projectSettlement(
  document,
  { requestId, idempotencyKey, budgetMicro },
) {
  check(
    document?.request_id === requestId &&
      document.idempotency_key === idempotencyKey,
    "settlement_operation_mismatch",
  );
  const receipt = document.receipt;
  check(
    receipt?.request_id === requestId &&
      receipt.settlement === "committed" &&
      ["delivered", "closed"].includes(receipt.status?.status),
    "settlement_not_final",
  );
  const f = receipt.financial;
  check(f && receipt.fees, "financial_receipt_required");
  const provider = amount(f.provider_micro_usd),
    platform = amount(f.platform_micro_usd),
    promo = amount(f.promo_micro_usd),
    cash = amount(f.cash_micro_usd),
    released = amount(f.released_micro_usd);
  check(
    promo <= platform && cash === provider + platform - promo,
    "receipt_charge_arithmetic_mismatch",
  );
  check(
    provider === amount(receipt.fees.provider_micro_usd) &&
      platform === amount(receipt.fees.platform_micro_usd) &&
      amount(receipt.fees.held_micro_usd) === 0n,
    "receipt_fees_mismatch",
  );
  check(
    cash + released <= integer(budgetMicro) && provider <= integer(budgetMicro),
    "receipt_exceeds_authorization",
  );
  check(
    provider === 0n || (typeof f.seller === "string" && f.seller.length > 0),
    "receipt_seller_required",
  );
  return {
    status: "committed",
    source: "verified-market-financial-receipt",
    unit: "microUSD",
    providerChargeMicro: String(provider),
    platformChargeMicro: String(platform),
    promoMicro: String(promo),
    cashChargeMicro: String(cash),
    releasedMicro: String(released),
    reservedMicro: String(cash + released),
    seller: f.seller ?? null,
    revision: receipt.revision,
    receiptKeysetDigest: document.workload_keyset_digest,
  };
}

import { isDeepStrictEqual } from "node:util";
import { Challenge, Receipt } from "mppx";
import { Mppx } from "mppx/client";
import { nearintents } from "@defuse-protocol/nearintents-mpp-sdk/client";
import { OneClick, Types } from "@defuse-protocol/nearintents-mpp-sdk";
import { check, digest, endpoint, uint } from "./config.mjs";

export function paidChatTransport({
  url,
  token,
  policy,
  payer,
  journal,
  controlled = false,
  fetcher = fetch,
  retryDelayMs = 250,
  maximumAttempts = 10,
  onEvent = () => {},
}) {
  const target = endpoint(url, controlled);
  check(target.pathname === "/v1/chat/completions", "chat_endpoint_required");
  check(
    typeof token === "string" &&
      token.length >= 32 &&
      policy &&
      payer?.durableOriginalOperations === true &&
      journal,
    "bounded_agent_wallet_required",
  );
  check(
    Number.isSafeInteger(maximumAttempts) &&
      maximumAttempts >= 2 &&
      maximumAttempts <= 1000 &&
      Number.isSafeInteger(retryDelayMs) &&
      retryDelayMs >= 0 &&
      retryDelayMs <= 60000,
    "bounded_client_retry_policy_required",
  );
  check(
    uint(policy.maximumTotalAmountIn) > 0n &&
      uint(policy.maximumAmountOut) > 0n &&
      Number.isSafeInteger(policy.maximumSettlementSeconds) &&
      policy.maximumSettlementSeconds >= 0,
    "explicit_agent_payment_policy_required",
  );
  check(
    policy.expectedRefundTo &&
      policy.expectedDestination?.destinationAsset &&
      policy.expectedDestination?.destinationRecipient &&
      policy.allowedCurrencies?.length === 1 &&
      policy.maxAmountIn?.[policy.allowedCurrencies[0]],
    "pinned_agent_payment_policy_required",
  );
  const agentKey = digest([target.href, digest(token)]);
  return {
    async invoke({ body, logicalCallId, signal }) {
      const raw = typeof body === "string" ? body : JSON.stringify(body);
      check(
        typeof logicalCallId === "string" &&
          /^[a-zA-Z0-9_.:-]{1,128}$/.test(logicalCallId),
        "stable_idempotency_key_required",
      );
      // One outstanding wallet effect per agent. The inference API is still the
      // only resource endpoint; this journal is payment recovery, not a session.
      return journal.locked("agent:" + agentKey, async () => {
        const key = `chat:${agentKey}:${logicalCallId}`;
        let original = await journal.get(key);
        const binding = digest([target.href, logicalCallId, raw]);
        check(
          !original || original.binding === binding,
          "logical_request_conflict",
        );
        const pinned = await journal.get("policy:" + agentKey);
        check(
          !pinned || pinned.fingerprint === digest(policy),
          "agent_payment_policy_changed",
        );
        for (let attempt = 0; attempt < maximumAttempts; attempt++) {
          signal?.throwIfAborted();
          let response;
          try {
            response = await fetcher(target, {
              method: "POST",
              body: raw,
              signal,
              redirect: "error",
              cache: "no-store",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${token}`,
                "idempotency-key": logicalCallId,
                ...(original?.credential
                  ? { "payment-authorization": original.credential }
                  : {}),
              },
            });
          } catch (e) {
            if (
              !(e instanceof TypeError) ||
              signal?.aborted ||
              attempt + 1 === maximumAttempts
            )
              throw e;
            continue;
          }
          if (response.status === 402) {
            const offered = await response.clone().json();
            const challenge = Challenge.deserialize(
              response.headers.get("www-authenticate"),
            );
            check(
              challenge.method === "nearintents" &&
                challenge.intent === "charge" &&
                challenge.header === "Payment-Authorization" &&
                isDeepStrictEqual(offered.challenge, challenge),
              "invalid_inference_challenge",
            );
            check(
              offered.terms?.version === "fixed-request-v1" &&
                offered.terms.usageRebate === false &&
                offered.terms.failedDelivery ===
                  "full-merchant-refund-due-manual-v1" &&
                offered.terms.requestHash === digest(raw) &&
                challenge.request.externalId === offered.id,
              "request_quote_binding_failed",
            );
            const q = challenge.request,
              d = q.methodDetails;
            check(
              offered.terms.amountOut === d.amountOut &&
                offered.terms.destinationAsset === d.destinationAsset &&
                offered.terms.destinationRecipient === d.destinationRecipient &&
                offered.terms.originAsset === q.currency &&
                offered.terms.refundTo === d.refundTo,
              "request_quote_binding_failed",
            );
            check(
              uint(d.amountOut) <= uint(policy.maximumAmountOut) &&
                d.timeEstimate <= policy.maximumSettlementSeconds,
              "autobidder_price_or_speed_rejected",
            );
            check(
              Number.isFinite(Date.parse(challenge.expires)) &&
                Date.now() + d.timeEstimate * 1000 <
                  Date.parse(challenge.expires),
              "insufficient_payment_time",
            );
            check(
              q.description ===
                `fixed-request-v1; terms=${digest(offered.terms)}; no usage rebate`,
              "request_quote_binding_failed",
            );
            check(
              !original || original.challenge.id === challenge.id,
              "replacement_payment_forbidden",
            );
            if (!original) {
              const total = (await journal.list())
                .filter((r) => r.agentKey === agentKey)
                .reduce((sum, r) => sum + uint(r.amountIn), 0n);
              check(
                total + uint(q.amount) <= uint(policy.maximumTotalAmountIn),
                "agent_total_budget_exhausted",
              );
              original = {
                kind: "chat",
                agentKey,
                binding,
                logicalCallId,
                challenge,
                amountIn: q.amount,
                state: "prepared",
              };
              await journal.put("policy:" + agentKey, {
                kind: "policy",
                fingerprint: digest(policy),
              });
              await journal.put(key, original);
            }
            if (!original.credential) {
              const client = Mppx.create({
                polyfill: false,
                methods: [
                  nearintents.charge({
                    policy,
                    sendDeposit: async ({ request }) => {
                      // The signer persists signed bytes/nonce before broadcast and
                      // recovers that exact original effect after any lost ACK.
                      const hash = await payer.payOriginal({
                        operationId: offered.id,
                        request,
                        signal,
                      });
                      original = {
                        ...original,
                        sourceHash: hash,
                        state: "broadcast",
                      };
                      await journal.put(key, original);
                      return hash;
                    },
                  }),
                ],
              });
              const credential = await client.createCredential(
                response,
                original.sourceHash ? { hash: original.sourceHash } : undefined,
              );
              original = { ...original, credential, state: "presented" };
              await journal.put(key, original);
              onEvent({
                type: "inference_payment_presented",
                callId: logicalCallId,
                orderId: offered.id,
                amountIn: q.amount,
                currency: q.currency,
              });
            }
            await response.body?.cancel();
            continue;
          }
          if (response.status === 200) {
            check(original?.credential, "unpaid_inference_response");
            const receipt = Receipt.deserialize(
              response.headers.get("payment-receipt"),
            );
            check(
              receipt.method === "nearintents" &&
                receipt.status === "success" &&
                receipt.challengeId === original.challenge.id &&
                receipt.externalId === original.challenge.request.externalId &&
                receipt.reference &&
                receipt.destinationNetwork ===
                  Types.chainOf(policy.expectedDestination.destinationAsset),
              "inference_receipt_binding_failed",
            );
            const network = Types.chainOf(original.challenge.request.currency);
            check(
              typeof receipt.originTxHash === "string" &&
                OneClick.canonicalTxHash(receipt.originTxHash, network) ===
                  OneClick.canonicalTxHash(original.sourceHash, network),
              "inference_receipt_binding_failed",
            );
            await journal.put(key, { ...original, state: "complete", receipt });
            return response;
          }
          if (
            ![202, 503].includes(response.status) ||
            attempt + 1 === maximumAttempts
          )
            return response;
          await response.body?.cancel();
          await new Promise((resolve, reject) => {
            const timer = setTimeout(done, retryDelayMs);
            function done() {
              signal?.removeEventListener("abort", abort);
              resolve();
            }
            function abort() {
              clearTimeout(timer);
              signal?.removeEventListener("abort", abort);
              reject(signal.reason);
            }
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        }
        throw Error("original_inference_requires_reconciliation");
      });
    },
  };
}

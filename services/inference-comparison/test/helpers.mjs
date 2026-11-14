import {
  freezeNearTariff,
  freezeSelfHostedTariff,
  prepareComparison,
  MODEL,
} from "../core.mjs";
export const time = 1800000000000;
export const request = {
  messages: [{ role: "user", content: "Return the number 42." }],
  temperature: 0,
  max_completion_tokens: 64,
};
export const catalog = () => ({
  models: [
    {
      modelId: MODEL,
      metadata: { isReady: true, ownedBy: "nearai", quantization: "fp8" },
      inputCostPerToken: { amount: 40, scale: 9, currency: "USD" },
      outputCostPerToken: { amount: 1350, scale: 9, currency: "USD" },
      cacheReadCostPerToken: { amount: 18, scale: 9, currency: "USD" },
    },
  ],
});
export const tariffs = () => ({
  nearTariff: freezeNearTariff(catalog(), { observedAtMs: time }),
  selfHostedTariff: freezeSelfHostedTariff({
    rates: { input: "40000", cache_input: "18000", output: "1350000" },
    modelRevisionRef: "pinned-checkpoint",
    observedAtMs: time,
    expiresAtMs: time + 3600000,
  }),
});
export const plan = () =>
  prepareComparison({
    request,
    ...tariffs(),
    ownerAccount: "judge.near",
    budgetPerArmMicro: "10000",
    deadlineMs: time + 60000,
    now: time,
  });
export function stream(model = MODEL, { badUsage = false } = {}) {
  const frame = (choices, usage) =>
    "data: " +
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      model,
      choices,
      ...(usage ? { usage } : {}),
    }) +
    "\n\n";
  return Buffer.from(
    frame([{ index: 0, delta: { content: "42" }, finish_reason: null }]) +
      frame([{ index: 0, delta: {}, finish_reason: "stop" }]) +
      frame([], {
        prompt_tokens: 2,
        completion_tokens: 3,
        total_tokens: badUsage ? 99 : 5,
      }) +
      "data: [DONE]\n\n",
  );
}

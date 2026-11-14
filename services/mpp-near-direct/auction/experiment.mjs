import { hash, requireThat as check, uint } from "../contract.mjs";
export function freezeExperiment({
  seed,
  scope,
  serviceClassVersion,
  codeRevision,
  policyVersion,
  tasks,
}) {
  check(
    ["controlled", "real"].includes(scope) &&
      Number.isSafeInteger(seed) &&
      typeof codeRevision === "string" &&
      typeof policyVersion === "string",
    "invalid_manifest",
  );
  check(
    Array.isArray(tasks) &&
      tasks.length > 0 &&
      tasks.length <= 10000 &&
      new Set(tasks.map((t) => t.id)).size === tasks.length,
    "invalid_assignments",
  );
  for (const t of tasks) {
    check(
      typeof t.id === "string" &&
        ["A", "B", "C"].includes(t.group) &&
        typeof t.budgetGroup === "string" &&
        Number.isSafeInteger(t.releaseAtMs) &&
        Number.isSafeInteger(t.deadlineMs) &&
        t.deadlineMs > t.releaseAtMs,
      "invalid_assignment",
    );
    uint(t.initialBudgetNano);
  }
  const body = {
    version: 1,
    seed,
    scope,
    serviceClassVersion,
    codeRevision,
    policyVersion,
    tasks: structuredClone(tasks),
  };
  return { ...body, manifestHash: hash(body) };
}
// The collector supplies original, authenticated Market records. Task correctness
// comes from the independent evaluator; unexported browser tasks stay missing.
export function economicReport(manifest, taskRecords, financialRecords) {
  const { manifestHash, ...body } = manifest;
  check(hash(body) === manifestHash, "manifest_changed");
  const assignments = new Map(manifest.tasks.map((t) => [t.id, t]));
  check(
    new Set(taskRecords.map((t) => t.id)).size === taskRecords.length &&
      taskRecords.every((t) => assignments.has(t.id)),
    "unassigned_or_duplicate_task",
  );
  const finance = new Map(financialRecords.map((f) => [f.orderId, f]));
  check(finance.size === financialRecords.length, "duplicate_financial_record");
  const used = new Set(),
    groups = {};
  for (const assigned of manifest.tasks) {
    const t = taskRecords.find((t) => t.id === assigned.id),
      key = assigned.group + ":" + assigned.budgetGroup;
    const g = (groups[key] ??= {
      assigned: 0,
      onTimeCorrect: 0,
      missingTasks: 0,
      unsettledOrders: 0,
      knownBuyerCostYocto: 0n,
      sellerRevenueYocto: 0n,
      refundGasYocto: 0n,
      unresolvedPrincipalYocto: 0n,
      latenciesMs: [],
    });
    g.assigned++;
    const correct =
      t?.verification?.outcome === "correct" &&
      Number.isSafeInteger(t.completedAtMs) &&
      t.completedAtMs <= assigned.deadlineMs;
    if (correct) g.onTimeCorrect++;
    if (!t) {
      g.missingTasks++;
      continue;
    }
    if (Number.isFinite(t.elapsedMs) && t.elapsedMs >= 0)
      g.latenciesMs.push(t.elapsedMs);
    check(Array.isArray(t.orderIds), "missing_order_bindings");
    for (const id of t.orderIds) {
      check(!used.has(id), "order_assigned_twice");
      used.add(id);
      const f = finance.get(id);
      if (
        !f ||
        !["settled", "refund_confirmed"].includes(f.settlementState) ||
        f.gasActualYocto == null
      ) {
        g.unsettledOrders++;
        if (f)
          g.unresolvedPrincipalYocto +=
            uint(f.principal.prepaid) -
            uint(f.principal.refunded) -
            uint(f.principal.charged);
        continue;
      }
      check(f.scope === manifest.scope, "financial_scope_mismatch");
      const charged = uint(f.principal.charged),
        gas = uint(f.gasActualYocto);
      check(
        charged + uint(f.principal.refunded) === uint(f.principal.prepaid),
        "principal_not_conserved",
      );
      g.knownBuyerCostYocto += charged + gas;
      g.sellerRevenueYocto += charged;
      if (f.refundGasYocto != null) g.refundGasYocto += uint(f.refundGasYocto);
    }
  }
  return {
    version: 1,
    manifestHash,
    scope: manifest.scope,
    mechanismEffectEstablished: false,
    groups: Object.fromEntries(
      Object.entries(groups).map(([key, g]) => [
        key,
        {
          ...g,
          knownBuyerCostYocto: String(g.knownBuyerCostYocto),
          sellerRevenueYocto: String(g.sellerRevenueYocto),
          refundGasYocto: String(g.refundGasYocto),
          unresolvedPrincipalYocto: String(g.unresolvedPrincipalYocto),
          finalBuyerCostYocto:
            g.unsettledOrders || g.missingTasks
              ? null
              : String(g.knownBuyerCostYocto),
          costPerOnTimeSuccess:
            g.onTimeCorrect && !g.unsettledOrders && !g.missingTasks
              ? {
                  numeratorYocto: String(g.knownBuyerCostYocto),
                  denominator: g.onTimeCorrect,
                }
              : null,
          costStatus:
            g.missingTasks || g.unsettledOrders
              ? "unresolved"
              : g.onTimeCorrect
                ? "final"
                : "no_on_time_successes",
        },
      ]),
    ),
  };
}

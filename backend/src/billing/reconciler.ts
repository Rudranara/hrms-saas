import type { PrismaClient } from "@prisma/client";
import { replacementBlockingStates, type BillingService } from "./service";

export function reconciliationInterval(value: string | number | undefined) {
  const interval = value === undefined ? 300000 : Number(value);
  if (!Number.isSafeInteger(interval) || interval < 60000 || interval > 3600000)
    throw new Error("Billing recovery interval must be an integer between 60000 and 3600000 milliseconds.");
  return interval;
}

// Safe recovery for missed webhooks. Reconciliation only fetches provider state;
// it never creates subscriptions, charges customers, or changes trial dates.
export async function reconcileDue(db: PrismaClient, billing: BillingService, now = new Date(), stopped = () => false) {
  if (!billing.provider.available) return { checked: 0, failed: 0 };
  const cutoff = new Date(now.getTime() - 30 * 86400000);
  const operations = await db.billingReplacement.findMany({ where: { state: { in: [...replacementBlockingStates, "READY"] } }, select: { fromSubscriptionId: true }, orderBy: { updatedAt: "asc" }, take: 25 });
  const operationIds = operations.map((op) => op.fromSubscriptionId);
  const rows = await db.subscription.findMany({ where: { AND: [
    { OR: [{ status: { in: ["CREATING", "CREATE_UNKNOWN", "CREATED", "AUTHENTICATED", "ACTIVE", "PENDING", "HALTED", "PAUSED"] } }, { paidUntil: { gt: now } },
      { status: { in: ["CANCELLED", "COMPLETED", "EXPIRED"] }, OR: [{ createdAt: { gte: cutoff } }, { cancelledAt: { gte: cutoff } }, { currentPeriodEnd: { gte: cutoff } }, { payments: { some: { updatedAt: { gte: cutoff } } } }] },
      { id: { in: operationIds } }] },
    { OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now.getTime() - 5 * 60000) } }, { id: { in: operationIds } }] },
    { createdAt: { lt: new Date(now.getTime() - 60000) } },
  ] }, select: { id: true }, orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }], take: 25 });
  let failed = 0, checked = 0;
  for (const row of rows) { if (stopped()) break; checked++; try { await billing.reconcile(row.id); } catch { failed++; } }
  return { checked, failed };
}
export function startBillingReconciler(db: PrismaClient, billing: BillingService, intervalMs = 300000) {
  const interval = reconciliationInterval(intervalMs);
  let stopped = false, active: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (stopped || active) return;
    active = reconcileDue(db, billing, new Date(), () => stopped).then((result) => { if (result.failed) console.warn(`Billing recovery: ${result.failed} subscriptions need another attempt.`); }).catch(() => console.warn("Billing recovery temporarily unavailable.")).finally(() => { active = null; });
  }, interval);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); return active ?? Promise.resolve(); };
}

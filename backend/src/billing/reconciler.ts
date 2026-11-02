import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { replacementBlockingStates, type BillingService } from "./service";
import { RefundService } from "./refunds";
import { ServiceError } from "../services/errors";

export const refundInspectionIntervalMs = 250;
export const refundScanId = "external-refunds";
export const refundScanLeaseMs = 30 * 60000;
export function refundRetryDelay(attempts: number) { return Math.min(3600000, 60000 * 2 ** Math.min(6, Math.max(0, attempts - 1))); }
async function providerPaused(db: PrismaClient, now: Date) {
  const scan = await db.refundDiscoveryScan.findUnique({ where: { id: refundScanId }, select: { pausedUntil: true } });
  return !!scan?.pausedUntil && scan.pausedUntil > now;
}
function globalRateLimit(error: unknown): error is ServiceError {
  return error instanceof ServiceError && error.code === "PROVIDER_RATE_LIMITED" && error.rateLimitScope !== "payment";
}
function cooldown(scan: { rateLimitAttempts: number; pausedUntil: Date | null }, error: ServiceError, now: Date) {
  const attempts = Math.min(30, scan.rateLimitAttempts + 1);
  const until = new Date(now.getTime() + Math.max(refundRetryDelay(attempts), error.retryAfterMs ?? 0));
  return { rateLimitAttempts: attempts, pausedUntil: scan.pausedUntil && scan.pausedUntil > until ? scan.pausedUntil : until };
}
async function deferProvider(db: PrismaClient, error: unknown, now: Date) {
  if (!globalRateLimit(error)) return false;
  await db.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO RefundDiscoveryScan (id) VALUES (${refundScanId}) ON DUPLICATE KEY UPDATE id = id`;
    await tx.$queryRaw`SELECT id FROM RefundDiscoveryScan WHERE id = ${refundScanId} FOR UPDATE`;
    const scan = await tx.refundDiscoveryScan.findUniqueOrThrow({ where: { id: refundScanId } });
    await tx.refundDiscoveryScan.update({ where: { id: refundScanId }, data: cooldown(scan, error, now) });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  return true;
}
export async function discoverExternalRefunds(db: PrismaClient, refunds: Pick<RefundService, "syncPayment">, stopped = () => false, wait: (ms: number) => Promise<unknown> = pause, clock = () => new Date()) {
  const owner = randomUUID();
  await db.$executeRaw`INSERT INTO RefundDiscoveryScan (id) VALUES (${refundScanId}) ON DUPLICATE KEY UPDATE id = id`;
  const claim = await db.refundDiscoveryScan.updateMany({ where: { id: refundScanId, AND: [ { OR: [{ leaseUntil: null }, { leaseUntil: { lte: clock() } }] }, { OR: [{ pausedUntil: null }, { pausedUntil: { lte: clock() } }] } ] }, data: { leaseOwner: owner, leaseUntil: new Date(clock().getTime() + refundScanLeaseMs) } });
  if (!claim.count) return 0;
  let failed = 0;
  const owned = async () => (await db.refundDiscoveryScan.updateMany({ where: { id: refundScanId, leaseOwner: owner, leaseUntil: { gt: clock() }, OR: [{ pausedUntil: null }, { pausedUntil: { lte: clock() } }] }, data: { leaseUntil: new Date(clock().getTime() + refundScanLeaseMs) } })).count > 0;
  try {
    let scan = await db.refundDiscoveryScan.findUniqueOrThrow({ where: { id: refundScanId } });
    // Finite cycle: inserts on either side of the cursor are included next wrap.
    if (!scan.upperBound) {
      const last = await db.billingPayment.findFirst({ orderBy: { id: "desc" }, select: { id: true } });
      await db.refundDiscoveryScan.updateMany({ where: { id: refundScanId, leaseOwner: owner }, data: { upperBound: last?.id ?? null } });
      scan = { ...scan, upperBound: last?.id ?? null };
    }
    const payments = scan.upperBound ? await db.billingPayment.findMany({ where: { id: { ...(scan.cursor ? { gt: scan.cursor } : {}), lte: scan.upperBound } }, select: { id: true, status: true, amountRefundedMinor: true, discoveryRetry: true }, orderBy: { id: "asc" }, take: 25 }) : [];
    // Retry budget is independent of main progress. Main rows with retry metadata
    // are checkpointed without GETs; only this queue controls their retry time.
    const retries = await db.refundDiscoveryRetry.findMany({ where: { nextAttemptAt: { lte: clock() } }, orderBy: [{ nextAttemptAt: "asc" }, { paymentId: "asc" }], take: 5 });
    const inspect = async (paymentId: string, checkpoint: boolean, skip = false) => {
      if (stopped() || !await owned()) return false;
      let error: unknown;
      if (!skip) {
        await wait(refundInspectionIntervalMs);
        if (stopped() || !await owned()) return false;
        try { await refunds.syncPayment(paymentId); } catch (caught) { error = caught; failed++; }
      }
      // Queue failure and advance cursor together; a crash before this commit
      // repeats the idempotent GET. Expired owners cannot overwrite a new worker.
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM RefundDiscoveryScan WHERE id = ${refundScanId} FOR UPDATE`;
        const current = await tx.refundDiscoveryScan.findUniqueOrThrow({ where: { id: refundScanId } });
        if (current.leaseOwner !== owner || !current.leaseUntil || current.leaseUntil <= clock()) throw new Error("Refund discovery lease expired");
        if (error) {
          const previous = await tx.refundDiscoveryRetry.findUnique({ where: { paymentId } });
          const attempts = Math.min(30, (previous?.attempts ?? 0) + 1);
          const code = error instanceof ServiceError ? error.code : "INSPECTION_FAILED";
          const nextAttemptAt = new Date(clock().getTime() + Math.max(refundRetryDelay(attempts), error instanceof ServiceError ? error.retryAfterMs ?? 0 : 0));
          await tx.refundDiscoveryRetry.upsert({ where: { paymentId }, create: { paymentId, attempts, nextAttemptAt, failureCode: code }, update: { attempts, nextAttemptAt, failureCode: code } });
        } else if (!skip) await tx.refundDiscoveryRetry.deleteMany({ where: { paymentId } });
        await tx.refundDiscoveryScan.update({ where: { id: refundScanId }, data: { ...(checkpoint ? { cursor: paymentId } : {}), ...(globalRateLimit(error) ? cooldown(current, error, clock()) : !error && !skip ? { rateLimitAttempts: 0 } : {}) } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      return !globalRateLimit(error);
    };
    // Main scan goes first, ensuring repeated retry failures cannot monopolize it.
    for (const payment of payments) {
      if (!await inspect(payment.id, true, !!payment.discoveryRetry || !(["captured", "refunded"].includes(payment.status) || payment.amountRefundedMinor > 0))) return failed;
    }
    if (payments.length < 25 && !stopped() && await owned()) await db.refundDiscoveryScan.updateMany({ where: { id: refundScanId, leaseOwner: owner }, data: { cursor: null, upperBound: null } });
    for (const retry of retries) if (!await inspect(retry.paymentId, false)) break;
  } finally { await db.refundDiscoveryScan.updateMany({ where: { id: refundScanId, leaseOwner: owner }, data: { leaseOwner: null, leaseUntil: null } }); }
  return failed;
}

export function reconciliationInterval(value: string | number | undefined) {
  const interval = value === undefined ? 300000 : Number(value);
  if (!Number.isSafeInteger(interval) || interval < 60000 || interval > 3600000)
    throw new Error("Billing recovery interval must be an integer between 60000 and 3600000 milliseconds.");
  return interval;
}

// Safe recovery for missed webhooks. Reconciliation only fetches provider state;
// it never creates subscriptions, charges customers, or changes trial dates.
export async function reconcileDue(db: PrismaClient, billing: BillingService, now = new Date(), stopped = () => false, wait: (ms: number) => Promise<unknown> = pause) {
  if (!billing.provider.available) return { checked: 0, failed: 0 };
  const startedAt = Date.now(), clock = () => new Date(now.getTime() + Date.now() - startedAt);
  if (await providerPaused(db, clock())) return { checked: 0, failed: 0 };
  const refunds = new RefundService(db, billing, () => now);
  // Make durable discovery progress before unrelated recovery can hit a 429.
  let failed = billing.provider.paymentRefunds ? await discoverExternalRefunds(db, refunds, stopped, wait, clock) : 0;
  if (await providerPaused(db, clock())) return { checked: 0, failed };
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
  let checked = 0;
  for (const row of rows) { if (stopped() || await providerPaused(db, clock())) break; checked++; try { await billing.reconcile(row.id); } catch (error) { failed++; if (await deferProvider(db, error, clock())) return { checked, failed }; } }
  let limited = false;
  const recovered = await refunds.recoverPending(() => stopped() || limited, async error => { limited = await deferProvider(db, error, clock()); }, async () => !await providerPaused(db, clock()));
  return { checked: checked + recovered.checked, failed: failed + recovered.failed };
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

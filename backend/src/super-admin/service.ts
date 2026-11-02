import { Prisma, type PrismaClient } from "@prisma/client";
import { paidAccessSql, graceAccessSql, graceMilliseconds, matchesAccessPolicySql } from "../billing/access-rules";
import { ServiceError, type Clock } from "../services/errors";
import { historicalPlanName } from "../billing/terms";

export const classifications = ["ALL", "TRIALING", "PAID_ACTIVE", "TRIAL_EXPIRED", "PENDING", "PAST_DUE", "CHECKOUT_FAILED", "PAUSED", "CANCELLED", "EXPIRED", "NO_SUBSCRIPTION", "SUSPENDED", "ADMIN_ACTIVE", "ADMIN_SCHEDULED", "ADMIN_EXPIRED"] as const;
export type Classification = typeof classifications[number];
type Page = { page: number; pageSize: number };
type Filters = Page & { q?: string; status: Classification };
export type DateRange = { from: Date; until: Date; fromDate: string; toDate: string };

// One row per organization. Only provider-reconciled payment records can prove
// paid access. This reporting classification never changes business eligibility.
function organizationRows(now: Date, graceMs: number) {
  const hasPaid = (alias: "s" | "candidate") => Prisma.sql`(${paidAccessSql(alias, now)} AND ${matchesAccessPolicySql(alias)})`;
  const hasGrace = (alias: "s" | "candidate") => Prisma.sql`(${graceAccessSql(alias, now, graceMs)} AND ${matchesAccessPolicySql(alias)})`;
  return Prisma.sql`SELECT base.*, CASE
    WHEN accessMode = 'SUSPENDED' THEN 'SUSPENDED'
    WHEN accessMode = 'CONTROLLED' AND trialEnabled = 0 AND subscriptionEnabled = 0 THEN 'SUSPENDED'
    WHEN accessMode = 'CONTROLLED' AND trialEnabled = 1 AND subscriptionEnabled = 0 AND hasPaidAccess = 1 THEN CASE WHEN subscriptionStatus = 'ACTIVE' THEN 'PAID_ACTIVE' WHEN subscriptionStatus IN ('PENDING','HALTED') THEN 'PAST_DUE' WHEN subscriptionStatus = 'COMPLETED' THEN 'EXPIRED' ELSE subscriptionStatus END
    WHEN accessMode = 'CONTROLLED' AND manualActive = 1 THEN 'ADMIN_ACTIVE'
    WHEN accessMode = 'CONTROLLED' AND trialActive = 1 THEN 'TRIALING'
    WHEN accessMode = 'CONTROLLED' AND trialEnabled = 1 AND subscriptionEnabled = 0 AND hasGraceAccess = 1 THEN 'PAST_DUE'
    WHEN accessMode = 'CONTROLLED' AND subscriptionEnabled = 1 AND manualAccessStartsAt > ${now} THEN 'ADMIN_SCHEDULED'
    WHEN accessMode = 'CONTROLLED' THEN 'ADMIN_EXPIRED'
    WHEN accessMode = 'MANUAL' AND manualActive = 1 THEN 'ADMIN_ACTIVE'
    WHEN accessMode = 'MANUAL' AND manualAccessStartsAt > ${now} THEN 'ADMIN_SCHEDULED'
    WHEN accessMode = 'MANUAL' THEN 'ADMIN_EXPIRED'
    WHEN hasPaidAccess = 1 AND subscriptionStatus = 'ACTIVE' THEN 'PAID_ACTIVE'
    WHEN subscriptionStatus = 'CANCELLED' THEN 'CANCELLED'
    WHEN subscriptionStatus IN ('COMPLETED','EXPIRED') THEN 'EXPIRED'
    WHEN subscriptionStatus = 'PAUSED' THEN 'PAUSED'
    WHEN subscriptionStatus = 'FAILED' THEN 'CHECKOUT_FAILED'
    WHEN subscriptionStatus IN ('PENDING','HALTED') OR paymentStatus = 'failed' THEN 'PAST_DUE'
    WHEN subscriptionStatus IN ('CREATING','CREATE_UNKNOWN','CREATED','AUTHENTICATED') THEN 'PENDING'
    WHEN subscriptionStatus = 'ACTIVE' AND paidUntil <= ${now} THEN 'EXPIRED'
    WHEN subscriptionStatus = 'ACTIVE' THEN 'PENDING'
    WHEN trialActive = 1 THEN 'TRIALING'
    WHEN trialEnd <= ${now} THEN 'TRIAL_EXPIRED'
    ELSE 'NO_SUBSCRIPTION' END AS classification,
    CASE WHEN accessMode = 'SUSPENDED' THEN 0 WHEN accessMode = 'MANUAL' THEN manualActive
      WHEN accessMode = 'CONTROLLED' AND trialEnabled = 1 AND subscriptionEnabled = 0 THEN (hasPaidAccess = 1 OR trialActive = 1 OR hasGraceAccess = 1)
      WHEN accessMode = 'CONTROLLED' THEN (manualActive = 1 OR trialActive = 1)
      ELSE (hasPaidAccess = 1 OR trialActive = 1 OR hasGraceAccess = 1) END AS accessAllowed,
    CASE WHEN accessMode = 'SUSPENDED' THEN 'NONE'
      WHEN accessMode = 'CONTROLLED' AND trialEnabled = 1 AND subscriptionEnabled = 0 THEN IF(hasPaidAccess = 1, 'SUBSCRIPTION', IF(trialActive = 1, 'TRIAL', IF(hasGraceAccess = 1, 'GRACE', 'NONE')))
      WHEN accessMode = 'CONTROLLED' THEN IF(manualActive = 1, 'MANUAL', IF(trialActive = 1, 'TRIAL', 'NONE'))
      WHEN accessMode = 'MANUAL' THEN IF(manualActive = 1, 'MANUAL', 'NONE')
      WHEN hasPaidAccess = 1 THEN 'SUBSCRIPTION' WHEN trialActive = 1 THEN 'TRIAL'
      WHEN hasGraceAccess = 1 THEN 'GRACE' ELSE 'NONE' END AS accessSource
    FROM (SELECT o.id, o.name, o.phoneNumber, o.employeeSize, o.createdAt, o.trialStartedAt,
      o.accessMode, o.accessVersion, o.trialEnabled, o.subscriptionEnabled, o.manualAccessStartsAt, o.manualAccessExpiresAt,
      JSON_UNQUOTE(JSON_EXTRACT(o.manualAccessPlan, '$.name')) AS manualPlanName,
      JSON_UNQUOTE(JSON_EXTRACT(o.manualAccessPlan, '$.interval')) AS manualPlanCycle,
      ((o.accessMode <> 'CONTROLLED' OR o.subscriptionEnabled = 1) AND o.manualAccessStartsAt <= ${now} AND o.manualAccessExpiresAt > ${now}) AS manualActive,
      CASE WHEN o.trialStartedAt IS NOT NULL AND o.trialExpiresAt IS NOT NULL
        THEN o.trialExpiresAt ELSE NULL END AS trialEnd,
      ((o.accessMode = 'AUTO' OR (o.accessMode = 'CONTROLLED' AND o.trialEnabled = 1)) AND o.trialStartedAt <= ${now} AND o.trialExpiresAt > ${now}) AS trialActive,
      admin.fullName AS administratorName, admin.email AS administratorEmail,
      s.id AS subscriptionId, COALESCE(NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(s.commercialTerms, '$.planName')), 'null'), ''), plan.name) AS planName, s.planId, s.interval AS billingCycle,
      s.status AS subscriptionStatus, s.amountMinor, s.currency,
      s.currentPeriodStart, s.currentPeriodEnd, s.nextBillingAt, s.paidUntil,
      s.cancelledAt, s.cancelAtCycleEnd, s.lastSyncedAt,
      COALESCE((${hasPaid("s")}), 0) AS hasPaidAccess,
      COALESCE((${hasGrace("s")}), 0) AS hasGraceAccess,
      payment.status AS paymentStatus, payment.paidAt AS paymentPaidAt,
      (SELECT MIN(COALESCE(conversion.paidAt, conversion.captureVerifiedAt)) FROM BillingPayment conversion
        JOIN Subscription converted ON converted.id = conversion.subscriptionId
        WHERE converted.organizationId = o.id AND converted.lastSyncedAt IS NOT NULL
          AND conversion.providerInvoiceId IS NOT NULL AND conversion.amountMinor >= converted.amountMinor
          AND conversion.currency = converted.currency AND COALESCE(conversion.paidAt, conversion.captureVerifiedAt) <= ${now}
          AND conversion.status IN ('captured','refunded') AND COALESCE(conversion.paidAt, conversion.captureVerifiedAt) >= o.trialStartedAt) AS convertedAt
    FROM Organization o
    LEFT JOIN User admin ON admin.id = (SELECT firstUser.id FROM User firstUser
      WHERE firstUser.organizationId = o.id ORDER BY firstUser.createdAt, firstUser.id LIMIT 1)
    LEFT JOIN Subscription s ON s.id = (SELECT candidate.id FROM Subscription candidate
      WHERE candidate.organizationId = o.id ORDER BY CASE WHEN ${hasPaid("candidate")} THEN 0
        WHEN ${hasGrace("candidate")} THEN 1
        WHEN candidate.status IN ('CREATING','CREATE_UNKNOWN','CREATED','AUTHENTICATED','ACTIVE','PENDING','HALTED','PAUSED') THEN 2 ELSE 3 END,
        candidate.createdAt DESC, candidate.id DESC LIMIT 1)
    LEFT JOIN BillingPlan plan ON plan.id = s.planId
    LEFT JOIN BillingPayment payment ON payment.id = (SELECT recent.id FROM BillingPayment recent
      JOIN Subscription owner ON owner.id = recent.subscriptionId
      WHERE owner.organizationId = o.id AND owner.lastSyncedAt IS NOT NULL
      ORDER BY recent.createdAt DESC, recent.id DESC LIMIT 1)
  ) base`;
}

type Row = {
  id: string; name: string; phoneNumber: string | null; employeeSize: string | null; createdAt: Date; trialStartedAt: Date | null; trialEnd: Date | null;
  trialActive: number | bigint | null; hasPaidAccess: number | bigint; convertedAt: Date | null;
  administratorName: string | null; administratorEmail: string | null;
  manualPlanName: string | null; manualPlanCycle: string | null;
  subscriptionId: string | null; planId: string | null; planName: string | null; billingCycle: string | null;
  subscriptionStatus: string | null; amountMinor: number | null; currency: string | null;
  currentPeriodStart: Date | null; currentPeriodEnd: Date | null; nextBillingAt: Date | null; paidUntil: Date | null;
  cancelledAt: Date | null; cancelAtCycleEnd: number | bigint | null; lastSyncedAt: Date | null;
  paymentStatus: string | null; paymentPaidAt: Date | null; classification: Classification;
  accessMode: string; accessVersion: number; accessAllowed: number | bigint | null; accessSource: string;
  manualAccessStartsAt: Date | null; manualAccessExpiresAt: Date | null; manualActive: number | bigint | null; hasGraceAccess: number | bigint;
};
function serialize(row: Row) {
  return { ...row, trialActive: !!Number(row.trialActive), hasPaidAccess: !!Number(row.hasPaidAccess), hasGraceAccess: !!Number(row.hasGraceAccess), manualActive: !!Number(row.manualActive), accessAllowed: !!Number(row.accessAllowed), cancelAtCycleEnd: !!Number(row.cancelAtCycleEnd) };
}
function number(value: unknown) {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result)) throw new ServiceError("REPORT_TOO_LARGE", 503, "This report exceeds the supported numeric range.");
  return result;
}
function predicate(filters: Filters, now: Date) {
  const status = filters.status === "ALL" ? Prisma.sql`1 = 1`
    : filters.status === "TRIALING" ? Prisma.sql`(accessMode = 'CONTROLLED' AND classification = 'TRIALING') OR (accessMode = 'AUTO' AND trialActive = 1 AND hasPaidAccess = 0)`
    : filters.status === "TRIAL_EXPIRED" ? Prisma.sql`accessMode = 'AUTO' AND trialEnd <= ${now} AND hasPaidAccess = 0`
    : Prisma.sql`classification = ${filters.status}`;
  const search = filters.q?.trim();
  if (!search) return status;
  const pattern = `%${search.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
  return Prisma.sql`(${status}) AND (name LIKE ${pattern} ESCAPE '!' OR id LIKE ${pattern} ESCAPE '!'
    OR administratorEmail LIKE ${pattern} ESCAPE '!')`;
}
const subscriptionSelect = {
  id: true, planId: true, commercialTerms: true, plan: { select: { name: true } }, status: true,
  interval: true, amountMinor: true, currency: true, createdAt: true, currentPeriodStart: true,
  currentPeriodEnd: true, paidUntil: true, nextBillingAt: true, cancelAtCycleEnd: true,
  cancelledAt: true, lastSyncedAt: true,
} satisfies Prisma.SubscriptionSelect;
const paymentSelect = {
  id: true, subscriptionId: true, amountMinor: true, currency: true, status: true,
  paidAt: true, captureVerifiedAt: true, paidAtSource: true, createdAt: true, subscription: { select: { commercialTerms: true, plan: { select: { name: true } }, interval: true } },
} satisfies Prisma.BillingPaymentSelect;

export class SuperAdminService {
  private graceMs: number;
  constructor(private db: PrismaClient, private clock: Clock, graceHours?: number) { this.graceMs = graceMilliseconds(graceHours); }
  async organizations(filters: Filters) {
    const now = this.clock(), rows = organizationRows(now, this.graceMs), where = predicate(filters, now);
    const [items, counts] = await this.db.$transaction([
      this.db.$queryRaw<Row[]>(Prisma.sql`SELECT * FROM (${rows}) report WHERE ${where}
        ORDER BY createdAt DESC, id DESC LIMIT ${filters.pageSize} OFFSET ${(filters.page - 1) * filters.pageSize}`),
      this.db.$queryRaw<{ total: bigint }[]>(Prisma.sql`SELECT COUNT(*) total FROM (${rows}) report WHERE ${where}`),
    ]);
    return { items: items.map(serialize), total: number(counts[0]?.total), page: filters.page, pageSize: filters.pageSize };
  }
  async organization(id: string) {
    const result = await this.db.$queryRaw<Row[]>(Prisma.sql`SELECT * FROM (${organizationRows(this.clock(), this.graceMs)}) report WHERE id = ${id} LIMIT 1`);
    if (!result[0]) throw new ServiceError("ORGANIZATION_NOT_FOUND", 404, "Organization not found.");
    return serialize(result[0]);
  }
  async metrics(range: DateRange) {
    const now = this.clock();
    const [rows, revenue] = await Promise.all([
      this.db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT COUNT(*) totalOrganizations,
        SUM((accessMode = 'CONTROLLED' AND classification = 'TRIALING') OR (accessMode = 'AUTO' AND trialActive = 1 AND hasPaidAccess = 0)) activeTrials,
        SUM(classification = 'PAID_ACTIVE') paidActive,
        SUM(accessMode = 'AUTO' AND trialEnd <= ${now} AND hasPaidAccess = 0) expiredTrials,
        SUM(classification = 'ADMIN_ACTIVE') manualAccess,
        SUM(classification = 'SUSPENDED') suspendedOrganizations,
        SUM(classification = 'PENDING') paymentPending,
        SUM(classification IN ('PAST_DUE','CHECKOUT_FAILED')) paymentFailed,
        SUM(classification = 'CANCELLED') cancelled,
        SUM(classification = 'EXPIRED') expiredSubscriptions,
        SUM(convertedAt IS NOT NULL) convertedTrials
        FROM (${organizationRows(now, this.graceMs)}) report`),
      this.revenue(range),
    ]);
    return { asOf: now, counts: Object.fromEntries(Object.entries(rows[0] || {}).map(([key, value]) => [key, number(value)])), revenue };
  }
  async revenue(range: DateRange) {
    const result = await this.db.billingPayment.aggregate({
      where: { status: "captured", currency: "INR", OR: [{ paidAt: { gte: range.from, lt: range.until } }, { paidAt: null, captureVerifiedAt: { gte: range.from, lt: range.until } }],
        providerInvoiceId: { not: null }, amountMinor: { gt: 0 }, subscription: { lastSyncedAt: { not: null } } },
      _sum: { amountMinor: true }, _count: { id: true },
    });
    return { currency: "INR", capturedAmountMinor: number(result._sum.amountMinor), paymentCount: result._count.id,
      from: range.fromDate, to: range.toDate, timezone: "Asia/Kolkata", refundsMinor: null, netRevenueMinor: null,
      note: "Captured provider-confirmed payments only, dated by signed capture event when available, otherwise first capture verification; legacy dates are retained. Complete historical refund totals and net revenue remain unavailable. Partial refunds may be included in captured totals. Fully refunded records are excluded. No currency conversion." };
  }
  async subscriptions(id: string, pagination: Page) {
    await this.exists(id);
    const [items, total] = await this.db.$transaction([
      this.db.subscription.findMany({ where: { organizationId: id }, select: subscriptionSelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: pagination.pageSize, skip: (pagination.page - 1) * pagination.pageSize }),
      this.db.subscription.count({ where: { organizationId: id } }),
    ]);
    return { items: items.map(({ commercialTerms, plan, ...row }) => ({ ...row, plan: { name: historicalPlanName(commercialTerms, plan.name) } })), total, ...pagination };
  }
  async payments(id: string, pagination: Page) {
    await this.exists(id);
    const where = { subscription: { organizationId: id, lastSyncedAt: { not: null } } };
    const [items, total] = await this.db.$transaction([
      this.db.billingPayment.findMany({ where, select: paymentSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: pagination.pageSize, skip: (pagination.page - 1) * pagination.pageSize }),
      this.db.billingPayment.count({ where }),
    ]);
    return { items: items.map(({ subscription, ...row }) => ({ ...row, subscription: { interval: subscription.interval, plan: { name: historicalPlanName(subscription.commercialTerms, subscription.plan.name) } } })), total, ...pagination };
  }
  private async exists(id: string) {
    if (!await this.db.organization.count({ where: { id } })) throw new ServiceError("ORGANIZATION_NOT_FOUND", 404, "Organization not found.");
  }
}

import { Prisma, type PrismaClient, type Organization } from "@prisma/client";
import { z } from "zod";
import { hashToken } from "../auth/security";
import { AccessPolicy } from "../billing/access";
import { ServiceError, type Clock } from "../services/errors";

const common = { requestId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), reason: z.string().trim().min(5, "Explain the reason in at least 5 characters.").max(500) };
const timestamp = z.string().datetime({ offset: true }).refine((value) => { const year = new Date(value).getUTCFullYear(); return year >= 2000 && year <= 2100; }, "Choose a date between 2000 and 2100.");
export const accessChange = z.discriminatedUnion("action", [
  z.strictObject({ ...common, reason: common.reason.default("Trial and subscription access updated by super admin."), action: z.literal("SET_CONTROLS"), trialEnabled: z.boolean(), subscriptionEnabled: z.boolean(), planId: z.string().trim().min(1).max(191).optional(), trialExpiresAt: timestamp.optional(), startsAt: timestamp.optional(), expiresAt: timestamp.optional() }),
  z.strictObject({ ...common, action: z.literal("SUSPEND") }),
  z.strictObject({ ...common, action: z.literal("RESTORE") }),
  z.strictObject({ ...common, action: z.literal("TRIAL_END"), expiresAt: timestamp }),
  z.strictObject({ ...common, action: z.literal("EXTEND_TRIAL"), days: z.number().int().min(1).max(3650) }),
  z.strictObject({ ...common, action: z.literal("MANUAL"), startsAt: timestamp, expiresAt: timestamp }),
]);
type Change = z.infer<typeof accessChange>;
const organizationSelect = { id: true, name: true, accessMode: true, accessVersion: true, trialEnabled: true, subscriptionEnabled: true, trialStartedAt: true, trialExpiresAt: true, manualAccessStartsAt: true, manualAccessExpiresAt: true, manualAccessPlan: true } as const;
type Settings = Pick<Organization, keyof typeof organizationSelect>;
function snapshot(value: Settings, version = value.accessVersion) {
  return { accessMode: value.accessMode, accessVersion: version, trialEnabled: value.trialEnabled, subscriptionEnabled: value.subscriptionEnabled, manualAccessPlan: value.manualAccessPlan, trialStartedAt: value.trialStartedAt?.toISOString() ?? null,
    trialExpiresAt: value.trialExpiresAt?.toISOString() ?? null, manualAccessStartsAt: value.manualAccessStartsAt?.toISOString() ?? null, manualAccessExpiresAt: value.manualAccessExpiresAt?.toISOString() ?? null };
}

export class OrganizationAccessService {
  constructor(private db: PrismaClient, private access: AccessPolicy, private clock: Clock) {}
  async get(id: string, page = 1) {
    const [organization, events, total] = await this.db.$transaction([
      this.db.organization.findUnique({ where: { id }, select: organizationSelect }),
      this.db.organizationAccessAudit.findMany({ where: { organizationId: id }, select: { id: true, actorSuperAdminId: true, actorName: true, action: true, outcome: true, reason: true, before: true, after: true, failureCode: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, skip: (page - 1) * 20 }),
      this.db.organizationAccessAudit.count({ where: { organizationId: id } }),
    ]);
    if (!organization) throw new ServiceError("ORGANIZATION_NOT_FOUND", 404, "Organization not found.");
    const plans = await this.db.billingPlan.findMany({ where: { enabled: true }, select: { id: true, name: true, interval: true }, orderBy: [{ name: "asc" }, { interval: "asc" }, { id: "asc" }] });
    return { organization, plans, access: await this.access.status(id), history: { items: events, total, page, pageSize: 20 } };
  }
  async change(id: string, actorId: string, sessionToken: string, input: Change) {
    const requestHash = hashToken(JSON.stringify({ organizationId: id, actorId, ...input }));
    let actorName = "Platform administrator", organizationName = "Unknown organization";
    try {
      return await this.db.$transaction(async (tx) => {
        const actorLock = await tx.superAdmin.updateMany({ where: { id: actorId, isActive: true }, data: { updatedAt: this.clock() } });
        if (actorLock.count !== 1) throw new ServiceError("SESSION_EXPIRED", 401, "Your platform access changed. Sign in again.");
        const actor = await tx.superAdmin.findUniqueOrThrow({ where: { id: actorId }, select: { fullName: true, authVersion: true } }); actorName = actor.fullName;
        const session = await tx.superAdminSession.findUnique({ where: { tokenHash: hashToken(sessionToken) } });
        if (!session || session.superAdminId !== actorId || session.authVersion !== actor.authVersion || session.expiresAt <= this.clock())
          throw new ServiceError("SESSION_EXPIRED", 401, "Your platform session ended. Sign in again.");
        const previous = await tx.organizationAccessAudit.findMany({ where: { requestId: input.requestId }, orderBy: { createdAt: "asc" } });
        const completed = previous.find((event) => event.outcome === "SUCCESS");
        if (completed) {
          if (completed.requestHash !== requestHash) throw new ServiceError("REQUEST_CONFLICT", 409, "This request ID was already used for a different operation.");
          return { auditId: completed.id, replayed: true, message: "This access change was already saved." };
        }
        if (previous.some((event) => event.requestHash !== requestHash)) throw new ServiceError("REQUEST_CONFLICT", 409, "This request ID was already used for a different operation.");
        const locked = await tx.organization.updateMany({ where: { id, accessVersion: input.expectedVersion }, data: { accessVersion: { increment: 1 } } });
        if (locked.count !== 1) {
          if (!await tx.organization.count({ where: { id } })) throw new ServiceError("ORGANIZATION_NOT_FOUND", 404, "Organization not found.");
          throw new ServiceError("ACCESS_CONFLICT", 409, "Another administrator changed these settings. Refresh and review the current values before saving again.");
        }
        const before = await tx.organization.findUniqueOrThrow({ where: { id }, select: organizationSelect }); organizationName = before.name;
        const now = this.clock();
        let data: Prisma.OrganizationUpdateInput;
        switch (input.action) {
          case "SET_CONTROLS": {
            const trialStart = before.trialStartedAt ?? now;
            const trialEnd = input.trialExpiresAt ? new Date(input.trialExpiresAt) : null;
            const start = input.startsAt ? new Date(input.startsAt) : null;
            const end = input.expiresAt ? new Date(input.expiresAt) : null;
            if (input.trialEnabled && (!trialEnd || trialEnd <= trialStart)) throw new ServiceError("INVALID_TRIAL_DATES", 400, "Choose a trial end after the original trial start.");
            if (input.subscriptionEnabled && (!start || !end || end <= start)) throw new ServiceError("INVALID_ACCESS_DATES", 400, "Choose subscription dates with the end on or after the start date.");
            if ((!input.trialEnabled && input.trialExpiresAt) || (!input.subscriptionEnabled && (input.startsAt || input.expiresAt))) throw new ServiceError("INVALID_ACCESS_DATES", 400, "Dates can only be changed for enabled options.");
            if (!input.subscriptionEnabled && input.planId) throw new ServiceError("INVALID_ACCESS_PLAN", 400, "A plan can only be changed when subscription access is on.");
            let plan: { id: string; name: string; interval: string } | undefined;
            if (input.subscriptionEnabled) {
              if (!input.planId) throw new ServiceError("INVALID_ACCESS_PLAN", 400, "Select a subscription plan.");
              // Lock the catalog row until assignment and audit commit, so disabling
              // a plan cannot race with validation. No provider billing is created.
              const plans = await tx.$queryRaw<{ id: string; name: string; interval: string }[]>(Prisma.sql`SELECT id, name, \`interval\` FROM BillingPlan WHERE id = ${input.planId} AND enabled = true FOR UPDATE`);
              plan = plans[0];
              if (!plan) throw new ServiceError("INVALID_ACCESS_PLAN", 400, "This plan is unavailable. Select an available subscription plan.");
            }
            data = { accessMode: "CONTROLLED", trialEnabled: input.trialEnabled, subscriptionEnabled: input.subscriptionEnabled,
              ...(input.trialEnabled ? { trialStartedAt: trialStart, trialExpiresAt: trialEnd } : {}),
              ...(input.subscriptionEnabled ? { manualAccessStartsAt: start, manualAccessExpiresAt: end, manualAccessPlan: plan! } : {}) };
            break;
          }
          case "SUSPEND": data = { accessMode: "SUSPENDED" }; break;
          case "RESTORE": data = { accessMode: "AUTO", manualAccessStartsAt: null, manualAccessExpiresAt: null }; break;
          case "MANUAL": {
            const startsAt = new Date(input.startsAt), expiresAt = new Date(input.expiresAt);
            if (expiresAt <= startsAt) throw new ServiceError("INVALID_ACCESS_DATES", 400, "The access end must be after the access start.");
            data = { accessMode: "MANUAL", manualAccessStartsAt: startsAt, manualAccessExpiresAt: expiresAt }; break;
          }
          case "TRIAL_END": {
            const start = before.trialStartedAt ?? now, end = new Date(input.expiresAt);
            if (end <= start) throw new ServiceError("INVALID_TRIAL_DATES", 400, "The trial end must be after the original trial start.");
            data = { trialStartedAt: start, trialExpiresAt: end }; break;
          }
          case "EXTEND_TRIAL": {
            const base = Math.max(now.getTime(), before.trialExpiresAt?.getTime() ?? now.getTime());
            data = { trialStartedAt: before.trialStartedAt ?? now, trialExpiresAt: new Date(base + input.days * 86400000) }; break;
          }
        }
        const after = await tx.organization.update({ where: { id }, data, select: organizationSelect });
        const event = await tx.organizationAccessAudit.create({ data: { organizationId: id, organizationName, actorSuperAdminId: actorId, actorName, action: input.action, outcome: "SUCCESS", reason: input.reason,
          before: snapshot(before, input.expectedVersion), after: snapshot(after), requestId: input.requestId, requestHash, createdAt: now } });
        return { auditId: event.id, replayed: false, message: "Organization access settings saved and audited." };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      const failure = error instanceof ServiceError ? error : error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)
        ? new ServiceError("ACCESS_CONFLICT", 409, "A concurrent access change was detected. Refresh the current settings before retrying.") : error;
      // Failed attempts never alter organization settings. Success history is
      // committed atomically above; rejected-attempt logging is best-effort.
      if (organizationName === "Unknown organization") organizationName = (await this.db.organization.findUnique({ where: { id }, select: { name: true } }).catch(() => null))?.name ?? organizationName;
      await this.db.organizationAccessAudit.createMany({ data: [{ organizationId: id, organizationName, actorSuperAdminId: actorId, actorName, action: input.action, outcome: "FAILED", reason: input.reason,
        failureCode: failure instanceof ServiceError ? failure.code : "INTERNAL_ERROR", requestId: input.requestId, requestHash, createdAt: this.clock() }], skipDuplicates: true }).catch(() => {});
      throw failure;
    }
  }
}

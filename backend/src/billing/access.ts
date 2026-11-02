import type { NextFunction, Request, Response } from "express";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ServiceError, type Clock } from "../services/errors";
import { allowsSelfServiceCheckout, blocksCheckout, graceMilliseconds, matchesAccessPolicy, paidStatuses, replaceableAfterTrialReset, supersededForCheckout, verifiedPaymentSql } from "./access-rules";
import { historicalPlanName } from "./terms";

export class AccessPolicy {
  private graceMs: number;
  get graceHours() { return this.graceMs / 3600000; }
  constructor(
    private db: PrismaClient,
    private clock: Clock,
    graceHours = Number(process.env.BILLING_GRACE_HOURS || 0),
  ) {
    this.graceMs = graceMilliseconds(graceHours);
  }
  async status(organizationId: string) {
    const organization = await this.db.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { trialStartedAt: true, trialExpiresAt: true, accessMode: true, accessVersion: true, trialEnabled: true, subscriptionEnabled: true, manualAccessStartsAt: true, manualAccessExpiresAt: true, manualAccessPlan: true },
    });
    const now = this.clock();
    const recovery = await this.db.billingReplacement.findFirst({ where: { organizationId, state: { in: ["CHECKING", "CANCELLING", "SETTLING", "CONFLICT"] } }, select: { state: true, fromSubscriptionId: true, settleAfter: true } });
    const subscriptions = await this.db.subscription.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      include: {
        plan: { select: { name: true } },
        payments: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            status: true,
            amountMinor: true,
            currency: true,
            paidAt: true,
            createdAt: true,
          },
        },
      },
    });
    const verified = new Set((await this.db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT s.id FROM Subscription s WHERE s.organizationId = ${organizationId} AND ${verifiedPaymentSql("s", now)}
    `)).map((row) => row.id));
    const paid = subscriptions.find(
      (s) =>
        verified.has(s.id) && matchesAccessPolicy(organization, s) &&
        s.paidUntil &&
        s.paidUntil > now &&
        paidStatuses.includes(s.status),
    );
    const trialEnd =
      organization.trialStartedAt && organization.trialExpiresAt
        ? organization.trialExpiresAt
        : null;
    const trial = !!(
      organization.trialStartedAt &&
      organization.trialStartedAt <= now &&
      trialEnd &&
      trialEnd > now
    );
    const grace =
      !paid &&
      subscriptions.find(
        (s) =>
          verified.has(s.id) && matchesAccessPolicy(organization, s) && ["PENDING", "HALTED"].includes(s.status) &&
          s.paidUntil &&
          s.paidUntil.getTime() + this.graceMs > now.getTime(),
      );
    const latest = paid || grace || subscriptions[0] || null;
    const state = paid
      ? ["PENDING", "HALTED"].includes(paid.status)
        ? "PAST_DUE"
        : paid.status === "ACTIVE"
          ? "ACTIVE"
          : paid.status
      : trial
        ? "TRIALING"
        : grace
          ? "PAST_DUE"
          : latest
            ? ["PENDING", "HALTED"].includes(latest.status)
              ? "PAST_DUE"
              : latest.status === "ACTIVE"
                ? latest.paidUntil && latest.paidUntil <= now
                  ? "EXPIRED"
                  : "CREATED"
                : latest.status
            : trialEnd
              ? "TRIAL_EXPIRED"
              : "SUBSCRIPTION_REQUIRED";
    const manual = organization.accessMode === "MANUAL";
    const controlled = organization.accessMode === "CONTROLLED";
    const checkoutAllowed = allowsSelfServiceCheckout(organization);
    const blockers = subscriptions.filter((s) => blocksCheckout(organization, s, now));
    const checkoutBlockedBySubscription = blockers.some((s) => !replaceableAfterTrialReset(organization, s) &&
      !(["CREATED", "AUTHENTICATED"].includes(s.status) && !s.currentPeriodStart && !s.paidUntil));
    const controlledTrial = controlled && organization.trialEnabled && trial;
    const purchasedAccess = controlled && checkoutAllowed && (paid || (!controlledTrial && grace));
    const suspended = organization.accessMode === "SUSPENDED";
    const manualActive = !!((manual || (controlled && organization.subscriptionEnabled)) && organization.manualAccessStartsAt && organization.manualAccessExpiresAt && organization.manualAccessStartsAt <= now && organization.manualAccessExpiresAt > now);
    const effectiveState = suspended || (controlled && !organization.trialEnabled && !organization.subscriptionEnabled) ? "SUSPENDED" : controlledTrial && !manualActive ? "TRIALING" : manual || controlled ? manualActive ? "ADMIN_ACTIVE" : (manual || organization.subscriptionEnabled) && organization.manualAccessStartsAt && organization.manualAccessStartsAt > now ? "ADMIN_SCHEDULED" : "ADMIN_EXPIRED" : state;
    return {
      serverTime: now.toISOString(),
      state: purchasedAccess ? state : effectiveState,
      allowed: !suspended && (controlled ? !!purchasedAccess || manualActive || controlledTrial : manual ? manualActive : !!(paid || trial || grace)),
      checkoutAllowed,
      checkoutBlockedBySubscription,
      checkoutReplacementRequired: blockers.some((s) => replaceableAfterTrialReset(organization, s)),
      billingRecovery: recovery ? { state: recovery.state, subscriptionId: recovery.fromSubscriptionId, settleAfter: recovery.settleAfter } : null,
      accessMode: organization.accessMode,
      trialEnabled: organization.trialEnabled,
      subscriptionEnabled: organization.subscriptionEnabled,
      manualAccess: organization.manualAccessStartsAt && organization.manualAccessExpiresAt ? { startsAt: organization.manualAccessStartsAt, expiresAt: organization.manualAccessExpiresAt, plan: organization.manualAccessPlan } : null,
      source: suspended ? "NONE" : purchasedAccess ? paid ? "SUBSCRIPTION" : "GRACE" : controlled ? manualActive ? "MANUAL" : controlledTrial ? "TRIAL" : "NONE" : manual ? manualActive ? "MANUAL" : "NONE" : paid
        ? "SUBSCRIPTION"
        : trial
          ? "TRIAL"
          : grace
            ? "GRACE"
            : "NONE",
      trialStartedAt: organization.trialStartedAt,
      trialExpiresAt: trialEnd,
      remainingTrialSeconds:
        !suspended && !manual && (!controlled || organization.trialEnabled) && trial && trialEnd
          ? Math.floor((trialEnd.getTime() - now.getTime()) / 1000)
          : 0,
      graceHours: this.graceMs / 3600000,
      subscription: latest
        ? {
            id: latest.id,
            supersededByAccessPolicy: supersededForCheckout(organization, latest),
            planName: historicalPlanName(latest.commercialTerms, latest.plan.name),
            planId: latest.planId,
            status: latest.status,
            interval: latest.interval,
            amountMinor: latest.amountMinor,
            currency: latest.currency,
            paidUntil: latest.paidUntil,
            currentPeriodStart: latest.currentPeriodStart,
            currentPeriodEnd: latest.currentPeriodEnd,
            cancelledAt: latest.cancelledAt,
            latestPayment: latest.payments[0] || null,
            nextBillingAt: latest.nextBillingAt,
            cancelAtCycleEnd: latest.cancelAtCycleEnd,
            totalCount: latest.totalCount,
            lastSyncedAt: latest.lastSyncedAt,
          }
        : null,
    };
  }
  requireSubscription = async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    try {
      const access = await this.status(req.auth!.organizationId);
      if (!access.allowed)
        throw new ServiceError(
          access.state === "TRIAL_EXPIRED"
            ? "TRIAL_EXPIRED"
            : "SUBSCRIPTION_REQUIRED",
          402,
          "Your organization needs a valid subscription to access business operations.",
        );
      next();
    } catch (error) {
      next(error);
    }
  };
}

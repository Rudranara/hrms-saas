import { createHash } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { requireAuthentication, requireRole } from "../auth/security";
import type { Services } from "../services";
import { ServiceError } from "../services/errors";
import { paidStatuses } from "./access-rules";
import { historicalPlanName } from "./terms";
import { refundEligible, refundedAmount, remainingRefundable } from "./refunds";

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const limited = () =>
  rateLimit({
    windowMs: 15 * 60000,
    limit: 40,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      success: false,
      code: "RATE_LIMITED",
      message: "Too many billing requests. Please try again later.",
    },
  });
export function billingRouter(db: PrismaClient, services: Services) {
  const router = Router(),
    billing = services.billing;
  router.get("/plans", async (_req, res) =>
    res.json({
      success: true,
      plans: await billing.plans(),
      providerAvailable: billing.provider.available,
      checkoutReadiness: billing.checkoutReadiness(),
      mode: billing.provider.mode,
    }),
  );
  router.use(requireAuthentication(db));
  router.get("/status", async (req, res) =>
    res.json({
      success: true,
      access: await services.access.status(req.auth!.organizationId),
      providerAvailable: billing.provider.available,
      checkoutReadiness: billing.checkoutReadiness(),
      mode: billing.provider.mode,
    }),
  );
  router.use(requireRole("ORGANIZATION_ADMIN"));
  router.post("/quote", limited(), async (req, res) => {
    const input = z.strictObject({ planId: identifier, period: z.enum(["monthly", "yearly"]) }).safeParse(req.body);
    if (!input.success) throw new ServiceError("VALIDATION_ERROR", 400, "Choose a valid plan and billing frequency. Client prices and capacity are not accepted.");
    res.status(201).json({ success: true, quote: await billing.quote(req.auth!.organizationId, input.data.planId, input.data.period) });
  });
  router.get("/quote", async (req, res) => {
    const query = z.strictObject({ quoteId: identifier }).safeParse(req.query);
    if (!query.success) throw new ServiceError("VALIDATION_ERROR", 400, "Choose a payment quote.");
    res.json({ success: true, quote: await billing.getQuote(req.auth!.organizationId, query.data.quoteId) });
  });
  router.get("/purchase", async (req, res) => {
    const query = z.strictObject({ subscriptionId: identifier }).safeParse(req.query);
    if (!query.success) throw new ServiceError("VALIDATION_ERROR", 400, "Choose your subscription.");
    const row = await billing.own(req.auth!.organizationId, query.data.subscriptionId);
    const payment = await db.billingPayment.findFirst({ where: { subscriptionId: row.id, status: "captured", OR: [{ captureVerifiedAt: { lte: services.clock() } }, { paidAt: { lte: services.clock() } }], providerInvoiceId: { not: null }, currency: row.currency, amountMinor: { gte: row.amountMinor } }, orderBy: { createdAt: "desc" } });
    const access = await services.access.status(req.auth!.organizationId);
    const lastAttempt = await db.billingPayment.findFirst({ where: { subscriptionId: row.id }, select: { status: true }, orderBy: { createdAt: "desc" } });
    const paid = !!(payment && payment.amountRefundedMinor < payment.amountMinor && row.lastSyncedAt && row.paidUntil && row.paidUntil > services.clock() && paidStatuses.includes(row.status));
    const review = await db.billingReplacement.findFirst({ where: { organizationId: req.auth!.organizationId, state: "CONFLICT" }, select: { id: true } });
    const state = review ? "REVIEW" : paid ? access.allowed && access.source === "SUBSCRIPTION" && access.subscription?.id === row.id ? "SUCCESS" : "RESTRICTED" : lastAttempt?.status === "failed" || ["FAILED", "CANCELLED", "COMPLETED", "EXPIRED"].includes(row.status) ? "FAILED" : "PENDING";
    res.json({ success: true, purchase: { state, subscriptionId: row.id, planId: row.planId, planName: historicalPlanName(row.commercialTerms, (await db.billingPlan.findUniqueOrThrow({ where: { id: row.planId } })).name), interval: row.interval, amountMinor: row.amountMinor, currency: row.currency, paidAmountMinor: paid ? payment!.amountMinor : null, transactionReference: paid ? payment!.providerPaymentId : null, nextBillingAt: row.nextBillingAt, paidUntil: row.paidUntil, cancelAtCycleEnd: row.cancelAtCycleEnd, invoiceUrl: null } });
  });
  router.get("/history", async (req, res) => {
    const query = z.object({ page: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(10000)).default(1) }).safeParse(req.query);
    if (!query.success) throw new ServiceError("VALIDATION_ERROR", 400, "Choose a valid payment-history page.");
    const payments = await db.billingPayment.findMany({
      where: { subscription: { organizationId: req.auth!.organizationId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      skip: (query.data.page - 1) * 50,
      select: {
        id: true,
        amountMinor: true,
        currency: true,
        status: true,
        paidAt: true,
        paymentCreatedAt: true,
        captureVerifiedAt: true,
        paidAtSource: true,
        amountRefundedMinor: true,
        providerInvoiceId: true,
        refunds: { select: { id: true, providerRefundId: true, amountMinor: true, status: true, processedAt: true, verifiedAt: true, createdAt: true }, orderBy: { createdAt: "desc" } },
        refundRequests: { where: { activePaymentId: { not: null } }, select: { id: true }, take: 1 },
        createdAt: true,
        subscription: {
          select: { plan: { select: { name: true } }, commercialTerms: true, interval: true, lastSyncedAt: true },
        },
      },
    });
    res.json({ success: true, page: query.data.page, hasMore: payments.length === 50, payments: payments.map(({ subscription, providerInvoiceId, refundRequests, ...payment }) => ({ ...payment, amountRefundedMinor: refundedAmount(payment), remainingRefundableMinor: remainingRefundable(payment), refundEligible: !!subscription.lastSyncedAt && refundEligible({ ...payment, providerInvoiceId }) && !refundRequests.length, activeRefundRequest: refundRequests[0]?.id ?? null, subscription: { interval: subscription.interval, plan: { name: historicalPlanName(subscription.commercialTerms, subscription.plan.name) } } })) });
  });
  router.post(
    "/checkout",
    limited(),
    async (req, res) => {
      const data = z.strictObject({ quoteId: identifier, replaceSubscriptionId: identifier.optional() }).safeParse(req.body);
      if (!data.success)
        throw new ServiceError(
          "VALIDATION_ERROR",
          400,
          "Review a valid payment quote before checkout. Client amounts and provider plan IDs are not accepted.",
        );
      res.json({
        success: true,
        checkout: await billing.checkoutQuote(req.auth!.organizationId, data.data.quoteId, data.data.replaceSubscriptionId),
      });
    },
  );
  router.post(
    "/confirm",
    limited(),
    async (req, res) => {
      const data = z
        .strictObject({
          subscriptionId: identifier,
          razorpay_payment_id: identifier,
          razorpay_subscription_id: identifier,
          razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/i),
        })
        .safeParse(req.body);
      if (!data.success)
        throw new ServiceError(
          "INVALID_PAYMENT_SIGNATURE",
          400,
          "Invalid payment confirmation.",
        );
      await billing.confirm(req.auth!.organizationId, data.data);
      res.json({
        success: true,
        access: await services.access.status(req.auth!.organizationId),
        message:
          "Provider status checked. Access depends on a verified captured payment.",
      });
    },
  );
  router.post("/refresh", limited(), async (req, res) => {
    const body = z
      .strictObject({ subscriptionId: identifier })
      .safeParse(req.body);
    if (!body.success)
      throw new ServiceError(
        "VALIDATION_ERROR",
        400,
        "Choose a subscription to refresh.",
      );
    const row = await billing.own(
      req.auth!.organizationId,
      body.data.subscriptionId,
    );
    await billing.reconcile(row.id);
    res.json({
      success: true,
      access: await services.access.status(req.auth!.organizationId),
    });
  });
  router.post(
    "/cancel",
    limited(),
    async (req, res) => {
      const body = z
        .strictObject({
          subscriptionId: identifier,
          atCycleEnd: z.boolean().default(true),
        })
        .safeParse(req.body);
      if (!body.success)
        throw new ServiceError(
          "VALIDATION_ERROR",
          400,
          "Choose a subscription and cancellation timing.",
        );
      const cancellation = await billing.cancel(
        req.auth!.organizationId,
        body.data.subscriptionId,
        body.data.atCycleEnd,
      );
      res.json({
        success: true,
        access: await services.access.status(req.auth!.organizationId),
        message: cancellation.atCycleEnd
          ? "The provider accepted cancellation at the end of the billing cycle."
          : "The provider accepted cancellation. Verified paid access is retained until its paid-through date.",
      });
    },
  );
  return router;
}
export function billingWebhook(
  db: PrismaClient,
  services: Services,
): RequestHandler {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!services.billing.provider.available)
      throw new ServiceError(
        "BILLING_UNAVAILABLE",
        503,
        "Billing webhook credentials are not configured.",
      );
    const body = req.body;
    if (
      !Buffer.isBuffer(body) ||
      !services.billing.provider.verifyWebhook(
        body,
        req.get("x-razorpay-signature") || "",
      )
    )
      throw new ServiceError(
        "INVALID_WEBHOOK_SIGNATURE",
        400,
        "Webhook signature could not be verified.",
      );
    const eventId = req.get("x-razorpay-event-id");
    if (!eventId || !/^[a-zA-Z0-9_-]{1,128}$/.test(eventId))
      throw new ServiceError(
        "INVALID_WEBHOOK",
        400,
        "A provider event ID is required.",
      );
    const parsed = z
      .object({
        event: z.string().max(80),
        created_at: z.number().int().positive().optional(),
        payload: z.object({
          refund: z.object({ entity: z.object({ id: identifier, payment_id: identifier }) }).optional(),
          subscription: z
            .object({
              entity: z.object({
                id: z.string(),
                notes: z.record(z.string(), z.string()).optional(),
              }),
            })
            .optional(),
          invoice: z
            .object({
              entity: z.object({
                subscription_id: z.string().nullable().optional(),
              }),
            })
            .optional(),
          payment: z
            .object({
              entity: z.object({
                id: identifier,
                invoice_id: identifier.nullable().optional(),
              }),
            })
            .optional(),
        }),
      })
      .safeParse(JSON.parse(body.toString("utf8")));
    if (!parsed.success)
      throw new ServiceError(
        "INVALID_WEBHOOK",
        400,
        "Invalid webhook payload.",
      );
    const entity = parsed.data.payload.subscription?.entity;
    let paymentEntity = parsed.data.payload.payment?.entity;
    const relevant =
      /^(subscription\.(authenticated|activated|charged|completed|updated|pending|halted|cancelled|paused|resumed)|invoice\.paid|payment\.(captured|failed|authorized)|refund\.(created|processed|failed|speed_changed))$/.test(
        parsed.data.event,
      );
    if (!relevant) {
      res.json({ success: true, ignored: true });
      return;
    }
    // Deduplicate before any network lookup, including payment-only events.
    const digest = createHash("sha256").update(body).digest("hex");
    const processed = await db.billingEvent.findUnique({
      where: { id: eventId },
    });
    if (processed) {
      if (processed.bodyHash !== digest)
        throw new ServiceError(
          "WEBHOOK_CONFLICT",
          409,
          "Webhook identifier conflict.",
        );
      res.json({ success: true, duplicate: true });
      return;
    }
    let remoteId =
      entity?.id || parsed.data.payload.invoice?.entity.subscription_id;
    const refund = parsed.data.payload.refund?.entity;
    if (parsed.data.event.startsWith("refund.")) {
      if (!refund || (paymentEntity && paymentEntity.id !== refund.payment_id))
        throw new ServiceError("PAYMENT_MISMATCH", 409, "Refund and payment identifiers do not match.");
      const payment = await services.billing.provider.payment(refund.payment_id);
      if (payment.id !== refund.payment_id) throw new ServiceError("PAYMENT_MISMATCH", 409, "Refund payment could not be verified.");
      // Refund totals come from this authenticated GET, never the event's amount.
      paymentEntity = { id: payment.id, invoice_id: payment.invoice_id };
    }
    if (!remoteId && paymentEntity?.invoice_id) {
      const invoice = await services.billing.provider.invoice(
        paymentEntity.invoice_id,
      );
      if (invoice.id !== paymentEntity.invoice_id)
        throw new ServiceError(
          "PAYMENT_MISMATCH",
          409,
          "Provider invoice could not be matched.",
        );
      remoteId = invoice.subscription_id;
    }
    if (!remoteId) {
      res.json({ success: true, ignored: true });
      return;
    }
    const local = await db.subscription.findFirst({
      where: {
        OR: [
          { providerSubscriptionId: remoteId },
          ...(entity?.notes?.localSubscriptionId
            ? [{ id: entity.notes.localSubscriptionId }]
            : []),
        ],
      },
    });
    if (!local) {
      res.json({ success: true, ignored: true });
      return;
    }
    if (refund) {
      // Create any missing payment evidence before importing the refund. Do not
      // acknowledge the event until its ledger entry is durable as well.
      await services.billing.reconcile(local.id);
      const payment = await db.billingPayment.findFirst({ where: { providerPaymentId: refund.payment_id, subscriptionId: local.id }, select: { id: true } });
      if (!payment) throw new ServiceError("PAYMENT_MISMATCH", 409, "The refund's original payment has not been reconciled.");
      await services.refunds.syncPayment(payment.id, refund.id);
    }
    await services.billing.reconcile(local.id, {
      id: eventId,
      digest,
      type: parsed.data.event,
      ...(paymentEntity ? { paymentId: paymentEntity.id } : {}),
      ...(parsed.data.created_at ? { occurredAt: new Date(parsed.data.created_at * 1000) } : {}),
    });
    res.json({ success: true });
  };
}

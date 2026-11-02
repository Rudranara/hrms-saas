import { createHash, randomBytes } from "node:crypto";
import { allowsSelfServiceCheckout, blocksCheckout, replaceableAfterTrialReset } from "./access-rules";
import {
  Prisma,
  type PrismaClient,
  type Subscription,
  type BillingPlan,
  type BillingQuote,
} from "@prisma/client";
import { ServiceError, type Clock } from "../services/errors";
import { billingTaxNote } from "./tax";
import { definiteProviderRejection } from "./provider";
import type {
  PaymentProvider,
  RemoteSubscription,
  RemotePayment,
} from "./provider";

type Event = { id: string; digest: string; type: string; paymentId?: string; occurredAt?: Date };
export const replacementBlockingStates = ["CHECKING", "CANCELLING", "SETTLING", "CONFLICT"];
const replacementWait = () => new ServiceError("REPLACEMENT_PENDING", 409, "The previous subscription is being checked. Wait at least one minute, then choose Proceed to payment again. If it remains unresolved, refresh provider status.");
const replacementConflict = () => new ServiceError("PAYMENT_REVIEW_REQUIRED", 409, "Payment and cancellation may have overlapped. Payment records and verified paid time are retained. Contact your platform administrator for review; do not pay again.");
function trialRepurchase(value: Prisma.JsonValue | null) {
  return value && typeof value === "object" && !Array.isArray(value) && value.kind === "TRIAL_REPURCHASE" && typeof value.accessVersion === "number" ? value : null;
}
export class BillingService {
  constructor(
    private db: PrismaClient,
    public provider: PaymentProvider,
    private clock: Clock,
  ) {}
  private async publicQuote(quote: BillingQuote) {
    const organization = await this.db.organization.findUniqueOrThrow({ where: { id: quote.organizationId } });
    const rows = await this.db.subscription.findMany({ where: { organizationId: quote.organizationId }, orderBy: { createdAt: "desc" } });
    const previous = rows.find((row) => blocksCheckout(organization, row, this.clock()) && replaceableAfterTrialReset(organization, row));
    const { providerPlanId: _providerPlanId, ...snapshot } = quote;
    const terms = { ...snapshot, replacesSubscriptionId: previous?.id ?? null };
    return { ...terms, serverTime: this.clock(), discountMinor: 0, renewalAmountMinor: quote.amountMinor, capacity: null, features: ["Organization-level subscription billing", "Cancel future renewals", "Verified payment history"], terms: `Charged ${quote.interval === "MONTHLY" ? "monthly" : "yearly"} for up to ${quote.totalCount} billing cycles unless cancelled. ${quote.interval === "YEARLY" ? `${quote.totalCount} annual cycles may span up to ${quote.totalCount} years.` : "Each payment covers one monthly billing period."} Paid billing begins on provider activation; trial dates are unchanged.` };
  }
  async quote(organizationId: string, planId: string, period: "monthly" | "yearly") {
    const [organization, plan] = await Promise.all([this.db.organization.findUniqueOrThrow({ where: { id: organizationId } }), this.db.billingPlan.findFirst({ where: { id: planId, enabled: true } })]);
    if (organization.accessMode === "SUSPENDED") throw new ServiceError("ORGANIZATION_SUSPENDED", 403, "Workspace access is suspended. Contact your platform administrator.");
    if (!allowsSelfServiceCheckout(organization)) throw new ServiceError("ADMIN_MANAGED_ACCESS", 403, "Contact your platform administrator to manage subscription access.");
    if (!plan || plan.interval.toLowerCase() !== period) throw new ServiceError("PLAN_UNAVAILABLE", 400, "Choose a valid plan and matching billing frequency.");
    if (!plan.amountMinor || !plan.providerPlanId) throw new ServiceError("PLAN_UNAVAILABLE", 503, "This plan is not configured for checkout.");
    const quote = await this.db.billingQuote.create({ data: { organizationId, organizationName: organization.name, planId: plan.id, planName: plan.name, providerPlanId: plan.providerPlanId, interval: plan.interval, amountMinor: plan.amountMinor, currency: plan.currency, totalCount: plan.totalCount, taxNote: billingTaxNote(), expiresAt: new Date(this.clock().getTime() + 15 * 60000), createdAt: this.clock() } });
    return this.publicQuote(quote);
  }
  async getQuote(organizationId: string, id: string) {
    const quote = await this.db.billingQuote.findFirst({ where: { id, organizationId } });
    if (!quote) throw new ServiceError("QUOTE_NOT_FOUND", 404, "Payment quote not found.");
    return this.publicQuote(quote);
  }
  private validQuote(quote: BillingQuote | null, plan: BillingPlan) {
    if (!quote || quote.version !== 1 || quote.expiresAt <= this.clock()) throw new ServiceError("QUOTE_EXPIRED", 409, "This payment summary expired. Review a new quote before paying.");
    if (!plan.enabled || quote.planId !== plan.id || quote.planName !== plan.name || quote.amountMinor !== plan.amountMinor || quote.currency !== plan.currency || quote.interval !== plan.interval || quote.providerPlanId !== plan.providerPlanId || quote.totalCount !== plan.totalCount || quote.taxNote !== billingTaxNote()) throw new ServiceError("QUOTE_STALE", 409, "Subscription terms changed. Review a new payment summary before paying.");
  }
  async checkoutQuote(organizationId: string, quoteId: string, replaceSubscriptionId?: string) {
    const quote = await this.db.billingQuote.findFirst({ where: { id: quoteId, organizationId } });
    if (!quote) throw new ServiceError("QUOTE_NOT_FOUND", 404, "Payment quote not found.");
    const plan = await this.db.billingPlan.findUniqueOrThrow({ where: { id: quote.planId } });
    this.validQuote(quote, plan);
    const organization = await this.db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (organization.accessMode === "SUSPENDED") throw new ServiceError("ORGANIZATION_SUSPENDED", 403, "Workspace access is suspended. Contact your platform administrator.");
    if (!allowsSelfServiceCheckout(organization)) throw new ServiceError("ADMIN_MANAGED_ACCESS", 403, "Contact your platform administrator to manage subscription access.");
    const waiting = await this.db.billingReplacement.findFirst({ where: { organizationId, OR: [
      { state: "SETTLING", settleAfter: { lte: this.clock() } },
      { state: "CANCELLING", updatedAt: { lt: new Date(this.clock().getTime() - 60000) } },
    ] } });
    if (waiting) await this.reconcile(waiting.fromSubscriptionId);
    const operation = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM Organization WHERE id = ${organizationId} FOR UPDATE`;
      const blocked = await tx.billingReplacement.findFirst({ where: { organizationId, state: { in: replacementBlockingStates } } });
      if (blocked) { if (blocked.state === "CONFLICT") throw replacementConflict(); throw replacementWait(); }
      const ready = await tx.billingReplacement.findFirst({ where: { organizationId, state: "READY" } });
      if (ready) return null;
      const policy = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
      const rows = await tx.subscription.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" } });
      const superseded = rows.filter((row) => blocksCheckout(policy, row, this.clock()) && replaceableAfterTrialReset(policy, row));
      if (superseded.length > 1) throw new ServiceError("PAYMENT_REVIEW_REQUIRED", 409, "Multiple earlier subscriptions need administrator review before another payment.");
      const pending = superseded[0] ?? rows.find((row) => ["CREATED", "AUTHENTICATED"].includes(row.status) && row.planId !== quote.planId);
      if (!pending) return null;
      if (superseded[0] && replaceSubscriptionId !== pending.id) throw new ServiceError("REPLACEMENT_CONSENT_REQUIRED", 409, "Review a fresh payment summary and confirm replacement of your earlier recurring subscription before proceeding.");
      const context = superseded[0] ? { kind: "TRIAL_REPURCHASE", accessVersion: policy.accessVersion } : undefined;
      return tx.billingReplacement.upsert({ where: { fromSubscriptionId: pending.id }, create: { organizationId, fromSubscriptionId: pending.id, quoteId, state: "CHECKING", context, createdAt: this.clock(), updatedAt: this.clock() }, update: { quoteId, state: "CHECKING", context: context ?? Prisma.DbNull, reason: null, settleAfter: null, updatedAt: this.clock() } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if (operation) {
      try {
        // Durable reservation blocks every other checkout while provider calls run.
        // GETs happen immediately before cancellation; no local lock can freeze Razorpay.
        await this.reconcile(operation.fromSubscriptionId);
        const current = await this.own(organizationId, operation.fromSubscriptionId);
        const remote = await this.provider.fetchSubscription(current.providerSubscriptionId!);
        this.match(current, remote);
        const money = await this.db.billingPayment.count({ where: { subscriptionId: current.id, OR: [{ status: { in: ["authorized", "captured", "refunded"] } }, { amountRefundedMinor: { gt: 0 } }] } });
        const repurchase = trialRepurchase(operation.context);
        if (!repurchase && (!["created", "authenticated"].includes(remote.status) || remote.paid_count > 0 || remote.current_start || current.paidUntil || money)) {
          await this.db.billingReplacement.updateMany({ where: { id: operation.id, state: "CHECKING" }, data: { state: "ABORTED", reason: "PAYMENT_STARTED_BEFORE_CANCEL", updatedAt: this.clock() } });
          throw new ServiceError("SUBSCRIPTION_EXISTS", 409, "The previous subscription has started or received payment. It was not cancelled.");
        }
        const claimed = await this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM Organization WHERE id = ${organizationId} FOR UPDATE`;
          const policy = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
          if (repurchase && (policy.accessVersion !== repurchase.accessVersion || !replaceableAfterTrialReset(policy, current)))
            throw new ServiceError("ACCESS_CONFLICT", 409, "Access settings changed. Review a fresh payment summary.");
          const context = repurchase ? { ...repurchase, paidCount: remote.paid_count, financialDigest: await this.financialDigest(tx, current.id) } : undefined;
          return tx.billingReplacement.updateMany({ where: { id: operation.id, state: "CHECKING" }, data: { state: "CANCELLING", context, updatedAt: this.clock() } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
        if (claimed.count !== 1) throw replacementConflict();
        const cancelled = repurchase && ["cancelled", "completed", "expired"].includes(remote.status) ? remote : await this.provider.cancel(remote.id, false);
        this.match(current, cancelled);
        // Persist uncertainty before reading again. Never repeat cancellation on retry.
        await this.db.billingReplacement.updateMany({ where: { id: operation.id, state: "CANCELLING" }, data: { state: "SETTLING", settleAfter: new Date(this.clock().getTime() + 60000), updatedAt: this.clock() } });
        await this.reconcile(current.id);
        const after = await this.db.billingReplacement.findUniqueOrThrow({ where: { id: operation.id } });
        if (after.state === "CONFLICT") throw replacementConflict();
        if (cancelled.status !== "cancelled") throw replacementWait();
      } catch (error) {
        // A timeout is not permission to cancel or create again. Recovery is GET-only.
        await this.db.billingReplacement.updateMany({ where: { id: operation.id, state: "CHECKING" }, data: { state: "ABORTED", reason: "PRECHECK_FAILED_NO_CANCEL", updatedAt: this.clock() } });
        throw error;
      }
      throw replacementWait();
    }
    const ready = await this.db.billingReplacement.findFirst({ where: { organizationId, state: "READY" } });
    if (ready && ready.fromSubscriptionId !== waiting?.fromSubscriptionId) await this.reconcile(ready.fromSubscriptionId);
    return this.checkout(organizationId, quote.planId, quote.interval.toLowerCase() as "monthly" | "yearly", quoteId);
  }
  checkoutReadiness() {
    if (this.provider.apiConfigurationError)
      return {
        ready: false,
        code: this.provider.apiConfigurationError.code,
        message: this.provider.apiConfigurationError.message,
      };
    if (!this.provider.available)
      return {
        ready: false,
        code: "RAZORPAY_WEBHOOK_SECRET_MISSING",
        message:
          "RAZORPAY_WEBHOOK_SECRET is missing. Configure this backend-only secret to enable checkout. A public webhook URL is not required for local checkout readiness; production webhook delivery must be configured separately.",
      };
    return {
      ready: true,
      code: "CONFIGURED",
      message:
        "Razorpay checkout is configured. Paid access still requires provider-confirmed payment and subscription state.",
    };
  }
  async plans() {
    return (
      await this.db.billingPlan.findMany({
        where: { enabled: true },
        orderBy: { id: "asc" },
      })
    ).map(
      ({
        id,
        name,
        interval,
        amountMinor,
        currency,
        totalCount,
        providerPlanId,
      }) => ({
        id,
        name,
        interval,
        amountMinor,
        currency,
        totalCount,
        taxNote: billingTaxNote(),
        unavailableReason: !this.provider.available
          ? this.checkoutReadiness().message
          : !providerPlanId
            ? "This plan has no synchronized Razorpay plan ID. Run billing:sync-plans on the backend."
            : !amountMinor
              ? "This plan has no configured price."
              : null,
        configured: !!(
          this.provider.available &&
          providerPlanId &&
          amountMinor &&
          amountMinor > 0
        ),
      }),
    );
  }
  private async validatePlan(
    plan: Pick<
      BillingPlan,
      "providerPlanId" | "amountMinor" | "currency" | "interval"
    >,
  ) {
    if (!plan.providerPlanId || !plan.amountMinor || plan.amountMinor <= 0)
      throw new ServiceError(
        "PLAN_UNAVAILABLE",
        503,
        "This plan is not configured. No payment has been initiated.",
      );
    const remote = await this.provider.fetchPlan(plan.providerPlanId);
    if (
      remote.id !== plan.providerPlanId ||
      remote.item.amount !== plan.amountMinor ||
      remote.item.currency !== plan.currency ||
      remote.interval !== 1 ||
      remote.period !== plan.interval.toLowerCase()
    )
      throw new ServiceError(
        "PLAN_CONFIGURATION_MISMATCH",
        503,
        "The configured plan does not match the payment provider. Checkout is unavailable.",
      );
  }
  async own(organizationId: string, id: string) {
    const row = await this.db.subscription.findFirst({
      where: { id, organizationId },
    });
    if (!row)
      throw new ServiceError(
        "SUBSCRIPTION_NOT_FOUND",
        404,
        "Subscription not found.",
      );
    return row;
  }
  private checkoutData(row: Subscription) {
    return {
      subscriptionId: row.id,
      providerSubscriptionId: row.providerSubscriptionId,
      keyId: this.provider.keyId,
      mode: this.provider.mode,
      amountMinor: row.amountMinor,
      currency: row.currency,
      interval: row.interval,
      totalCount: row.totalCount,
    };
  }
  async checkout(organizationId: string, planId: string, period?: "monthly" | "yearly", quoteId?: string) {
    const organizationAccess = await this.db.organization.findUnique({ where: { id: organizationId }, select: { accessMode: true, trialEnabled: true, subscriptionEnabled: true } });
    if (organizationAccess?.accessMode === "SUSPENDED") throw new ServiceError("ORGANIZATION_SUSPENDED", 403, "Workspace access is suspended by the platform administrator. New checkout is unavailable; existing billing can still be viewed or cancelled.");
    if (organizationAccess && !allowsSelfServiceCheckout(organizationAccess)) throw new ServiceError("ADMIN_MANAGED_ACCESS", 403, "Workspace subscription dates are managed by the platform administrator. Contact them before starting a new checkout.");
    const plan = await this.db.billingPlan.findFirst({
      where: { id: planId, enabled: true },
    });
    if (!plan)
      throw new ServiceError(
        "PLAN_UNAVAILABLE",
        400,
        "Choose an available plan.",
      );
    if (period && plan.interval.toLowerCase() !== period)
      throw new ServiceError("VALIDATION_ERROR", 400, "The selected billing period does not match this plan. Choose the plan again.");
    if (quoteId) this.validQuote(await this.db.billingQuote.findFirst({ where: { id: quoteId, organizationId } }), plan);
    if (!this.provider.available)
      throw new ServiceError(
        "BILLING_UNAVAILABLE",
        503,
        `${this.checkoutReadiness().message} No payment has been initiated.`,
      );
    await this.validatePlan(plan);
    const now = this.clock();
    const prepared = await this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM Organization WHERE id = ${organizationId} FOR UPDATE`;
        const replacement = await tx.billingReplacement.findFirst({ where: { organizationId, state: { in: [...replacementBlockingStates, "READY"] } } });
        if (replacement && replacement.state !== "READY") { if (replacement.state === "CONFLICT") throw replacementConflict(); throw replacementWait(); }
        let quote: BillingQuote | null = null;
        if (quoteId) {
          await tx.$queryRaw`SELECT id FROM BillingPlan WHERE id = ${planId} FOR UPDATE`;
          const currentPlan = await tx.billingPlan.findUniqueOrThrow({ where: { id: planId } });
          quote = await tx.billingQuote.findFirst({ where: { id: quoteId, organizationId } });
          this.validQuote(quote, currentPlan);
          // The provider request below must use the terms validated under lock.
          if (currentPlan.providerPlanId !== plan.providerPlanId || currentPlan.amountMinor !== plan.amountMinor || currentPlan.totalCount !== plan.totalCount) throw new ServiceError("QUOTE_STALE", 409, "Subscription terms changed. Review a new quote.");
        }
        const accessPolicy = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { accessMode: true, accessVersion: true, trialEnabled: true, subscriptionEnabled: true } });
        if (accessPolicy.accessMode === "SUSPENDED") throw new ServiceError("ORGANIZATION_SUSPENDED", 403, "Workspace access is suspended by the platform administrator. New checkout is unavailable; existing billing can still be viewed or cancelled.");
        if (!allowsSelfServiceCheckout(accessPolicy)) throw new ServiceError("ADMIN_MANAGED_ACCESS", 403, "Workspace subscription dates are managed by the platform administrator. Contact them before starting a new checkout.");
        const existingRows = await tx.subscription.findMany({
          where: {
            organizationId,
            OR: [
              {
                status: {
                  in: [
                    "CREATING",
                    "CREATE_UNKNOWN",
                    "CREATED",
                    "AUTHENTICATED",
                    "ACTIVE",
                    "PENDING",
                    "HALTED",
                    "PAUSED",
                  ],
                },
              },
              { paidUntil: { gt: now } },
            ],
          },
          orderBy: { createdAt: "desc" },
        });
        const existing = existingRows.find((row) => blocksCheckout(accessPolicy, row, now));
        if (existing) {
          if (
            ["CREATED", "AUTHENTICATED"].includes(existing.status) &&
            existing.planId === planId &&
            existing.providerSubscriptionId && existing.amountMinor === plan.amountMinor && existing.currency === plan.currency && existing.providerPlanId === plan.providerPlanId && existing.interval === plan.interval && existing.totalCount === plan.totalCount
          ) {
            if (quote) await tx.billingQuote.update({ where: { id: quote.id }, data: { subscriptionId: existing.id } });
            return { row: existing, reused: true };
          }
          throw new ServiceError(
            "SUBSCRIPTION_EXISTS",
            409,
            "An existing or pending subscription must be resolved first. Refresh its status or cancel it before choosing another plan.",
          );
        }
        const row = await tx.subscription.create({
          data: {
            creationOperationId: randomBytes(16).toString("hex"),
            organizationId,
            planId: plan.id,
            providerPlanId: plan.providerPlanId!,
            amountMinor: plan.amountMinor!,
            currency: plan.currency,
            interval: plan.interval,
            totalCount: plan.totalCount,
            commercialTerms: { accessPolicyVersion: accessPolicy.accessVersion, ...(quote ? { version: quote.version, quoteId: quote.id, planName: quote.planName, amountMinor: quote.amountMinor, currency: quote.currency, interval: quote.interval, totalCount: quote.totalCount, taxNote: quote.taxNote, discountMinor: 0, capacity: null } : {}) },
            createdAt: now,
          },
        });
        if (quote) await tx.billingQuote.update({ where: { id: quote.id }, data: { subscriptionId: row.id } });
        if (replacement) await tx.billingReplacement.update({ where: { id: replacement.id }, data: { state: "COMPLETED", toSubscriptionId: row.id, updatedAt: this.clock() } });
        return { row, reused: false };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    if (prepared.reused) return this.checkoutData(prepared.row);
    try {
      const remote = await this.provider.createSubscription(
        plan.providerPlanId!,
        plan.totalCount,
        prepared.row.id,
        organizationId,
      );
      this.match(prepared.row, remote);
      const completed = await this.db.subscription.updateMany({
        where: { id: prepared.row.id, status: "CREATING", creationOperationId: prepared.row.creationOperationId, syncLeaseOwner: null },
        data: {
          providerSubscriptionId: remote.id,
          status: "CREATED",
          providerCustomerId: remote.customer_id || null,
        },
      });
      const row = await this.db.subscription.findUniqueOrThrow({ where: { id: prepared.row.id } });
      if (completed.count !== 1 && row.providerSubscriptionId !== remote.id)
        throw new ServiceError("BILLING_SYNC_PENDING", 503, "Provider creation is being reconciled. Check status before retrying.");
      return this.checkoutData(row);
    } catch (error) {
      await this.db.subscription.updateMany({
        where: { id: prepared.row.id, status: "CREATING", creationOperationId: prepared.row.creationOperationId, syncLeaseOwner: null },
        data: {
          status: definiteProviderRejection(error)
            ? "FAILED"
            : "CREATE_UNKNOWN",
        },
      });
      throw error;
    }
  }
  private match(local: Subscription, remote: RemoteSubscription) {
    if (
      remote.plan_id !== local.providerPlanId ||
      remote.notes.localSubscriptionId !== local.id ||
      remote.notes.organizationId !== local.organizationId ||
      (local.providerSubscriptionId &&
        local.providerSubscriptionId !== remote.id)
    )
      throw new ServiceError(
        "PROVIDER_STATE_MISMATCH",
        409,
        "Provider subscription details could not be matched to this organization.",
      );
  }
  private async financialDigest(db: Pick<Prisma.TransactionClient, "billingPayment">, id: string) {
    const rows = await db.billingPayment.findMany({ where: { subscriptionId: id }, orderBy: { providerPaymentId: "asc" },
      select: { providerPaymentId: true, status: true, amountMinor: true, currency: true, amountRefundedMinor: true } });
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  }
  private async paymentEvidence(value: RemotePayment) {
    const prior = await this.db.billingPayment.findUnique({ where: { providerPaymentId: value.id }, select: { status: true, amountRefundedMinor: true } });
    const refunded = Math.max(prior?.amountRefundedMinor ?? 0, value.amount_refunded);
    // Refunds are irreversible financial evidence. A lagging provider read must
    // not erase that evidence or turn a fully refunded cycle back into paid time.
    return { ...value, amount_refunded: refunded,
      status: prior?.status === "refunded" || (value.amount > 0 && refunded >= value.amount) ? "refunded" : value.status };
  }
  async reconcile(id: string, event?: Event) {
    if (event) {
      const existing = await this.db.billingEvent.findUnique({
        where: { id: event.id },
      });
      if (existing) {
        if (
          existing.bodyHash !== event.digest ||
          existing.subscriptionId !== id
        )
          throw new ServiceError(
            "WEBHOOK_CONFLICT",
            409,
            "Webhook identifier conflict.",
          );
        return;
      }
    }
    const owner = randomBytes(16).toString("hex"),
      now = this.clock();
    const acquired = await this.db.subscription.updateMany({
      where: {
        id,
        OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }],
      },
      data: {
        syncLeaseOwner: owner,
        syncLeaseUntil: new Date(now.getTime() + 120000),
      },
    });
    if (acquired.count !== 1)
      throw new ServiceError(
        "BILLING_SYNC_PENDING",
        503,
        "Subscription synchronization is in progress. Please retry shortly.",
      );
    try {
      const local = await this.db.subscription.findUniqueOrThrow({
        where: { id },
      });
      const remote = local.providerSubscriptionId
        ? await this.provider.fetchSubscription(local.providerSubscriptionId)
        : await this.provider.findSubscription(id, local.createdAt);
      if (!remote)
        throw new ServiceError(
          "CHECKOUT_PENDING",
          409,
          "Checkout initialization is awaiting provider confirmation. No paid access has been granted.",
        );
      this.match(local, remote);
      if (
        ["CANCELLED", "COMPLETED", "EXPIRED"].includes(local.status) &&
        !["cancelled", "completed", "expired"].includes(remote.status)
      )
        throw new ServiceError(
          "STALE_PROVIDER_STATE",
          503,
          "The provider returned an older subscription state. Please retry synchronization.",
        );
      await this.validatePlan(local);
      const start = remote.current_start || 0,
        end = remote.current_end || 0;
      // Financial recovery must also inspect terminal/unstarted subscriptions.
      const invoices = await this.provider.invoices(remote.id, start);
      const payments: { value: RemotePayment; invoice: string }[] = [];
      let paidUntil: Date | null = null;
      for (const invoice of invoices) {
        if (invoice.subscription_id !== remote.id || !invoice.payment_id)
          continue;
        const payment = await this.paymentEvidence(await this.provider.payment(invoice.payment_id));
        if (
          payment.invoice_id !== invoice.id ||
          payment.id !== invoice.payment_id ||
          payment.currency !== local.currency
        )
          continue;
        payments.push({ value: payment, invoice: invoice.id });
        const belongsToPeriod =
          invoice.billing_start === start ||
          (invoice.issued_at ?? invoice.created_at) >= start;
        if (
          remote.paid_count > 0 &&
          end > start &&
          start > 0 &&
          belongsToPeriod &&
          (invoice.billing_start === start || payment.created_at >= start) &&
          invoice.status === "paid" &&
          invoice.amount_paid >= local.amountMinor &&
          invoice.currency === local.currency &&
          payment.status === "captured" &&
          payment.amount >= local.amountMinor &&
          payment.amount_refunded < payment.amount
        ) {
          const until =
            invoice.billing_end && invoice.billing_end > start
              ? Math.min(end, invoice.billing_end)
              : end;
          paidUntil = new Date(until * 1000);
        }
      }
      // Payment-only webhooks can report failed attempts that are no longer
      // invoice.payment_id. Record them only after fetching the provider invoice
      // and proving that it belongs to this persisted subscription. They never
      // grant paid time; only the captured paid-invoice checks above can do that.
      if (
        event?.paymentId &&
        !payments.some((p) => p.value.id === event.paymentId)
      ) {
        const payment = await this.paymentEvidence(await this.provider.payment(event.paymentId));
        if (
          payment.id !== event.paymentId ||
          payment.currency !== local.currency
        )
          throw new ServiceError(
            "PAYMENT_MISMATCH",
            409,
            "Provider payment could not be matched to this subscription.",
          );
        if (payment.invoice_id) {
          const invoice = await this.provider.invoice(payment.invoice_id);
          if (
            invoice.id !== payment.invoice_id ||
            invoice.subscription_id !== remote.id
          )
            throw new ServiceError(
              "PAYMENT_MISMATCH",
              409,
              "Provider invoice belongs to a different subscription.",
            );
          payments.push({ value: payment, invoice: invoice.id });
        }
        // An authorization amount can lack an invoice. Acknowledge the
        // independently verified subscription state without attributing that
        // payment to a tenant or granting paid time from the event payload.
      }
      const currentPaymentRefunded = payments.some(
        (p) =>
          p.value.status === "refunded" ||
          p.value.amount_refunded >= p.value.amount,
      );
      // Never extend access from subscription.status alone or an authorization payment.
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM Organization WHERE id = ${local.organizationId} FOR UPDATE`;
        const locked = await tx.subscription.findFirst({
          where: {
            id,
            syncLeaseOwner: owner,
            syncLeaseUntil: { gt: this.clock() },
          },
        });
        if (!locked)
          throw new ServiceError(
            "BILLING_SYNC_PENDING",
            503,
            "Subscription synchronization timed out. Please retry.",
          );
        const committed = await tx.subscription.updateMany({
          where: { id, syncLeaseOwner: owner, syncLeaseUntil: { gt: this.clock() } },
          data: {
            providerSubscriptionId: remote.id,
            providerCustomerId: remote.customer_id || null,
            status: remote.status.toUpperCase(),
            currentPeriodStart: start ? new Date(start * 1000) : null,
            currentPeriodEnd: end ? new Date(end * 1000) : null,
            nextBillingAt:
              !locked.cancelAtCycleEnd &&
              !["cancelled", "completed", "expired"].includes(remote.status) &&
              remote.charge_at
                ? new Date(remote.charge_at * 1000)
                : null,
            paidUntil:
              paidUntil ?? (currentPaymentRefunded ? null : locked.paidUntil),
            cancelledAt:
              remote.status === "cancelled"
                ? (locked.cancelledAt ??
                  (remote.ended_at
                    ? new Date(remote.ended_at * 1000)
                    : this.clock()))
                : locked.cancelledAt,
            lastSyncedAt: this.clock(),
            syncLeaseOwner: null,
            syncLeaseUntil: null,
          },
        });
        if (committed.count !== 1) throw new ServiceError("BILLING_SYNC_PENDING", 503, "The reconciliation lease expired or changed. No financial updates were committed.");
        for (const { value, invoice } of payments) {
          const paymentOwner = await tx.billingPayment.findUnique({
            where: { providerPaymentId: value.id },
            select: { subscriptionId: true, paidAt: true, paidAtSource: true, captureVerifiedAt: true, amountRefundedMinor: true, status: true, amountMinor: true, updatedAt: true },
          });
          if (paymentOwner && paymentOwner.subscriptionId !== id)
            throw new ServiceError(
              "PAYMENT_MISMATCH",
              409,
              "A payment cannot be assigned to a different subscription.",
            );
          const captured = value.status === "captured";
          // Only a signed capture event timestamp represents capture time. An API
          // GET proves capture happened, but cannot tell us precisely when.
          const captureEvent = captured && event?.type === "payment.captured" && event.paymentId === value.id &&
            event.occurredAt && event.occurredAt.getTime() >= value.created_at * 1000 && event.occurredAt <= this.clock()
            ? event.occurredAt : null;
          const timestamp = !paymentOwner?.paidAt && captureEvent
            ? { paidAt: captureEvent, paidAtSource: "SIGNED_CAPTURE_EVENT" } : {};
          const verifiedAt = captured ? paymentOwner?.captureVerifiedAt ?? this.clock() : undefined;
          const refunded = Math.max(paymentOwner?.amountRefundedMinor ?? 0, value.amount_refunded);
          await tx.billingPayment.upsert({
            where: { providerPaymentId: value.id },
            create: {
              subscriptionId: id,
              providerPaymentId: value.id,
              providerInvoiceId: invoice,
              amountMinor: value.amount,
              currency: value.currency,
              status: value.status,
              paymentCreatedAt: new Date(value.created_at * 1000),
              captureVerifiedAt: verifiedAt,
              amountRefundedMinor: refunded,
              ...timestamp,
            },
            update: { status: value.status, amountMinor: value.amount, paymentCreatedAt: new Date(value.created_at * 1000), captureVerifiedAt: verifiedAt, amountRefundedMinor: refunded, ...timestamp,
              updatedAt: paymentOwner && paymentOwner.status === value.status && paymentOwner.amountMinor === value.amount && paymentOwner.amountRefundedMinor === refunded && !Object.keys(timestamp).length && (!captured || paymentOwner.captureVerifiedAt) ? paymentOwner.updatedAt : this.clock() },
          });
        }
        const operation = await tx.billingReplacement.findUnique({ where: { fromSubscriptionId: id } });
        if (operation && operation.state !== "ABORTED") {
          const context = trialRepurchase(operation.context);
          const hasBaseline = context && typeof context.financialDigest === "string" && typeof context.paidCount === "number";
          const money = hasBaseline ? remote.paid_count !== context.paidCount || await this.financialDigest(tx, id) !== context.financialDigest :
            remote.paid_count > 0 || !!remote.current_start || !!paidUntil ||
            payments.some(({ value }) => ["authorized", "captured", "refunded"].includes(value.status) || value.amount_refunded > 0) ||
            await tx.billingPayment.count({ where: { subscriptionId: id, OR: [{ status: { in: ["authorized", "captured", "refunded"] } }, { amountRefundedMinor: { gt: 0 } }] } }) > 0;
          if (money && operation.state !== "CHECKING") {
            await tx.billingReplacement.update({ where: { id: operation.id }, data: { state: "CONFLICT", reason: "PAYMENT_CANCEL_OVERLAP", updatedAt: this.clock() } });
          } else if (!money && (remote.status === "cancelled" || (hasBaseline && ["completed", "expired"].includes(remote.status))) && ["CANCELLING", "SETTLING"].includes(operation.state)) {
            await tx.billingReplacement.update({ where: { id: operation.id }, data: {
              state: operation.settleAfter && operation.settleAfter <= this.clock() ? "READY" : "SETTLING",
              settleAfter: operation.settleAfter ?? new Date(this.clock().getTime() + 60000),
              updatedAt: this.clock(),
            } });
          } else if (["CHECKING", "CANCELLING", "SETTLING"].includes(operation.state) && operation.updatedAt < new Date(this.clock().getTime() - 5 * 60000)) {
            await tx.billingReplacement.update({ where: { id: operation.id }, data: { state: "CONFLICT", reason: "INTERRUPTED_REPLACEMENT_REQUIRES_REVIEW", updatedAt: this.clock() } });
          }
        }
        if (event)
          await tx.billingEvent.create({
            data: {
              id: event.id,
              subscriptionId: id,
              bodyHash: event.digest,
              type: event.type,
            },
          });
      });
    } finally {
      await this.db.subscription.updateMany({
        where: { id, syncLeaseOwner: owner },
        data: { syncLeaseOwner: null, syncLeaseUntil: null },
      });
    }
  }
  async confirm(
    organizationId: string,
    data: {
      subscriptionId: string;
      razorpay_subscription_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
    },
  ) {
    const row = await this.own(organizationId, data.subscriptionId);
    if (
      !row.providerSubscriptionId ||
      row.providerSubscriptionId !== data.razorpay_subscription_id ||
      !this.provider.verifyCheckout(
        data.razorpay_payment_id,
        row.providerSubscriptionId,
        data.razorpay_signature,
      )
    )
      throw new ServiceError(
        "INVALID_PAYMENT_SIGNATURE",
        400,
        "Payment confirmation could not be verified.",
      );
    const payment = await this.provider.payment(data.razorpay_payment_id);
    const invoices = await this.provider.invoices(
      row.providerSubscriptionId,
      0,
    );
    if (
      !invoices.some(
        (invoice) =>
          invoice.subscription_id === row.providerSubscriptionId &&
          invoice.id === payment.invoice_id &&
          invoice.payment_id === payment.id,
      )
    )
      throw new ServiceError(
        "PAYMENT_MISMATCH",
        400,
        "This payment does not belong to the selected subscription.",
      );
    await this.reconcile(row.id);
  }
  async cancel(organizationId: string, id: string, atCycleEnd: boolean) {
    const replacing = await this.db.billingReplacement.findFirst({ where: { organizationId, state: { in: replacementBlockingStates } } });
    if (replacing) { if (replacing.state === "CONFLICT") throw replacementConflict(); throw replacementWait(); }
    const row = await this.own(organizationId, id);
    if (!row.providerSubscriptionId) {
      await this.reconcile(id);
      throw new ServiceError(
        "CHECKOUT_PENDING",
        409,
        "Refresh the subscription before cancelling.",
      );
    }
    if (
      ["CANCELLED", "COMPLETED", "EXPIRED"].includes(row.status) ||
      row.cancelAtCycleEnd
    )
      return { atCycleEnd: row.cancelAtCycleEnd };
    // An unstarted billing cycle cannot be cancelled at its end. Fetch fresh
    // provider dates rather than infer from a local trial or browser flag.
    const latest = await this.provider.fetchSubscription(
      row.providerSubscriptionId,
    );
    this.match(row, latest);
    const cycleEnd =
      atCycleEnd &&
      !!latest.current_start &&
      !!latest.current_end &&
      latest.current_end * 1000 > this.clock().getTime();
    const remote = await this.provider.cancel(
      row.providerSubscriptionId,
      cycleEnd,
    );
    this.match(row, remote);
    if (!cycleEnd && remote.status !== "cancelled")
      throw new ServiceError(
        "CANCELLATION_PENDING",
        503,
        "The provider has not confirmed immediate cancellation. Refresh provider status; no cancellation success is assumed.",
      );
    await this.db.subscription.update({
      where: { id },
      data: {
        cancelAtCycleEnd: cycleEnd && remote.status !== "cancelled",
        cancelledAt: remote.status === "cancelled" ? this.clock() : null,
      },
    });
    await this.reconcile(id);
    return { atCycleEnd: cycleEnd && remote.status !== "cancelled" };
  }
}

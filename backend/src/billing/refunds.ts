import { randomUUID, createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BillingService } from "./service";
import type { RemoteRefund } from "./provider";
import { historicalPlanName } from "./terms";
import { hashToken } from "../auth/security";
import { ServiceError, type Clock } from "../services/errors";

export const refundStatuses = ["PENDING", "APPROVED", "REJECTED", "PROCESSING", "PARTIALLY_REFUNDED", "REFUNDED", "FAILED"] as const;
const paymentInclude = { subscription: { include: { organization: { select: { id: true, name: true } }, plan: { select: { name: true } } } } } as const;
type Payment = Prisma.BillingPaymentGetPayload<{ include: typeof paymentInclude }>;
export function refundedAmount(payment: { amountMinor: number; amountRefundedMinor: number; status?: string }) { return payment.status === "refunded" ? payment.amountMinor : Math.min(payment.amountMinor, payment.amountRefundedMinor); }
export function remainingRefundable(payment: { amountMinor: number; amountRefundedMinor: number; status?: string }) { return Math.max(0, payment.amountMinor - refundedAmount(payment)); }
export function refundEligible(payment: { status: string; providerInvoiceId: string | null; paidAt: Date | null; captureVerifiedAt: Date | null; amountMinor: number; amountRefundedMinor: number }) {
  return payment.status === "captured" && !!payment.providerInvoiceId && !!(payment.paidAt || payment.captureVerifiedAt) && remainingRefundable(payment) > 0;
}
export class RefundService {
  constructor(private db: PrismaClient, private billing: BillingService, private clock: Clock) {}
  private async payment(id: string, organizationId?: string) {
    const row = await this.db.billingPayment.findFirst({ where: { id, ...(organizationId ? { subscription: { organizationId } } : {}) }, include: paymentInclude });
    if (!row) throw new ServiceError("PAYMENT_NOT_FOUND", 404, "Payment not found.");
    return row;
  }
  private async verifiedPayment(row: Payment) {
    const remote = await this.billing.provider.payment(row.providerPaymentId);
    if (!row.providerInvoiceId || remote.id !== row.providerPaymentId || remote.invoice_id !== row.providerInvoiceId || remote.amount !== row.amountMinor || remote.currency !== row.currency || !["captured", "refunded"].includes(remote.status) || remote.amount_refunded < 0 || remote.amount_refunded > remote.amount)
      throw new ServiceError("PAYMENT_NOT_REFUNDABLE", 409, "The original captured payment could not be verified.");
    const invoice = await this.billing.provider.invoice(row.providerInvoiceId);
    if (invoice.id !== row.providerInvoiceId || invoice.payment_id !== remote.id || invoice.subscription_id !== row.subscription.providerSubscriptionId)
      throw new ServiceError("PAYMENT_MISMATCH", 409, "The payment invoice could not be matched to this subscription.");
    return remote;
  }
  private async availableBalance(row: Payment, refunded: number) {
    if (!this.billing.provider.paymentRefunds) throw new ServiceError("REFUND_UNAVAILABLE", 503, "Refund verification is unavailable.");
    const refunds = await this.billing.provider.paymentRefunds(row.providerPaymentId);
    if (refunds.some(value => value.payment_id !== row.providerPaymentId || value.currency !== row.currency || !Number.isSafeInteger(value.amount) || value.amount <= 0)) throw new ServiceError("REFUND_MISMATCH", 409, "Provider refund history could not be verified.");
    const processed = refunds.filter(value => value.status === "processed").reduce((total, value) => total + value.amount, 0);
    const pending = refunds.filter(value => value.status === "pending").reduce((total, value) => total + value.amount, 0);
    return Math.max(0, row.amountMinor - Math.max(row.amountRefundedMinor, refunded, processed) - pending);
  }
  async submit(organizationId: string, userId: string, paymentId: string, reason: string, submissionKey: string) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM BillingPayment WHERE id = ${paymentId} FOR UPDATE`;
      const row = await tx.billingPayment.findFirst({ where: { id: paymentId, subscription: { organizationId } }, include: paymentInclude });
      if (!row) throw new ServiceError("PAYMENT_NOT_FOUND", 404, "Payment not found.");
      const replay = await tx.refundRequest.findUnique({ where: { submissionKey } });
      if (replay) { if (replay.organizationId !== organizationId || replay.paymentId !== paymentId || replay.reason !== reason || replay.requestedBy !== userId) throw new ServiceError("REQUEST_CONFLICT", 409, "This request reference was already used."); return { id: replay.id }; }
      if (!refundEligible(row) || !row.subscription.lastSyncedAt) throw new ServiceError("PAYMENT_NOT_REFUNDABLE", 409, "Only verified captured payments with a refundable balance are eligible.");
      if (await tx.refundRequest.count({ where: { activePaymentId: row.id } })) throw new ServiceError("REFUND_REQUEST_EXISTS", 409, "This payment already has a refund request awaiting a final result.");
      const request = await tx.refundRequest.create({ data: { organizationId, organizationName: row.subscription.organization.name, paymentId, activePaymentId: paymentId, requestedBy: userId, submissionKey, reason, requestedAmountMinor: remainingRefundable(row), createdAt: this.clock() } });
      await tx.refundAuditEvent.create({ data: { requestId: request.id, actorId: userId, action: "REQUESTED", amountMinor: request.requestedAmountMinor, detail: reason, createdAt: this.clock() } });
      return { id: request.id };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
  async list(organizationId?: string, page = 1, status?: string, q = "") {
    const where: Prisma.RefundRequestWhereInput = { ...(organizationId ? { organizationId, payment: { subscription: { organizationId } } } : {}), ...(status ? { status } : {}), ...(q ? { OR: [{ organizationName: { contains: q } }, { payment: { providerPaymentId: { contains: q } } }, { payment: { subscription: { organization: { name: { contains: q } } } } }] } : {}) };
    const [rows, total] = await this.db.$transaction([this.db.refundRequest.findMany({ where, include: { payment: { include: paymentInclude }, transaction: true, audit: { orderBy: { createdAt: "desc" }, take: 20 } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 20, take: 20 }), this.db.refundRequest.count({ where })]);
    return { items: rows.map(row => ({ id: row.id, organizationName: row.payment.subscription.organization.name, paymentId: row.paymentId, providerPaymentId: row.payment.providerPaymentId, planName: historicalPlanName(row.payment.subscription.commercialTerms, row.payment.subscription.plan.name), subscriptionStatus: row.payment.subscription.status, interval: row.payment.subscription.interval, paymentDate: row.payment.paidAt ?? row.payment.captureVerifiedAt ?? row.payment.paymentCreatedAt, amountMinor: row.payment.amountMinor, currency: row.payment.currency, refundedMinor: refundedAmount(row.payment), remainingMinor: remainingRefundable(row.payment), requestedAmountMinor: row.requestedAmountMinor, approvedAmountMinor: row.approvedAmountMinor, reason: row.reason, status: row.status, rejectionReason: row.rejectionReason, decidedAt: row.decidedAt, decisionName: row.decisionName, createdAt: row.createdAt, version: row.version, transaction: row.transaction ? { id: row.transaction.id, providerRefundId: row.transaction.providerRefundId, amountMinor: row.transaction.amountMinor, status: row.transaction.status, providerStatus: row.transaction.providerStatus, failureCode: row.transaction.failureCode, verifiedAt: row.transaction.verifiedAt, processedAt: row.transaction.processedAt } : null, audit: row.audit.map(event => ({ action: event.action, actorName: event.actorName, amountMinor: event.amountMinor, detail: event.detail, createdAt: event.createdAt })) })), total, page, pageSize: 20 };
  }
  async decide(id: string, actorId: string, token: string, input: { action: "APPROVE" | "REJECT"; requestId: string; expectedVersion: number; amountMinor?: number; reason?: string }) {
    const request = await this.db.refundRequest.findUnique({ where: { id } });
    if (!request) throw new ServiceError("REFUND_NOT_FOUND", 404, "Refund request not found.");
    // Provider reads occur before the decision transaction; the payment lock
    // below reserves the amount and Razorpay enforces its own remaining balance.
    const original = await this.payment(request.paymentId);
    const remote = input.action === "APPROVE" && request.status === "PENDING" ? await this.verifiedPayment(original) : null;
    const verifiedBalance = remote ? await this.availableBalance(original, remote.amount_refunded) : 0;
    const transactionId = await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM SuperAdmin WHERE id = ${actorId} FOR UPDATE`;
      const session = await tx.superAdminSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { superAdmin: true } });
      if (!session || session.superAdminId !== actorId || !session.superAdmin.isActive || session.authVersion !== session.superAdmin.authVersion || session.expiresAt <= this.clock()) throw new ServiceError("SESSION_EXPIRED", 401, "Your platform session ended. Sign in again.");
      await tx.$queryRaw`SELECT id FROM BillingPayment WHERE id = ${request.paymentId} FOR UPDATE`;
      const row = await tx.refundRequest.findUniqueOrThrow({ where: { id }, include: { transaction: true } });
      if (row.decisionKey === input.requestId) {
        if (row.decisionBy !== actorId || (input.action === "APPROVE" ? row.approvedAmountMinor !== input.amountMinor : row.rejectionReason !== input.reason)) throw new ServiceError("REQUEST_CONFLICT", 409, "This decision reference was already used.");
        return row.transaction?.id ?? null;
      }
      if (row.status !== "PENDING" || row.version !== input.expectedVersion) throw new ServiceError("REFUND_CONFLICT", 409, "This request has already changed. Refresh before deciding.");
      const payment = await tx.billingPayment.findUniqueOrThrow({ where: { id: row.paymentId } });
      if (input.action === "REJECT") {
        if (!input.reason || input.reason.trim().length < 5) throw new ServiceError("REASON_REQUIRED", 400, "Explain the rejection in at least five characters.");
        await tx.refundRequest.update({ where: { id }, data: { status: "REJECTED", activePaymentId: null, rejectionReason: input.reason, decisionKey: input.requestId, decisionBy: actorId, decisionName: session.superAdmin.fullName, decidedAt: this.clock(), version: { increment: 1 } } });
      } else {
        const amount = input.amountMinor!;
        const remaining = Math.min(verifiedBalance, payment.amountMinor - Math.max(payment.amountRefundedMinor, remote!.amount_refunded));
        if (!refundEligible(payment) || remote!.status !== "captured" || !Number.isSafeInteger(amount) || amount <= 0 || amount > remaining || amount > row.requestedAmountMinor) throw new ServiceError("INVALID_REFUND_AMOUNT", 409, "The approved amount must be positive and within the current refundable balance and requested amount.");
        await tx.refundRequest.update({ where: { id }, data: { status: "APPROVED", approvedAmountMinor: amount, decisionKey: input.requestId, decisionBy: actorId, decisionName: session.superAdmin.fullName, decidedAt: this.clock(), version: { increment: 1 } } });
        const transaction = await tx.refundTransaction.create({ data: { requestId: id, paymentId: row.paymentId, receipt: `hrms_${randomUUID().replaceAll("-", "")}`, idempotencyKey: randomUUID(), amountMinor: amount, currency: payment.currency, createdAt: this.clock() } });
        await tx.refundAuditEvent.create({ data: { requestId: id, actorId, actorName: session.superAdmin.fullName, action: "APPROVED", amountMinor: amount, detail: "Approved after explicit confirmation; provider processing is separate.", createdAt: this.clock() } });
        return transaction.id;
      }
      await tx.refundAuditEvent.create({ data: { requestId: id, actorId, actorName: session.superAdmin.fullName, action: "REJECTED", detail: input.reason, createdAt: this.clock() } });
      return null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if (transactionId) await this.initiate(transactionId);
    return { success: true };
  }
  private async initiate(id: string) {
    const row = await this.db.refundTransaction.findUniqueOrThrow({ where: { id } });
    if (row.status !== "PREPARED") { await this.recoverOne(id); return; }
    const payment = await this.payment(row.paymentId);
    if (!this.billing.provider.available || !this.billing.provider.createRefund || !this.billing.provider.fetchRefund) throw new ServiceError("REFUND_UNAVAILABLE", 503, "Refund processing is unavailable. Check the provider configuration before continuing the saved approval.");
    const remote = await this.verifiedPayment(payment);
    if (row.amountMinor > await this.availableBalance(payment, remote.amount_refunded) || remote.status !== "captured") throw new ServiceError("INVALID_REFUND_AMOUNT", 409, "The payment balance changed. This approved refund needs review.");
    // Claim once before POST. Recovery of INITIATING/RECONCILING is GET-only.
    const claimed = await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM BillingPayment WHERE id = ${row.paymentId} FOR UPDATE`;
      const changed = await tx.refundTransaction.updateMany({ where: { id, status: "PREPARED", amountMinor: row.amountMinor, receipt: row.receipt, idempotencyKey: row.idempotencyKey, providerRefundId: null }, data: { status: "INITIATING", updatedAt: this.clock() } });
      if (changed.count) {
        await tx.refundRequest.updateMany({ where: { id: row.requestId!, status: "APPROVED" }, data: { status: "PROCESSING", version: { increment: 1 } } });
        await tx.refundAuditEvent.create({ data: { requestId: row.requestId!, action: "PROCESSING_STARTED", amountMinor: row.amountMinor, detail: "Durable once-only provider submission claimed before sending the refund.", createdAt: this.clock() } });
      }
      return changed.count;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if (!claimed) return;
    try {
      const response = await this.billing.provider.createRefund(payment.providerPaymentId, row.amountMinor, row.receipt, row.idempotencyKey);
      if (response.payment_id !== payment.providerPaymentId || response.amount !== row.amountMinor || response.currency !== row.currency || (response.receipt && response.receipt !== row.receipt)) throw new ServiceError("REFUND_MISMATCH", 409, "Refund evidence needs review.");
      await this.db.refundTransaction.updateMany({ where: { id, providerRefundId: null }, data: { providerRefundId: response.id } });
      await this.observe(await this.billing.provider.fetchRefund(response.id), payment.id);
    } catch (error) {
      const code = error instanceof ServiceError ? error.code : "REFUND_RESPONSE_UNCONFIRMED";
      if (["PROVIDER_AUTHENTICATION_FAILED", "PROVIDER_PERMISSION_DENIED", "PROVIDER_NOT_FOUND"].includes(code)) {
        await this.db.$transaction(async tx => {
          await tx.$queryRaw`SELECT id FROM BillingPayment WHERE id = ${row.paymentId} FOR UPDATE`;
          const changed = await tx.refundTransaction.updateMany({ where: { id, status: "INITIATING", providerRefundId: null }, data: { status: "FAILED", failureCode: code, updatedAt: this.clock() } });
          if (changed.count) {
            await tx.refundRequest.update({ where: { id: row.requestId! }, data: { status: "FAILED", activePaymentId: null, version: { increment: 1 } } });
            await tx.refundAuditEvent.create({ data: { requestId: row.requestId!, action: "FAILED", detail: code, createdAt: this.clock() } });
          }
        });
        return;
      }
      // Even a duplicate-receipt rejection may refer to an existing refund.
      // No uncertain result is released or automatically submitted again.
      const uncertain = await this.db.refundTransaction.updateMany({ where: { id, status: { in: ["INITIATING", "RECONCILING"] } }, data: { status: "RECONCILING", failureCode: code, updatedAt: this.clock() } });
      if (uncertain.count) await this.db.refundAuditEvent.create({ data: { requestId: row.requestId!, action: "RECONCILIATION_REQUIRED", detail: code, createdAt: this.clock() } });
    }
  }
  async processApproved(id: string, actorId: string, token: string, amountMinor: number) {
    const transactionId = await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM SuperAdmin WHERE id = ${actorId} FOR UPDATE`;
      const session = await tx.superAdminSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { superAdmin: true } });
      if (!session || session.superAdminId !== actorId || !session.superAdmin.isActive || session.authVersion !== session.superAdmin.authVersion || session.expiresAt <= this.clock()) throw new ServiceError("SESSION_EXPIRED", 401, "Your platform session ended. Sign in again.");
      const request = await tx.refundRequest.findUnique({ where: { id }, include: { transaction: true } });
      if (!request?.transaction || request.approvedAmountMinor !== amountMinor) throw new ServiceError("REFUND_CONFLICT", 409, "Review the saved approval before continuing.");
      await tx.refundAuditEvent.create({ data: { requestId: id, actorId, actorName: session.superAdmin.fullName, action: "PROCESSING_CHECKED", amountMinor, detail: "Continued the existing approved operation; uncertain operations remain GET-only.", createdAt: this.clock() } });
      return request.transaction.id;
    });
    await this.initiate(transactionId); return { success: true };
  }
  async changePrepared(id: string, actorId: string, token: string, input: { action: "AMEND" | "VOID"; requestId: string; expectedVersion: number; reason: string; amountMinor?: number }) {
    const initial = await this.db.refundRequest.findUnique({ where: { id }, include: { transaction: true } });
    if (!initial?.transaction) throw new ServiceError("REFUND_NOT_FOUND", 404, "Approved refund not found.");
    const original = await this.payment(initial.paymentId);
    const remote = input.action === "AMEND" ? await this.verifiedPayment(original) : null;
    const balance = remote ? await this.availableBalance(original, remote.amount_refunded) : 0;
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM SuperAdmin WHERE id = ${actorId} FOR UPDATE`;
      const session = await tx.superAdminSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { superAdmin: true } });
      if (!session || session.superAdminId !== actorId || !session.superAdmin.isActive || session.authVersion !== session.superAdmin.authVersion || session.expiresAt <= this.clock()) throw new ServiceError("SESSION_EXPIRED", 401, "Your platform session ended. Sign in again.");
      await tx.$queryRaw`SELECT id FROM BillingPayment WHERE id = ${initial.paymentId} FOR UPDATE`;
      const row = await tx.refundRequest.findUniqueOrThrow({ where: { id }, include: { transaction: true } });
      if (row.decisionKey === input.requestId) {
        if (row.decisionBy !== actorId || (input.action === "AMEND" ? row.approvedAmountMinor !== input.amountMinor || row.status !== "APPROVED" : row.status !== "REJECTED" || row.rejectionReason !== input.reason)) throw new ServiceError("REQUEST_CONFLICT", 409, "This recovery reference was already used.");
        return;
      }
      const operation = row.transaction;
      if (row.status !== "APPROVED" || row.version !== input.expectedVersion || operation?.status !== "PREPARED" || operation.providerRefundId || operation.providerStatus) throw new ServiceError("REFUND_CONFLICT", 409, "Only a definitely unsubmitted prepared approval can be changed. Refresh its status.");
      if (input.reason.trim().length < 5 || input.reason.length > 500) throw new ServiceError("REASON_REQUIRED", 400, "Explain the approval change using 5–500 characters.");
      if (input.action === "AMEND") {
        const payment = await tx.billingPayment.findUniqueOrThrow({ where: { id: row.paymentId } });
        const amount = input.amountMinor!;
        const remaining = Math.min(balance, remainingRefundable(payment), payment.amountMinor - remote!.amount_refunded);
        if (!refundEligible(payment) || remote!.status !== "captured" || !Number.isSafeInteger(amount) || amount <= 0 || amount > remaining || amount > row.requestedAmountMinor) throw new ServiceError("INVALID_REFUND_AMOUNT", 409, "Choose a positive amount within the freshly verified remaining balance.");
        // A new reference also fences an initiator holding the previous approval snapshot.
        await tx.refundTransaction.update({ where: { id: operation.id }, data: { amountMinor: amount, receipt: `hrms_${randomUUID().replaceAll("-", "")}`, idempotencyKey: randomUUID() } });
        await tx.refundRequest.update({ where: { id }, data: { approvedAmountMinor: amount, decisionKey: input.requestId, decisionBy: actorId, decisionName: session.superAdmin.fullName, decidedAt: this.clock(), version: { increment: 1 } } });
      } else {
        await tx.refundTransaction.update({ where: { id: operation.id }, data: { status: "VOIDED" } });
        await tx.refundRequest.update({ where: { id }, data: { status: "REJECTED", activePaymentId: null, rejectionReason: input.reason, decisionKey: input.requestId, decisionBy: actorId, decisionName: session.superAdmin.fullName, decidedAt: this.clock(), version: { increment: 1 } } });
      }
      await tx.refundAuditEvent.create({ data: { requestId: id, actorId, actorName: session.superAdmin.fullName, action: input.action === "AMEND" ? "APPROVAL_AMENDED" : "APPROVAL_VOIDED", amountMinor: input.action === "AMEND" ? input.amountMinor : operation.amountMinor, detail: `${input.reason} Previous approved amount: ${operation.amountMinor} ${operation.currency} minor units. Previous receipt: ${operation.receipt}. Recovery reference: ${input.requestId}. No provider submission was made.`, createdAt: this.clock() } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return { success: true };
  }
  async observe(remote: RemoteRefund, paymentId: string) {
    const payment = await this.payment(paymentId), verified = await this.verifiedPayment(payment);
    if (remote.payment_id !== payment.providerPaymentId || remote.currency !== payment.currency || !Number.isSafeInteger(remote.amount) || remote.amount <= 0 || remote.amount > payment.amountMinor) throw new ServiceError("REFUND_MISMATCH", 409, "Refund does not match the original payment.");
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM BillingPayment WHERE id = ${paymentId} FOR UPDATE`;
      const current = await tx.billingPayment.findUniqueOrThrow({ where: { id: paymentId } });
      const existing = await tx.refundTransaction.findUnique({ where: { providerRefundId: remote.id } });
      const candidate = remote.receipt ? await tx.refundTransaction.findUnique({ where: { receipt: remote.receipt } }) : null;
      const local = existing ?? candidate;
      if (local && (local.paymentId !== paymentId || local.amountMinor !== remote.amount || local.currency !== remote.currency || (local.providerRefundId && local.providerRefundId !== remote.id))) throw new ServiceError("REFUND_MISMATCH", 409, "Refund reference is associated with different financial evidence.");
      // Provider completion is irreversible even while its payment aggregate lags.
      const providerStatus = local?.providerStatus === "processed" ? "processed" : remote.status;
      if ((local?.status === "PROCESSED" && providerStatus !== "processed") || (local?.status === "FAILED" && providerStatus === "pending")) return;
      const total = Math.max(refundedAmount(current), verified.amount_refunded);
      const otherProcessed = await tx.refundTransaction.aggregate({ where: { paymentId, status: "PROCESSED", ...(local ? { id: { not: local.id } } : {}) }, _sum: { amountMinor: true } });
      const processed = providerStatus === "processed" && total >= (otherProcessed._sum.amountMinor ?? 0) + remote.amount;
      const status = processed ? "PROCESSED" : providerStatus === "failed" ? "FAILED" : "PROCESSING";
      const data = { providerRefundId: remote.id, providerStatus, status, providerCreatedAt: new Date(remote.created_at * 1000), verifiedAt: local?.status === status && local.providerStatus === providerStatus ? local.verifiedAt : this.clock(), processedAt: processed ? local?.processedAt ?? this.clock() : local?.processedAt ?? null, failureCode: null, ...(local?.status === status && local.providerStatus === providerStatus ? { updatedAt: local.updatedAt } : {}) };
      const externalReference = `ext_${createHash("sha256").update(remote.id).digest("hex").slice(0, 32)}`;
      const result = local ? await tx.refundTransaction.update({ where: { id: local.id }, data }) : await tx.refundTransaction.create({ data: { ...data, paymentId, amountMinor: remote.amount, currency: remote.currency, receipt: externalReference, idempotencyKey: externalReference } });
      if (total !== current.amountRefundedMinor || (total >= current.amountMinor && current.status !== "refunded")) await tx.billingPayment.update({ where: { id: paymentId }, data: { amountRefundedMinor: total, ...(total >= current.amountMinor ? { status: "refunded" } : {}) } });
      if (result.requestId) {
        const request = await tx.refundRequest.findUniqueOrThrow({ where: { id: result.requestId } });
        const requestStatus = processed ? result.amountMinor < request.requestedAmountMinor ? "PARTIALLY_REFUNDED" : "REFUNDED" : status === "FAILED" ? "FAILED" : "PROCESSING";
        if (request.status !== requestStatus) {
          await tx.refundRequest.update({ where: { id: result.requestId }, data: { status: requestStatus, ...(["REFUNDED", "PARTIALLY_REFUNDED", "FAILED"].includes(requestStatus) ? { activePaymentId: null } : {}), version: { increment: 1 } } });
          await tx.refundAuditEvent.create({ data: { requestId: result.requestId, action: requestStatus, amountMinor: result.amountMinor, detail: "Status verified with provider refund and payment APIs. Bank credit timing depends on the original payment method.", createdAt: this.clock() } });
        }
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    await this.billing.reconcile(payment.subscriptionId);
  }
  async recoverOne(id: string) {
    const row = await this.db.refundTransaction.findUniqueOrThrow({ where: { id } });
    if (row.status === "PREPARED" || row.status === "PROCESSED" || !this.billing.provider.fetchRefund || !this.billing.provider.paymentRefunds) return;
    const payment = await this.payment(row.paymentId);
    const remote = row.providerRefundId ? await this.billing.provider.fetchRefund(row.providerRefundId) : (await this.billing.provider.paymentRefunds(payment.providerPaymentId)).find(value => value.receipt === row.receipt);
    if (remote) await this.observe(remote, payment.id);
    else await this.db.refundTransaction.updateMany({ where: { id, status: { in: ["INITIATING", "RECONCILING", "PROCESSING"] } }, data: { updatedAt: this.clock(), failureCode: "REFUND_NOT_YET_FOUND" } });
    // Not found is uncertain: keep the reservation, never POST a second refund.
  }
  async syncPayment(paymentId: string, refundId?: string) {
    if (!this.billing.provider.fetchRefund || !this.billing.provider.paymentRefunds) return;
    const payment = await this.payment(paymentId);
    const rows = refundId ? [await this.billing.provider.fetchRefund(refundId)] : await this.billing.provider.paymentRefunds(payment.providerPaymentId);
    for (const row of rows) await this.observe(row, paymentId);
  }
  async refresh(id: string, organizationId?: string) {
    const request = await this.db.refundRequest.findFirst({ where: { id, ...(organizationId ? { organizationId, payment: { subscription: { organizationId } } } : {}) }, include: { transaction: true } });
    if (!request) throw new ServiceError("REFUND_NOT_FOUND", 404, "Refund request not found.");
    if (request.transaction) await this.recoverOne(request.transaction.id);
    return { success: true };
  }
  async recoverPending(stopped = () => false, onError: (error: unknown) => Promise<void> = async () => {}, mayInspect: () => Promise<boolean> = async () => true) {
    const rows = await this.db.refundTransaction.findMany({ where: { status: { in: ["INITIATING", "RECONCILING", "PROCESSING"] } }, orderBy: { updatedAt: "asc" }, take: 25 });
    let failed = 0, checked = 0;
    for (const row of rows) { if (stopped() || !await mayInspect()) break; checked++; try { await this.recoverOne(row.id); } catch (error) { failed++; await onError(error); await this.db.refundTransaction.updateMany({ where: { id: row.id, status: { in: ["INITIATING", "RECONCILING", "PROCESSING"] } }, data: { updatedAt: this.clock() } }).catch(() => {}); } }
    return { checked, failed };
  }
}

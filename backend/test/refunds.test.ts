import "dotenv/config";
import assert from "node:assert/strict";
import { before, beforeEach, afterEach, after, it } from "node:test";
import { randomUUID, createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { Server } from "node:http";
import { createApp } from "../src/server";
import { newSession } from "../src/auth/security";
import { RefundService } from "../src/billing/refunds";
import { BillingService } from "../src/billing/service";
import { AccessPolicy } from "../src/billing/access";
import { ServiceError } from "../src/services/errors";
import { validSignature, type PaymentProvider, type RemoteRefund, type RemoteSubscription, type RemotePayment } from "../src/billing/provider";
import { discoverExternalRefunds, reconcileDue, refundInspectionIntervalMs, refundScanId, refundScanLeaseMs, refundRetryDelay } from "../src/billing/reconciler";
if (!/^\/hrms_billing_audit_[a-f0-9]{12}$/.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error("Refund tests require the isolated local fixture database.");
const db = new PrismaClient(), planId = `refund-${randomUUID()}`, now = new Date("2026-11-02T10:00:00Z"), origin = "http://localhost:3000";
let provider: Provider, service: RefundService, billing: BillingService, server: Server, base: string, org: string, other: string, actor: string, second: string, token: string, secondToken: string, cookie: string, employeeCookie: string, otherCookie: string, paymentId: string, subId: string;
class Provider implements PaymentProvider {
  available = true; keyId = "rzp_test_fixture"; mode = "test" as const; creates = 0; cancels = 0; behavior = "processed"; rows = new Map<string, RemoteRefund>();
  subscription!: RemoteSubscription; paymentRow!: RemotePayment;
  refundListReads: string[] = [];
  onInvoice?: () => Promise<void>;
  onRefund?: (row: RemoteRefund) => Promise<void>;
  async fetchPlan(id: string) { return { id, period: "monthly" as const, interval: 1, item: { amount: 10000, currency: "INR" } }; }
  async createSubscription(): Promise<RemoteSubscription> { throw Error("Not used"); }
  async fetchSubscription() { return structuredClone(this.subscription); }
  async findSubscription() { return structuredClone(this.subscription); }
  async invoices() { return [{ id: this.paymentRow.invoice_id!, subscription_id: this.subscription.id, payment_id: this.paymentRow.id, status: "paid", amount_paid: 10000, currency: "INR", created_at: this.paymentRow.created_at, billing_start: this.subscription.current_start, billing_end: this.subscription.current_end }]; }
  async invoice() { await this.onInvoice?.(); return (await this.invoices())[0]!; }
  async payment() { return structuredClone(this.paymentRow); }
  async cancel() { this.cancels++; this.subscription.status = "cancelled"; return structuredClone(this.subscription); }
  verifyCheckout() { return true; }
  verifyWebhook(body: Buffer, signature: string) { return validSignature(body, signature, "refund-webhook"); }
  async createRefund(payment: string, amount: number, receipt: string, _key: string) {
    this.creates++;
    if (this.behavior === "denied") throw new ServiceError("PROVIDER_PERMISSION_DENIED", 503, "Fixture access denied");
    if (this.behavior === "network-before") throw new ServiceError("PROVIDER_NETWORK_ERROR", 503, "Fixture network outage");
    const row: RemoteRefund = { id: `rfnd_${randomUUID().replaceAll("-", "")}`, payment_id: payment, amount, currency: "INR", receipt, status: this.behavior === "failed" ? "failed" : this.behavior === "pending" ? "pending" : "processed", created_at: Math.floor(now.getTime() / 1000) };
    this.rows.set(row.id, row);
    if (row.status === "processed") { this.paymentRow.amount_refunded += amount; if (this.paymentRow.amount_refunded >= this.paymentRow.amount) this.paymentRow.status = "refunded"; }
    await this.onRefund?.(row);
    if (this.behavior === "lost-response") throw new ServiceError("PROVIDER_TIMEOUT", 503, "Fixture response lost after refund");
    return structuredClone(row);
  }
  async fetchRefund(id: string) { return structuredClone(this.rows.get(id)!); }
  async paymentRefunds(paymentId = this.paymentRow.id) { this.refundListReads.push(paymentId); return [...this.rows.values()].filter(row => row.payment_id === paymentId).map(row => structuredClone(row)); }
}
async function account(label: string, role: "ORGANIZATION_ADMIN" | "EMPLOYEE" = "ORGANIZATION_ADMIN") {
  const session = newSession();
  const row = await db.organization.create({ data: { name: label, users: { create: { fullName: label, email: `${randomUUID()}@example.test`, role, passwordHash: "unused", sessions: { create: { tokenHash: session.tokenHash, expiresAt: new Date("2030-01-01") } } } } } });
  return { id: row.id, cookie: `hrms_session=${session.token}` };
}
async function admin() { const session = newSession(); const row = await db.superAdmin.create({ data: { fullName: "Refund reviewer", email: `${randomUUID()}@example.test`, passwordHash: "unused", sessions: { create: { tokenHash: session.tokenHash, expiresAt: new Date("2030-01-01") } } } }); return { id: row.id, token: session.token }; }
async function request(path: string, data?: unknown, auth = cookie, trusted = true) { const response = await fetch(base + path, { method: data === undefined ? "GET" : "POST", headers: { Cookie: auth, "Content-Type": "application/json", ...(trusted ? { Origin: origin, "X-HRMS-Request": "1" } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, data: await response.json() }; }
const submit = () => request("/api/billing/refunds", { paymentId, reason: "Please review this captured payment", requestId: randomUUID() });
const approve = (id: string, amountMinor = 10000, key = randomUUID(), auth = `hrms_platform_session=${token}`) => request(`/api/super-admin/refunds/${id}/decision`, { action: "APPROVE", amountMinor, confirmed: true, expectedVersion: 0, requestId: key }, auth);
async function state(id: string) { return db.refundRequest.findUniqueOrThrow({ where: { id }, include: { transaction: true } }); }
before(async () => { await db.billingPlan.create({ data: { id: planId, name: "Refund fixture", interval: "MONTHLY", amountMinor: 10000, currency: "INR", providerPlanId: `plan_${randomUUID().replaceAll("-", "")}` } }); });
beforeEach(async () => {
  await db.refundDiscoveryRetry.deleteMany();
  await db.refundDiscoveryScan.deleteMany();
  const a = await account("Refund fixture organization"), b = await account("Other refund fixture"); org = a.id; cookie = a.cookie; other = b.id; otherCookie = b.cookie;
  const employee = await db.user.create({ data: { organizationId: org, fullName: "Employee", email: `${randomUUID()}@example.test`, role: "EMPLOYEE", passwordHash: "unused" } }); const emp = newSession(); await db.session.create({ data: { userId: employee.id, tokenHash: emp.tokenHash, expiresAt: new Date("2030-01-01") } }); employeeCookie = `hrms_session=${emp.token}`;
  const x = await admin(), y = await admin(); actor = x.id; token = x.token; second = y.id; secondToken = y.token;
  provider = new Provider(); const start = Math.floor(now.getTime() / 1000) - 100;
  const subscription = await db.subscription.create({ data: { organizationId: org, planId, providerPlanId: (await db.billingPlan.findUniqueOrThrow({ where: { id: planId } })).providerPlanId!, providerSubscriptionId: `sub_${randomUUID().replaceAll("-", "")}`, status: "ACTIVE", amountMinor: 10000, currency: "INR", interval: "MONTHLY", totalCount: 12, paidUntil: new Date(now.getTime() + 30 * 86400000), currentPeriodStart: new Date(start * 1000), currentPeriodEnd: new Date(now.getTime() + 30 * 86400000), lastSyncedAt: now } }); subId = subscription.id;
  const payment = await db.billingPayment.create({ data: { subscriptionId: subId, providerPaymentId: `pay_${randomUUID().replaceAll("-", "")}`, providerInvoiceId: `inv_${randomUUID().replaceAll("-", "")}`, status: "captured", amountMinor: 10000, currency: "INR", paidAt: now, captureVerifiedAt: now } }); paymentId = payment.id;
  provider.subscription = { id: subscription.providerSubscriptionId!, plan_id: subscription.providerPlanId, status: "active", current_start: start, current_end: Math.floor(subscription.paidUntil!.getTime() / 1000), paid_count: 1, notes: { localSubscriptionId: subId, organizationId: org } };
  provider.paymentRow = { id: payment.providerPaymentId, invoice_id: payment.providerInvoiceId, status: "captured", amount: 10000, amount_refunded: 0, currency: "INR", created_at: start };
  billing = new BillingService(db, provider, () => now); service = new RefundService(db, billing, () => now);
  server = createApp(db, { frontendOrigin: origin, production: false }, { provider, clock: () => now }).listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); const ids = (await db.refundRequest.findMany({ where: { organizationId: org }, select: { id: true } })).map(row => row.id); await db.refundAuditEvent.deleteMany({ where: { requestId: { in: ids } } }); await db.refundTransaction.deleteMany({ where: { payment: { subscription: { organizationId: org } } } }); await db.refundRequest.deleteMany({ where: { organizationId: org } }); await db.organization.deleteMany({ where: { id: { in: [org, other] } } }); await db.superAdmin.deleteMany({ where: { id: { in: [actor, second] } } }); });
after(async () => { await db.billingPlan.delete({ where: { id: planId } }); await db.$disconnect(); });

it("submits an idempotent full-balance request and rejects duplicates and tenant tampering", async () => {
  const body = { paymentId, reason: "Review the original payment", requestId: randomUUID() };
  const first = await request("/api/billing/refunds", body); assert.equal(first.status, 201);
  assert.equal((await request("/api/billing/refunds", body)).data.id, first.data.id);
  assert.equal((await submit()).status, 409); assert.equal(provider.creates, 0);
  assert.equal((await request("/api/billing/refunds", { ...body, organizationId: other })).status, 400);
  assert.equal((await request("/api/billing/refunds", { ...body, requestId: randomUUID() }, otherCookie)).status, 404);
  assert.equal((await request("/api/billing/refunds", undefined, otherCookie)).data.total, 0);
  assert.equal((await request(`/api/billing/refunds/${first.data.id}/refresh`, {}, otherCookie)).status, 404);
});
it("enforces organization roles, dedicated platform sessions, CSRF and explicit approval confirmation", async () => {
  assert.equal((await request("/api/billing/refunds", undefined, "")).status, 401);
  assert.equal((await request("/api/billing/refunds", undefined, employeeCookie)).status, 403);
  assert.equal((await request("/api/billing/refunds", { paymentId, reason: "Review payment", requestId: randomUUID() }, cookie, false)).status, 403);
  const id = (await submit()).data.id;
  assert.equal((await approve(id, 10000, randomUUID(), cookie)).status, 401);
  assert.equal((await approve(id, 10000, randomUUID(), "")).status, 401);
  assert.equal((await request(`/api/super-admin/refunds/${id}/decision`, { action: "APPROVE", expectedVersion: 0, requestId: randomUUID(), amountMinor: 10000 }, `hrms_platform_session=${token}`)).status, 400);
  await db.superAdmin.update({ where: { id: actor }, data: { isActive: false } }); assert.equal((await approve(id)).status, 401); assert.equal(provider.creates, 0);
});
it("rejects uncaptured, unverified and fully refunded payments", async () => {
  for (const status of ["authorized", "failed", "created", "refunded"]) { await db.billingPayment.update({ where: { id: paymentId }, data: { status } }); assert.equal((await submit()).status, 409); }
  await db.billingPayment.update({ where: { id: paymentId }, data: { status: "captured", paidAt: null, captureVerifiedAt: null } }); assert.equal((await submit()).status, 409);
});
it("reports legacy fully refunded payments with zero refundable balance without backfilling old rows", async () => {
  await db.billingPayment.update({ where: { id: paymentId }, data: { status: "refunded", amountRefundedMinor: 0 } });
  const history = (await request("/api/billing/history")).data.payments[0];
  assert.equal(history.amountRefundedMinor, 10000); assert.equal(history.remainingRefundableMinor, 0); assert.equal(history.refundEligible, false);
  assert.equal((await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } })).amountRefundedMinor, 0);
});
it("keeps older captured payments available through bounded, tenant-scoped history pagination", async () => {
  await db.billingPayment.createMany({ data: Array.from({ length: 51 }, () => ({ subscriptionId: subId, providerPaymentId: `pay_${randomUUID().replaceAll("-", "")}`, providerInvoiceId: `inv_${randomUUID().replaceAll("-", "")}`, amountMinor: 10000, currency: "INR", status: "captured", paidAt: now })) });
  const first = (await request("/api/billing/history")).data, second = (await request("/api/billing/history?page=2")).data;
  assert.equal(first.payments.length, 50); assert.equal(first.hasMore, true); assert.equal(second.payments.length, 2); assert.equal(second.hasMore, false);
  assert.equal(first.payments.some((row: { id: string }) => second.payments.some((next: { id: string }) => next.id === row.id)), false);
  assert.equal((await request("/api/billing/history?page=2", undefined, otherCookie)).data.payments.length, 0);
});
it("requires a rejection reason and preserves the decision and organization notification", async () => {
  const id = (await submit()).data.id, auth = `hrms_platform_session=${token}`;
  assert.equal((await request(`/api/super-admin/refunds/${id}/decision`, { action: "REJECT", reason: "", requestId: randomUUID(), expectedVersion: 0 }, auth)).status, 400);
  assert.equal((await request(`/api/super-admin/refunds/${id}/decision`, { action: "REJECT", reason: "Service was supplied as agreed", requestId: randomUUID(), expectedVersion: 0 }, auth)).status, 200);
  const listed = (await request("/api/billing/refunds")).data.items[0]; assert.equal(listed.status, "REJECTED"); assert.equal(listed.rejectionReason, "Service was supplied as agreed"); assert.equal(provider.creates, 0);
});
it("rechecks platform authorization after provider preflight reads", async () => {
  const id = (await submit()).data.id;
  provider.onInvoice = async () => { await db.superAdmin.update({ where: { id: actor }, data: { isActive: false } }); };
  assert.equal((await approve(id)).status, 401); assert.equal(provider.creates, 0); assert.equal((await state(id)).status, "PENDING");
});
it("resumes a committed approval after a pre-POST outage without creating a different operation", async () => {
  const id = (await submit()).data.id; let reads = 0;
  provider.onInvoice = async () => { if (++reads === 2) throw new ServiceError("PROVIDER_NETWORK_ERROR", 503, "Fixture pre-POST outage"); };
  assert.equal((await approve(id)).status, 503); assert.equal((await state(id)).transaction!.status, "PREPARED"); assert.equal(provider.creates, 0);
  provider.onInvoice = undefined;
  const path = `/api/super-admin/refunds/${id}/process`, payload = { amountMinor: 10000, confirmed: true }, auth = `hrms_platform_session=${secondToken}`;
  assert.equal((await request(path, payload, auth)).status, 200); assert.equal((await request(path, payload, auth)).status, 200); assert.equal(provider.creates, 1);
});
it("fully refunds with provider proof, preserves history, revokes paid access and never cancels renewal", async () => {
  const original = await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } }), id = (await submit()).data.id, key = randomUUID();
  assert.equal((await approve(id, 10000, key)).status, 200); assert.equal((await state(id)).status, "REFUNDED");
  assert.equal((await approve(id, 10000, key)).status, 200); assert.equal(provider.creates, 1); assert.equal(provider.cancels, 0);
  const payment = await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } }); assert.equal(payment.amountMinor, original.amountMinor); assert.equal(payment.paidAt!.getTime(), original.paidAt!.getTime()); assert.equal(payment.amountRefundedMinor, 10000);
  assert.equal((await new AccessPolicy(db, () => now).status(org)).allowed, false);
  await db.organization.update({ where: { id: org }, data: { trialStartedAt: now, trialExpiresAt: new Date(now.getTime() + 86400000) } }); assert.equal((await new AccessPolicy(db, () => now).status(org)).source, "TRIAL");
  await db.organization.update({ where: { id: org }, data: { accessMode: "MANUAL", manualAccessStartsAt: now, manualAccessExpiresAt: new Date(now.getTime() + 86400000) } }); assert.equal((await new AccessPolicy(db, () => now).status(org)).source, "MANUAL");
});
it("supports multiple reviewed partial refunds without shortening access or exceeding the captured amount", async () => {
  const id = (await submit()).data.id; assert.equal((await approve(id, 4000)).status, 200); assert.equal((await state(id)).status, "PARTIALLY_REFUNDED");
  assert.equal((await new AccessPolicy(db, () => now).status(org)).allowed, true);
  const next = (await submit()).data.id; assert.equal((await state(next)).requestedAmountMinor, 6000);
  assert.equal((await approve(next, 6001)).status, 409); assert.equal((await approve(next, 0)).status, 400);
  assert.equal((await approve(next, 6000)).status, 200); assert.equal(provider.creates, 2); assert.equal((await state(next)).status, "REFUNDED"); assert.equal((await submit()).status, 409);
});
it("serializes two reviewers and double clicks into one provider refund", async () => {
  const id = (await submit()).data.id, key = randomUUID();
  const results = await Promise.all([approve(id, 10000, key), approve(id, 10000, randomUUID(), `hrms_platform_session=${secondToken}`)]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]); assert.equal(provider.creates, 1);
});
it("replays simultaneous identical approvals without a second provider POST", async () => {
  const id = (await submit()).data.id, key = randomUUID();
  const results = await Promise.all([approve(id, 10000, key), approve(id, 10000, key)]);
  assert.deepEqual(results.map(value => value.status), [200, 200]); assert.equal(provider.creates, 1);
});
it("does not issue or approve a refund if its financial audit cannot be committed", async () => {
  const id = (await submit()).data.id;
  const guarded = db.$extends({ query: { refundAuditEvent: { async create() { throw Error("Fixture audit unavailable"); } } } });
  const refunds = new RefundService(guarded as unknown as PrismaClient, billing, () => now);
  await assert.rejects(refunds.decide(id, actor, token, { action: "APPROVE", amountMinor: 10000, requestId: randomUUID(), expectedVersion: 0 }));
  assert.equal((await state(id)).status, "PENDING"); assert.equal((await state(id)).transaction, null); assert.equal(provider.creates, 0);
});
it("recovers a lost refund response with GETs only and preserves verified success across stale evidence", async () => {
  provider.behavior = "lost-response"; const id = (await submit()).data.id; assert.equal((await approve(id)).status, 200);
  let row = await state(id); assert.equal(row.transaction!.status, "RECONCILING"); assert.equal(row.status, "PROCESSING");
  await service.refresh(id, org); row = await state(id); assert.equal(row.status, "REFUNDED"); assert.equal(provider.creates, 1);
  const remote = [...provider.rows.values()][0]!; await service.observe({ ...remote, status: "pending" }, paymentId); assert.equal((await state(id)).status, "REFUNDED");
});
it("keeps unconfirmed network failures reserved and never repeats the POST", async () => {
  provider.behavior = "network-before"; const id = (await submit()).data.id, key = randomUUID(); await approve(id, 10000, key);
  await approve(id, 10000, key); await service.recoverPending(); await service.refresh(id, org);
  assert.equal(provider.creates, 1); assert.equal((await state(id)).status, "PROCESSING"); assert.equal((await submit()).status, 409);
});
it("preserves webhook-verified completion when the initiating response subsequently times out", async () => {
  provider.behavior = "lost-response"; provider.onRefund = async row => service.observe(row, paymentId);
  const id = (await submit()).data.id; await approve(id);
  assert.equal((await state(id)).status, "REFUNDED"); assert.equal((await state(id)).transaction!.status, "PROCESSED");
  assert.equal(await db.refundAuditEvent.count({ where: { requestId: id, action: "RECONCILIATION_REQUIRED" } }), 0); assert.equal(provider.creates, 1);
});
it("reports provider-verified failure without claiming a refund completed", async () => {
  provider.behavior = "failed"; const id = (await submit()).data.id; await approve(id); assert.equal((await state(id)).status, "FAILED");
  assert.equal((await new AccessPolicy(db, () => now).status(org)).allowed, true); assert.equal((await submit()).status, 201);
});
it("accounts for externally pending refunds and rejects excess approval before issuing a refund", async () => {
  provider.behavior = "pending"; await provider.createRefund(provider.paymentRow.id, 9000, "external_pending", "external_key");
  const id = (await submit()).data.id; assert.equal((await approve(id, 10000)).status, 409); assert.equal(provider.creates, 1);
  provider.behavior = "processed"; assert.equal((await approve(id, 1000)).status, 200); assert.equal(provider.creates, 2);
});
it("releases a definitively denied provider initiation without retrying that operation", async () => {
  provider.behavior = "denied"; const id = (await submit()).data.id; await approve(id); assert.equal((await state(id)).status, "FAILED");
  await service.refresh(id, org); assert.equal(provider.creates, 1); assert.equal((await submit()).status, 201);
});
it("accepts delayed signed refund webhooks, deduplicates events and rejects forged or mismatched evidence", async () => {
  provider.behavior = "pending"; const id = (await submit()).data.id; await approve(id); const refund = [...provider.rows.values()][0]!;
  refund.status = "processed"; provider.paymentRow.amount_refunded = 10000; provider.paymentRow.status = "refunded";
  const eventId = `evt_${randomUUID()}`, body = JSON.stringify({ event: "refund.processed", payload: { refund: { entity: { id: refund.id, payment_id: provider.paymentRow.id } } } });
  const send = (signature: string) => fetch(`${base}/api/billing/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-razorpay-event-id": eventId, "x-razorpay-signature": signature }, body });
  assert.equal((await send("0".repeat(64))).status, 400);
  const signature = createHmac("sha256", "refund-webhook").update(body).digest("hex"); assert.equal((await send(signature)).status, 200); assert.equal((await send(signature)).status, 200);
  assert.equal((await state(id)).status, "REFUNDED"); assert.equal(await db.refundTransaction.count({ where: { paymentId } }), 1);
  await assert.rejects(service.observe({ ...refund, payment_id: "pay_another_organization" }, paymentId));
});
it("imports an external refund before a local request exists and preserves cancellation independence", async () => {
  const refund = await provider.createRefund(provider.paymentRow.id, 3000, "external_receipt", "external_key");
  await service.syncPayment(paymentId, refund.id); assert.equal(await db.refundRequest.count({ where: { organizationId: org } }), 0);
  assert.equal(await db.refundTransaction.count({ where: { paymentId } }), 1); assert.equal((await submit()).status, 201); assert.equal(provider.cancels, 0);
  const creates = provider.creates; await billing.cancel(org, subId, false); assert.equal(provider.creates, creates); assert.equal(provider.cancels, 1);
});
it("durably imports a signed refund event before the local payment or refund record exists", async () => {
  await db.billingPayment.delete({ where: { id: paymentId } });
  const refund = await provider.createRefund(provider.paymentRow.id, 3000, "external_early_receipt", "external_key");
  const body = JSON.stringify({ event: "refund.processed", payload: { refund: { entity: { id: refund.id, payment_id: provider.paymentRow.id } } } });
  const response = await fetch(`${base}/api/billing/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-razorpay-event-id": `evt_${randomUUID()}`, "x-razorpay-signature": createHmac("sha256", "refund-webhook").update(body).digest("hex") }, body });
  assert.equal(response.status, 200);
  const payment = await db.billingPayment.findUniqueOrThrow({ where: { providerPaymentId: provider.paymentRow.id } });
  assert.equal(payment.amountRefundedMinor, 3000); assert.equal(await db.refundTransaction.count({ where: { paymentId: payment.id } }), 1);
});

it("cannot restore paid access when a full refund commits after a captured reconciliation snapshot", async () => {
  let injected = false;
  const guarded = db.$extends({ query: { billingPayment: { async findUnique({ args, query }) {
    const snapshot = await query(args);
    if (!injected && args.select?.status && args.select?.amountRefundedMinor) {
      injected = true;
      const refund = await provider.createRefund(provider.paymentRow.id, 10000, "audit_race_receipt", "audit_race_key");
      // Observation commits the financial evidence, then its reconcile loses the
      // lease to the already-running outer reconciliation.
      await assert.rejects(service.observe(refund, paymentId), (error: unknown) => error instanceof ServiceError && error.code === "BILLING_SYNC_PENDING");
    }
    return snapshot;
  } } } });
  await new BillingService(guarded as unknown as PrismaClient, provider, () => now).reconcile(subId);
  assert.equal(injected, true);
  const payment = await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } });
  assert.equal(payment.status, "refunded"); assert.equal(payment.amountRefundedMinor, 10000);
  assert.equal((await db.subscription.findUniqueOrThrow({ where: { id: subId } })).paidUntil, null);
  assert.equal((await new AccessPolicy(db, () => now).status(org)).allowed, false);
  // Defense in depth: even a legacy inconsistent captured/full-total row cannot
  // prove access. Separate trial and authorized grants still work.
  await db.billingPayment.update({ where: { id: paymentId }, data: { status: "captured" } });
  await db.subscription.update({ where: { id: subId }, data: { paidUntil: new Date(now.getTime() + 86400000) } });
  assert.equal((await new AccessPolicy(db, () => now).status(org)).allowed, false);
  await db.organization.update({ where: { id: org }, data: { trialStartedAt: new Date(now.getTime() - 1000), trialExpiresAt: new Date(now.getTime() + 86400000) } });
  assert.equal((await new AccessPolicy(db, () => now).status(org)).source, "TRIAL");
});

it("latches provider processed evidence during aggregate lag and keeps its reservation across stale failure", async () => {
  provider.behavior = "pending"; const id = (await submit()).data.id; await approve(id);
  const refund = [...provider.rows.values()][0]!; refund.status = "processed";
  await service.observe(refund, paymentId);
  assert.equal((await state(id)).transaction!.providerStatus, "processed");
  assert.equal((await state(id)).transaction!.status, "PROCESSING");
  refund.status = "failed"; await service.observe(refund, paymentId);
  const lagged = await state(id);
  assert.equal(lagged.transaction!.providerStatus, "processed"); assert.equal(lagged.status, "PROCESSING"); assert.equal(lagged.activePaymentId, paymentId);
  assert.equal((await submit()).status, 409);
  provider.paymentRow.amount_refunded = 10000; provider.paymentRow.status = "refunded";
  await service.observe(refund, paymentId);
  assert.equal((await state(id)).transaction!.status, "PROCESSED"); assert.equal((await state(id)).status, "REFUNDED");
});

async function preparedApproval() {
  const id = (await submit()).data.id; let reads = 0;
  provider.onInvoice = async () => { if (++reads === 2) throw new ServiceError("PROVIDER_NETWORK_ERROR", 503, "Pre-claim outage"); };
  assert.equal((await approve(id)).status, 503); provider.onInvoice = undefined;
  assert.equal((await state(id)).transaction!.status, "PREPARED"); return id;
}
it("amends an unsubmitted approval after an external refund and preserves its history", async () => {
  const id = await preparedApproval(), initial = await state(id);
  await provider.createRefund(provider.paymentRow.id, 4000, "external_changed_balance", "external_change_key");
  const auth = `hrms_platform_session=${token}`, path = `/api/super-admin/refunds/${id}/prepared`;
  const body = { action: "AMEND", amountMinor: 6000, confirmed: true, expectedVersion: initial.version, requestId: randomUUID(), reason: "External refund reduced remaining balance" };
  assert.equal((await request(path, { ...body, amountMinor: 7000 }, auth)).status, 409);
  assert.equal((await request(path, body, auth)).status, 200);
  assert.equal((await request(path, body, auth)).status, 200);
  const amended = await state(id); assert.equal(amended.approvedAmountMinor, 6000); assert.notEqual(amended.transaction!.receipt, initial.transaction!.receipt);
  assert.equal(await db.refundAuditEvent.count({ where: { requestId: id, action: "APPROVED" } }), 1);
  assert.equal(await db.refundAuditEvent.count({ where: { requestId: id, action: "APPROVAL_AMENDED" } }), 1);
  assert.equal((await request(`/api/super-admin/refunds/${id}/process`, { confirmed: true, amountMinor: 6000 }, auth)).status, 200);
  assert.equal(provider.creates, 2); assert.equal(provider.paymentRow.amount_refunded, 10000);
});
it("voids only definitely unsubmitted approvals after explicit authorized confirmation", async () => {
  const id = await preparedApproval(), row = await state(id), path = `/api/super-admin/refunds/${id}/prepared`;
  const body = { action: "VOID", confirmed: true, expectedVersion: row.version, requestId: randomUUID(), reason: "No longer appropriate to issue this refund" };
  assert.equal((await request(path, body, cookie)).status, 401);
  assert.equal((await request(path, { ...body, confirmed: false }, `hrms_platform_session=${token}`)).status, 400);
  assert.equal((await request(path, body, `hrms_platform_session=${token}`)).status, 200);
  assert.equal((await state(id)).transaction!.status, "VOIDED"); assert.equal((await state(id)).activePaymentId, null); assert.equal(provider.creates, 0);
  assert.equal((await submit()).status, 201);
});
it("never amends or voids an uncertain initiation", async () => {
  provider.behavior = "network-before"; const id = (await submit()).data.id; await approve(id); const row = await state(id);
  for (const action of ["AMEND", "VOID"]) {
    const result = await request(`/api/super-admin/refunds/${id}/prepared`, { action, ...(action === "AMEND" ? { amountMinor: 5000 } : {}), confirmed: true, expectedVersion: row.version, requestId: randomUUID(), reason: "Attempted uncertain recovery change" }, `hrms_platform_session=${token}`);
    assert.equal(result.status, 409);
  }
  assert.equal(provider.creates, 1); assert.equal((await state(id)).activePaymentId, paymentId);
});
it("fences an initiator holding an approval snapshot while another reviewer amends it", async () => {
  const id = await preparedApproval(), row = await state(id);
  provider.onInvoice = async () => {
    provider.onInvoice = undefined;
    await service.changePrepared(id, actor, token, { action: "AMEND", amountMinor: 5000, expectedVersion: row.version, requestId: randomUUID(), reason: "Reviewer reduced the unsubmitted amount" });
  };
  await service.processApproved(id, actor, token, 10000);
  assert.equal(provider.creates, 0); assert.equal((await state(id)).transaction!.status, "PREPARED");
  await service.processApproved(id, actor, token, 5000);
  assert.equal(provider.creates, 1); assert.equal(provider.paymentRow.amount_refunded, 5000);
});
it("walks 60+ mixed zero/positive refund payments in bounded paced batches, retries failures and discovers earlier IDs", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `scan_${String(i).padStart(3, "0")}`);
  await db.billingPayment.createMany({ data: ids.map((id, i) => ({ id, subscriptionId: subId, providerPaymentId: `pay_${id}`, amountMinor: 10000, amountRefundedMinor: i % 2 ? 100 : 0, currency: "INR", status: "captured" })) });
  await db.billingPayment.create({ data: { id: "scan_ignored", subscriptionId: subId, providerPaymentId: "pay_scan_ignored", amountMinor: 10000, currency: "INR", status: "failed" } });
  const seen = new Set<string>(); let failOnce = true;
  let inspections = 0, waits = 0;
  const wait = async (ms: number) => { assert.equal(ms, 250); assert.equal(ms, refundInspectionIntervalMs); waits++; };
  const inspector = { syncPayment: async (id: string) => { inspections++; if (id === ids[3] && failOnce) { failOnce = false; throw Error("Temporary provider failure"); } seen.add(id); } };
  let failures = 0;
  for (let batch = 0; batch < 3; batch++) { const before = inspections; failures += await discoverExternalRefunds(db, inspector, undefined, wait); assert(inspections - before <= 25); }
  assert.equal(failures, 1); assert.equal(seen.size, 60); assert(seen.has(paymentId)); assert(!seen.has("scan_ignored"));
  await db.billingPayment.create({ data: { id: "scan_000_early", subscriptionId: subId, providerPaymentId: "pay_scan_new_early", amountMinor: 10000, amountRefundedMinor: 100, currency: "INR", status: "captured" } });
  const before = inspections;
  const later = () => new Date(Date.now() + 120000);
  await Promise.all([discoverExternalRefunds(db, inspector, undefined, wait, later), discoverExternalRefunds(db, inspector, undefined, wait, later)]);
  assert(inspections - before <= 30); // One main batch plus the independent retry budget.
  assert(seen.has(ids[3]!)); assert(seen.has("scan_000_early")); assert.equal(seen.size, 62);
  assert.equal(waits, inspections);
});

for (const amount of [3000, 10000]) it(`discovers a missed-webhook external refund of ${amount} from zero local evidence using recovery GETs`, async () => {
  const worker = new PrismaClient();
  try {
    const original = await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.equal(original.amountRefundedMinor, 0);
    // Smaller captures remain discoverable/refundable but cannot independently
    // prove this subscription's 10000-minor-unit paid entitlement.
    const extraPayments = Array.from({ length: 60 }, (_, i) => ({ id: `missed_${String(i).padStart(3, "0")}`, subscriptionId: subId, providerPaymentId: `pay_missed_${i}`, providerInvoiceId: `inv_missed_${i}`, paidAt: now, amountMinor: 1000, amountRefundedMinor: i % 2 ? 100 : 0, currency: "INR", status: "captured" }));
    await db.billingPayment.createMany({ data: extraPayments });
    const refund: RemoteRefund = { id: `rfnd_${randomUUID().replaceAll("-", "")}`, payment_id: original.providerPaymentId, amount, currency: "INR", status: "processed", receipt: "external_missed_webhook", created_at: Math.floor(now.getTime() / 1000) };
    // External activity changes only the provider fixture: no local writes,
    // webhook, submit, approval, or provider createRefund call.
    provider.rows.set(refund.id, refund);
    provider.paymentRow.amount_refunded = amount;
    provider.paymentRow.status = amount === 10000 ? "refunded" : "captured";
    assert.equal(await db.refundTransaction.count({ where: { paymentId } }), 0);
    const workerBilling = new BillingService(worker, provider, () => now);
    for (let batch = 0; batch < 3; batch++) {
      const before = provider.refundListReads.length;
      await reconcileDue(worker, workerBilling, now);
      assert(provider.refundListReads.length - before <= 25);
    }
    assert.deepEqual(new Set(provider.refundListReads), new Set([original.providerPaymentId, ...extraPayments.map(payment => payment.providerPaymentId)]));
    const updated = await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.equal(updated.amountRefundedMinor, amount);
    assert.equal(updated.status, amount === 10000 ? "refunded" : "captured");
    assert.equal(updated.amountMinor, original.amountMinor); assert.deepEqual(updated.paidAt, original.paidAt);
    const ledger = await db.refundTransaction.findUniqueOrThrow({ where: { providerRefundId: refund.id } });
    assert.equal(ledger.status, "PROCESSED"); assert.equal(ledger.requestId, null); assert.equal(ledger.amountMinor, amount);
    assert.equal((await new AccessPolicy(db, () => now).status(org)).allowed, amount < 10000);
    if (amount === 10000) {
      // A subsequent stale provider capture cannot restore refunded evidence/access.
      provider.paymentRow.status = "captured"; provider.paymentRow.amount_refunded = 0;
      await billing.reconcile(subId);
      const stale = await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } });
      assert.equal(stale.status, "refunded"); assert.equal(stale.amountRefundedMinor, 10000);
      assert.equal((await db.subscription.findUniqueOrThrow({ where: { id: subId } })).paidUntil, null);
      assert.equal((await new AccessPolicy(db, () => now).status(org)).allowed, false);
    }
    assert.equal(provider.creates, 0); assert.equal(provider.cancels, 0);
  } finally { await worker.$disconnect(); }
});

it("persists a global cooldown while checkpointing a rate-limited payment for separate retry", async () => {
  const worker = new PrismaClient(), attempts: string[] = [];
  let limited = true;
  const inspector = { syncPayment: async (id: string) => { attempts.push(id); if (limited) throw new ServiceError("PROVIDER_RATE_LIMITED", 503, "Fixture HTTP 429"); } };
  try {
    await db.billingPayment.create({ data: { id: "zz_after_rate_limit", subscriptionId: subId, providerPaymentId: "pay_after_rate_limit", amountMinor: 10000, currency: "INR", status: "captured" } });
    const clock = () => now;
    assert.equal(await discoverExternalRefunds(worker, inspector, undefined, async () => {}, clock), 1);
    assert.deepEqual(attempts, [paymentId]);
    assert.equal((await db.refundDiscoveryScan.findUniqueOrThrow({ where: { id: refundScanId } })).cursor, paymentId);
    assert.equal(await discoverExternalRefunds(worker, inspector, undefined, async () => {}, clock), 0);
    assert.deepEqual(attempts, [paymentId]);
    limited = false;
    assert.equal(await discoverExternalRefunds(worker, inspector, undefined, async () => {}, () => new Date(now.getTime() + 60000)), 0);
    assert.deepEqual(attempts, [paymentId, "zz_after_rate_limit", paymentId]);
    assert.equal(await db.refundDiscoveryRetry.count(), 0);
  } finally { await worker.$disconnect(); }
});

it("independent workers can overlap discovery without losing or duplicating financial evidence", async () => {
  const workers = [new PrismaClient(), new PrismaClient()];
  const refund: RemoteRefund = { id: `rfnd_${randomUUID().replaceAll("-", "")}`, payment_id: provider.paymentRow.id, amount: 3000, currency: "INR", status: "processed", receipt: "external_concurrent", created_at: Math.floor(now.getTime() / 1000) };
  provider.rows.set(refund.id, refund); provider.paymentRow.amount_refunded = 3000;
  try {
    const results = await Promise.all(workers.map(worker => discoverExternalRefunds(worker, new RefundService(worker, new BillingService(worker, provider, () => now), () => now), undefined, async () => {})));
    // A competing subscription lease may reject a post-observation reconcile;
    // the already-committed ledger/payment evidence must still be unique and safe.
    assert(results.every(result => result <= 1));
    await billing.reconcile(subId);
    assert.equal(await db.refundTransaction.count({ where: { paymentId } }), 1);
    assert.equal((await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } })).amountRefundedMinor, 3000);
    assert.equal((await new AccessPolicy(db, () => now).status(org)).allowed, true);
    assert.equal(provider.creates, 0);
  } finally { await Promise.all(workers.map(worker => worker.$disconnect())); }
});

it("does not advance past an uninspected payment when shutdown occurs during pacing", async () => {
  const worker = new PrismaClient(), seen: string[] = []; let stopped = false;
  const inspector = { syncPayment: async (id: string) => { seen.push(id); } };
  try {
    await discoverExternalRefunds(worker, inspector, () => stopped, async () => { stopped = true; });
    assert.deepEqual(seen, []);
    await discoverExternalRefunds(worker, inspector, () => false, async () => {});
    assert.deepEqual(seen, [paymentId]);
  } finally { await worker.$disconnect(); }
});

for (const scope of ["global", "payment"] as const) it(`a persistent ${scope} 429 cannot starve 65 later captures and a missed full refund`, async () => {
  // The refunded original is deliberately last; the first 65 captures have no
  // refunds. Use the real service for the financial observation/access checks.
  await db.billingPayment.update({ where: { id: paymentId }, data: { id: "zz_refunded" } });
  paymentId = "zz_refunded";
  const ids = Array.from({ length: 65 }, (_, i) => `durable_${String(i).padStart(3, "0")}`);
  await db.billingPayment.createMany({ data: ids.map(id => ({ id, subscriptionId: subId, providerPaymentId: `pay_${id}`, status: "captured", amountMinor: 10000, currency: "INR" })) });
  const refund: RemoteRefund = { id: `rfnd_${randomUUID().replaceAll("-", "")}`, payment_id: provider.paymentRow.id, amount: 10000, currency: "INR", status: "processed", created_at: Math.floor(now.getTime() / 1000) };
  provider.rows.set(refund.id, refund); provider.paymentRow.amount_refunded = 10000; provider.paymentRow.status = "refunded";
  const seen = new Set<string>(); let tick = now.getTime(), failures = 0;
  const localIds = new Map(ids.map(id => [`pay_${id}`, id]));
  localIds.set(provider.paymentRow.id, paymentId);
  const readRefunds = provider.paymentRefunds.bind(provider);
  provider.paymentRefunds = async providerPaymentId => {
    const id = localIds.get(providerPaymentId)!;
    if (id === ids[0]) { failures++; throw new ServiceError("PROVIDER_RATE_LIMITED", 503, "Persistent fixture 429", 60000, scope); }
    seen.add(id); return readRefunds(providerPaymentId);
  };
  for (let cycle = 0; cycle < 8; cycle++) {
    const worker = new PrismaClient(); // Restart every batch: progress must be durable.
    try { await reconcileDue(worker, new BillingService(worker, provider, () => now), new Date(tick), undefined, async () => {}); }
    finally { await worker.$disconnect(); }
    if (scope === "global") {
      const before = failures;
      await reconcileDue(db, billing, new Date(tick), undefined, async () => {});
      assert.equal(failures, before); // No retry/GET while shared cooldown is active.
    }
    tick += 3600001;
  }
  for (const id of ids.slice(1)) assert(seen.has(id));
  assert(seen.has(paymentId)); assert(failures > 1);
  assert.equal((await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } })).amountRefundedMinor, 10000);
  assert.equal((await new AccessPolicy(db, () => now).status(org)).allowed, false);
  const deferred = await db.refundDiscoveryRetry.findUniqueOrThrow({ where: { paymentId: ids[0]! } });
  assert(deferred.attempts > 1); assert(deferred.nextAttemptAt.getTime() > tick - 3600001);
  // Recover the deferred payment with actual provider evidence after backoff.
  await db.billingPayment.update({ where: { id: ids[0]! }, data: { providerPaymentId: "pay_recovered", providerInvoiceId: "inv_recovered" } });
  provider.paymentRow.id = "pay_recovered"; provider.paymentRow.invoice_id = "inv_recovered";
  const recoveredRefund = { ...refund, id: "rfnd_recovered", payment_id: "pay_recovered" };
  provider.rows.set(recoveredRefund.id, recoveredRefund);
  await discoverExternalRefunds(db, service, undefined, async () => {}, () => new Date(tick));
  assert.equal(await db.refundDiscoveryRetry.count({ where: { paymentId: ids[0]! } }), 0);
  assert.equal((await db.billingPayment.findUniqueOrThrow({ where: { id: ids[0]! } })).amountRefundedMinor, 10000);
  assert.equal(provider.creates, 0);
});

it("replays an uncheckpointed GET after a crashed lease expires and fences the expired owner", async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const worker = new PrismaClient(); let inspections = 0;
  try {
    const old = discoverExternalRefunds(worker, { syncPayment: async () => { inspections++; started(); await gate; } }, undefined, async () => {}, () => now);
    await ready;
    const future = new Date(now.getTime() + refundScanLeaseMs + 1);
    await discoverExternalRefunds(db, { syncPayment: async () => { inspections++; } }, undefined, async () => {}, () => future);
    release();
    await assert.rejects(old, /lease expired/);
    assert.equal(inspections, 2);
    assert.equal((await db.refundDiscoveryScan.findUniqueOrThrow({ where: { id: refundScanId } })).leaseOwner, null);
  } finally { release?.(); await worker.$disconnect(); }
});

it("caps exponential retry delay without capping retry eligibility", () => {
  assert.equal(refundRetryDelay(1), 60000);
  assert.equal(refundRetryDelay(2), 120000);
  assert.equal(refundRetryDelay(30), 3600000);
  assert.equal(refundRetryDelay(1000), 3600000);
});

it("shared cooldown suppresses subscription and uncertain refund GETs across reconciliation clients", async () => {
  provider.behavior = "network-before";
  const id = (await submit()).data.id; await approve(id);
  assert.equal((await state(id)).transaction!.status, "RECONCILING");
  await db.subscription.update({ where: { id: subId }, data: { createdAt: new Date(now.getTime() - 120000), lastSyncedAt: null } });
  await db.refundDiscoveryScan.create({ data: { id: refundScanId, pausedUntil: new Date(now.getTime() + 120000) } });
  let reads = 0;
  const originalSubscription = provider.fetchSubscription.bind(provider), originalRefunds = provider.paymentRefunds.bind(provider);
  provider.fetchSubscription = async () => { reads++; return originalSubscription(); };
  provider.paymentRefunds = async payment => { reads++; return originalRefunds(payment); };
  const worker = new PrismaClient();
  try {
    assert.deepEqual(await reconcileDue(worker, new BillingService(worker, provider, () => now), now), { checked: 0, failed: 0 });
    assert.equal(reads, 0); assert.equal(provider.creates, 1);
  } finally { await worker.$disconnect(); }
});

it("repeats a financially committed GET if its checkpoint transaction fails", async () => {
  const refund: RemoteRefund = { id: "rfnd_checkpoint_failure", payment_id: provider.paymentRow.id, amount: 10000, currency: "INR", status: "processed", created_at: Math.floor(now.getTime() / 1000) };
  provider.rows.set(refund.id, refund); provider.paymentRow.amount_refunded = 10000; provider.paymentRow.status = "refunded";
  const guarded = db.$extends({ query: { refundDiscoveryScan: { async update({ args, query }) {
    if (args.data.cursor === paymentId) throw Error("Fixture checkpoint unavailable");
    return query(args);
  } } } });
  await assert.rejects(discoverExternalRefunds(guarded as unknown as PrismaClient, service, undefined, async () => {}, () => now), /checkpoint unavailable/);
  assert.equal((await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } })).status, "refunded");
  assert.equal((await db.refundDiscoveryScan.findUniqueOrThrow({ where: { id: refundScanId } })).cursor, null);
  await discoverExternalRefunds(db, service, undefined, async () => {}, () => now);
  assert.equal(await db.refundTransaction.count({ where: { providerRefundId: refund.id } }), 1);
  assert.equal((await new AccessPolicy(db, () => now).status(org)).allowed, false);
  assert.equal(provider.creates, 0);
});

it("finishes a finite scan then visits new IDs on both sides and payments whose eligibility changed", async () => {
  const ids = Array.from({ length: 65 }, (_, i) => `population_${String(i).padStart(3, "0")}`);
  await db.billingPayment.createMany({ data: ids.map((id, i) => ({ id, subscriptionId: subId, providerPaymentId: `pay_${id}`, status: i === 0 ? "failed" : "captured", amountMinor: 10000, currency: "INR" })) });
  const seen = new Set<string>(), inspector = { syncPayment: async (id: string) => { seen.add(id); } };
  await discoverExternalRefunds(db, inspector, undefined, async () => {}, () => now);
  for (const id of ["aaa_inserted", "zzz_inserted"]) await db.billingPayment.create({ data: { id, subscriptionId: subId, providerPaymentId: `pay_${id}`, status: "captured", amountMinor: 10000, currency: "INR" } });
  await db.billingPayment.update({ where: { id: ids[0]! }, data: { status: "captured" } });
  await discoverExternalRefunds(db, inspector, undefined, async () => {}, () => now);
  await discoverExternalRefunds(db, inspector, undefined, async () => {}, () => now);
  assert(!seen.has("aaa_inserted")); assert(!seen.has("zzz_inserted")); assert(!seen.has(ids[0]!));
  for (let i = 0; i < 3; i++) await discoverExternalRefunds(db, inspector, undefined, async () => {}, () => now);
  assert(seen.has("aaa_inserted")); assert(seen.has("zzz_inserted")); assert(seen.has(ids[0]!));
});

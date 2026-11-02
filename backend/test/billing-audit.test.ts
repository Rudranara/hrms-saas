import "dotenv/config";
import assert from "node:assert/strict";
import { before, after, beforeEach, it } from "node:test";
import { randomUUID, createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { Server } from "node:http";
import { BillingService } from "../src/billing/service";
import { AccessPolicy } from "../src/billing/access";
import { SuperAdminService } from "../src/super-admin/service";
import { reconcileDue, reconciliationInterval, startBillingReconciler } from "../src/billing/reconciler";
import { createApp } from "../src/server";
import { newSession } from "../src/auth/security";
import { ServiceError } from "../src/services/errors";
import { validSignature, type PaymentProvider, type RemoteSubscription, type RemotePayment, type RemoteInvoice } from "../src/billing/provider";

if (!/^\/hrms_billing_audit_[a-f0-9]{12}$/.test(new URL(process.env.DATABASE_URL!).pathname))
  throw new Error("Audit regression tests require the isolated verification database.");
const db = new PrismaClient(), run = randomUUID().replaceAll("-", "");
const planIds = [`audit-monthly-${run}`, `audit-yearly-${run}`];
const organizations: string[] = [];
let now: Date, org: string, service: BillingService, provider: FakeProvider, server: Server, base: string, cookie: string;
class FakeProvider implements PaymentProvider {
  fixture = randomUUID().replaceAll("-", "");
  available = true; keyId = "rzp_test_fixture"; mode = "test" as const;
  remote = new Map<string, RemoteSubscription>(); payments = new Map<string, RemotePayment>(); invoiceRows = new Map<string, RemoteInvoice[]>();
  creates = 0; cancels = 0; paymentCalls = 0;
  onCreate?: (row: RemoteSubscription) => Promise<void>;
  onCancel?: (id: string) => Promise<void>;
  onFetch?: () => Promise<void>;
  async fetchPlan(id: string) { return { id, interval: 1, period: id.endsWith("yearly") ? "yearly" as const : "monthly" as const, item: { amount: id.endsWith("yearly") ? 120000 : 12000, currency: "INR" } }; }
  async createSubscription(plan: string, _cycles: number, reference: string, organizationId: string) {
    const row: RemoteSubscription = { id: `sub_${this.fixture}_${++this.creates}`, plan_id: plan, status: "created", current_start: null, current_end: null, paid_count: 0, notes: { localSubscriptionId: reference, organizationId } };
    this.remote.set(row.id, row); const response = structuredClone(row);
    await this.onCreate?.(row); return response;
  }
  async fetchSubscription(id: string) { const row = structuredClone(this.remote.get(id)!); await this.onFetch?.(); return row; }
  async findSubscription(reference: string) { return structuredClone([...this.remote.values()].find((row) => row.notes.localSubscriptionId === reference) ?? null); }
  async invoices(id: string) { return structuredClone(this.invoiceRows.get(id) ?? []); }
  async invoice(id: string) { return structuredClone([...this.invoiceRows.values()].flat().find((row) => row.id === id)!); }
  async payment(id: string) { this.paymentCalls++; return structuredClone(this.payments.get(id)!); }
  async cancel(id: string, _atCycleEnd: boolean) { this.cancels++; await this.onCancel?.(id); const row = this.remote.get(id)!; row.status = "cancelled"; return structuredClone(row); }
  verifyCheckout(p: string, s: string, signature: string) { return validSignature(`${p}|${s}`, signature, "fixture"); }
  verifyWebhook(body: Buffer, signature: string) { return validSignature(body, signature, "fixture-webhook"); }
  charge(id: string, status = "captured") {
    const row = this.remote.get(id)!, start = Math.floor(now.getTime() / 1000), end = start + 30 * 86400;
    row.status = status === "captured" ? "active" : "pending"; row.current_start = start; row.current_end = end; row.charge_at = end; row.paid_count = status === "captured" ? 1 : 0;
    const paymentId = `pay_${randomUUID().replaceAll("-", "")}`, invoiceId = `inv_${randomUUID().replaceAll("-", "")}`, amount = row.plan_id.endsWith("yearly") ? 120000 : 12000;
    this.payments.set(paymentId, { id: paymentId, invoice_id: invoiceId, status, amount, currency: "INR", amount_refunded: 0, created_at: start });
    this.invoiceRows.set(id, [{ id: invoiceId, subscription_id: id, payment_id: paymentId, status: status === "captured" ? "paid" : "issued", amount_paid: status === "captured" ? amount : 0, currency: "INR", created_at: start, issued_at: start, billing_start: start, billing_end: end }]);
    return paymentId;
  }
}
async function quote(index = 0) { return service.quote(org, planIds[index]!, index ? "yearly" : "monthly"); }
async function checkout() { return service.checkoutQuote(org, (await quote()).id); }
async function resetToTrial(trialEnabled = true) {
  await db.organization.update({ where: { id: org }, data: { accessMode: "CONTROLLED", accessVersion: { increment: 1 }, trialEnabled, subscriptionEnabled: false, trialStartedAt: now, trialExpiresAt: new Date(now.getTime() + 7 * 86400000) } });
}
const gate = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };
async function webhook(event: string, paymentId: string, eventId = `evt_${randomUUID().replaceAll("-", "")}`, valid = true) {
  const body = JSON.stringify({ event, created_at: Math.floor(now.getTime() / 1000), payload: { refund: { entity: { id: "rfnd_fixture", payment_id: paymentId } } } });
  const response = await fetch(`${base}/api/billing/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-razorpay-event-id": eventId, "x-razorpay-signature": valid ? createHmac("sha256", "fixture-webhook").update(body).digest("hex") : "0".repeat(64) }, body });
  return { status: response.status, data: await response.json() };
}
before(async () => { for (let i = 0; i < 2; i++) await db.billingPlan.create({ data: { id: planIds[i]!, name: "Original agreed plan", providerPlanId: `plan_audit_${run}_${i ? "yearly" : "monthly"}`, amountMinor: i ? 120000 : 12000, currency: "INR", interval: i ? "YEARLY" : "MONTHLY", totalCount: 12 } }); });
beforeEach(async () => {
  now = new Date("2026-11-02T10:00:00Z"); provider = new FakeProvider(); service = new BillingService(db, provider, () => now);
  const session = newSession();
  const row = await db.organization.create({ data: { name: `Audit fixture ${run}`, trialStartedAt: new Date(now.getTime() - 10 * 86400000), trialExpiresAt: new Date(now.getTime() - 3 * 86400000), users: { create: { email: `${randomUUID()}@example.test`, fullName: "Audit Fixture", passwordHash: "unused-fixture", role: "ORGANIZATION_ADMIN", sessions: { create: { tokenHash: session.tokenHash, expiresAt: new Date("2030-01-01") } } } } } });
  org = row.id; organizations.push(org); cookie = `hrms_session=${session.token}`;
  server = createApp(db, { frontendOrigin: "http://localhost:3000", production: false }, { provider, clock: () => now }).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
// Local import kept explicit so no test starts a production application.
import { afterEach } from "node:test";
after(async () => { await db.organization.deleteMany({ where: { id: { in: organizations } } }); await db.billingPlan.deleteMany({ where: { id: { in: planIds } } }); await db.$disconnect(); });

it("preserves ACTIVE when creation returns late", async () => {
  provider.onCreate = async (row) => { provider.charge(row.id); await service.reconcile(row.notes.localSubscriptionId!); };
  const sub = await checkout(); assert.equal((await service.own(org, sub.subscriptionId)).status, "ACTIVE");
});
for (const index of [0, 1]) it(`allows ${index ? "another" : "the same"} plan after an admin trial reset, with consent and confirmed prior cancellation`, async () => {
  const old = await checkout(), payment = provider.charge(old.providerSubscriptionId!); await service.reconcile(old.subscriptionId);
  const historical = await service.own(org, old.subscriptionId); await resetToTrial();
  const access = await new AccessPolicy(db, () => now).status(org);
  assert.equal(access.source, "TRIAL"); assert.equal(access.checkoutBlockedBySubscription, false); assert.equal(access.checkoutReplacementRequired, true);
  const next = await quote(index); assert.equal(next.replacesSubscriptionId, old.subscriptionId);
  await assert.rejects(service.checkoutQuote(org, next.id), (error: any) => error.code === "REPLACEMENT_CONSENT_REQUIRED");
  await assert.rejects(service.checkoutQuote(org, next.id, "another_organization_subscription"), (error: any) => error.code === "REPLACEMENT_CONSENT_REQUIRED");
  assert.equal(provider.cancels, 0); assert.equal(provider.creates, 1);
  await assert.rejects(service.checkoutQuote(org, next.id, old.subscriptionId), (error: any) => error.code === "REPLACEMENT_PENDING");
  assert.equal(provider.cancels, 1); assert.equal(provider.creates, 1);
  assert.equal((await service.own(org, old.subscriptionId)).paidUntil!.getTime(), historical.paidUntil!.getTime());
  now = new Date(now.getTime() + 61000); // Proceed retries perform the due confirmation read automatically.
  const fresh = await service.checkoutQuote(org, next.id, old.subscriptionId); assert.notEqual(fresh.subscriptionId, old.subscriptionId); assert.equal(provider.creates, 2);
  provider.charge(fresh.providerSubscriptionId!); await service.reconcile(fresh.subscriptionId);
  assert.equal((await new AccessPolicy(db, () => now).status(org)).source, "SUBSCRIPTION");
  assert.deepEqual((await service.own(org, old.subscriptionId)).commercialTerms, historical.commercialTerms);
  assert.equal((await db.billingPayment.findUniqueOrThrow({ where: { providerPaymentId: payment } })).subscriptionId, old.subscriptionId);
});
for (const index of [0, 1]) it(`allows a ${index ? "yearly" : "monthly"} purchase after confirmed admin cancellation without granting a free trial`, async () => {
  const old = await checkout(); provider.charge(old.providerSubscriptionId!); await service.reconcile(old.subscriptionId);
  await resetToTrial(false);
  // Simulate a provider-confirmed cancellation, never merely a local status edit.
  provider.remote.get(old.providerSubscriptionId!)!.status = "cancelled";
  await service.reconcile(old.subscriptionId);
  const historical = await service.own(org, old.subscriptionId);
  const history = await db.billingPayment.findMany({ where: { subscriptionId: old.subscriptionId } });
  const policy = new AccessPolicy(db, () => now), report = new SuperAdminService(db, () => now);
  const before = await policy.status(org);
  assert.equal(before.allowed, false); assert.equal(before.checkoutAllowed, true);
  assert.equal(before.checkoutBlockedBySubscription, false);
  assert.equal((await report.organization(org)).accessAllowed, false);
  const next = await quote(index); assert.equal(next.replacesSubscriptionId, null);
  const fresh = await service.checkoutQuote(org, next.id);
  assert.equal((await policy.status(org)).allowed, false, "Opening checkout must not restore workspace access");
  provider.charge(fresh.providerSubscriptionId!); await service.reconcile(fresh.subscriptionId);
  const paid = await policy.status(org), current = await report.organization(org);
  assert.equal(paid.allowed, true); assert.equal(paid.source, "SUBSCRIPTION");
  assert.equal(current.accessAllowed, true); assert.equal(current.accessSource, "SUBSCRIPTION"); assert.equal(current.classification, "PAID_ACTIVE");
  const saved = await db.organization.findUniqueOrThrow({ where: { id: org } });
  assert.equal(saved.trialEnabled, false); assert.equal(saved.subscriptionEnabled, false);
  assert.deepEqual(await db.billingPayment.findMany({ where: { subscriptionId: old.subscriptionId } }), history);
  assert.equal((await service.own(org, old.subscriptionId)).paidUntil!.getTime(), historical.paidUntil!.getTime());
  assert.equal(provider.cancels, 0); assert.equal(provider.creates, 2);
});
it("exposes the settlement deadline and recovers cancellation through the tenant-scoped refresh endpoint", async () => {
  const old = await checkout(); provider.charge(old.providerSubscriptionId!); await service.reconcile(old.subscriptionId); await resetToTrial();
  const next = await quote(1);
  await assert.rejects(service.checkoutQuote(org, next.id, old.subscriptionId), (error: any) => error.code === "REPLACEMENT_PENDING");
  const pending = await new AccessPolicy(db, () => now).status(org);
  assert.equal(pending.billingRecovery?.state, "SETTLING");
  assert.equal(pending.billingRecovery?.settleAfter?.getTime(), now.getTime() + 60000);
  const history = await db.billingPayment.findMany({ where: { subscriptionId: old.subscriptionId } });
  now = new Date(now.getTime() + 61000);
  const response = await fetch(`${base}/api/billing/refresh`, { method: "POST", headers: { Cookie: cookie, Origin: "http://localhost:3000", "X-HRMS-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify({ subscriptionId: old.subscriptionId }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).access.billingRecovery, null);
  assert.equal(provider.creates, 1, "Checking cancellation must not create another subscription");
  assert.equal(provider.cancels, 1, "Checking cancellation must not send another cancellation");
  assert.deepEqual(await db.billingPayment.findMany({ where: { subscriptionId: old.subscriptionId } }), history);
  await service.checkoutQuote(org, next.id, old.subscriptionId);
  assert.equal(provider.creates, 2);
});
it("blocks a new payment arriving while the older paid subscription is replaced after trial reset", async () => {
  const old = await checkout(); provider.charge(old.providerSubscriptionId!); await service.reconcile(old.subscriptionId); await resetToTrial();
  const next = await quote(1); provider.onCancel = async (id) => { provider.charge(id); };
  await assert.rejects(service.checkoutQuote(org, next.id, old.subscriptionId), (error: any) => error.code === "PAYMENT_REVIEW_REQUIRED");
  assert.equal(provider.creates, 1); assert.equal(await db.billingPayment.count({ where: { subscriptionId: old.subscriptionId } }), 2);
  assert.equal((await db.billingReplacement.findUniqueOrThrow({ where: { fromSubscriptionId: old.subscriptionId } })).state, "CONFLICT");
});
it("serializes competing paid replacements after a trial reset", async () => {
  const old = await checkout(); provider.charge(old.providerSubscriptionId!); await service.reconcile(old.subscriptionId); await resetToTrial();
  const next = await quote(1), waiting = gate(), entered = gate(); provider.onCancel = async () => { entered.release(); await waiting.promise; };
  const first = assert.rejects(service.checkoutQuote(org, next.id, old.subscriptionId), (error: any) => error.code === "REPLACEMENT_PENDING");
  await entered.promise;
  await assert.rejects(service.checkoutQuote(org, next.id, old.subscriptionId), (error: any) => error.code === "REPLACEMENT_PENDING");
  waiting.release(); await first; assert.equal(provider.cancels, 1); assert.equal(provider.creates, 1);
});
it("recovers an uncertain paid cancellation without sending another cancellation", async () => {
  const old = await checkout(); provider.charge(old.providerSubscriptionId!); await service.reconcile(old.subscriptionId); await resetToTrial();
  const next = await quote(1); provider.onCancel = async (id) => { provider.remote.get(id)!.status = "cancelled"; throw new ServiceError("PROVIDER_TIMEOUT", 503, "fixture timeout"); };
  await assert.rejects(service.checkoutQuote(org, next.id, old.subscriptionId));
  now = new Date(now.getTime() + 61000); await service.reconcile(old.subscriptionId);
  now = new Date(now.getTime() + 61000); await service.reconcile(old.subscriptionId);
  await service.checkoutQuote(org, next.id, old.subscriptionId); assert.equal(provider.cancels, 1); assert.equal(provider.creates, 2);
});
it("preserves ACTIVE when the late creation response throws a definite or uncertain error", async () => {
  for (const code of ["PROVIDER_REJECTED", "PROVIDER_TIMEOUT"]) {
    provider.onCreate = async (row) => { provider.charge(row.id); await service.reconcile(row.notes.localSubscriptionId!); throw new ServiceError(code, 503, "fixture failure"); };
    await assert.rejects(checkout());
    const row = await db.subscription.findFirstOrThrow({ where: { organizationId: org }, orderBy: { createdAt: "desc" } }); assert.equal(row.status, "ACTIVE");
    // Only fixture rows in this isolated DB are changed to start the next scenario.
    await db.subscription.update({ where: { id: row.id }, data: { status: "COMPLETED", paidUntil: new Date(0) } });
  }
});
it("records a payment arriving during cancellation, enters review and blocks all replacement checkout", async () => {
  const old = await checkout(), next = await quote(1);
  provider.onCancel = async (id) => { provider.charge(id); };
  await assert.rejects(service.checkoutQuote(org, next.id), (error: any) => error.code === "PAYMENT_REVIEW_REQUIRED");
  const op = await db.billingReplacement.findUniqueOrThrow({ where: { fromSubscriptionId: old.subscriptionId } }); assert.equal(op.state, "CONFLICT");
  assert.equal(await db.billingPayment.count({ where: { subscriptionId: old.subscriptionId, status: "captured" } }), 1);
  assert.ok((await service.own(org, old.subscriptionId)).paidUntil); assert.equal(provider.creates, 1);
  await assert.rejects(service.checkoutQuote(org, (await quote()).id), (error: any) => error.code === "PAYMENT_REVIEW_REQUIRED");
});
it("serializes concurrent plan switches and waits for a second settled observation before one replacement", async () => {
  const old = await checkout(), next = await quote(1), wait = gate(); provider.onCancel = async () => wait.promise;
  const first = service.checkoutQuote(org, next.id); await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(service.checkoutQuote(org, next.id), (error: any) => error.code === "REPLACEMENT_PENDING");
  await assert.rejects(service.checkoutQuote(org, (await quote()).id), (error: any) => error.code === "REPLACEMENT_PENDING");
  wait.release(); await assert.rejects(first, (error: any) => error.code === "REPLACEMENT_PENDING");
  assert.equal(provider.cancels, 1); assert.equal(provider.creates, 1);
  now = new Date(now.getTime() + 61000); await service.reconcile(old.subscriptionId);
  const responses = await Promise.allSettled([service.checkoutQuote(org, next.id), service.checkoutQuote(org, next.id)]);
  assert.ok(responses.some((r) => r.status === "fulfilled")); assert.equal(provider.creates, 2);
});
it("a late payment after cancellation or replacement still creates durable review", async () => {
  const old = await checkout(), next = await quote(1);
  await assert.rejects(service.checkoutQuote(org, next.id)); now = new Date(now.getTime() + 61000); await service.reconcile(old.subscriptionId); await service.checkoutQuote(org, next.id);
  provider.charge(old.providerSubscriptionId!); provider.remote.get(old.providerSubscriptionId!)!.status = "cancelled";
  await service.reconcile(old.subscriptionId);
  assert.equal((await db.billingReplacement.findUniqueOrThrow({ where: { fromSubscriptionId: old.subscriptionId } })).state, "CONFLICT");
  const response = await fetch(`${base}/api/billing/purchase?subscriptionId=${old.subscriptionId}`, { headers: { Cookie: cookie } }); assert.equal((await response.json()).purchase.state, "REVIEW");
});
it("an expired worker cannot commit any subscription, payment or event changes", async () => {
  const sub = await checkout(); provider.charge(sub.providerSubscriptionId!); provider.onFetch = async () => { now = new Date(now.getTime() + 121000); };
  await assert.rejects(service.reconcile(sub.subscriptionId, { id: `evt_expired_${run}`, digest: "fixture", type: "payment.captured" }), (error: any) => error.code === "BILLING_SYNC_PENDING");
  assert.equal((await service.own(org, sub.subscriptionId)).status, "CREATED"); assert.equal(await db.billingPayment.count({ where: { subscriptionId: sub.subscriptionId } }), 0);
});
it("an old worker cannot overwrite or clear a replacement worker's lease", async () => {
  const sub = await checkout(); provider.charge(sub.providerSubscriptionId!); const a = gate(), b = gate(), enteredA = gate(), enteredB = gate(); let calls = 0;
  provider.onFetch = async () => { if (++calls === 1) { enteredA.release(); await a.promise; } else { enteredB.release(); await b.promise; } };
  const first = service.reconcile(sub.subscriptionId); const firstRejected = assert.rejects(first, (error: any) => error.code === "BILLING_SYNC_PENDING"); await enteredA.promise;
  now = new Date(now.getTime() + 121000); const second = service.reconcile(sub.subscriptionId); await enteredB.promise;
  const owner = (await service.own(org, sub.subscriptionId)).syncLeaseOwner;
  a.release(); await firstRejected; assert.equal((await service.own(org, sub.subscriptionId)).syncLeaseOwner, owner);
  b.release(); await second; assert.equal((await service.own(org, sub.subscriptionId)).status, "ACTIVE");
});
it("fences the final SQL write even when ownership changes after the successful lease read", async () => {
  const sub = await checkout(); provider.charge(sub.providerSubscriptionId!); let replaced = false;
  const delayed = db.$extends({ query: { subscription: { async findFirst({ args, query }) {
    const row = await query(args);
    if (args.where?.syncLeaseOwner && !replaced) {
      replaced = true;
      await db.subscription.update({ where: { id: sub.subscriptionId }, data: { status: "ACTIVE", syncLeaseOwner: "new-worker", syncLeaseUntil: new Date(now.getTime() + 120000) } });
    }
    return row;
  } } } });
  await assert.rejects(new BillingService(delayed as unknown as PrismaClient, provider, () => now).reconcile(sub.subscriptionId), (error: any) => error.code === "BILLING_SYNC_PENDING");
  const row = await service.own(org, sub.subscriptionId); assert.equal(replaced, true); assert.equal(row.status, "ACTIVE"); assert.equal(row.syncLeaseOwner, "new-worker");
  assert.equal(await db.billingPayment.count({ where: { subscriptionId: sub.subscriptionId } }), 0);
});
it("separates creation, observed capture and signed capture-event time without inventing paidAt", async () => {
  const sub = await checkout(), id = provider.charge(sub.providerSubscriptionId!, "authorized"), created = now;
  await service.reconcile(sub.subscriptionId); now = new Date(now.getTime() + 3600000);
  const p = provider.payments.get(id)!, invoice = provider.invoiceRows.get(sub.providerSubscriptionId!)![0]!; p.status = "captured"; invoice.status = "paid"; invoice.amount_paid = p.amount; provider.remote.get(sub.providerSubscriptionId!)!.status = "active"; provider.remote.get(sub.providerSubscriptionId!)!.paid_count = 1;
  await service.reconcile(sub.subscriptionId); let stored = await db.billingPayment.findUniqueOrThrow({ where: { providerPaymentId: id } });
  assert.equal(stored.paidAt, null); assert.equal(stored.paymentCreatedAt!.getTime(), created.getTime()); assert.equal(stored.captureVerifiedAt!.getTime(), now.getTime());
  const revenue = await new SuperAdminService(db, () => now).revenue({ from: new Date(now.getTime() - 1000), until: new Date(now.getTime() + 1000), fromDate: "2026-11-02", toDate: "2026-11-02" });
  assert.ok(revenue.capturedAmountMinor >= p.amount); assert.match(revenue.note, /first capture verification/);
  const occurredAt = new Date(created.getTime() + 1800000);
  await service.reconcile(sub.subscriptionId, { id: `evt_capture_${run}`, digest: "fixture", type: "payment.captured", paymentId: id, occurredAt });
  stored = await db.billingPayment.findUniqueOrThrow({ where: { providerPaymentId: id } }); assert.equal(stored.paidAt!.getTime(), occurredAt.getTime()); assert.equal(stored.paidAtSource, "SIGNED_CAPTURE_EVENT");
  await service.reconcile(sub.subscriptionId); assert.equal((await db.billingPayment.findUniqueOrThrow({ where: { providerPaymentId: id } })).paidAt!.getTime(), occurredAt.getTime());
});
it("preserves legacy paidAt and does not keep terminal financial lookbacks alive with unchanged reads", async () => {
  const sub = await checkout(), id = provider.charge(sub.providerSubscriptionId!); await service.reconcile(sub.subscriptionId);
  const legacy = new Date(now.getTime() - 86400000), changed = new Date(now.getTime() - 3600000);
  await db.billingPayment.update({ where: { providerPaymentId: id }, data: { paidAt: legacy, paidAtSource: null, updatedAt: changed } });
  await service.reconcile(sub.subscriptionId, { id: `evt_legacy_${run}`, digest: "fixture", type: "payment.captured", paymentId: id, occurredAt: now });
  const stored = await db.billingPayment.findUniqueOrThrow({ where: { providerPaymentId: id } }); assert.equal(stored.paidAt!.getTime(), legacy.getTime()); assert.equal(stored.updatedAt.getTime(), changed.getTime());
});
it("verifies refund signatures, deduplicates refunds and records partial/full totals without duplicate payments", async () => {
  const sub = await checkout(), id = provider.charge(sub.providerSubscriptionId!); await service.reconcile(sub.subscriptionId);
  provider.payments.get(id)!.amount_refunded = 100;
  assert.equal((await webhook("refund.processed", id, "evt_invalid", false)).status, 400);
  const eventId = `evt_refund_${run}`; assert.equal((await webhook("refund.processed", id, eventId)).status, 200); const calls = provider.paymentCalls;
  assert.equal((await webhook("refund.processed", id, eventId)).data.duplicate, true); assert.equal(provider.paymentCalls, calls);
  assert.equal((await db.billingPayment.findUniqueOrThrow({ where: { providerPaymentId: id } })).amountRefundedMinor, 100); assert.ok((await service.own(org, sub.subscriptionId)).paidUntil);
  provider.payments.get(id)!.amount_refunded = 12000; provider.payments.get(id)!.status = "refunded";
  assert.equal((await webhook("refund.processed", id)).status, 200); assert.equal((await service.own(org, sub.subscriptionId)).paidUntil, null);
  assert.equal(await db.billingPayment.count({ where: { subscriptionId: sub.subscriptionId } }), 1);
  provider.payments.get(id)!.amount_refunded = 0; provider.payments.get(id)!.status = "captured"; // lagging provider read
  await service.reconcile(sub.subscriptionId);
  assert.equal((await service.own(org, sub.subscriptionId)).paidUntil, null);
  const retained = await db.billingPayment.findUniqueOrThrow({ where: { providerPaymentId: id } }); assert.equal(retained.status, "refunded"); assert.equal(retained.amountRefundedMinor, 12000);
});
it("recovers terminal financial history in a bounded lookback without reactivating expired access", async () => {
  const sub = await checkout(); now = new Date(now.getTime() - 45 * 86400000); const id = provider.charge(sub.providerSubscriptionId!);
  now = new Date(now.getTime() + 45 * 86400000); provider.remote.get(sub.providerSubscriptionId!)!.status = "completed";
  await db.subscription.update({ where: { id: sub.subscriptionId }, data: { status: "COMPLETED", createdAt: new Date(now.getTime() - 45 * 86400000), currentPeriodEnd: new Date(now.getTime() - 15 * 86400000), lastSyncedAt: null } });
  const scoped = db.$extends({ query: { subscription: { findMany: ({ args, query }) => query({ ...args, where: { AND: [args.where ?? {}, { organizationId: org }] } }) } } });
  assert.equal((await reconcileDue(scoped as unknown as PrismaClient, service, now)).checked, 1);
  assert.equal(await db.billingPayment.count({ where: { providerPaymentId: id } }), 1); assert.equal((await new AccessPolicy(db, () => now).status(org)).allowed, false);
  provider.payments.get(id)!.status = "refunded"; provider.payments.get(id)!.amount_refunded = 12000; assert.equal((await webhook("refund.processed", id)).status, 200);
  assert.equal((await new AccessPolicy(db, () => now).status(org)).allowed, false);
});
it("rejects invalid scheduler intervals at both startup parsing and scheduler construction", () => {
  assert.equal(reconciliationInterval(undefined), 300000);
  assert.equal(reconciliationInterval(60000), 60000); assert.equal(reconciliationInterval(3600000), 3600000);
  for (const value of ["", "garbage", "60000.5", "Infinity", 0, 1, -1, 59999, 3600001, 2147483648]) {
    assert.throws(() => reconciliationInterval(value)); assert.throws(() => startBillingReconciler(db, service, Number(value)));
  }
});
it("uses agreed snapshot names for status, history and purchase after a catalog rename", async () => {
  const sub = await checkout(); provider.charge(sub.providerSubscriptionId!); await service.reconcile(sub.subscriptionId);
  await db.billingPlan.update({ where: { id: planIds[0] }, data: { name: "Renamed catalog" } });
  assert.equal((await new AccessPolicy(db, () => now).status(org)).subscription!.planName, "Original agreed plan");
  const history = await fetch(`${base}/api/billing/history`, { headers: { Cookie: cookie } }).then((r) => r.json()); assert.equal(history.payments[0].subscription.plan.name, "Original agreed plan");
  await db.billingPlan.update({ where: { id: planIds[0] }, data: { name: "Original agreed plan" } });
});

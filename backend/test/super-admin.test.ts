import "dotenv/config";
import assert from "node:assert/strict";
import { before, after, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/server";
import { hashPassword } from "../src/auth/password";
import { hashToken, newSession } from "../src/auth/security";


if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
const db = new PrismaClient(), run = randomUUID(), now = new Date("2026-10-27T12:00:00Z"), day = 86400000;
const origin = "http://localhost:3000", ids: string[] = [], cases = new Map<string, string>();
let server: Server, base = "", adminCookie = "", tenantCookie = "", employeeCookie = "", passwordHash = "";
let baseline: { counts: Record<string, number>; revenue: { capturedAmountMinor: number; paymentCount: number } };
const platformIds: string[] = [];
const planId = `admin-test-${run}`;
async function request(path: string, cookie = adminCookie, body?: unknown) {
  const response = await fetch(base + "/api" + path, { method: body ? "POST" : "GET", headers: { Origin: origin, "X-HRMS-Request": "1", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
async function org(label: string, trial = false, expired = false) {
  const organization = await db.organization.create({ data: { name: `${run} ${label}`, createdAt: new Date(now.getTime() - ids.length * 1000),
    trialStartedAt: trial || expired ? new Date(now.getTime() - (expired ? 8 : 1) * day) : null,
    trialExpiresAt: trial || expired ? new Date(now.getTime() + (expired ? -1 : 6) * day) : null } });
  ids.push(organization.id); cases.set(label, organization.id); return organization.id;
}
async function user(organizationId: string, role: "SUPER_ADMIN" | "ORGANIZATION_ADMIN" | "EMPLOYEE") {
  const session = newSession();
  if (role === "SUPER_ADMIN") {
    const row = await db.superAdmin.create({ data: { fullName: "Platform fixture", email: randomUUID()+"@example.test", passwordHash } });
    platformIds.push(row.id);
    await db.superAdminSession.create({ data: { superAdminId: row.id, tokenHash: session.tokenHash, expiresAt: session.expiresAt } });
    return { row, cookie: "hrms_platform_session="+session.token };
  }
  const row = await db.user.create({ data: { organizationId, role, fullName: role+" fixture", email: randomUUID()+"@example.test", passwordHash } });
  await db.session.create({ data: { userId: row.id, tokenHash: session.tokenHash, expiresAt: session.expiresAt } });
  return { row, cookie: "hrms_session="+session.token };
}
async function subscription(organizationId: string, status: string, paidDays?: number, synced = true, createdAgo = 0) {
  return db.subscription.create({ data: { organizationId, planId, providerPlanId: `plan_${run}`, status, amountMinor: 10000, currency: "INR", interval: "MONTHLY", totalCount: 12,
    createdAt: new Date(now.getTime() - createdAgo * day), paidUntil: paidDays === undefined ? null : new Date(now.getTime() + paidDays * day),
    currentPeriodStart: paidDays === undefined ? null : new Date(now.getTime() - 20 * day), currentPeriodEnd: paidDays === undefined ? null : new Date(now.getTime() + paidDays * day),
    lastSyncedAt: synced ? now : null } });
}
async function payment(subscriptionId: string, status: string, amountMinor: number, extra: { currency?: string; paidAt?: Date | null; providerInvoiceId?: string | null } = {}) {
  return db.billingPayment.create({ data: { subscriptionId, status, amountMinor, currency: "INR", providerPaymentId: `pay_${randomUUID()}`, providerInvoiceId: `inv_${randomUUID()}`,
    paidAt: ["captured", "refunded"].includes(status) ? new Date(now.getTime() - day) : null, ...extra } });
}
before(async () => {
  passwordHash = await hashPassword("Admin fixture passphrase");
  await db.billingPlan.create({ data: { id: planId, name: "Admin fixture", interval: "MONTHLY", amountMinor: 10000, currency: "INR", totalCount: 12 } });
  const platform = await org("platform"), tenant = await org("tenant", true);
  adminCookie = (await user(platform, "SUPER_ADMIN")).cookie;
  tenantCookie = (await user(tenant, "ORGANIZATION_ADMIN")).cookie;
  employeeCookie = (await user(tenant, "EMPLOYEE")).cookie;
  const app = createApp(db, { frontendOrigin: origin, production: false }, { clock: () => now });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const initial = await request("/super-admin/metrics");
  assert.equal(initial.status, 200, JSON.stringify(initial.data));
  baseline = initial.data;
  await org("trial", true); await org("trial expired", false, true); await org("Percent%_Org");
  await subscription(await org("pending", true), "CREATED");
  const authorized = await subscription(await org("authorization only"), "AUTHENTICATED", 8);
  await payment(authorized.id, "authorized", 10000);
  const failed = await subscription(await org("failed"), "HALTED"); await payment(failed.id, "failed", 10000);
  const cancelled = await subscription(await org("cancelled", false, true), "CANCELLED", 8); await payment(cancelled.id, "captured", 20000);
  const expired = await subscription(await org("expired", false, true), "ACTIVE", -2); await payment(expired.id, "captured", 30000);
  const paid = await subscription(await org("paid", false, true), "ACTIVE", 10); await payment(paid.id, "captured", 10000);
  await payment(paid.id, "refunded", 10000); await payment(paid.id, "captured", 99999, { currency: "USD" });
  await payment(paid.id, "captured", 99999, { paidAt: null }); await payment(paid.id, "captured", 99999, { providerInvoiceId: null });
  const multiId = await org("multiple", false, true), multi = await subscription(multiId, "ACTIVE", 10, true, 2);
  await payment(multi.id, "captured", 40000); await payment(multi.id, "captured", 50000);
  await subscription(multiId, "CREATED");
  const unconfirmed = await subscription(await org("unconfirmed"), "ACTIVE", 10, false); await payment(unconfirmed.id, "captured", 90000);
  const nominal = await subscription(await org("nominal capture", false, true), "ACTIVE", 10); await payment(nominal.id, "captured", 1);
  await subscription(await org("paused"), "PAUSED");
  await subscription(await org("checkout failed"), "FAILED");
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (ids.length) await db.organization.deleteMany({ where: { id: { in: ids } } });
  await db.billingPlan.deleteMany({ where: { id: planId } });
  await db.superAdminAuditEvent.deleteMany({ where: { actorSuperAdminId: { in: platformIds } } });
  await db.superAdmin.deleteMany({ where: { id: { in: platformIds } } });
  await db.$disconnect();
});
it("protects every platform endpoint from anonymous users and ordinary tenant roles", async () => {
  for (const path of ["metrics", "revenue", "organizations", `organizations/${cases.get("paid")}`, `organizations/${cases.get("paid")}/subscriptions`, `organizations/${cases.get("paid")}/payments`]) {
    assert.equal((await request(`/super-admin/${path}`, "")).status, 401);
    for (const cookie of [tenantCookie, employeeCookie]) assert.equal((await request(`/super-admin/${path}`, cookie)).status, 401);
  }
  assert.equal((await request("/super-admin/metrics?role=SUPER_ADMIN", tenantCookie)).status, 401);
  assert.equal((await request("/auth/register", "", { organizationName: "Forged admin", fullName: "Attacker", email: `${run}@example.test`, password: "securepass8", confirmPassword: "securepass8", role: "SUPER_ADMIN" })).status, 400);
  assert.equal((await request(`/organizations/${cases.get("paid")}`, tenantCookie)).status, 403);
  assert.equal((await request("/organization", adminCookie)).status, 401, "Platform role does not inherit tenant administrator powers");
});
it("classifies each organization once using captured payments rather than checkout or authorization", async () => {
  const expected = { trial: "TRIALING", "trial expired": "TRIAL_EXPIRED", pending: "PENDING", "authorization only": "PENDING", failed: "PAST_DUE", cancelled: "CANCELLED", expired: "EXPIRED", paid: "PAID_ACTIVE", multiple: "PAID_ACTIVE", unconfirmed: "PENDING", "nominal capture": "PENDING", paused: "PAUSED", "checkout failed": "CHECKOUT_FAILED" };
  for (const [label, classification] of Object.entries(expected)) {
    const result = await request(`/super-admin/organizations/${cases.get(label)}`);
    assert.equal(result.status, 200);
    assert.equal(result.data.organization.classification, classification, label);
  }
  const metrics = (await request("/super-admin/metrics")).data;
  assert.equal(metrics.counts.totalOrganizations - baseline.counts.totalOrganizations!, 14);
  assert.equal(metrics.counts.paidActive - baseline.counts.paidActive!, 2);
  assert.equal(metrics.counts.activeTrials - baseline.counts.activeTrials!, 2, "Pending checkout can retain trial access");
  assert.equal(metrics.counts.paymentPending - baseline.counts.paymentPending!, 4);
  assert.equal(metrics.counts.paymentFailed - baseline.counts.paymentFailed!, 2);
  const multiple = (await request(`/super-admin/organizations/${cases.get("multiple")}`)).data.organization;
  assert.equal(multiple.hasPaidAccess, true);
  assert.ok(multiple.convertedAt);
  assert.equal((await request(`/super-admin/organizations/${cases.get("cancelled")}`)).data.organization.hasPaidAccess, true);
  const nominal = (await request(`/super-admin/organizations/${cases.get("nominal capture")}`)).data.organization;
  assert.equal(nominal.hasPaidAccess, false); assert.equal(nominal.convertedAt, null);
});
it("filters and searches literal text, paginates deterministically and returns honest empty states", async () => {
  const first = await request(`/super-admin/organizations?q=${run}&page=1&pageSize=2`);
  const next = await request(`/super-admin/organizations?q=${run}&page=2&pageSize=2`);
  assert.equal(first.data.items.length, 2); assert.equal(next.data.items.length, 2);
  assert.equal(first.data.items.some((a: { id: string }) => next.data.items.some((b: { id: string }) => a.id === b.id)), false);
  const literal = await request("/super-admin/organizations?q=" + encodeURIComponent("Percent%_Org"));
  assert.equal(literal.data.total, 1);
  for (const status of ["TRIALING", "PAID_ACTIVE", "TRIAL_EXPIRED", "PENDING", "PAST_DUE", "CHECKOUT_FAILED", "PAUSED", "CANCELLED", "EXPIRED"]) {
    const result = await request(`/super-admin/organizations?q=${run}&status=${status}`);
    assert.equal(result.status, 200); assert.ok(result.data.total > 0);
  }
  const empty = await request("/super-admin/organizations?q=" + encodeURIComponent("' OR 1=1 --"));
  assert.equal(empty.data.total, 0); assert.deepEqual(empty.data.items, []);
  assert.equal((await request("/super-admin/organizations/does-not-exist")).status, 404);
});
it("rejects malformed filters, dates and unbounded requests", async () => {
  for (const suffix of ["page=0", "pageSize=500", "status=PAID", "q=" + "a".repeat(121), "page=1&page=2", "role=SUPER_ADMIN"]) assert.equal((await request(`/super-admin/organizations?${suffix}`)).status, 400);
  for (const suffix of ["from=2026-02-30", "from=2026-10-28&to=2026-10-20", "from=2020-01-01&to=2026-01-01", "to=javascript:alert(1)"]) assert.equal((await request(`/super-admin/revenue?${suffix}`)).status, 400);
});
it("sums unique verified captured INR records with inclusive IST dates and excludes non-captured and unconfirmed records", async () => {
  const result = (await request("/super-admin/revenue")).data.revenue;
  assert.equal(result.capturedAmountMinor - baseline.revenue.capturedAmountMinor, 150001);
  assert.equal(result.paymentCount - baseline.revenue.paymentCount, 6);
  assert.equal(result.refundsMinor, null); assert.equal(result.netRevenueMinor, null);
  const outside = (await request("/super-admin/revenue?from=2020-01-01&to=2020-01-01")).data.revenue;
  assert.equal(outside.capturedAmountMinor, 0);
  const row = await db.billingPayment.findFirstOrThrow({ where: { subscription: { organizationId: cases.get("multiple")! } } });
  await assert.rejects(db.billingPayment.create({ data: { subscriptionId: row.subscriptionId, providerPaymentId: row.providerPaymentId, amountMinor: row.amountMinor, currency: row.currency, status: row.status, paidAt: row.paidAt } }), { code: "P2002" });
  assert.equal((await request("/super-admin/revenue")).data.revenue.capturedAmountMinor, result.capturedAmountMinor);
});
it("returns bounded histories without provider secrets, full customer data or cross-tenant leakage", async () => {
  const subs = await request(`/super-admin/organizations/${cases.get("multiple")}/subscriptions?pageSize=1`);
  assert.equal(subs.data.total, 2); assert.equal(subs.data.items.length, 1);
  const payments = await request(`/super-admin/organizations/${cases.get("multiple")}/payments?pageSize=1`);
  assert.equal(payments.data.total, 2); assert.equal(payments.data.items.length, 1);
  const serialized = JSON.stringify({ ...subs.data, payments: payments.data });
  for (const secret of ["passwordHash", "providerCustomerId", "providerPaymentId", "tokenHash", "keySecret"]) assert.equal(serialized.includes(secret), false);
});

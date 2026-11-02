import "dotenv/config";
import assert from "node:assert/strict";
import { before, beforeEach, afterEach, after, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/server";
import { hashPassword } from "../src/auth/password";
import { newSession } from "../src/auth/security";
import { AccessPolicy } from "../src/billing/access";
import { OrganizationAccessService } from "../src/super-admin/organization-access";

if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
const db = new PrismaClient(), origin = "http://localhost:3000", day = 86400000, planId = `access-${randomUUID()}`;
let now: Date, server: Server, base = "", orgId = "", otherId = "", actorId = "", secondActorId = "", cookie = "", secondCookie = "", tenantCookie = "", otherCookie = "", employeeCookie = "", hash = "";
async function platformSession(id: string) {
  const session = newSession();
  await db.superAdminSession.create({ data: { superAdminId: id, tokenHash: session.tokenHash, expiresAt: new Date(now.getTime() + 365 * day) } });
  return `hrms_platform_session=${session.token}`;
}
async function organization(label: string) {
  const org = await db.organization.create({ data: { name: label, trialStartedAt: new Date(now.getTime() - day), trialExpiresAt: new Date(now.getTime() + 6 * day), users: { create: { fullName: "Access fixture operator", email: `${randomUUID()}@example.test`, passwordHash: hash, role: "ORGANIZATION_ADMIN" } } }, include: { users: true } });
  const session = newSession(); await db.session.create({ data: { userId: org.users[0]!.id, tokenHash: session.tokenHash, expiresAt: session.expiresAt } });
  return { id: org.id, cookie: `hrms_session=${session.token}` };
}
async function request(path: string, body?: unknown, auth = cookie, trusted = true, method = body === undefined ? "GET" : "POST") {
  if (path === "/api/billing/checkout" && body && typeof body === "object" && "planId" in body) {
    const quoted = await request("/api/billing/quote", { ...body, period: "monthly" }, auth, trusted);
    if (quoted.status !== 201) return quoted;
    body = { quoteId: quoted.data.quote.id };
  }
  const response = await fetch(base + path, { method, headers: { Cookie: auth, "Content-Type": "application/json", ...(trusted ? { Origin: origin, "X-HRMS-Request": "1" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
const url = (id = orgId) => `/api/super-admin/organizations/${id}/access`;
async function change(action: string, extra: Record<string, unknown> = {}, id = orgId, auth = cookie) {
  const org = await db.organization.findUniqueOrThrow({ where: { id } });
  const body = { action, expectedVersion: org.accessVersion, requestId: randomUUID(), reason: "Approved organization support adjustment", ...(action === "SET_CONTROLS" && extra.subscriptionEnabled === true ? { planId } : {}), ...extra };
  return { ...await request(url(id), body, auth), body };
}
async function access(auth = tenantCookie) { return (await request("/api/billing/status", undefined, auth)).data.access; }
async function report(id = orgId) { return (await request(`/api/super-admin/organizations/${id}`)).data.organization; }
async function paid(status = "ACTIVE", proof = true, until = new Date(now.getTime() + 30 * day)) {
  await db.organization.update({ where: { id: orgId }, data: { trialExpiresAt: new Date(now.getTime() - 1) } });
  return db.subscription.create({ data: { organizationId: orgId, planId, providerPlanId: "plan_access_fixture", providerSubscriptionId: `sub_${randomUUID().replaceAll("-", "")}`, status, amountMinor: 10000, currency: "INR", interval: "MONTHLY", totalCount: 12,
    currentPeriodStart: new Date(now.getTime() - day), currentPeriodEnd: until, paidUntil: until, nextBillingAt: until, lastSyncedAt: now,
    ...(proof ? { payments: { create: { providerPaymentId: `pay_${randomUUID()}`, providerInvoiceId: `inv_${randomUUID()}`, amountMinor: 10000, currency: "INR", status: "captured", paidAt: now } } } : {}),
  } });
}
before(async () => {
  hash = await hashPassword("Access fixture passphrase");
  await db.billingPlan.create({ data: { id: planId, name: "Access fixture plan", interval: "MONTHLY", amountMinor: 10000, currency: "INR", totalCount: 12 } });
});
beforeEach(async () => {
  now = new Date();
  const org = await organization("Access controls fixture"), other = await organization("Unaffected organization fixture");
  orgId = org.id; tenantCookie = org.cookie; otherId = other.id; otherCookie = other.cookie;
  const employee = await db.user.create({ data: { organizationId: orgId, fullName: "Employee fixture", email: `${randomUUID()}@example.test`, passwordHash: hash, role: "EMPLOYEE" } });
  const employeeSession = newSession(); await db.session.create({ data: { userId: employee.id, tokenHash: employeeSession.tokenHash, expiresAt: employeeSession.expiresAt } }); employeeCookie = `hrms_session=${employeeSession.token}`;
  actorId = (await db.superAdmin.create({ data: { fullName: "Access fixture super admin", email: `${randomUUID()}@example.test`, passwordHash: hash } })).id;
  secondActorId = (await db.superAdmin.create({ data: { fullName: "Second access operator", email: `${randomUUID()}@example.test`, passwordHash: hash } })).id;
  cookie = await platformSession(actorId); secondCookie = await platformSession(secondActorId);
  server = createApp(db, { frontendOrigin: origin, production: false }, { clock: () => now, graceHours: 2 }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.organizationAccessAudit.deleteMany({ where: { organizationId: { in: [orgId, otherId] } } });
  await db.organization.deleteMany({ where: { id: { in: [orgId, otherId] } } });
  await db.superAdminAuditEvent.deleteMany({ where: { actorSuperAdminId: { in: [actorId, secondActorId] } } });
  await db.superAdmin.deleteMany({ where: { id: { in: [actorId, secondActorId] } } });
});
after(async () => { await db.billingPlan.deleteMany({ where: { id: planId } }); await db.$disconnect(); });

it("saves independent access switches atomically and retains disabled dates without provider fallback", async () => {
  const provider = await paid();
  const dates = { trialExpiresAt: new Date(now.getTime() + 5 * day).toISOString(), startsAt: new Date(now.getTime() - day).toISOString(), expiresAt: new Date(now.getTime() + 2 * day).toISOString() };
  const saved = await change("SET_CONTROLS", { trialEnabled: true, subscriptionEnabled: true, ...dates, reason: undefined });
  assert.equal(saved.status, 200);
  assert.equal((await access()).source, "MANUAL"); assert.equal((await report()).accessSource, "MANUAL");
  now = new Date(dates.expiresAt);
  assert.equal((await access()).source, "TRIAL"); assert.equal((await report()).classification, "TRIALING");
  assert.equal((await change("SET_CONTROLS", { trialEnabled: false, subscriptionEnabled: false })).status, 200);
  assert.equal((await access()).allowed, false); assert.equal((await access()).state, "SUSPENDED");
  assert.equal((await access()).checkoutAllowed, true, "Disabling access must preserve the ability to purchase without a trial");
  assert.equal((await report()).accessAllowed, false); assert.equal((await report()).classification, "SUSPENDED");
  assert.equal((await request("/api/organization", undefined, tenantCookie)).status, 402);
  const disabled = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  assert.equal(disabled.manualAccessExpiresAt!.toISOString(), dates.expiresAt);
  assert.equal(disabled.trialExpiresAt!.toISOString(), dates.trialExpiresAt);
  assert.equal((await change("SET_CONTROLS", { trialEnabled: true, subscriptionEnabled: false, trialExpiresAt: dates.trialExpiresAt })).status, 200);
  assert.equal((await access()).source, "TRIAL");
  assert.equal((await report()).classification, "TRIALING");
  const reloaded = (await request(url())).data;
  assert.equal(reloaded.organization.trialEnabled, true);
  assert.equal(reloaded.organization.subscriptionEnabled, false);
  assert.equal(reloaded.access.source, "TRIAL");
  now = new Date(dates.trialExpiresAt);
  assert.equal((await access()).allowed, false); assert.equal((await report()).accessAllowed, false);
  const unchanged = await db.subscription.findUniqueOrThrow({ where: { id: provider.id } });
  assert.equal(unchanged.paidUntil!.getTime(), provider.paidUntil!.getTime());
  assert.equal(await db.billingPayment.count({ where: { subscriptionId: provider.id } }), 1);
  const history = (await request(url())).data.history.items;
  assert.equal(history.filter((event: { outcome: string }) => event.outcome === "SUCCESS").length, 3);
  assert.equal(history[0].after.trialEnabled, true); assert.equal(history[0].after.subscriptionEnabled, false);
  const replay = await request(url(), saved.body); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true);
});
it("enforces subscription-only date boundaries even when trial and provider time remain", async () => {
  await paid();
  const startsAt = new Date(now.getTime() + day).toISOString(), expiresAt = new Date(now.getTime() + 3 * day).toISOString();
  assert.equal((await change("SET_CONTROLS", { trialEnabled: false, subscriptionEnabled: true, startsAt, expiresAt })).status, 200);
  assert.equal((await access()).state, "ADMIN_SCHEDULED"); assert.equal((await access()).allowed, false);
  assert.equal((await report()).accessAllowed, false);
  now = new Date(startsAt);
  assert.equal((await access()).source, "MANUAL"); assert.equal((await report()).accessAllowed, true);
  now = new Date(expiresAt);
  assert.equal((await access()).allowed, false); assert.equal((await report()).accessAllowed, false);
});
it("keeps existing paid renewals and grace from overriding a saved trial-only policy", async () => {
  const sub = await paid();
  const end = new Date(now.getTime() + 3 * day).toISOString();
  assert.equal((await change("SET_CONTROLS", { trialEnabled: true, subscriptionEnabled: false, trialExpiresAt: end })).status, 200);
  const original = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
  // A later provider synchronization must not undo the admin's access decision.
  await db.subscription.update({ where: { id: sub.id }, data: { paidUntil: new Date(now.getTime() + 60 * day), lastSyncedAt: now } });
  assert.equal((await access()).source, "TRIAL"); assert.equal((await report()).accessSource, "TRIAL");
  assert.equal((await access(employeeCookie)).source, "TRIAL");
  now = new Date(end);
  assert.equal((await access()).allowed, false); assert.equal((await report()).accessAllowed, false);
  assert.equal((await request("/api/organization", undefined, tenantCookie)).status, 402);
  await db.subscription.update({ where: { id: sub.id }, data: { status: "HALTED", paidUntil: new Date(now.getTime() - 3600000) } });
  assert.equal((await access()).allowed, false); assert.equal((await report()).accessAllowed, false);
  assert.deepEqual((await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).commercialTerms, original.commercialTerms);
  assert.equal(await db.billingPayment.count({ where: { subscriptionId: sub.id } }), 1);
});
it("allows a purchase under the current trial policy but a later admin save overrides it", async () => {
  const end = new Date(now.getTime() + 4 * day).toISOString();
  await change("SET_CONTROLS", { trialEnabled: true, subscriptionEnabled: false, trialExpiresAt: end });
  const policy = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  const sub = await paid();
  await db.organization.update({ where: { id: orgId }, data: { trialExpiresAt: new Date(end) } });
  await db.subscription.update({ where: { id: sub.id }, data: { commercialTerms: { accessPolicyVersion: policy.accessVersion } } });
  assert.equal((await access()).source, "SUBSCRIPTION"); assert.equal((await report()).accessSource, "SUBSCRIPTION");
  await change("SET_CONTROLS", { trialEnabled: true, subscriptionEnabled: false, trialExpiresAt: end });
  assert.equal((await access()).source, "TRIAL"); assert.equal((await report()).accessSource, "TRIAL");
  assert.equal((await db.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status, "ACTIVE");
});
it("rejects missing or inverted enabled dates and dates on disabled options without partial updates", async () => {
  for (const extra of [
    { trialEnabled: true, subscriptionEnabled: false },
    { trialEnabled: false, subscriptionEnabled: true },
    { trialEnabled: false, subscriptionEnabled: false, expiresAt: now.toISOString() },
    { trialEnabled: false, subscriptionEnabled: false, trialExpiresAt: now.toISOString() },
    { trialEnabled: true, subscriptionEnabled: false, trialExpiresAt: new Date(now.getTime() - 2 * day).toISOString() },
    { trialEnabled: false, subscriptionEnabled: true, startsAt: now.toISOString(), expiresAt: now.toISOString() },
  ]) assert.equal((await change("SET_CONTROLS", extra)).status, 400);
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  assert.equal(org.accessVersion, 0); assert.equal(org.accessMode, "AUTO");
  assert.equal(await db.organizationAccessAudit.count({ where: { organizationId: orgId, outcome: "SUCCESS" } }), 0);
});
it("requires an active platform session, CSRF, strict organization-scoped input and a reason", async () => {
  const body = { action: "SUSPEND", expectedVersion: 0, requestId: randomUUID(), reason: "Support investigation" };
  for (const auth of ["", tenantCookie, employeeCookie]) {
    assert.equal((await request(url(), undefined, auth)).status, 401);
    assert.equal((await request(url(), body, auth)).status, 401);
  }
  assert.equal((await request(url(), body, cookie, false)).status, 403);
  for (const extra of [{ reason: "" }, { expectedVersion: -1 }, { requestId: "invalid" }, { organizationId: otherId }, { actorSuperAdminId: secondActorId }, { paidUntil: now.toISOString() }])
    assert.equal((await request(url(), { ...body, ...extra })).status, 400);
  await db.superAdmin.update({ where: { id: actorId }, data: { authVersion: { increment: 1 } } });
  assert.equal((await request(url(), body)).status, 401);
  assert.equal((await db.organization.findUniqueOrThrow({ where: { id: orgId } })).accessVersion, 0);
});
it("extends trials beyond seven days without changing the start and enforces exact expiry in APIs and reports", async () => {
  const before = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  assert.equal((await change("EXTEND_TRIAL", { days: 10 })).status, 200);
  const after = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  assert.equal(after.trialStartedAt?.getTime(), before.trialStartedAt?.getTime());
  assert.equal(after.trialExpiresAt?.getTime(), before.trialExpiresAt!.getTime() + 10 * day);
  now = new Date(before.trialStartedAt!.getTime() + 8 * day);
  assert.equal((await access()).allowed, true); assert.equal((await access()).source, "TRIAL");
  assert.equal((await request("/api/organization", undefined, tenantCookie)).status, 200);
  assert.equal((await report()).trialEnd, after.trialExpiresAt!.toISOString()); assert.equal((await report()).accessAllowed, true);
  now = after.trialExpiresAt!;
  assert.equal((await access()).allowed, false); assert.equal((await report()).accessAllowed, false);
  assert.equal((await request("/api/organization", undefined, tenantCookie)).status, 402);
});
it("shortens trial dates and adds days from now for expired trials while preserving original dates", async () => {
  const before = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  assert.equal((await change("TRIAL_END", { expiresAt: new Date(now.getTime() - 1).toISOString() })).status, 200);
  assert.equal((await access()).allowed, false);
  assert.equal((await change("EXTEND_TRIAL", { days: 3 })).status, 200);
  const after = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  assert.equal(after.trialExpiresAt?.getTime(), now.getTime() + 3 * day);
  assert.equal(after.trialStartedAt?.getTime(), before.trialStartedAt?.getTime());
  assert.equal((await change("TRIAL_END", { expiresAt: before.trialStartedAt!.toISOString() })).status, 400);
  assert.equal((await db.organization.findUniqueOrThrow({ where: { id: orgId } })).accessVersion, 2);
});
it("enforces manual start-inclusive and end-exclusive dates and keeps other organizations independent", async () => {
  const start = new Date(now.getTime() + day), end = new Date(now.getTime() + 2 * day);
  assert.equal((await change("MANUAL", { startsAt: start.toISOString(), expiresAt: end.toISOString() })).status, 200);
  assert.equal((await access()).state, "ADMIN_SCHEDULED"); assert.equal((await access()).allowed, false);
  assert.equal((await report()).classification, "ADMIN_SCHEDULED"); assert.equal((await report()).accessAllowed, false);
  now = start;
  assert.equal((await access()).allowed, true); assert.equal((await access()).source, "MANUAL");
  assert.equal((await report()).classification, "ADMIN_ACTIVE"); assert.equal((await report()).accessSource, "MANUAL");
  now = end;
  assert.equal((await access()).allowed, false); assert.equal((await report()).classification, "ADMIN_EXPIRED");
  assert.equal((await access(otherCookie)).allowed, true);
  assert.equal(await db.subscription.count({ where: { organizationId: orgId } }), 0);
  assert.equal(await db.billingPayment.count({ where: { subscription: { organizationId: orgId } } }), 0);
});
it("lets admin-managed dates shorten paid eligibility without altering provider records and survives later synchronization", async () => {
  const sub = await paid(), payments = await db.billingPayment.findMany({ where: { subscriptionId: sub.id } });
  assert.equal((await access()).source, "SUBSCRIPTION");
  assert.equal((await change("MANUAL", { startsAt: now.toISOString(), expiresAt: new Date(now.getTime() + 2 * day).toISOString() })).status, 200);
  now = new Date(now.getTime() + 3 * day);
  assert.equal((await access()).allowed, false); assert.equal((await report()).accessAllowed, false);
  assert.deepEqual(await db.subscription.findUniqueOrThrow({ where: { id: sub.id } }), sub);
  assert.deepEqual(await db.billingPayment.findMany({ where: { subscriptionId: sub.id } }), payments);
  await db.subscription.update({ where: { id: sub.id }, data: { paidUntil: new Date(now.getTime() + 60 * day), currentPeriodEnd: new Date(now.getTime() + 60 * day), lastSyncedAt: now } });
  assert.equal((await access()).allowed, false, "Provider updates cannot override a manual end date");
  assert.equal((await change("RESTORE")).status, 200); assert.equal((await access()).allowed, true); assert.equal((await access()).source, "SUBSCRIPTION");
});
it("suspension overrides paid, trial, manual and employee access while preserving login, billing and recovery", async () => {
  await paid();
  assert.equal((await change("SUSPEND")).status, 200);
  assert.equal((await access()).state, "SUSPENDED"); assert.equal((await access()).allowed, false);
  assert.equal((await access(employeeCookie)).allowed, false); assert.equal((await access(otherCookie)).allowed, true);
  assert.equal((await report()).classification, "SUSPENDED"); assert.equal((await report()).accessAllowed, false);
  assert.equal((await request("/api/organization", undefined, tenantCookie)).status, 402);
  for (const path of ["/api/auth/me", "/api/billing/status", "/api/billing/history", "/api/auth/verification-status"]) assert.equal((await request(path, undefined, tenantCookie)).status, 200);
  assert.equal((await request("/api/billing/checkout", { planId }, tenantCookie)).data.code, "ORGANIZATION_SUSPENDED");
  assert.equal((await change("EXTEND_TRIAL", { days: 20 })).status, 200);
  assert.equal((await access()).allowed, false, "Editing a trial cannot remove suspension");
  assert.equal((await change("RESTORE")).status, 200); assert.equal((await access()).allowed, true);
  await change("MANUAL", { startsAt: now.toISOString(), expiresAt: new Date(now.getTime() + day).toISOString() });
  await change("SUSPEND"); assert.equal((await access()).allowed, false);
});
it("records immutable before/after snapshots and safely replays identical requests", async () => {
  const result = await change("EXTEND_TRIAL", { days: 2, reason: "Customer support approved two days" });
  assert.equal(result.status, 200);
  const event = await db.organizationAccessAudit.findUniqueOrThrow({ where: { id: result.data.auditId } });
  assert.equal(event.actorSuperAdminId, actorId); assert.equal(event.organizationId, orgId); assert.equal(event.actorName, "Access fixture super admin");
  assert.equal((event.before as { accessVersion: number }).accessVersion, 0); assert.equal((event.after as { accessVersion: number }).accessVersion, 1);
  assert.equal(JSON.stringify(event).includes("passwordHash"), false); assert.equal(JSON.stringify(event).includes("tokenHash"), false);
  const replay = await request(url(), result.body); assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true);
  assert.equal(await db.organizationAccessAudit.count({ where: { organizationId: orgId, outcome: "SUCCESS" } }), 1);
  assert.equal((await db.organization.findUniqueOrThrow({ where: { id: orgId } })).accessVersion, 1);
  assert.equal((await request(url(), { ...result.body, reason: "Different request content" })).status, 409);
  assert.equal((await request(url(), result.body)).data.replayed, true, "A rejected conflicting payload cannot poison a successful request replay");
  assert.equal((await request(url(otherId), result.body)).status, 409);
  for (const method of ["PUT", "PATCH", "DELETE"]) assert.equal((await request(url(), {}, cookie, true, method)).status, 404);
  assert.deepEqual(await db.organizationAccessAudit.findUniqueOrThrow({ where: { id: event.id } }), event);
});
it("rejects conflicting administrators without losing an update and audits the rejected attempt", async () => {
  const base = { expectedVersion: 0, reason: "Concurrent support decision" };
  const results = await Promise.all([
    request(url(), { ...base, action: "SUSPEND", requestId: randomUUID() }),
    request(url(), { ...base, action: "EXTEND_TRIAL", days: 5, requestId: randomUUID() }, secondCookie),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await db.organization.findUniqueOrThrow({ where: { id: orgId } })).accessVersion, 1);
  assert.equal(await db.organizationAccessAudit.count({ where: { organizationId: orgId, outcome: "SUCCESS" } }), 1);
  assert.equal(await db.organizationAccessAudit.count({ where: { organizationId: orgId, outcome: "FAILED", failureCode: "ACCESS_CONFLICT" } }), 1);
});
it("rolls back access and revision changes when the success audit cannot be written", async () => {
  const extended = db.$extends({ query: { organizationAccessAudit: { async create() { throw new Error("Simulated audit storage failure"); } } } });
  const service = new OrganizationAccessService(extended as unknown as PrismaClient, new AccessPolicy(db, () => now), () => now);
  const before = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  await assert.rejects(service.change(orgId, actorId, cookie.slice("hrms_platform_session=".length), { action: "SUSPEND", expectedVersion: 0, requestId: randomUUID(), reason: "Audit atomicity fixture" }));
  assert.deepEqual(await db.organization.findUniqueOrThrow({ where: { id: orgId } }), before);
  assert.equal(await db.organizationAccessAudit.count({ where: { organizationId: orgId, outcome: "SUCCESS" } }), 0);
});
it("requires captured-payment proof for automatic paid/grace access and keeps report results aligned", async () => {
  const sub = await paid("HALTED", false, new Date(now.getTime() - 3600000));
  assert.equal((await access()).allowed, false); assert.equal((await report()).accessAllowed, false);
  await db.billingPayment.create({ data: { subscriptionId: sub.id, providerPaymentId: `pay_${randomUUID()}`, providerInvoiceId: `inv_${randomUUID()}`, amountMinor: 10000, currency: "INR", status: "captured", paidAt: now } });
  assert.equal((await access()).source, "GRACE"); assert.equal((await access()).allowed, true);
  assert.equal((await report()).accessSource, "GRACE"); assert.equal((await report()).accessAllowed, true);
  await change("SUSPEND"); assert.equal((await access()).allowed, false); assert.equal((await report()).accessAllowed, false);
});
it("rejects invalid manual windows and retains bounded history after organization deletion", async () => {
  const before = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  assert.equal((await change("MANUAL", { startsAt: now.toISOString(), expiresAt: now.toISOString() })).status, 400);
  assert.deepEqual(await db.organization.findUniqueOrThrow({ where: { id: orgId } }), before);
  for (let index = 0; index < 21; index++) assert.equal((await change(index % 2 ? "RESTORE" : "SUSPEND")).status, 200);
  const history = (await request(url())).data.history;
  assert.equal(history.items.length, 20); assert.equal(history.total, 22);
  assert.equal((await request(url() + "?page=2")).data.history.items.length, 2);
  await db.organization.delete({ where: { id: orgId } });
  assert.equal(await db.organizationAccessAudit.count({ where: { organizationId: orgId } }), 22);
});

it("assigns and audits a catalog plan without creating payment records", async () => {
  const dates = { trialEnabled: false, subscriptionEnabled: true, startsAt: now.toISOString(), expiresAt: new Date(now.getTime() + day).toISOString() };
  assert.equal((await change("SET_CONTROLS", dates)).status, 200);
  const settings = (await request(url())).data;
  assert.ok(settings.plans.some((plan: { id: string }) => plan.id === planId));
  assert.deepEqual(settings.organization.manualAccessPlan, { id: planId, name: "Access fixture plan", interval: "MONTHLY" });
  assert.deepEqual((await access()).manualAccess.plan, settings.organization.manualAccessPlan);
  assert.equal((await report()).manualPlanName, "Access fixture plan");
  assert.equal((await report()).manualPlanCycle, "MONTHLY");
  assert.deepEqual(settings.history.items[0].after.manualAccessPlan, settings.organization.manualAccessPlan);
  assert.equal((await access(otherCookie)).manualAccess, null);
  assert.equal(await db.subscription.count({ where: { organizationId: orgId } }), 0);
  assert.equal(await db.billingPayment.count({ where: { subscription: { organizationId: orgId } } }), 0);
  await db.billingPlan.update({ where: { id: planId }, data: { name: "Renamed catalog plan" } });
  try {
    assert.equal((await access()).manualAccess.plan.name, "Access fixture plan");
    assert.equal((await change("SET_CONTROLS", { trialEnabled: false, subscriptionEnabled: false })).status, 200);
    assert.deepEqual((await request(url())).data.organization.manualAccessPlan, settings.organization.manualAccessPlan);
  } finally { await db.billingPlan.update({ where: { id: planId }, data: { name: "Access fixture plan" } }); }
});
it("rejects missing, unknown, disabled or off-toggle plans atomically", async () => {
  const dates = { trialEnabled: false, subscriptionEnabled: true, startsAt: now.toISOString(), expiresAt: new Date(now.getTime() + day).toISOString() };
  const original = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  for (const selected of [undefined, "nonexistent-admin-plan"]) {
    const result = await change("SET_CONTROLS", { ...dates, planId: selected });
    assert.equal(result.status, 400); assert.equal(result.data.code, "INVALID_ACCESS_PLAN");
  }
  await db.billingPlan.update({ where: { id: planId }, data: { enabled: false } });
  try {
    assert.equal((await change("SET_CONTROLS", dates)).data.code, "INVALID_ACCESS_PLAN");
    assert.equal((await request(url())).data.plans.some((plan: { id: string }) => plan.id === planId), false);
  } finally { await db.billingPlan.update({ where: { id: planId }, data: { enabled: true } }); }
  assert.equal((await change("SET_CONTROLS", { trialEnabled: false, subscriptionEnabled: false, planId })).data.code, "INVALID_ACCESS_PLAN");
  assert.deepEqual(await db.organization.findUniqueOrThrow({ where: { id: orgId } }), original);
});

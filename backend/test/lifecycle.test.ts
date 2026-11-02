import "dotenv/config";
import assert from "node:assert/strict";
import { before, after, beforeEach, describe, it } from "node:test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/server";
import type { Mailer, MailMessage } from "../src/services/mail";
import { ServiceError } from "../src/services/errors";
import {
  validSignature,
  type PaymentProvider,
  type RemotePlan,
  type RemoteInvoice,
  type RemotePayment,
  type RemoteSubscription,
} from "../src/billing/provider";
import { hashToken, newSession, TRIAL_MS } from "../src/auth/security";
import { hashPassword } from "../src/auth/password";
import { BillingService } from "../src/billing/service";
import { reconcileDue } from "../src/billing/reconciler";

if (process.env.NODE_ENV === "production")
  throw new Error("Integration fixtures must not run in production.");
const db = new PrismaClient(),
  run = randomUUID().replaceAll("-", "");
const password = `A lifecycle test passphrase ${randomUUID()}`;
let now = new Date(),
  server: Server,
  base = "",
  sequence = 0;
const organizations: string[] = [];
const planIds = [`test-monthly-${run}`, `test-yearly-${run}`];
const origin = "http://localhost:3000";
class TestMailer implements Mailer {
  available = true;
  fail = false;
  delay = 0;
  messages: MailMessage[] = [];
  async send(message: MailMessage) {
    if (this.delay)
      await new Promise((resolve) => setTimeout(resolve, this.delay));
    if (this.fail)
      throw new ServiceError(
        "EMAIL_UNAVAILABLE",
        503,
        "Test SMTP rejected delivery.",
      );
    this.messages.push(message);
  }
  token(email: string, subject: string) {
    const message = [...this.messages]
      .reverse()
      .find((item) => item.to === email && item.subject.includes(subject));
    const token = message?.text.match(/#token=([a-f0-9]{64})/)?.[1];
    assert.ok(token, "Test mail should contain an in-memory link");
    return token;
  }
  otp(email: string) {
    const message = [...this.messages]
      .reverse()
      .find((item) => item.to === email && item.subject.includes("reset code"));
    const code = message?.text.match(/code is: (\d{8})/)?.[1];
    assert.ok(code, "Test mail should contain an eight-digit reset OTP");
    return code;
  }
}
class TestProvider implements PaymentProvider {
  available = true;
  keyId = "rzp_test_fixture";
  mode = "test" as const;
  secret = randomBytes(32).toString("hex");
  webhookSecret = randomBytes(32).toString("hex");
  fail = false;
  createCount = 0;
  cancelCount = 0;
  plans = new Map<string, RemotePlan>();
  subscriptions = new Map<string, RemoteSubscription>();
  invoiceRows = new Map<string, RemoteInvoice[]>();
  paymentRows = new Map<string, RemotePayment>();
  private check() {
    if (this.fail)
      throw new ServiceError(
        "PROVIDER_UNAVAILABLE",
        503,
        "Test provider unavailable.",
      );
  }
  async fetchPlan(id: string) {
    this.check();
    return structuredClone(this.plans.get(id)!);
  }
  async createSubscription(
    planId: string,
    _cycles: number,
    reference: string,
    organizationId: string,
  ) {
    this.check();
    this.createCount++;
    const row: RemoteSubscription = {
      id: `sub_${run}_${this.createCount}`,
      plan_id: planId,
      status: "created",
      current_start: null,
      current_end: null,
      paid_count: 0,
      notes: { localSubscriptionId: reference, organizationId },
    };
    this.subscriptions.set(row.id, row);
    return structuredClone(row);
  }
  async fetchSubscription(id: string) {
    this.check();
    return structuredClone(this.subscriptions.get(id)!);
  }
  async findSubscription(reference: string) {
    this.check();
    return structuredClone(
      [...this.subscriptions.values()].find(
        (item) => item.notes.localSubscriptionId === reference,
      ) || null,
    );
  }
  async invoices(id: string) {
    this.check();
    return structuredClone(this.invoiceRows.get(id) || []);
  }
  async payment(id: string) {
    this.check();
    return structuredClone(this.paymentRows.get(id)!);
  }
  async invoice(id: string) {
    this.check();
    const invoice = [...this.invoiceRows.values()]
      .flat()
      .find((row) => row.id === id);
    if (!invoice) throw new Error("Fixture invoice missing");
    return structuredClone(invoice);
  }
  async cancel(id: string, atCycleEnd: boolean) {
    this.check();
    this.cancelCount++;
    const row = this.subscriptions.get(id)!;
    if (atCycleEnd) row.has_scheduled_changes = true;
    else row.status = "cancelled";
    return structuredClone(row);
  }
  verifyCheckout(paymentId: string, subscriptionId: string, signature: string) {
    return validSignature(
      `${paymentId}|${subscriptionId}`,
      signature,
      this.secret,
    );
  }
  verifyWebhook(body: Buffer, signature: string) {
    return validSignature(body, signature, this.webhookSecret);
  }
  charge(id: string, status = "captured", refunded = false) {
    const row = this.subscriptions.get(id)!,
      plan = this.plans.get(row.plan_id)!;
    const start = Math.floor(now.getTime() / 1000),
      end = start + (plan.period === "monthly" ? 30 : 365) * 86400;
    row.status = status === "captured" ? "active" : "pending";
    row.current_start = start;
    row.current_end = end;
    row.charge_at = end;
    if (status === "captured") row.paid_count++;
    const paymentId = `pay_${randomUUID().replaceAll("-", "")}`,
      invoiceId = `inv_${randomUUID().replaceAll("-", "")}`;
    const payment: RemotePayment = {
      id: paymentId,
      invoice_id: invoiceId,
      status,
      amount: plan.item.amount,
      currency: plan.item.currency,
      amount_refunded: refunded ? plan.item.amount : 0,
      created_at: start,
    };
    const invoice: RemoteInvoice = {
      id: invoiceId,
      subscription_id: id,
      payment_id: paymentId,
      status: status === "captured" ? "paid" : "issued",
      currency: plan.item.currency,
      amount_paid: status === "captured" ? plan.item.amount : 0,
      billing_start: start,
      billing_end: end,
      issued_at: start,
      created_at: start,
    };
    this.paymentRows.set(paymentId, payment);
    this.invoiceRows.set(id, [...(this.invoiceRows.get(id) || []), invoice]);
    return paymentId;
  }
}
const mailer = new TestMailer(),
  provider = new TestProvider();
async function request(path: string, body?: unknown, cookie?: string) {
  if (path === "/api/billing/checkout" && body && typeof body === "object" && "planId" in body) {
    const input = body as { planId: string; period?: string };
    const quoted = await request("/api/billing/quote", { ...input, period: input.period || (String(input.planId).includes("yearly") ? "yearly" : "monthly") }, cookie);
    if (quoted.status !== 201) return quoted;
    body = { quoteId: quoted.data.quote.id };
  }
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      Origin: origin,
      "X-HRMS-Request": "1",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
  };
}
async function account(verified = false, requestVerification = true) {
  const email = `lifecycle-${run}-${++sequence}@example.test`;
  const messagesBefore = mailer.messages.length;
  // Existing unverified accounts remain supported; signup OTP is tested separately.
  const org = await db.organization.create({ data: { name: `Lifecycle ${run}`, trialStartedAt: now, trialExpiresAt: new Date(now.getTime() + TRIAL_MS), users: { create: { fullName: "Test Administrator", email, passwordHash: await hashPassword(password), role: "ORGANIZATION_ADMIN" } } }, include: { users: true } });
  const session = newSession();
  await db.session.create({ data: { userId: org.users[0]!.id, tokenHash: session.tokenHash, expiresAt: session.expiresAt } });
  organizations.push(org.id);
  assert.equal(mailer.messages.length, messagesBefore);
  const value = {
    email,
    userId: org.users[0]!.id,
    organizationId: org.id,
    cookie: `hrms_session=${session.token}`,
  };
  if (requestVerification && mailer.available && !mailer.fail) {
    assert.equal((await request("/api/auth/verification/request", {}, value.cookie)).status, 200);
  }
  if (verified) {
    const confirmed = await request("/api/auth/verification/confirm", {
          token: mailer.token(email, "Verify"),
        });
    assert.equal(confirmed.status, 200);
    value.cookie = confirmed.cookie;
  }
  return value;
}
async function expire(organizationId: string) {
  await db.organization.update({
    where: { id: organizationId },
    data: {
      trialStartedAt: new Date(now.getTime() - TRIAL_MS - 1000),
      trialExpiresAt: new Date(now.getTime() - 1000),
    },
  });
}
async function checkout(cookie: string, interval = "MONTHLY") {
  const result = await request(
    "/api/billing/checkout",
    { planId: planIds[interval === "MONTHLY" ? 0 : 1] },
    cookie,
  );
  assert.equal(result.status, 200);
  return result.data.checkout as {
    subscriptionId: string;
    providerSubscriptionId: string;
  };
}
async function webhook(
  remoteId: string,
  type = "subscription.charged",
  eventId = `evt_${randomUUID().replaceAll("-", "")}`,
  signature?: string,
  paymentId?: string,
) {
  const body = Buffer.from(
    JSON.stringify({
      event: type,
      payload: {
        ...(paymentId
          ? {
              payment: {
                entity: {
                  id: paymentId,
                  invoice_id:
                    provider.paymentRows.get(paymentId)?.invoice_id || null,
                },
              },
            }
          : {}),
        subscription: {
          entity: {
            id: remoteId,
            notes: provider.subscriptions.get(remoteId)?.notes || {},
          },
        },
      },
    }),
  );
  const response = await fetch(`${base}/api/billing/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-event-id": eventId,
      "x-razorpay-signature":
        signature ||
        createHmac("sha256", provider.webhookSecret).update(body).digest("hex"),
    },
    body,
  });
  return { status: response.status, data: await response.json() };
}
async function paymentWebhook(
  paymentId: string,
  type: string,
  eventId = `evt_${randomUUID().replaceAll("-", "")}`,
) {
  const payment = provider.paymentRows.get(paymentId)!;
  const body = Buffer.from(
    JSON.stringify({
      event: type,
      payload: {
        payment: { entity: { id: payment.id, invoice_id: payment.invoice_id } },
      },
    }),
  );
  const response = await fetch(`${base}/api/billing/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-event-id": eventId,
      "x-razorpay-signature": createHmac("sha256", provider.webhookSecret)
        .update(body)
        .digest("hex"),
    },
    body,
  });
  return { status: response.status, data: await response.json() };
}

describe(
  "Email, recovery, trial and billing workflows against MySQL with isolated provider fixtures",
  { concurrency: false },
  () => {
    before(async () => {
      await db.$connect();
      for (const [index, interval] of ["MONTHLY", "YEARLY"].entries()) {
        const providerPlanId = `plan_${run}${index}`;
        provider.plans.set(providerPlanId, {
          id: providerPlanId,
          period: interval.toLowerCase() as "monthly" | "yearly",
          interval: 1,
          item: { amount: index ? 120000 : 12000, currency: "INR" },
        });
        await db.billingPlan.create({
          data: {
            id: planIds[index]!,
            name: `Test fixture ${interval}`,
            interval: interval as "MONTHLY" | "YEARLY",
            amountMinor: index ? 120000 : 12000,
            currency: "INR",
            providerPlanId,
            totalCount: 12,
          },
        });
      }
    });
    beforeEach(async () => {
      now = new Date();
      mailer.available = true;
      mailer.fail = false;
      mailer.delay = 0;
      provider.fail = false;
      // A fresh application isolates each test's rate-limit budget while
      // keeping the real production middleware and limits unchanged.
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      const app = createApp(
        db,
        { frontendOrigin: origin, production: false },
        { clock: () => new Date(now), mailer, provider },
      );
      server = await new Promise<Server>((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      });
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    after(async () => {
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      if (organizations.length)
        await db.organization.deleteMany({
          where: { id: { in: organizations } },
        });
      await db.billingPlan.deleteMany({ where: { id: { in: planIds } } });
      await db.$disconnect();
    });

    it("existing unverified accounts retain dashboard and billing access without SMTP", async () => {
      mailer.available = false;
      const a = await account(false, false);
      assert.equal(
        (await request("/api/auth/me", undefined, a.cookie)).status,
        200,
      );
      assert.equal(
        (await request("/api/organization", undefined, a.cookie)).status,
        200,
      );
      assert.equal(await db.accountToken.count({ where: { userId: a.userId } }), 0);
      assert.equal(
        (await request("/api/billing/status", undefined, a.cookie)).status,
        200,
      );
      assert.equal((await request("/api/auth/verification-status", undefined, a.cookie)).data.verified, false);
    });
    it("accepts a valid verification once, handles already-verified accounts, and rejects replay", async () => {
      const a = await account();
      const token = mailer.token(a.email, "Verify");
      const row = await db.accountToken.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });
      assert.notEqual(row.tokenHash, token);
      const confirmed = await request("/api/auth/verification/confirm", { token });
      assert.equal(confirmed.status, 200);
      assert.match(confirmed.cookie, /^hrms_session=/);
      assert.equal("sessionToken" in confirmed.data, false);
      const oldCookie = a.cookie;
      a.cookie = confirmed.cookie;
      assert.equal((await request("/api/auth/me", undefined, oldCookie)).status, 200);
      assert.equal(
        (await request("/api/auth/verification/confirm", { token })).data.code,
        "TOKEN_USED",
      );
      assert.equal(
        (await request("/api/auth/verification/request", {}, a.cookie)).data
          .alreadyVerified,
        true,
      );
      assert.equal(
        (await request("/api/auth/verification-status", undefined, a.cookie))
          .data.verified,
        true,
      );
      assert.equal(
        (await request("/api/organization", undefined, a.cookie)).status,
        200,
      );
    });
    it("atomically consumes concurrent verification requests", async () => {
      const a = await account();
      const token = mailer.token(a.email, "Verify");
      const results = await Promise.all([
        request("/api/auth/verification/confirm", { token }),
        request("/api/auth/verification/confirm", { token }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      assert.equal(await db.session.count({ where: { userId: a.userId, authVersion: { gte: 0 } } }), 2);
      assert.equal(await db.session.count({ where: { userId: a.userId, authVersion: { lt: 0 } } }), 0);
      assert.equal(results.find((r) => r.status === 409)?.cookie, "");
    });
    it("allows unverified login, rotates the session and keeps optional verification available", async () => {
      const a = await account();
      const login = await request("/api/auth/login", { email: a.email, password }, a.cookie);
      assert.equal(login.status, 200);
      assert.equal(login.data.verificationRequired, false);
      assert.match(login.cookie, /^hrms_session=/);
      assert.equal((await request("/api/auth/me", undefined, login.cookie)).status, 200);
      assert.equal((await request("/api/auth/me", undefined, a.cookie)).status, 401);
      const confirmed = await request("/api/auth/verification/confirm", { token: mailer.token(a.email, "Verify") });
      assert.equal(confirmed.status, 200);
      assert.notEqual(confirmed.cookie.split("=")[1], login.cookie.split("=")[1]);
      assert.equal((await request("/api/auth/me", undefined, confirmed.cookie)).data.user.id, a.userId);
      assert.equal((await request("/api/organization", undefined, confirmed.cookie)).status, 200);
      assert.equal((await request("/api/auth/verification-status", undefined, login.cookie)).data.verified, true);
    });
    it("upgrades a legacy verification-only challenge through normal login without changing trial dates", async () => {
      const a = await account(false, false);
      const before = await db.organization.findUniqueOrThrow({ where: { id: a.organizationId } });
      const token = a.cookie.split("=")[1]!;
      await db.session.update({ where: { tokenHash: hashToken(token) }, data: { authVersion: -1 } });
      assert.equal((await request("/api/auth/me", undefined, a.cookie)).status, 401);
      const legacy = a.cookie.replace("hrms_session=", "hrms_verification=");
      const login = await request("/api/auth/login", { email: a.email, password }, legacy);
      assert.equal(login.status, 200);
      assert.match(login.cookie, /^hrms_session=/);
      assert.equal((await request("/api/auth/me", undefined, login.cookie)).status, 200);
      const after = await db.organization.findUniqueOrThrow({ where: { id: a.organizationId } });
      assert.equal(after.trialStartedAt?.getTime(), before.trialStartedAt?.getTime());
      assert.equal(after.trialExpiresAt?.getTime(), before.trialExpiresAt?.getTime());
    });
    it("rejects invalid, malformed and expired verification tokens", async () => {
      const a = await account();
      const token = mailer.token(a.email, "Verify");
      assert.equal(
        (
          await request("/api/auth/verification/confirm", {
            token: "not-a-token",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("/api/auth/verification/confirm", {
            token: "0".repeat(64),
          })
        ).data.code,
        "TOKEN_INVALID",
      );
      now = new Date(now.getTime() + 1440 * 60000 + 1);
      assert.equal(
        (await request("/api/auth/verification/confirm", { token })).data.code,
        "TOKEN_EXPIRED",
      );
      assert.equal(
        (await db.user.findUniqueOrThrow({ where: { id: a.userId } }))
          .emailVerifiedAt,
        null,
      );
    });
    it("resends to the session owner, rotates old tokens and does not extend the trial", async () => {
      const a = await account();
      const original = mailer.token(a.email, "Verify");
      const trial = await db.organization.findUniqueOrThrow({
        where: { id: a.organizationId },
      });
      assert.equal(
        (await request("/api/auth/verification/request", {}, a.cookie)).status,
        429,
      );
      now = new Date(now.getTime() + 61000);
      const result = await request(
        "/api/auth/verification/request",
        { email: "another@example.test", organizationId: "untrusted" },
        a.cookie,
      );
      assert.equal(result.status, 200);
      const latest = mailer.token(a.email, "Verify");
      assert.equal(latest === original, false);
      assert.equal(
        (await request("/api/auth/verification/confirm", { token: original }))
          .status,
        400,
      );
      assert.equal(
        (await request("/api/auth/verification/confirm", { token: latest }))
          .status,
        200,
      );
      assert.equal(
        (
          await db.organization.findUniqueOrThrow({
            where: { id: a.organizationId },
          })
        ).trialExpiresAt!.getTime(),
        trial.trialExpiresAt!.getTime(),
      );
    });
    it("does not claim successful SMTP delivery when configuration is missing or send fails", async () => {
      mailer.available = false;
      const a = await account();
      assert.equal(
        await db.accountToken.count({ where: { userId: a.userId } }),
        0,
      );
      assert.equal(
        (await request("/api/auth/verification/request", {}, a.cookie)).status,
        503,
      );
      const one = await request("/api/auth/forgot-password", {
        email: a.email,
      });
      const two = await request("/api/auth/forgot-password", {
        email: `missing-${run}@example.test`,
      });
      assert.equal(one.status, 503);
      assert.equal(one.data.code, "EMAIL_UNAVAILABLE");
      assert.equal(two.status, 404);
      assert.equal(two.data.code, "ORGANIZATION_ACCOUNT_NOT_FOUND");
      mailer.available = true;
      mailer.fail = true;
      const failedRegistration = await account();
      assert.equal((await request("/api/auth/me", undefined, failedRegistration.cookie)).status, 200);
      assert.equal(
        (await request("/api/auth/verification/request", {}, a.cookie)).status,
        503,
      );
      assert.ok(
        (
          await db.accountToken.findUniqueOrThrow({
            where: {
              userId_purpose: { userId: a.userId, purpose: "VERIFY_EMAIL" },
            },
          })
        ).consumedAt,
      );
    });
    it("rejects unregistered organisation emails without sending mail and accepts registered emails without waiting for slow SMTP", async () => {
      const a = await account(true);
      mailer.delay = 1000;
      const start = Date.now();
      const existing = await request("/api/auth/forgot-password", {
        email: a.email,
      });
      const elapsed = Date.now() - start;
      const absent = await request("/api/auth/forgot-password", {
        email: `absent-${run}@example.test`,
      });
      assert.equal(existing.status, 202);
      assert.equal(absent.status, 404);
      assert.equal(absent.data.code, "ORGANIZATION_ACCOUNT_NOT_FOUND");
      assert.equal(absent.data.message, "No organisation account exists with this email address.");
      assert.ok(
        elapsed < 900,
        "Reset response must not depend on SMTP completion",
      );
      await new Promise((resolve) => setTimeout(resolve, 1050));
      assert.equal(mailer.messages.filter((message) => message.to === `absent-${run}@example.test`).length, 0);
    });
    it("sends organization reset OTPs immediately from email entry and limits only resend to sixty seconds", async () => {
      const a = await account(false, false), b = await account(false, false);
      const initial = await request("/api/auth/forgot-password", { email: a.email });
      assert.equal(initial.status, 202);
      assert.equal(initial.data.resendAvailableAt, new Date(now.getTime() + 60000).toISOString());
      const original = mailer.otp(a.email);
      assert.equal((await request("/api/auth/forgot-password", { email: a.email, resend: true })).status, 429);
      assert.equal((await request("/api/auth/forgot-password", { email: a.email })).status, 202, "Returning to the email form sends immediately even for the same address");
      assert.equal((await request("/api/auth/reset/verify-otp", { email: a.email, code: original })).status, 400);
      const currentA = mailer.otp(a.email);
      assert.equal((await request("/api/auth/forgot-password", { email: b.email })).status, 202, "An edited email starts a fresh request without waiting");
      const currentB = mailer.otp(b.email);
      assert.equal((await request("/api/auth/forgot-password", { email: b.email, resend: true })).status, 429);
      now = new Date(now.getTime() + 59999);
      assert.equal((await request("/api/auth/forgot-password", { email: b.email, resend: true })).status, 429);
      now = new Date(now.getTime() + 1);
      const resent = await request("/api/auth/forgot-password", { email: b.email, resend: true });
      assert.equal(resent.status, 202);
      assert.equal(resent.data.resendAvailableAt, new Date(now.getTime() + 60000).toISOString());
      assert.equal(mailer.messages.at(-1)!.to, b.email);
      assert.equal((await request("/api/auth/reset/verify-otp", { email: b.email, code: currentB })).status, 400);
      assert.equal((await request("/api/auth/reset/verify-otp", { email: b.email, code: mailer.otp(b.email) })).status, 200);
      assert.equal((await request("/api/auth/reset/verify-otp", { email: a.email, code: currentA })).status, 200, "Reset requests for another organization leave the first account's OTP intact");
      assert.equal((await request("/api/auth/forgot-password", { email: b.email, resend: true })).status, 429, "Successful resend restarts the cooldown");
    });
    it("delivers a reset OTP to an unverified address and verifies it only after the OTP is consumed", async () => {
      const a = await account(false, false);
      const count = mailer.messages.length;
      const before = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
      const reset = await request("/api/auth/forgot-password", { email: a.email });
      const absent = await request("/api/auth/forgot-password", { email: `absent-${run}@example.test` });
      assert.equal(reset.status, 202);
      assert.equal(absent.status, 404);
      assert.equal(absent.data.code, "ORGANIZATION_ACCOUNT_NOT_FOUND");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(mailer.messages.length, count + 1);
      const message = mailer.messages.at(-1)!;
      const code = message.text.match(/code is: (\d{8})/)?.[1];
      assert.ok(code, "Reset delivery must contain an eight-digit OTP");
      assert.ok(await db.accountToken.findUnique({ where: { userId_purpose: { userId: a.userId, purpose: "RESET_PASSWORD" } } }));
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: a.userId } })).emailVerifiedAt, null);
      assert.equal((await request("/api/auth/reset-password", { email: a.email, code, password: "newpass8", confirmPassword: "newpass8" })).status, 200);
      const after = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
      assert.notEqual(after.passwordHash, before.passwordHash);
      assert.equal(after.authVersion, before.authVersion + 1);
      assert.ok(after.emailVerifiedAt);
      assert.equal((await request("/api/auth/me", undefined, a.cookie)).status, 401);
    });
    it("still requires authentication and administrator authorization for paid checkout", async () => {
      const a = await account(false, false);
      assert.equal((await request("/api/billing/checkout", { planId: planIds[0] })).status, 401);
      await db.user.update({ where: { id: a.userId }, data: { role: "EMPLOYEE" } });
      assert.equal((await request("/api/billing/checkout", { planId: planIds[0] }, a.cookie)).status, 403);
      assert.equal(await db.subscription.count({ where: { organizationId: a.organizationId } }), 0);
    });
    it("invalidates the undelivered reset token on SMTP rejection and rejects unregistered emails", async () => {
      const a = await account(true);
      mailer.fail = true;
      const result = await request("/api/auth/forgot-password", {
        email: a.email,
      });
      const absent = await request("/api/auth/forgot-password", {
        email: `absent-reject-${run}@example.test`,
      });
      assert.equal(result.status, 202);
      assert.equal(absent.status, 404);
      assert.equal(absent.data.code, "ORGANIZATION_ACCOUNT_NOT_FOUND");
      assert.ok(
        (
          await db.accountToken.findUniqueOrThrow({
            where: {
              userId_purpose: { userId: a.userId, purpose: "RESET_PASSWORD" },
            },
          })
        ).consumedAt,
      );
    });
    it("rejects invalid and expired reset OTPs", async () => {
      const a = await account(true);
      await request("/api/auth/forgot-password", { email: a.email });
      const code = mailer.otp(a.email);
      assert.equal(
        (await request("/api/auth/reset-password", { email: a.email, code: "00000000", password: "newpass8", confirmPassword: "newpass8" })).status,
        400,
      );
      now = new Date(now.getTime() + 31 * 60000);
      assert.equal(
        (await request("/api/auth/reset-password", { email: a.email, code, password: "newpass8", confirmPassword: "newpass8" })).data.code,
        "TOKEN_EXPIRED",
      );
    });
    it("atomically updates the password, consumes the token and revokes all old sessions", async () => {
      const a = await account(true);
      const extra = await request("/api/auth/login", {
        email: a.email,
        password,
      });
      await request("/api/auth/forgot-password", { email: a.email });
      const code = mailer.otp(a.email),
        nextPassword = randomUUID().replaceAll("-", "").slice(0, 8);
      assert.equal(
        (
          await request("/api/auth/reset-password", {
            email: a.email,
            code,
            password: "1234567",
            confirmPassword: "1234567",
          })
        ).status,
        400,
      );
      const result = await request("/api/auth/reset-password", {
        email: a.email,
        code,
        password: nextPassword,
        confirmPassword: nextPassword,
      });
      assert.equal(result.status, 200);
      assert.equal(
        (await request("/api/auth/me", undefined, a.cookie)).status,
        401,
      );
      assert.equal(
        (await request("/api/auth/me", undefined, extra.cookie)).status,
        401,
      );
      assert.equal(
        (
          await request("/api/auth/reset-password", {
            email: a.email,
            code,
            password: nextPassword,
            confirmPassword: nextPassword,
          })
        ).status,
        400,
      );
      assert.equal(
        (await request("/api/auth/login", { email: a.email, password })).status,
        401,
      );
      assert.equal(
        (
          await request("/api/auth/login", {
            email: a.email,
            password: nextPassword,
          })
        ).status,
        200,
      );
      assert.equal(
        (await db.user.findUniqueOrThrow({ where: { id: a.userId } }))
          .authVersion,
        1,
      );
    });
    it("allows only one concurrent reset and keeps the other organization signed in", async () => {
      const a = await account(true),
        b = await account(true);
      await request("/api/auth/forgot-password", { email: a.email });
      const code = mailer.otp(a.email),
        nextPassword = `Concurrent password ${randomUUID()}`;
      const results = await Promise.all([
        request("/api/auth/reset-password", {
          email: a.email,
          code,
          password: nextPassword,
          confirmPassword: nextPassword,
        }),
        request("/api/auth/reset-password", {
          email: a.email,
          code,
          password: nextPassword,
          confirmPassword: nextPassword,
        }),
      ]);
      assert.equal(results.filter((r) => r.status === 200).length, 1);
      assert.equal(await db.session.count({ where: { userId: a.userId } }), 0);
      assert.equal(
        (await request("/api/auth/me", undefined, b.cookie)).status,
        200,
      );
    });
    it("starts an exact seven-day trial and enforces expiry on direct business API calls", async () => {
      const a = await account(true);
      const initial = await request("/api/billing/status", undefined, a.cookie);
      assert.equal(initial.data.access.state, "TRIALING");
      assert.equal(initial.data.access.allowed, true);
      assert.equal(
        Date.parse(initial.data.access.trialExpiresAt) -
          Date.parse(initial.data.access.trialStartedAt),
        TRIAL_MS,
      );
      await expire(a.organizationId);
      const denied = await request(
        `/api/organization?subscriptionStatus=ACTIVE&organizationId=another`,
        undefined,
        a.cookie,
      );
      assert.equal(denied.status, 402);
      assert.equal(denied.data.code, "TRIAL_EXPIRED");
      assert.equal(
        (await request("/api/auth/me", undefined, a.cookie)).status,
        200,
      );
      assert.equal(
        (await request("/api/billing/status", undefined, a.cookie)).status,
        200,
      );
      assert.equal(
        (await request("/api/auth/verification-status", undefined, a.cookie))
          .status,
        200,
      );
    });
    it("does not grant legacy organizations a fresh trial or change dates during login", async () => {
      const a = await account(true);
      await db.organization.update({
        where: { id: a.organizationId },
        data: { trialStartedAt: null, trialExpiresAt: null },
      });
      const login = await request("/api/auth/login", {
        email: a.email,
        password,
      });
      const access = (
        await request("/api/billing/status", undefined, login.cookie)
      ).data.access;
      assert.equal(access.state, "SUBSCRIPTION_REQUIRED");
      assert.equal(access.trialExpiresAt, null);
      assert.equal(
        (await request("/api/organization", undefined, login.cookie)).status,
        402,
      );
      assert.equal(
        (
          await request("/api/auth/register", {
            organizationName: "Attempted new trial",
            fullName: "Other Administrator",
            email: `other-${run}@example.test`,
            password,
            confirmPassword: password,
            organizationId: a.organizationId,
          })
        ).status,
        400,
      );
    });
    it("does not grant paid access merely by initiating checkout and reuses pending checkout", async () => {
      const a = await account(true);
      await expire(a.organizationId);
      const before = provider.createCount;
      const first = await checkout(a.cookie);
      const second = await checkout(a.cookie);
      assert.equal(first.subscriptionId, second.subscriptionId);
      assert.equal(provider.createCount - before, 1);
      assert.equal(
        (await request("/api/billing/status", undefined, a.cookie)).data.access
          .allowed,
        false,
      );
      assert.equal(
        (await request("/api/organization", undefined, a.cookie)).status,
        402,
      );
    });
    it("lets an unpaid customer choose another plan and replaces only the pending authorization on explicit payment", async () => {
      const a = await account(true), first = await checkout(a.cookie);
      const trial = await db.organization.findUniqueOrThrow({ where: { id: a.organizationId } });
      const quote = await request("/api/billing/quote", { planId: planIds[1], period: "yearly" }, a.cookie);
      assert.equal(quote.status, 201); assert.equal(provider.subscriptions.get(first.providerSubscriptionId)!.status, "created", "Selection must not cancel authorization");
      const pending = await request("/api/billing/checkout", { quoteId: quote.data.quote.id }, a.cookie);
      assert.equal(pending.data.code, "REPLACEMENT_PENDING");
      now = new Date(now.getTime() + 61000);
      await new BillingService(db, provider, () => now).reconcile(first.subscriptionId);
      const result = await request("/api/billing/checkout", { quoteId: quote.data.quote.id }, a.cookie);
      assert.equal(result.status, 200); assert.notEqual(result.data.checkout.subscriptionId, first.subscriptionId);
      assert.equal(provider.subscriptions.get(first.providerSubscriptionId)!.status, "cancelled");
      assert.equal((await db.subscription.findUniqueOrThrow({ where: { id: first.subscriptionId } })).status, "CANCELLED");
      assert.equal((await db.organization.findUniqueOrThrow({ where: { id: a.organizationId } })).trialExpiresAt!.getTime(), trial.trialExpiresAt!.getTime());
      assert.equal(await db.billingPayment.count({ where: { subscription: { organizationId: a.organizationId } } }), 0);
      const resumed = await request("/api/billing/checkout", { quoteId: quote.data.quote.id }, a.cookie); assert.equal(resumed.data.checkout.subscriptionId, result.data.checkout.subscriptionId);
    });
    it("does not replace an authorization when provider payment has arrived or cancellation cannot be confirmed", async () => {
      const a = await account(true), first = await checkout(a.cookie), count = provider.createCount;
      provider.charge(first.providerSubscriptionId);
      const denied = await request("/api/billing/checkout", { planId: planIds[1], period: "yearly" }, a.cookie);
      assert.equal(denied.status, 409); assert.equal(provider.createCount, count); assert.equal(provider.subscriptions.get(first.providerSubscriptionId)!.status, "active");
      const b = await account(true), pending = await checkout(b.cookie), cancellations = provider.cancelCount;
      provider.fail = true;
      const failed = await request("/api/billing/checkout", { planId: planIds[1], period: "yearly" }, b.cookie);
      assert.equal(failed.status, 503); assert.equal(provider.cancelCount, cancellations); assert.equal(provider.subscriptions.get(pending.providerSubscriptionId)!.status, "created");
    });
    it("prevents simultaneous checkouts from creating two provider subscriptions", async () => {
      const a = await account(true);
      const before = provider.createCount;
      const results = await Promise.all([
        request("/api/billing/checkout", { planId: planIds[0] }, a.cookie),
        request("/api/billing/checkout", { planId: planIds[0] }, a.cookie),
      ]);
      assert.ok(results.some((r) => r.status === 200));
      assert.equal(provider.createCount - before, 1);
      assert.equal(
        await db.subscription.count({
          where: { organizationId: a.organizationId },
        }),
        1,
      );
    });
    it("validates explicit billing periods and unknown plans before creating subscriptions", async () => {
      const a = await account(true);
      const before = provider.createCount;
      const trial = await db.organization.findUniqueOrThrow({ where: { id: a.organizationId } });
      for (const body of [
        { planId: planIds[0], period: "yearly" },
        { planId: planIds[1], period: "monthly" },
        { planId: planIds[0], period: "weekly" },
        { planId: `unknown-${run}`, period: "monthly" },
        { planId: "../growth-monthly", period: "monthly" },
      ]) assert.equal((await request("/api/billing/checkout", body, a.cookie)).status, 400);
      assert.equal(provider.createCount, before);
      for (const [index, period] of ["monthly", "yearly"].entries()) {
        const b = index ? await account(true) : a;
        const result = await request("/api/billing/checkout", { planId: planIds[index], period }, b.cookie);
        assert.equal(result.status, 200);
        const retry = await request("/api/billing/checkout", { planId: planIds[index], period }, b.cookie);
        assert.equal(result.data.checkout.subscriptionId, retry.data.checkout.subscriptionId);
      }
      const after = await db.organization.findUniqueOrThrow({ where: { id: a.organizationId } });
      assert.equal(after.trialStartedAt?.getTime(), trial.trialStartedAt?.getTime());
      assert.equal(after.trialExpiresAt?.getTime(), trial.trialExpiresAt?.getTime());
    });
    it("authorizes unverified administrators for checkout but rejects client amounts and provider plan IDs", async () => {
      const a = await account(false, false);
      assert.equal(
        (
          await request(
            "/api/billing/checkout",
            { planId: planIds[0] },
            a.cookie,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await request(
            "/api/billing/checkout",
            {
              planId: planIds[0],
              amountMinor: 1,
              providerPlanId: "plan_tampered",
            },
            a.cookie,
          )
        ).status,
        400,
      );
    });
    it("cross-checks provider prices instead of charging a mismatched plan", async () => {
      const a = await account(true);
      const plan = await db.billingPlan.findUniqueOrThrow({
        where: { id: planIds[0] },
      });
      const remote = provider.plans.get(plan.providerPlanId!)!;
      const original = remote.item.amount;
      try {
        remote.item.amount = 1;
        assert.equal(
          (
            await request(
              "/api/billing/checkout",
              { planId: planIds[0] },
              a.cookie,
            )
          ).data.code,
          "PLAN_CONFIGURATION_MISMATCH",
        );
        assert.equal(
          await db.subscription.count({
            where: { organizationId: a.organizationId },
          }),
          0,
        );
      } finally {
        remote.item.amount = original;
      }
    });
    it("rejects invalid callback and webhook signatures without changing paid access", async () => {
      const a = await account(true);
      await expire(a.organizationId);
      const sub = await checkout(a.cookie);
      const paymentId = provider.charge(sub.providerSubscriptionId);
      assert.equal(
        (
          await request(
            "/api/billing/confirm",
            {
              subscriptionId: sub.subscriptionId,
              razorpay_subscription_id: sub.providerSubscriptionId,
              razorpay_payment_id: paymentId,
              razorpay_signature: "0".repeat(64),
            },
            a.cookie,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await webhook(
            sub.providerSubscriptionId,
            "subscription.charged",
            undefined,
            "0".repeat(64),
          )
        ).status,
        400,
      );
      assert.equal(
        (await request("/api/billing/status", undefined, a.cookie)).data.access
          .allowed,
        false,
      );
    });
    it("restores eligible access only after a captured payment is verified and deduplicates webhooks", async () => {
      const a = await account(true);
      await expire(a.organizationId);
      const sub = await checkout(a.cookie);
      provider.charge(sub.providerSubscriptionId);
      const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
      assert.equal(
        (
          await webhook(
            sub.providerSubscriptionId,
            "subscription.charged",
            eventId,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await webhook(
            sub.providerSubscriptionId,
            "subscription.charged",
            eventId,
          )
        ).status,
        200,
      );
      const status = (await request("/api/billing/status", undefined, a.cookie))
        .data.access;
      assert.equal(status.source, "SUBSCRIPTION");
      assert.equal(status.allowed, true);
      assert.equal(
        (await request("/api/organization", undefined, a.cookie)).status,
        200,
      );
      assert.equal(
        await db.billingPayment.count({
          where: { subscriptionId: sub.subscriptionId },
        }),
        1,
      );
      assert.equal(
        await db.billingEvent.count({
          where: { subscriptionId: sub.subscriptionId },
        }),
        1,
      );
    });
    it("allows purchase during an admin-extended trial and activates verified paid access without changing trial dates", async () => {
      const a = await account(true);
      const original = await db.organization.findUniqueOrThrow({ where: { id: a.organizationId } });
      const trialEnd = new Date(now.getTime() + 22 * 86400000);
      await db.organization.update({ where: { id: a.organizationId }, data: { accessMode: "CONTROLLED", trialEnabled: true, subscriptionEnabled: false, trialExpiresAt: trialEnd } });
      const initial = (await request("/api/billing/status", undefined, a.cookie)).data.access;
      assert.equal(initial.checkoutAllowed, true); assert.equal(initial.source, "TRIAL");
      const sub = await checkout(a.cookie);
      assert.equal((await request("/api/billing/status", undefined, a.cookie)).data.access.source, "TRIAL", "Authorization alone must not grant paid access");
      provider.charge(sub.providerSubscriptionId); await webhook(sub.providerSubscriptionId);
      const verified = (await request("/api/billing/status", undefined, a.cookie)).data.access;
      assert.equal(verified.source, "SUBSCRIPTION"); assert.equal(verified.allowed, true);
      const unchanged = await db.organization.findUniqueOrThrow({ where: { id: a.organizationId } });
      assert.equal(unchanged.trialStartedAt!.getTime(), original.trialStartedAt!.getTime());
      assert.equal(unchanged.trialExpiresAt!.getTime(), trialEnd.getTime());
      now = new Date(trialEnd.getTime() + 1);
      assert.equal((await request("/api/billing/status", undefined, a.cookie)).data.access.source, "SUBSCRIPTION");
      assert.equal((await request("/api/organization", undefined, a.cookie)).status, 200);
      now = new Date(verified.subscription.paidUntil);
      assert.equal((await request("/api/billing/status", undefined, a.cookie)).data.access.allowed, false);
      for (const policy of [
        { accessMode: "CONTROLLED", trialEnabled: false, subscriptionEnabled: false },
        { accessMode: "CONTROLLED", trialEnabled: false, subscriptionEnabled: true },
        { accessMode: "MANUAL", trialEnabled: true, subscriptionEnabled: false },
      ]) {
        await db.organization.update({ where: { id: a.organizationId }, data: policy });
        assert.equal((await request("/api/billing/status", undefined, a.cookie)).data.access.checkoutAllowed, false);
        assert.equal((await request("/api/billing/checkout", { planId: planIds[0] }, a.cookie)).data.code, "ADMIN_MANAGED_ACCESS");
      }
    });
    it("binds quotes to the tenant, fixed cycle price and approved terms, and rejects expiry, tampering and stale terms", async () => {
      const a = await account(true), b = await account(true), before = provider.createCount;
      const quoted = await request("/api/billing/quote", { planId: planIds[0], period: "monthly" }, a.cookie);
      assert.equal(quoted.status, 201); const quote = quoted.data.quote;
      assert.equal(quote.amountMinor, 12000); assert.equal(quote.renewalAmountMinor, 12000); assert.equal(quote.totalCount, 12); assert.equal(quote.discountMinor, 0); assert.equal(quote.capacity, null); assert.equal("providerPlanId" in quote, false);
      assert.equal(provider.createCount, before, "Review must not create a provider operation");
      assert.equal((await request(`/api/billing/quote?quoteId=${quote.id}`, undefined, b.cookie)).status, 404);
      assert.equal((await request("/api/billing/checkout", { quoteId: quote.id }, b.cookie)).status, 404);
      assert.equal((await request("/api/billing/checkout", { quoteId: quote.id, amountMinor: 1 }, a.cookie)).status, 400);
      assert.equal((await request("/api/billing/quote", { planId: planIds[0], period: "monthly", capacity: 100 }, a.cookie)).status, 400);
      await db.billingPlan.update({ where: { id: planIds[0] }, data: { name: "Changed fixture terms" } });
      assert.equal((await request("/api/billing/checkout", { quoteId: quote.id }, a.cookie)).data.code, "QUOTE_STALE");
      await db.billingPlan.update({ where: { id: planIds[0] }, data: { name: quote.planName } });
      now = new Date(now.getTime() + 16 * 60000);
      assert.equal((await request("/api/billing/checkout", { quoteId: quote.id }, a.cookie)).data.code, "QUOTE_EXPIRED");
      assert.equal(provider.createCount, before);
      const yearly = await request("/api/billing/quote", { planId: planIds[1], period: "yearly" }, a.cookie);
      assert.equal(yearly.data.quote.amountMinor, 120000); assert.equal(yearly.data.quote.totalCount, 12); assert.ok(yearly.data.quote.terms.includes("12 years"));
    });
    it("reuses concurrent quote checkout and legacy pending subscriptions without changing agreed prices or cycles", async () => {
      const a = await account(true), before = provider.createCount;
      const quote = (await request("/api/billing/quote", { planId: planIds[0], period: "monthly" }, a.cookie)).data.quote;
      const results = await Promise.all([request("/api/billing/checkout", { quoteId: quote.id }, a.cookie), request("/api/billing/checkout", { quoteId: quote.id }, a.cookie)]);
      assert.equal(provider.createCount, before + 1); assert.ok(results.some((result) => result.status === 200)); assert.ok(results.every((result) => [200, 409].includes(result.status)));
      const id = results.find((result) => result.status === 200)!.data.checkout.subscriptionId;
      const stored = await db.subscription.findUniqueOrThrow({ where: { id } }); assert.equal((stored.commercialTerms as { quoteId: string }).quoteId, quote.id);
      await db.subscription.update({ where: { id }, data: { commercialTerms: null } });
      const fresh = (await request("/api/billing/quote", { planId: planIds[0], period: "monthly" }, a.cookie)).data.quote;
      const resumed = await request("/api/billing/checkout", { quoteId: fresh.id }, a.cookie);
      assert.equal(resumed.status, 200); assert.equal(resumed.data.checkout.subscriptionId, id); assert.equal(provider.createCount, before + 1);
      assert.equal((await db.subscription.findUniqueOrThrow({ where: { id } })).totalCount, stored.totalCount);
    });
    it("records observed capture separately from unknown paidAt and makes repeated callbacks safe", async () => {
      const a = await account(true), sub = await checkout(a.cookie);
      const paymentId = provider.charge(sub.providerSubscriptionId, "authorized");
      assert.equal((await webhook(sub.providerSubscriptionId, "payment.authorized", undefined, undefined, paymentId)).status, 200);
      assert.equal((await db.billingPayment.findUniqueOrThrow({ where: { providerPaymentId: paymentId } })).paidAt, null);
      assert.equal((await request(`/api/billing/purchase?subscriptionId=${sub.subscriptionId}`, undefined, a.cookie)).data.purchase.state, "PENDING");
      const payment = provider.paymentRows.get(paymentId)!; payment.status = "captured";
      const invoice = provider.invoiceRows.get(sub.providerSubscriptionId)![0]!; invoice.status = "paid"; invoice.amount_paid = payment.amount;
      const remote = provider.subscriptions.get(sub.providerSubscriptionId)!; remote.status = "active"; remote.paid_count = 1;
      assert.equal((await webhook(sub.providerSubscriptionId)).status, 200);
      const stored = await db.billingPayment.findUniqueOrThrow({ where: { providerPaymentId: paymentId } }); assert.equal(stored.paidAt, null); assert.ok(stored.captureVerifiedAt); assert.equal(stored.paymentCreatedAt!.getTime(), payment.created_at * 1000);
      const signature = createHmac("sha256", provider.secret).update(`${paymentId}|${sub.providerSubscriptionId}`).digest("hex");
      for (let i = 0; i < 2; i++) assert.equal((await request("/api/billing/confirm", { subscriptionId: sub.subscriptionId, razorpay_payment_id: paymentId, razorpay_subscription_id: sub.providerSubscriptionId, razorpay_signature: signature }, a.cookie)).status, 200);
      assert.equal(await db.billingPayment.count({ where: { providerPaymentId: paymentId } }), 1);
      const status = (await request(`/api/billing/purchase?subscriptionId=${sub.subscriptionId}`, undefined, a.cookie)).data.purchase;
      assert.equal(status.state, "SUCCESS"); assert.equal(status.transactionReference, paymentId); assert.equal(status.paidAmountMinor, payment.amount);
    });
    it("recovers a captured payment after a missed webhook without creating another subscription or altering trial dates", async () => {
      const a = await account(true), sub = await checkout(a.cookie), before = await db.organization.findUniqueOrThrow({ where: { id: a.organizationId } });
      provider.charge(sub.providerSubscriptionId); const count = provider.createCount;
      now = new Date(now.getTime() + 2 * 60000);
      // Isolate the worker batch from unrelated fixture/provider histories.
      const workerDb = db.$extends({ query: { subscription: { async findMany({ args, query }) { return query({ ...args, where: { AND: [args.where || {}, { id: sub.subscriptionId }] } }); } } } });
      const result = await reconcileDue(workerDb as unknown as PrismaClient, new BillingService(db, provider, () => now), now);
      assert.equal(result.failed, 0); assert.equal(result.checked, 1); assert.equal(provider.createCount, count);
      assert.equal((await request(`/api/billing/purchase?subscriptionId=${sub.subscriptionId}`, undefined, a.cookie)).data.purchase.state, "SUCCESS");
      const after = await db.organization.findUniqueOrThrow({ where: { id: a.organizationId } }); assert.equal(after.trialExpiresAt!.getTime(), before.trialExpiresAt!.getTime());
    });
    it("preserves admin access controls across provider reconciliation and renewal", async () => {
      const a = await account(true); await expire(a.organizationId);
      const sub = await checkout(a.cookie);
      provider.charge(sub.providerSubscriptionId); await webhook(sub.providerSubscriptionId);
      const manualEnd = new Date(now.getTime() + 86400000);
      await db.organization.update({ where: { id: a.organizationId }, data: { accessMode: "MANUAL", manualAccessStartsAt: now, manualAccessExpiresAt: manualEnd } });
      provider.charge(sub.providerSubscriptionId); await webhook(sub.providerSubscriptionId);
      const manual = (await request("/api/billing/status", undefined, a.cookie)).data.access;
      assert.equal(manual.source, "MANUAL"); assert.equal(manual.allowed, true);
      assert.equal(manual.manualAccess.expiresAt, manualEnd.toISOString());
      now = manualEnd;
      await webhook(sub.providerSubscriptionId);
      assert.equal((await request("/api/billing/status", undefined, a.cookie)).data.access.allowed, false);
      await db.organization.update({ where: { id: a.organizationId }, data: { accessMode: "SUSPENDED" } });
      await webhook(sub.providerSubscriptionId);
      assert.equal((await request("/api/billing/status", undefined, a.cookie)).data.access.state, "SUSPENDED");
      assert.equal((await request("/api/organization", undefined, a.cookie)).status, 402);
    });
    it("confirms a callback using the stored subscription ID and verified provider state", async () => {
      const a = await account(true);
      await expire(a.organizationId);
      const sub = await checkout(a.cookie, "YEARLY");
      const paymentId = provider.charge(sub.providerSubscriptionId);
      const signature = createHmac("sha256", provider.secret)
        .update(`${paymentId}|${sub.providerSubscriptionId}`)
        .digest("hex");
      const result = await request(
        "/api/billing/confirm",
        {
          subscriptionId: sub.subscriptionId,
          razorpay_subscription_id: sub.providerSubscriptionId,
          razorpay_payment_id: paymentId,
          razorpay_signature: signature,
        },
        a.cookie,
      );
      assert.equal(result.status, 200);
      assert.equal(result.data.access.source, "SUBSCRIPTION");
      assert.equal(result.data.access.subscription.interval, "YEARLY");
    });
    it("pending, failed, and authorization-only payments do not grant paid access", async () => {
      const a = await account(true);
      await expire(a.organizationId);
      const sub = await checkout(a.cookie);
      provider.charge(sub.providerSubscriptionId, "failed");
      assert.equal(
        (await webhook(sub.providerSubscriptionId, "subscription.pending"))
          .status,
        200,
      );
      assert.equal(
        (await request("/api/billing/status", undefined, a.cookie)).data.access
          .allowed,
        false,
      );
      const remote = provider.subscriptions.get(sub.providerSubscriptionId)!;
      remote.status = "active";
      remote.paid_count = 1;
      const invoice = provider.invoiceRows.get(remote.id)![0]!;
      invoice.status = "paid";
      invoice.amount_paid = 1;
      const payment = provider.paymentRows.get(invoice.payment_id!)!;
      payment.status = "captured";
      payment.amount = 1;
      await webhook(remote.id);
      assert.equal(
        (await request("/api/billing/status", undefined, a.cookie)).data.access
          .allowed,
        false,
      );
    });
    it("cancels renewal, retains verified paid time, and ignores old event payload state", async () => {
      const a = await account(true);
      await expire(a.organizationId);
      const sub = await checkout(a.cookie);
      provider.charge(sub.providerSubscriptionId);
      await webhook(sub.providerSubscriptionId);
      const cancellation = await request(
        "/api/billing/cancel",
        { subscriptionId: sub.subscriptionId, atCycleEnd: true },
        a.cookie,
      );
      assert.equal(cancellation.status, 200);
      assert.equal(
        cancellation.data.access.subscription.cancelAtCycleEnd,
        true,
      );
      provider.subscriptions.get(sub.providerSubscriptionId)!.status =
        "cancelled";
      await webhook(sub.providerSubscriptionId, "subscription.cancelled");
      await webhook(sub.providerSubscriptionId, "subscription.activated");
      const state = (await request("/api/billing/status", undefined, a.cookie))
        .data.access;
      assert.equal(state.state, "CANCELLED");
      assert.equal(state.allowed, true);
      now = new Date(Date.parse(state.subscription.paidUntil) + 1000);
      assert.equal(
        (await request("/api/billing/status", undefined, a.cookie)).data.access
          .allowed,
        false,
      );
      assert.equal(
        (await request("/api/billing/status", undefined, a.cookie)).status,
        200,
      );
    });
    it("requires a captured renewal payment to extend access; failed renewal restricts access", async () => {
      const a = await account(true);
      await expire(a.organizationId);
      const sub = await checkout(a.cookie);
      provider.charge(sub.providerSubscriptionId);
      await webhook(sub.providerSubscriptionId);
      const paid = (await request("/api/billing/status", undefined, a.cookie))
        .data.access.subscription.paidUntil;
      now = new Date(Date.parse(paid) + 1000);
      provider.charge(sub.providerSubscriptionId, "failed");
      await webhook(sub.providerSubscriptionId, "subscription.pending");
      assert.equal(
        (await request("/api/organization", undefined, a.cookie)).status,
        402,
      );
      provider.charge(sub.providerSubscriptionId);
      await webhook(sub.providerSubscriptionId);
      assert.equal(
        (await request("/api/organization", undefined, a.cookie)).status,
        200,
      );
      assert.ok(
        Date.parse(
          (await request("/api/billing/status", undefined, a.cookie)).data
            .access.subscription.paidUntil,
        ) > Date.parse(paid),
      );
    });
    it("reports provider dates and latest payment, and labels a lapsed active period expired", async () => {
      const a = await account(true);
      await expire(a.organizationId);
      const sub = await checkout(a.cookie);
      provider.charge(sub.providerSubscriptionId);
      await webhook(sub.providerSubscriptionId);
      const active = (await request("/api/billing/status", undefined, a.cookie))
        .data.access;
      assert.ok(active.subscription.currentPeriodStart);
      assert.ok(active.subscription.currentPeriodEnd);
      assert.equal(active.subscription.latestPayment.status, "captured");
      assert.equal(
        active.subscription.nextBillingAt,
        active.subscription.currentPeriodEnd,
      );
      now = new Date(Date.parse(active.subscription.paidUntil) + 1000);
      const expired = (
        await request("/api/billing/status", undefined, a.cookie)
      ).data.access;
      assert.equal(expired.state, "EXPIRED");
      assert.equal(expired.allowed, false);
      assert.equal(
        (await request("/api/organization", undefined, a.cookie)).status,
        402,
      );
    });
    it("cancels an unstarted subscription immediately without restarting or cancelling its free trial", async () => {
      const a = await account(true);
      const original = (
        await request("/api/billing/status", undefined, a.cookie)
      ).data.access;
      const sub = await checkout(a.cookie);
      const result = await request(
        "/api/billing/cancel",
        { subscriptionId: sub.subscriptionId, atCycleEnd: true },
        a.cookie,
      );
      assert.equal(result.status, 200);
      assert.equal(
        provider.subscriptions.get(sub.providerSubscriptionId)!.status,
        "cancelled",
      );
      assert.equal(result.data.access.subscription.status, "CANCELLED");
      assert.equal(result.data.access.subscription.cancelAtCycleEnd, false);
      assert.ok(result.data.access.subscription.cancelledAt);
      assert.equal(result.data.access.trialStartedAt, original.trialStartedAt);
      assert.equal(result.data.access.trialExpiresAt, original.trialExpiresAt);
      assert.equal(result.data.access.state, "TRIALING");
    });
    it("processes payment-only captured and failed events using verified invoice ownership and deduplicates them", async () => {
      const a = await account(true);
      await expire(a.organizationId);
      const sub = await checkout(a.cookie);
      const paidId = provider.charge(sub.providerSubscriptionId);
      const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
      assert.equal(
        (await paymentWebhook(paidId, "payment.captured", eventId)).status,
        200,
      );
      assert.equal(
        (await paymentWebhook(paidId, "payment.captured", eventId)).data
          .duplicate,
        true,
      );
      assert.equal(
        await db.billingPayment.count({
          where: { subscriptionId: sub.subscriptionId },
        }),
        1,
      );
      const paid = (await request("/api/billing/status", undefined, a.cookie))
        .data.access;
      assert.equal(paid.source, "SUBSCRIPTION");
      now = new Date(Date.parse(paid.subscription.paidUntil) + 1000);
      const failedId = provider.charge(sub.providerSubscriptionId, "failed");
      // A failed attempt need not be the current invoice.payment_id.
      const failed = provider.paymentRows.get(failedId)!;
      provider.invoiceRows
        .get(sub.providerSubscriptionId)!
        .find((row) => row.id === failed.invoice_id)!.payment_id = null;
      assert.equal(
        (await paymentWebhook(failedId, "payment.failed")).status,
        200,
      );
      const state = (await request("/api/billing/status", undefined, a.cookie))
        .data.access;
      assert.equal(state.state, "PAST_DUE");
      assert.equal(state.allowed, false);
      assert.equal(state.subscription.latestPayment.status, "failed");
      const history = await request(
        "/api/billing/history",
        undefined,
        a.cookie,
      );
      assert.equal(history.data.payments.length, 2);
    });
    it("rejects a signed event that combines one subscription with another tenant's payment", async () => {
      const a = await account(true),
        b = await account(true);
      await expire(a.organizationId);
      await expire(b.organizationId);
      const sa = await checkout(a.cookie),
        sb = await checkout(b.cookie);
      const paymentId = provider.charge(sb.providerSubscriptionId),
        payment = provider.paymentRows.get(paymentId)!;
      const body = Buffer.from(
        JSON.stringify({
          event: "subscription.charged",
          payload: {
            subscription: { entity: { id: sa.providerSubscriptionId } },
            payment: {
              entity: { id: paymentId, invoice_id: payment.invoice_id },
            },
          },
        }),
      );
      const response = await fetch(`${base}/api/billing/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-razorpay-event-id": `evt_${randomUUID().replaceAll("-", "")}`,
          "x-razorpay-signature": createHmac("sha256", provider.webhookSecret)
            .update(body)
            .digest("hex"),
        },
        body,
      });
      assert.equal(response.status, 409);
      assert.equal(
        (await request("/api/billing/status", undefined, a.cookie)).data.access
          .allowed,
        false,
      );
      assert.equal(
        (await request("/api/billing/status", undefined, b.cookie)).data.access
          .allowed,
        false,
      );
    });
    it("acknowledges mandate authorization without an invoice but never treats it as a paid billing cycle", async () => {
      const a = await account(true);
      await expire(a.organizationId);
      const sub = await checkout(a.cookie);
      provider.subscriptions.get(sub.providerSubscriptionId)!.status =
        "authenticated";
      const paymentId = `pay_${randomUUID().replaceAll("-", "")}`;
      provider.paymentRows.set(paymentId, {
        id: paymentId,
        invoice_id: null,
        status: "authorized",
        amount: 100,
        currency: "INR",
        amount_refunded: 0,
        created_at: Math.floor(now.getTime() / 1000),
      });
      assert.equal(
        (
          await webhook(
            sub.providerSubscriptionId,
            "subscription.authenticated",
            `evt_${randomUUID().replaceAll("-", "")}`,
            undefined,
            paymentId,
          )
        ).status,
        200,
      );
      const status = (await request("/api/billing/status", undefined, a.cookie))
        .data.access;
      assert.equal(status.subscription.status, "AUTHENTICATED");
      assert.equal(status.allowed, false);
      assert.equal(status.subscription.paidUntil, null);
      assert.equal(
        await db.billingPayment.count({
          where: { subscriptionId: sub.subscriptionId },
        }),
        0,
      );
    });
    it("renews yearly subscriptions and retains only verified paid time after completion", async () => {
      const a = await account(true);
      await expire(a.organizationId);
      const sub = await checkout(a.cookie, "YEARLY");
      provider.charge(sub.providerSubscriptionId);
      await webhook(sub.providerSubscriptionId);
      const first = (await request("/api/billing/status", undefined, a.cookie))
        .data.access;
      assert.equal(first.subscription.interval, "YEARLY");
      now = new Date(Date.parse(first.subscription.paidUntil) + 1000);
      provider.charge(sub.providerSubscriptionId);
      await webhook(sub.providerSubscriptionId);
      const second = (await request("/api/billing/status", undefined, a.cookie))
        .data.access;
      assert.ok(
        Date.parse(second.subscription.paidUntil) >
          Date.parse(first.subscription.paidUntil),
      );
      provider.subscriptions.get(sub.providerSubscriptionId)!.status =
        "completed";
      await webhook(sub.providerSubscriptionId, "subscription.completed");
      const completed = (
        await request("/api/billing/status", undefined, a.cookie)
      ).data.access;
      assert.equal(completed.subscription.nextBillingAt, null);
      assert.equal(completed.allowed, true);
      now = new Date(Date.parse(completed.subscription.paidUntil) + 1000);
      assert.equal(
        (await request("/api/billing/status", undefined, a.cookie)).data.access
          .allowed,
        false,
      );
    });
    it("fails closed when provider synchronization is unavailable", async () => {
      const a = await account(true);
      await expire(a.organizationId);
      const sub = await checkout(a.cookie);
      provider.charge(sub.providerSubscriptionId);
      provider.fail = true;
      assert.equal((await webhook(sub.providerSubscriptionId)).status, 503);
      assert.equal(
        (await request("/api/billing/status", undefined, a.cookie)).data.access
          .allowed,
        false,
      );
    });
    it("prevents tenants from confirming, cancelling, refreshing, or reading each other's billing data", async () => {
      const a = await account(true),
        b = await account(true);
      await expire(a.organizationId);
      const sub = await checkout(a.cookie);
      provider.charge(sub.providerSubscriptionId);
      await webhook(sub.providerSubscriptionId);
      const before = provider.cancelCount;
      assert.equal(
        (
          await request(
            "/api/billing/cancel",
            { subscriptionId: sub.subscriptionId, atCycleEnd: true },
            b.cookie,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            "/api/billing/refresh",
            { subscriptionId: sub.subscriptionId },
            b.cookie,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            "/api/billing/confirm",
            {
              subscriptionId: sub.subscriptionId,
              razorpay_subscription_id: sub.providerSubscriptionId,
              razorpay_payment_id: "pay_fake",
              razorpay_signature: "0".repeat(64),
            },
            b.cookie,
          )
        ).status,
        404,
      );
      assert.equal(provider.cancelCount, before);
      assert.equal(
        (
          await request(
            `/api/billing/history?organizationId=${a.organizationId}`,
            undefined,
            b.cookie,
          )
        ).data.payments.length,
        0,
      );
      assert.equal(
        (
          await request(
            `/api/billing/status?organizationId=${a.organizationId}`,
            undefined,
            b.cookie,
          )
        ).data.access.source,
        "TRIAL",
      );
    });
    it("rate-limits token guessing", async () => {
      let status = 0;
      for (let i = 0; i < 32; i++) {
        status = (
          await request("/api/auth/reset/validate", { token: "f".repeat(64) })
        ).status;
        if (status === 429) break;
      }
      assert.equal(status, 429);
    });
  },
);

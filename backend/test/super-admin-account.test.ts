import "dotenv/config";
import assert from "node:assert/strict";
import { before, beforeEach, afterEach, after, it } from "node:test";
import { randomUUID, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/server";
import { hashPassword, verifyPassword } from "../src/auth/password";
import { hashToken, newSession } from "../src/auth/security";
import type { MailMessage, Mailer } from "../src/services/mail";

if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
const db = new PrismaClient(), password = "Settings fixture password", origin = "http://localhost:3000";
let organizationId = "", superAdminId = "", otherId = "", tenantId = "", email = "", cookie = "", secondCookie = "", tenantCookie = "", otherCookie = "";
let passwordHash = "", server: Server, base = "", now: Date, messages: MailMessage[];
let failDelivery = false;
const mailer: Mailer = { available: true, async send(message) { if (failDelivery) throw new Error("Secret provider detail must not escape"); messages.push(message); } };
async function session(id: string) {
  const user = await db.superAdmin.findUniqueOrThrow({ where: { id } });
  const value = newSession();
  await db.superAdminSession.create({ data: { superAdminId: id, authVersion: user.authVersion, tokenHash: value.tokenHash, expiresAt: value.expiresAt } });
  return `hrms_platform_session=${value.token}`;
}
async function request(path = "", body?: unknown, auth = cookie, trusted = true) {
  const response = await fetch(`${base}/api/super-admin/account${path}`, { method: body === undefined ? "GET" : "POST", headers: { Cookie: auth, "Content-Type": "application/json", ...(trusted ? { Origin: origin, "X-HRMS-Request": "1" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
async function login(address: string, pass = password) {
  const response = await fetch(`${base}/api/super-admin/auth/login`, { method: "POST", headers: { Origin: origin, "X-HRMS-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify({ email: address, password: pass }) });
  return { status: response.status, data: await response.json() };
}
const target = () => `${randomUUID()}@example.test`;
let latestRequestId = "";
const requestIds = new Map<string, string>();
const changeEmail = async (newEmail = target(), currentPassword = password) => {
  const result = await request("/email", { currentPassword, newEmail });
  if (result.status === 202) latestRequestId = result.data.requestId;
  return result;
};
const changePassword = (newPassword = "NewPass8", currentPassword = password) => request("/password", { currentPassword, newPassword, confirmPassword: newPassword });
const token = () => { const value = messages.at(-1)?.text.match(/verification code is: (\d{6})/)?.[1]; assert.ok(value); requestIds.set(value, latestRequestId); return value; };
const confirm = (value = token(), auth = cookie) => request("/email/confirm", { code: value, requestId: requestIds.get(value) || latestRequestId }, auth);
before(async () => { passwordHash = await hashPassword(password); });
beforeEach(async () => {
  now = new Date(); messages = []; failDelivery = false; mailer.available = true; latestRequestId = ""; requestIds.clear();
  const org = await db.organization.create({ data: { name: `Account settings ${randomUUID()}`, trialStartedAt: now, trialExpiresAt: new Date(now.getTime() + 7 * 86400000) } });
  organizationId = org.id; email = target();
  superAdminId = (await db.superAdmin.create({ data: { email, fullName: "Platform owner", passwordHash, emailVerifiedAt: now } })).id;
  otherId = (await db.superAdmin.create({ data: { email: target(), fullName: "Other platform owner", passwordHash } })).id;
  tenantId = (await db.user.create({ data: { organizationId, email: target(), fullName: "Tenant administrator", role: "ORGANIZATION_ADMIN", passwordHash } })).id;
  cookie = await session(superAdminId); secondCookie = await session(superAdminId); const tenantSession = newSession(); await db.session.create({ data: { userId: tenantId, tokenHash: tenantSession.tokenHash, expiresAt: tenantSession.expiresAt } }); tenantCookie = `hrms_session=${tenantSession.token}`; otherCookie = await session(otherId);
  server = createApp(db, { frontendOrigin: origin, production: false }, { mailer, clock: () => now }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.superAdminAuditEvent.deleteMany({ where: { actorSuperAdminId: { in: [superAdminId, otherId, tenantId] } } });
  await db.superAdmin.deleteMany({ where: { id: { in: [superAdminId, otherId] } } });
  if (organizationId) await db.organization.delete({ where: { id: organizationId } });
});
after(async () => { await db.$disconnect(); });

it("authorizes all account routes on the backend and rejects forged targets, roles and CSRF", async () => {
  for (const [path, body] of [["", undefined], ["/email", { currentPassword: password, newEmail: target() }], ["/email/resend", { requestId: "a".repeat(64) }], ["/email/confirm", { code: "123456", requestId: "a".repeat(64) }], ["/password", { currentPassword: password, newPassword: "NewPass8", confirmPassword: "NewPass8" }]] as const) {
    assert.equal((await request(path, body, "")).status, 401);
    assert.equal((await request(path, body, tenantCookie)).status, 401);
  }
  assert.equal((await request("/password", { currentPassword: password, newPassword: "NewPass8", confirmPassword: "NewPass8", superAdminId: otherId, role: "SUPER_ADMIN" })).status, 400);
  assert.equal((await request("?superAdminId=" + otherId)).status, 400);
  assert.equal((await request("/email", { currentPassword: password, newEmail: target() }, cookie, false)).status, 403);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: tenantId } })).role, "ORGANIZATION_ADMIN");
});
it("returns only the current owner's public information and honest verification status", async () => {
  const result = await request(); assert.equal(result.status, 200); assert.equal(result.data.admin.email, email); assert.ok(result.data.admin.emailVerifiedAt);
  for (const field of ["passwordHash", "authVersion", "tokenHash", "session"]) assert.equal(JSON.stringify(result.data).includes(field), false);
  const unverified = await request("", undefined, otherCookie); assert.equal(unverified.data.admin.emailVerifiedAt, null);
  assert.equal(unverified.data.pendingEmailChange, null);
});
it("requires the current password and validates new passwords before changing anything", async () => {
  assert.equal((await changePassword("NewPass8", "wrong password")).status, 400);
  assert.equal((await changeEmail(target(), "wrong password")).status, 400);
  for (const value of ["1234567", "a".repeat(129), password]) assert.equal((await changePassword(value)).status, 400);
  assert.equal((await request("/password", { currentPassword: password, newPassword: "NewPass8", confirmPassword: "Mismatch" })).status, 400);
  assert.equal((await request()).status, 200); assert.equal(await db.superAdminSession.count({ where: { superAdminId } }), 2);
  assert.equal((await db.superAdmin.findUniqueOrThrow({ where: { id: superAdminId } })).passwordHash, passwordHash);
});
it("hashes an eight-character password, revokes platform sessions, preserves tenant recovery tokens and cancels pending platform email changes", async () => {
  await changeEmail(); const oldToken = token();
  await db.accountToken.create({ data: { userId: tenantId, purpose: "RESET_PASSWORD", tokenHash: hashToken(randomBytes(32).toString("hex")), authVersion: 0, expiresAt: new Date(now.getTime() + 60000) } });
  const result = await changePassword(); assert.equal(result.status, 200); assert.equal(result.data.requiresReauthentication, true);
  assert.match(result.headers.get("set-cookie") || "", /hrms_platform_session=;/);
  const user = await db.superAdmin.findUniqueOrThrow({ where: { id: superAdminId } });
  assert.notEqual(user.passwordHash, passwordHash); assert.equal(await verifyPassword("NewPass8", user.passwordHash), true); assert.equal(user.authVersion, 1);
  assert.equal(await db.superAdminSession.count({ where: { superAdminId } }), 0); assert.equal(await db.accountToken.count({ where: { userId: tenantId } }), 1);
  assert.equal((await db.superAdminEmailChange.findUniqueOrThrow({ where: { superAdminId } })).state, "CANCELLED");
  assert.equal((await request()).status, 401); assert.equal((await request("", undefined, secondCookie)).status, 401);
  assert.equal((await login(email)).status, 401); assert.equal((await login(email, "NewPass8")).status, 200);
  cookie = await session(superAdminId); assert.equal((await confirm(oldToken, cookie)).status, 400);
  assert.equal((await request("", undefined, tenantCookie)).status, 401);
  const audit = await db.superAdminAuditEvent.findMany({ where: { actorSuperAdminId: superAdminId } }); assert.ok(audit.some((event) => event.action === "PASSWORD_CHANGED"));
  for (const secret of [password, "NewPass8", user.passwordHash, oldToken]) assert.equal(JSON.stringify(audit).includes(secret), false);
});
it("sends only to the new address, stores a hash, and keeps the original verified email and trial active until confirmation", async () => {
  const next = target(), org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const result = await changeEmail(next.toUpperCase()); assert.equal(result.status, 202); assert.equal(messages.length, 1); assert.equal(messages[0]!.to, next);
  assert.ok(messages[0]!.text.includes("six-digit code"));
  assert.equal(messages[0]!.text.includes("email-change-token"), false);
  const value = token(), pending = await db.superAdminEmailChange.findUniqueOrThrow({ where: { superAdminId } });
  assert.equal(pending.tokenHash, hashToken(`email-change:${result.data.requestId}:${value}`)); assert.notEqual(pending.tokenHash, value); assert.equal(pending.expiresAt.getTime() - now.getTime(), 600000);
  assert.equal(pending.failedAttempts, 0); assert.equal(pending.otpRequestId, result.data.requestId);
  assert.equal(JSON.stringify(result.data).includes(value), false);
  const account = (await request()).data; assert.equal(account.admin.email, email); assert.equal(account.pendingEmailChange.newEmail, next); assert.equal(account.pendingEmailChange.state, "SENT");
  assert.equal((await login(email)).status, 200); assert.equal((await login(next)).status, 401);
  assert.deepEqual(await db.organization.findUniqueOrThrow({ where: { id: organizationId } }), org);
});
it("reports missing mail configuration and transport failures without changing the account or exposing provider errors", async () => {
  mailer.available = false; const missing = await changeEmail(); assert.equal(missing.status, 503); assert.equal(messages.length, 0); assert.equal(await db.superAdminEmailChange.count({ where: { superAdminId } }), 0);
  mailer.available = true; failDelivery = true; const failed = await changeEmail(); assert.equal(failed.status, 503); assert.equal(JSON.stringify(failed.data).includes("Secret provider"), false);
  const pending = await db.superAdminEmailChange.findUniqueOrThrow({ where: { superAdminId } }); assert.equal(pending.state, "FAILED"); assert.ok(pending.consumedAt);
  assert.equal((await login(email)).status, 200); assert.equal((await request()).data.admin.email, email);
});
it("rejects existing emails at request time and again at confirmation without locking out the owner", async () => {
  const duplicate = (await db.superAdmin.findUniqueOrThrow({ where: { id: otherId } })).email;
  assert.equal((await changeEmail(duplicate)).status, 409); assert.equal(messages.length, 0);
  const next = target(); await changeEmail(next); const value = token();
  await db.superAdmin.update({ where: { id: otherId }, data: { email: next } });
  assert.equal((await confirm(value)).status, 409); assert.equal((await login(email)).status, 200);
  assert.equal((await request()).data.admin.email, email);
});
it("immediately sends fresh OTPs after password confirmation for the same or an edited email", async () => {
  const next = target();
  const initial = await changeEmail(next), first = token();
  assert.equal(initial.status, 202);
  assert.equal((await changeEmail(next, "wrong password")).status, 400);
  assert.equal(messages.length, 1);
  const repeated = await changeEmail(next), second = token();
  assert.equal(repeated.status, 202, "Re-entering the same pending email and correct password does not require a wait");
  assert.notEqual(repeated.data.requestId, initial.data.requestId);
  const editedEmail = target(), edited = await changeEmail(editedEmail); token();
  assert.equal(edited.status, 202, "Changing to a different email does not require a wait");
  assert.deepEqual(messages.map((message) => message.to), [next, next, editedEmail]);
  assert.equal((await request()).data.admin.email, email);
  assert.equal((await request("/email/resend", { requestId: edited.data.requestId })).status, 429, "Resend still requires the cooldown");
  assert.equal((await request("/email/confirm", { code: first, requestId: initial.data.requestId })).status, 400);
  assert.equal((await request("/email/confirm", { code: second, requestId: repeated.data.requestId })).status, 400);
  assert.equal((await confirm()).status, 200);
});
it("rejects incorrect, expired, malformed, wrong-owner and stale-auth-version verification codes", async () => {
  await changeEmail(); const value = token();
  assert.equal((await confirm(value === "000000" ? "000001" : "000000")).status, 400);
  assert.equal((await confirm("malformed")).status, 400); assert.equal((await confirm("0".repeat(64))).status, 400);
  assert.equal((await confirm(value, otherCookie)).status, 400);
  now = new Date(now.getTime() + 600001); assert.equal((await confirm(value)).status, 400);
  now = new Date(); await db.superAdmin.update({ where: { id: superAdminId }, data: { authVersion: { increment: 1 } } }); cookie = await session(superAdminId);
  assert.equal((await confirm(value)).status, 400); assert.equal((await request()).data.pendingEmailChange, null);
  assert.equal((await request()).data.admin.email, email);
});
it("resends directly to the pending address only after sixty seconds and resets the cooldown", async () => {
  const next = target(), initial = await changeEmail(next), first = token();
  const resend = () => request("/email/resend", { requestId: latestRequestId });
  assert.equal((await resend()).status, 429);
  now = new Date(now.getTime() + 59999); assert.equal((await resend()).status, 429);
  assert.equal(messages.length, 1);
  now = new Date(now.getTime() + 1);
  const result = await resend(); assert.equal(result.status, 202); latestRequestId = result.data.requestId;
  assert.notEqual(latestRequestId, initial.data.requestId);
  assert.equal(messages.length, 2); assert.equal(messages[1]!.to, next);
  assert.equal(result.data.createdAt, now.toISOString());
  assert.equal((await request()).data.admin.email, email);
  assert.equal((await resend()).status, 429);
  assert.equal((await request("/email/confirm", { code: first, requestId: initial.data.requestId })).status, 400);
  assert.equal((await confirm()).status, 200);
});
it("does not allow resends to change the address, use another owner's request, or reuse a stale request", async () => {
  assert.equal((await request("/email/resend", { requestId: "a".repeat(64) })).status, 400);
  const initial = await changeEmail();
  now = new Date(now.getTime() + 60000);
  assert.equal((await request("/email/resend", { requestId: initial.data.requestId }, otherCookie)).status, 400);
  assert.equal((await request("/email/resend", { requestId: initial.data.requestId, newEmail: target() })).status, 400);
  assert.equal((await request("/email/resend", { requestId: initial.data.requestId }, cookie, false)).status, 403);
  const replacement = await changeEmail();
  now = new Date(now.getTime() + 60000);
  assert.equal((await request("/email/resend", { requestId: initial.data.requestId })).status, 400);
  assert.equal(messages.length, 2);
  await db.superAdmin.update({ where: { id: superAdminId }, data: { authVersion: { increment: 1 } } });
  cookie = await session(superAdminId);
  assert.equal((await request("/email/resend", { requestId: replacement.data.requestId })).status, 400);
  assert.equal(messages.length, 2);
});
it("allows a fresh OTP after expiry but reports resend delivery failure honestly", async () => {
  const initial = await changeEmail();
  now = new Date(now.getTime() + 600001);
  failDelivery = true;
  assert.equal((await request("/email/resend", { requestId: initial.data.requestId })).status, 503);
  const failed = await db.superAdminEmailChange.findUniqueOrThrow({ where: { superAdminId } });
  assert.equal(failed.state, "FAILED"); assert.ok(failed.consumedAt);
  failDelivery = false;
  assert.equal((await request("/email/resend", { requestId: failed.otpRequestId })).status, 429);
  now = new Date(now.getTime() + 60000);
  const result = await request("/email/resend", { requestId: failed.otpRequestId });
  assert.equal(result.status, 202); latestRequestId = result.data.requestId;
  assert.equal((await confirm()).status, 200);
});
it("locks the OTP after five wrong guesses and persists attempts across sessions", async () => {
  await changeEmail(); const value = token(), wrong = value === "000000" ? "000001" : "000000";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await confirm(wrong, attempt % 2 ? cookie : secondCookie);
    assert.equal(result.status, 400);
    assert.equal(result.data.code, attempt === 5 ? "OTP_ATTEMPTS_EXCEEDED" : "INCORRECT_OTP");
    assert.equal((await db.superAdminEmailChange.findUniqueOrThrow({ where: { superAdminId } })).failedAttempts, attempt);
  }
  assert.equal((await confirm(value)).status, 400);
  assert.equal((await request()).data.pendingEmailChange.state, "LOCKED");
  assert.equal((await request()).data.admin.email, email);
  now = new Date(now.getTime() + 61000);
  assert.equal((await changeEmail()).status, 202);
  assert.equal((await db.superAdminEmailChange.findUniqueOrThrow({ where: { superAdminId } })).failedAttempts, 0);
  assert.equal((await confirm()).status, 200);
});
it("requires the current request ID and never accepts legacy email links", async () => {
  await changeEmail(); const value = token();
  assert.equal((await request("/email/confirm", { code: value, requestId: "a".repeat(64) })).status, 400);
  assert.equal((await request("/email/confirm", { token: "b".repeat(64), currentPassword: password })).status, 400);
  await db.superAdminEmailChange.update({ where: { superAdminId }, data: { otpRequestId: null } });
  assert.equal((await request()).data.pendingEmailChange, null);
  assert.equal((await confirm(value)).status, 400);
  assert.equal((await request()).data.admin.email, email);
});
it("consumes an OTP once under concurrent confirmation attempts", async () => {
  const next = target(); await changeEmail(next); const value = token();
  const results = await Promise.all([confirm(value), confirm(value, secondCookie)]);
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.equal((await db.superAdmin.findUniqueOrThrow({ where: { id: superAdminId } })).email, next);
  assert.equal(await db.superAdminAuditEvent.count({ where: { actorSuperAdminId: superAdminId, action: "EMAIL_CHANGED" } }), 1);
});
it("verifies the replacement email only on confirmation, revokes sessions and tokens, and rejects reuse after signing in again", async () => {
  const next = target(); await changeEmail(next); const value = token();
  await db.accountToken.create({ data: { userId: tenantId, purpose: "RESET_PASSWORD", tokenHash: hashToken(randomBytes(32).toString("hex")), authVersion: 0, expiresAt: new Date(now.getTime() + 60000) } });
  const result = await confirm(value); assert.equal(result.status, 200); assert.equal(result.data.requiresReauthentication, true);
  assert.match(result.headers.get("set-cookie") || "", /hrms_platform_session=;/);
  const user = await db.superAdmin.findUniqueOrThrow({ where: { id: superAdminId } }); assert.equal(user.email, next); assert.equal(user.emailVerifiedAt?.getTime(), now.getTime()); assert.equal(user.authVersion, 1);
  assert.equal(user.passwordHash, passwordHash); assert.equal(await db.superAdminSession.count({ where: { superAdminId } }), 0); assert.equal(await db.accountToken.count({ where: { userId: tenantId } }), 1);
  assert.equal((await request("", undefined, secondCookie)).status, 401); assert.equal((await login(email)).status, 401); assert.equal((await login(next)).status, 200);
  cookie = await session(superAdminId); assert.equal((await confirm(value)).status, 400);
  const account = (await request()).data; assert.equal(account.pendingEmailChange, null); assert.ok(account.auditEvents.some((event: { action: string }) => event.action === "EMAIL_CHANGED"));
  const other = (await request("", undefined, otherCookie)).data; assert.equal(other.auditEvents.length, 0);
});
it("allows an unverified platform owner to prove a replacement address without falsely verifying the old address", async () => {
  await db.superAdmin.update({ where: { id: superAdminId }, data: { emailVerifiedAt: null } });
  await changeEmail(); assert.equal((await request()).data.admin.emailVerifiedAt, null);
  assert.equal((await confirm()).status, 200); assert.ok((await db.superAdmin.findUniqueOrThrow({ where: { id: superAdminId } })).emailVerifiedAt);
});
it("allows verifying the initial address without claiming verification during provisioning", async () => {
  await db.superAdmin.update({ where: { id: superAdminId }, data: { emailVerifiedAt: null } });
  assert.equal((await changeEmail(email)).status, 202);
  assert.equal((await request()).data.admin.emailVerifiedAt, null);
  assert.equal((await confirm()).status, 200);
  const admin = await db.superAdmin.findUniqueOrThrow({ where: { id: superAdminId } });
  assert.equal(admin.email, email); assert.ok(admin.emailVerifiedAt);
});
it("permits a matching organization email while verifying only the intended SuperAdmin record", async () => {
  const tenantBefore = await db.user.findUniqueOrThrow({ where: { id: tenantId } });
  assert.equal((await changeEmail(tenantBefore.email)).status, 202);
  assert.equal((await confirm()).status, 200);
  const admin = await db.superAdmin.findUniqueOrThrow({ where: { id: superAdminId } });
  assert.equal(admin.email, tenantBefore.email); assert.ok(admin.emailVerifiedAt);
  assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: tenantId } }), tenantBefore);
  assert.equal((await request("", undefined, tenantCookie)).status, 401);
});
it("enforces the account-mutation attempt limit", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await request("/email", {})).status, 400);
  assert.equal((await changeEmail()).status, 429); assert.equal((await request()).status, 200);
});

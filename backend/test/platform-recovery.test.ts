import "dotenv/config";
import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { SMTPServer } from "smtp-server";
import { createApp } from "../src/server";
import { hashPassword, verifyPassword } from "../src/auth/password";
import { hashToken, newSession } from "../src/auth/security";
import { smtpMailer } from "../src/services/mail";

it("delivers a platform OTP through SMTP and resets only the matching platform account", async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const db = new PrismaClient(), email = `platform-reset-${randomUUID()}@example.test`;
  const password = "Original fixture password", next = "Replacement fixture password";
  let adminId = "", organizationId = "", now = new Date(), reject = false;
  const messages: string[] = [];
  const smtp = new SMTPServer({ authOptional: true, disabledCommands: ["AUTH", "STARTTLS"],
    onRcptTo(_address, _session, callback) { callback(reject ? new Error("Recipient rejected") : undefined); },
    onData(stream, _session, callback) { let raw = ""; stream.on("data", (chunk) => { raw += chunk.toString(); }); stream.on("end", () => { messages.push(raw); callback(); }); },
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const mailer = smtpMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String((smtp.server.address() as { port: number }).port), SMTP_FROM: "sender@example.test", SMTP_ALLOW_INSECURE_LOCAL: "true" });
  const origin = "http://localhost:3000";
  const server = createApp(db, { frontendOrigin: origin, production: false }, { mailer, clock: () => now }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function post(path: string, body: unknown) {
    const response = await fetch(`${base}/api/super-admin/auth/${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify(body) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  const latestCode = () => {
    const decoded = messages.at(-1)!.replace(/=\r?\n/g, "").replace(/=([A-F0-9]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    const code = decoded.match(/reset code is: (\d{8})/)?.[1]; assert.ok(code); return code;
  };
  try {
    const passwordHash = await hashPassword(password);
    adminId = (await db.superAdmin.create({ data: { email, fullName: "Recovery test fixture", passwordHash } })).id;
    const org = await db.organization.create({ data: { name: "Recovery isolation fixture", users: { create: { email, fullName: "Tenant fixture", passwordHash } } }, include: { users: true } });
    organizationId = org.id;
    const platformSession = newSession(), tenantSession = newSession();
    await db.superAdminSession.create({ data: { superAdminId: adminId, tokenHash: platformSession.tokenHash, expiresAt: platformSession.expiresAt } });
    await db.session.create({ data: { userId: org.users[0]!.id, tokenHash: tenantSession.tokenHash, expiresAt: tenantSession.expiresAt } });
    assert.equal((await post("forgot-password", { email: `missing-${email}` })).status, 404);
    assert.equal(messages.length, 0);
    const initial = await post("forgot-password", { email: email.toUpperCase() });
    assert.equal(initial.status, 202);
    assert.equal(initial.data.resendAvailableAt, new Date(now.getTime() + 60000).toISOString());
    let code = latestCode();
    const stored = await db.superAdminPasswordReset.findUniqueOrThrow({ where: { superAdminId: adminId } });
    assert.equal(stored.tokenHash, hashToken(code));
    const edited = await post("forgot-password", { email });
    assert.equal(edited.status, 202, "Sending from the email form must work immediately, even for a previously entered address");
    assert.equal(messages.length, 2);
    assert.equal((await post("reset/verify-otp", { email, code })).status, 400, "A fresh request invalidates the previous OTP");
    code = latestCode();
    assert.equal((await post("forgot-password", { email, resend: true })).status, 429);
    assert.equal(messages.length, 2);
    now = new Date(now.getTime() + 59999);
    assert.equal((await post("forgot-password", { email, resend: true })).status, 429);
    assert.equal(messages.length, 2);
    now = new Date(now.getTime() + 1);
    const resent = await post("forgot-password", { email, resend: true });
    assert.equal(resent.status, 202);
    assert.equal(resent.data.resendAvailableAt, new Date(now.getTime() + 60000).toISOString());
    assert.equal(messages.length, 3);
    assert.equal((await post("reset/verify-otp", { email, code })).status, 400, "Resending invalidates the previous OTP");
    code = latestCode();
    assert.equal((await post("reset/verify-otp", { email, code: "00000000" })).status, 400);
    assert.equal((await post("reset/verify-otp", { email, code })).status, 200);
    const mismatch = await post("reset-password", { email, code, password: next, confirmPassword: "wrong" });
    assert.equal(mismatch.status, 400); assert.equal(mismatch.headers.getSetCookie().length, 0);
    assert.equal((await post("reset-password", { email, code, password: next, confirmPassword: next })).status, 200);
    const admin = await db.superAdmin.findUniqueOrThrow({ where: { id: adminId } });
    assert.equal(await verifyPassword(next, admin.passwordHash), true);
    assert.equal(admin.authVersion, 1); assert.ok(admin.emailVerifiedAt);
    assert.equal(await db.superAdminSession.count({ where: { superAdminId: adminId } }), 0);
    assert.equal(await db.session.count({ where: { userId: org.users[0]!.id } }), 1);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: org.users[0]!.id } })).passwordHash, passwordHash);
    assert.notEqual((await post("reset-password", { email, code, password: next, confirmPassword: next })).status, 200);
    assert.equal((await post("login", { email, password: next })).status, 200);
    assert.equal((await post("login", { email, password })).status, 401);
    now = new Date(now.getTime() + 61000);
    assert.equal((await post("forgot-password", { email })).status, 202);
    const expiring = latestCode(); now = new Date(now.getTime() + 31 * 60000);
    assert.equal((await post("reset/verify-otp", { email, code: expiring })).data.code, "TOKEN_EXPIRED");
    reject = true;
    assert.equal((await post("forgot-password", { email })).status, 503);
    assert.ok((await db.superAdminPasswordReset.findUniqueOrThrow({ where: { superAdminId: adminId } })).consumedAt);
    reject = false;
    assert.equal((await post("forgot-password", { email })).status, 202, "Failed delivery must allow a fresh request");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => smtp.close(resolve));
    if (adminId) { await db.superAdminAuditEvent.deleteMany({ where: { actorSuperAdminId: adminId } }); await db.superAdmin.delete({ where: { id: adminId } }); }
    if (organizationId) await db.organization.delete({ where: { id: organizationId } });
    await db.$disconnect();
  }
});

import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it } from "node:test";
import type { Server } from "node:http";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/server";
import { TRIAL_MS } from "../src/auth/security";
import { SuperAdminService } from "../src/super-admin/service";
const db = new PrismaClient();
let now: Date, email: string, base: string, server: Server, messages: string[], available: boolean, fail: boolean;
const origin = "http://localhost:3000";
beforeEach(async () => {
  now = new Date(); email = `signup-${randomUUID()}@example.test`; messages = []; available = true; fail = false;
  const mailer = { get available() { return available; }, async send(message: { text: string }) { if (fail) throw new Error("Fixture delivery failure"); messages.push(message.text); } };
  server = createApp(db, { frontendOrigin: origin, production: false }, { clock: () => now, mailer }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const users = await db.user.findMany({ where: { email }, select: { organizationId: true } });
  await db.organization.deleteMany({ where: { id: { in: users.map((user) => user.organizationId) } } });
  await db.pendingRegistration.deleteMany({ where: { email } });
  await db.$disconnect();
});
async function post(path: string, body: unknown, cookie = "", trusted = true) {
  const response = await fetch(base + "/api/auth/" + path, { method: "POST", headers: { "Content-Type": "application/json", ...(trusted ? { Origin: origin, "X-HRMS-Request": "1" } : {}), Cookie: cookie }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json(), cookies: response.headers.getSetCookie(), cookie: response.headers.getSetCookie()[0]?.split(";")[0] || "" };
}
const payload = () => ({ organizationName: "OTP fixture organization", employeeSize: "11-50", fullName: "OTP Administrator", email, phoneNumber: "+91 98765 43210", password: "Signup fixture password", confirmPassword: "Signup fixture password" });
const code = () => messages.at(-1)!.match(/code is: (\d{6})/)![1]!;
it("creates no account before OTP, hashes pending credentials, then starts a verified seven-day trial exactly at confirmation", async () => {
  const sent = await post("register", payload()); assert.equal(sent.status, 202); assert.equal(sent.data.user, undefined);
  assert.match(sent.cookie, /^hrms_registration=/); assert.match(sent.cookies[0]!, /HttpOnly/);
  assert.equal(await db.user.count({ where: { email } }), 0);
  const pending = await db.pendingRegistration.findFirstOrThrow({ where: { email } });
  assert.notEqual(pending.passwordHash, payload().password); assert.notEqual(pending.codeHash, code());
  assert.equal(pending.phoneNumber, "+919876543210");
  assert.equal(pending.employeeSize, "11-50");
  now = new Date(now.getTime() + 5 * 60000);
  const result = await post("register/verify", { code: code() }, sent.cookie);
  assert.equal(result.status, 201); assert.ok(result.data.user.emailVerifiedAt); assert.match(result.cookie, /^hrms_session=/);
  assert.equal(Date.parse(result.data.user.organization.trialStartedAt), now.getTime());
  assert.equal(Date.parse(result.data.user.organization.trialExpiresAt) - now.getTime(), TRIAL_MS);
  assert.equal(await db.pendingRegistration.count({ where: { email } }), 0);
  assert.equal((await db.organization.findUniqueOrThrow({ where: { id: result.data.user.organizationId } })).phoneNumber, "+919876543210");
  assert.equal((await new SuperAdminService(db, () => now).organization(result.data.user.organizationId)).phoneNumber, "+919876543210");
  assert.equal((await new SuperAdminService(db, () => now).organization(result.data.user.organizationId)).employeeSize, "11-50");
  assert.equal((await post("register/verify", { code: code() }, sent.cookie)).status, 400);
});
it("requires a valid contact phone before sending signup OTP", async () => {
  for (const phoneNumber of [undefined, "", "abc1234567890", "123", "+1234567890123456", "++919876543210"]) {
    const response = await post("register", { ...payload(), phoneNumber });
    assert.equal(response.status, 400); assert.ok(response.data.errors.phoneNumber);
  }
  assert.equal(messages.length, 0);
  assert.equal(await db.pendingRegistration.count({ where: { email } }), 0);
});
it("requires one of the supported employee-size ranges before sending OTP", async () => {
  for (const employeeSize of [undefined, "", "0", "invalid", 50]) {
    const response = await post("register", { ...payload(), employeeSize });
    assert.equal(response.status, 400); assert.ok(response.data.errors.employeeSize);
  }
  assert.equal(messages.length, 0);
});
it("requires the pending browser cookie and locks after five incorrect codes", async () => {
  const sent = await post("register", payload());
  assert.equal((await post("register/verify", { code: code() })).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await post("register/verify", { code: "000000" }, sent.cookie)).status, 400);
  assert.equal((await post("register/verify", { code: code() }, sent.cookie)).status, 400);
  assert.equal(await db.user.count({ where: { email } }), 0);
});
it("enforces expiry and a sixty-second resend cooldown and invalidates older codes", async () => {
  const sent = await post("register", payload()), old = code();
  assert.equal((await post("register/resend", {}, sent.cookie)).status, 429);
  now = new Date(now.getTime() + 60000);
  assert.equal((await post("register/resend", {}, sent.cookie)).status, 200);
  // Extremely unlikely repeated random codes are still valid only for the latest request.
  if (old !== code()) assert.equal((await post("register/verify", { code: old }, sent.cookie)).status, 400);
  now = new Date(now.getTime() + 10 * 60000);
  assert.equal((await post("register/verify", { code: code() }, sent.cookie)).status, 400);
  assert.equal(await db.user.count({ where: { email } }), 0);
});
it("fails closed on unavailable or rejected email and enforces strict inputs and CSRF", async () => {
  available = false; assert.equal((await post("register", payload())).status, 503);
  available = true; fail = true; assert.equal((await post("register", payload())).status, 500);
  assert.equal(await db.pendingRegistration.count({ where: { email } }), 0);
  assert.equal((await post("register", payload(), "", false)).status, 403);
  assert.equal((await post("register", { ...payload(), role: "SUPER_ADMIN" })).status, 400);
  assert.equal(await db.user.count({ where: { email } }), 0);
});
it("atomically consumes concurrent verification and permits only one organization", async () => {
  const sent = await post("register", payload());
  const results = await Promise.all([post("register/verify", { code: code() }, sent.cookie), post("register/verify", { code: code() }, sent.cookie)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 400]);
  assert.equal(await db.user.count({ where: { email } }), 1);
});

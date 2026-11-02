import "dotenv/config";
import assert from "node:assert/strict";
import { it } from "node:test";
import { SMTPServer } from "smtp-server";
import { smtpMailer } from "../src/services/mail";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/server";
import { TRIAL_MS } from "../src/auth/security";
it("delivers through an actual loopback SMTP test server and confirms recipient acceptance", async () => {
  let received = "";
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, _session, callback) {
      stream.on("data", (chunk) => {
        received += chunk.toString();
      });
      stream.on("end", callback);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.server.address() as { port: number }).port;
    const mailer = smtpMailer({
      NODE_ENV: "development",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(port),
      SMTP_FROM: "HRMS <sender@example.test>",
      SMTP_ALLOW_INSECURE_LOCAL: "true",
    });
    assert.equal(mailer.available, true);
    await mailer.send({
      to: "recipient@example.test",
      subject: "SMTP integration test",
      text: "No live token is included in this transport test.",
    });
    assert.ok(received.includes("SMTP integration test"));
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
  }
});
it("does not permit unencrypted non-loopback SMTP or incomplete production credentials", () => {
  assert.equal(
    smtpMailer({
      NODE_ENV: "production",
      SMTP_HOST: "smtp.example.test",
      SMTP_FROM: "sender@example.test",
      SMTP_ALLOW_INSECURE_LOCAL: "true",
    }).available,
    false,
  );
});
it("reports missing configuration without constructing a connection or exposing credentials", async () => {
  const mailer = smtpMailer({}, () => { throw new Error("Must not connect"); });
  assert.equal(mailer.available, false);
  assert.equal(mailer.configurationError?.code, "EMAIL_NOT_CONFIGURED");
  for (const name of ["SMTP_HOST", "SMTP_FROM", "SMTP_USER", "SMTP_PASSWORD"])
    assert.ok(mailer.configurationError?.message.includes(name));
  await assert.rejects(mailer.checkConnection!(), { code: "EMAIL_NOT_CONFIGURED" });
  assert.equal(smtpMailer({ MAIL_PROVIDER: "resend" }).configurationError?.message.includes("RESEND_API_KEY"), true);
  assert.equal(smtpMailer({ MAIL_PROVIDER: "unknown" }).configurationError?.code, "EMAIL_PROVIDER_INVALID");
});
it("uses the Resend SMTP TLS preset and passes a private API key only to the mail transport", async () => {
  let sent = false, checked = false;
  const mailer = smtpMailer({ MAIL_PROVIDER: "resend", SMTP_FROM: "HRMS <accounts@example.test>", RESEND_API_KEY: "fixture_private_key", SMTP_HOST: "ignored.example.test" }, (options) => {
    assert.equal(options.host, "smtp.resend.com");
    assert.equal(options.port, 465);
    assert.equal(options.secure, true);
    assert.deepEqual(options.auth, { user: "resend", pass: "fixture_private_key" });
    assert.equal(options.tls?.rejectUnauthorized, true);
    return {
      async verify() { checked = true; return true; },
      async sendMail(message) { sent = true; assert.equal(message.from, "HRMS <accounts@example.test>"); return { accepted: [message.to], rejected: [] }; },
    };
  });
  assert.equal(mailer.available, true);
  await mailer.checkConnection!();
  await mailer.send({ to: "recipient@example.test", subject: "Fixture", text: "Fixture" });
  assert.equal(sent && checked, true);
  assert.equal(JSON.stringify(mailer).includes("fixture_private_key"), false);
});
it("uses Gmail TLS and the authenticated sender, normalizes App Password spaces, and rejects missing credentials", async () => {
  assert.equal(smtpMailer({ MAIL_PROVIDER: "gmail" }, () => { throw new Error("Must not connect"); }).configurationError?.code, "EMAIL_NOT_CONFIGURED");
  assert.equal(smtpMailer({ MAIL_PROVIDER: "gmail", SMTP_USER: "sender@gmail.com", SMTP_PASSWORD: "normal-password" }).configurationError?.code, "EMAIL_GMAIL_CONFIG_INVALID");
  const mailer = smtpMailer({ MAIL_PROVIDER: "gmail", SMTP_USER: " sender@gmail.com ", SMTP_PASSWORD: "abcd efgh ijkl mnop", SMTP_FROM: "old@resend.dev", SMTP_HOST: "ignored.example.test", SMTP_PORT: "25", SMTP_SECURE: "false" }, (options) => {
    assert.equal(options.host, "smtp.gmail.com");
    assert.equal(options.port, 465);
    assert.equal(options.secure, true);
    assert.equal(options.ignoreTLS, false);
    assert.equal(options.tls?.rejectUnauthorized, true);
    assert.deepEqual(options.auth, { user: "sender@gmail.com", pass: "abcdefghijklmnop" });
    return { async verify() { return true; }, async sendMail(message) {
      assert.equal(message.from, "sender@gmail.com");
      return { accepted: [message.to], rejected: [] };
    } };
  });
  await mailer.checkConnection!();
  await mailer.send({ to: "recipient@example.test", subject: "OTP fixture", text: "Fixture" });
});
it("rejects invalid SMTP settings and returns safe authentication, connection and rejection errors", async () => {
  const env = { SMTP_HOST: "smtp.example.test", SMTP_FROM: "sender@example.test", SMTP_USER: "fixture_user", SMTP_PASSWORD: "fixture_password" };
  assert.equal(smtpMailer({ ...env, SMTP_PORT: "wrong" }).configurationError?.code, "EMAIL_PORT_INVALID");
  assert.equal(smtpMailer({ ...env, SMTP_SECURE: "wrong" }).configurationError?.code, "EMAIL_TLS_INVALID");
  for (const [providerCode, expected] of [["EAUTH", "EMAIL_AUTH_FAILED"], ["ETIMEDOUT", "EMAIL_CONNECTION_FAILED"], ["EENVELOPE", "EMAIL_DELIVERY_FAILED"]]) {
    const fail = async () => { throw Object.assign(new Error("Secret fixture_password; provider response must remain private"), { code: providerCode }); };
    const mailer = smtpMailer(env, () => ({ verify: fail, sendMail: fail }));
    for (const request of [() => mailer.checkConnection!(), () => mailer.send({ to: "recipient@example.test", subject: "Fixture", text: "Fixture" })]) {
      await assert.rejects(request(), (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error);
        assert.equal(error.code, expected);
        assert.equal(error.message.includes("fixture_password"), false);
        return true;
      });
    }
  }
});
it("does not claim delivery when a real SMTP server rejects the recipient", async () => {
  const smtp = new SMTPServer({ authOptional: true, disabledCommands: ["AUTH", "STARTTLS"], onRcptTo(_address, _session, callback) { callback(new Error("Recipient rejected")); } });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  try {
    const mailer = smtpMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String((smtp.server.address() as { port: number }).port), SMTP_FROM: "sender@example.test", SMTP_ALLOW_INSECURE_LOCAL: "true" });
    await assert.rejects(mailer.send({ to: "recipient@example.test", subject: "Rejected fixture", text: "No token" }), { code: "EMAIL_DELIVERY_FAILED" });
  } finally { await new Promise<void>((resolve) => smtp.close(resolve)); }
});
it("identifies provider test-recipient restrictions without exposing the provider account email", async () => {
  const mailer = smtpMailer({ MAIL_PROVIDER: "resend", SMTP_FROM: "onboarding@resend.dev", RESEND_API_KEY: "fixture_private_key" }, () => ({
    async verify() { return true; },
    async sendMail() { throw Object.assign(new Error("Private provider response"), { code: "EENVELOPE", response: "550 You can only send testing emails to your own email address (private@example.test)." }); },
  }));
  await assert.rejects(mailer.send({ to: "recipient@example.test", subject: "Fixture", text: "Fixture" }), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error);
    assert.equal(error.code, "EMAIL_TEST_RECIPIENT_RESTRICTED");
    assert.equal(error.message.includes("private@example.test"), false);
    return true;
  });
});
it("requires registration OTP delivered through real loopback SMTP before creating an account", async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const db = new PrismaClient(), run = randomUUID(), email = `smtp-registration-${run}@example.test`;
  const organizationName = `SMTP registration ${run}`, messages: string[] = [];
  const smtp = new SMTPServer({
    authOptional: true, disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, _session, callback) {
      let raw = "";
      stream.on("data", (chunk) => { raw += chunk.toString(); });
      stream.on("end", () => { messages.push(raw); callback(); });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const mailer = smtpMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String((smtp.server.address() as { port: number }).port), SMTP_FROM: "HRMS <sender@example.test>", SMTP_ALLOW_INSECURE_LOCAL: "true" });
  const app = createApp(db, { frontendOrigin: "http://localhost:3000", production: false }, { mailer });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown, cookie?: string) => fetch(base + path, { method: "POST", headers: { Origin: "http://localhost:3000", "X-HRMS-Request": "1", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  try {
    const response = await post("/api/auth/register", { organizationName, employeeSize: "11-50", fullName: "SMTP Test Admin", email, phoneNumber: "+919876543210", password: "8charsOK", confirmPassword: "8charsOK" });
    assert.equal(response.status, 202);
    const registration = await response.json();
    assert.equal(registration.verificationRequired, true);
    assert.equal(registration.user, undefined);
    assert.equal(messages.length, 1);
    assert.equal(await db.user.count({ where: { email } }), 0);
    const registeredCookie = response.headers.getSetCookie().find((value) => value.startsWith("hrms_registration="))?.split(";")[0];
    assert.ok(registeredCookie);
    assert.equal((await fetch(base + "/api/auth/me", { headers: { Cookie: registeredCookie } })).status, 401);
    const decoded = messages[0]!.replace(/=\r?\n/g, "").replace(/=([A-F0-9]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    const code = decoded.match(/registration code is: (\d{6})/)?.[1];
    assert.ok(code, "Email must contain the registration OTP");
    assert.equal(JSON.stringify(registration).includes(code), false);
    const stored = await db.pendingRegistration.findFirstOrThrow({ where: { email } });
    assert.notEqual(stored.codeHash, code);
    assert.ok(stored.expiresAt > new Date());
    const confirmation = await post("/api/auth/register/verify", { code }, registeredCookie);
    assert.equal(confirmation.status, 201);
    const user = await db.user.findUniqueOrThrow({ where: { email }, include: { organization: true } });
    assert.ok(user.emailVerifiedAt);
    assert.equal(user.organization.trialExpiresAt!.getTime() - user.organization.trialStartedAt!.getTime(), TRIAL_MS);
    const cookie = confirmation.headers.getSetCookie().find((value) => value.startsWith("hrms_session="))?.split(";")[0];
    assert.ok(cookie);
    const me = await fetch(base + "/api/auth/me", { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, user.id);
    assert.equal((await post("/api/auth/register/verify", { code }, registeredCookie)).status, 400);
    const after = await db.organization.findUniqueOrThrow({ where: { id: user.organizationId } });
    assert.equal(after.trialExpiresAt?.getTime(), user.organization.trialExpiresAt?.getTime());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => smtp.close(resolve));
    const fixture = await db.user.findUnique({ where: { email }, include: { organization: true } });
    if (fixture?.organization.name === organizationName) await db.organization.delete({ where: { id: fixture.organizationId } });
    await db.pendingRegistration.deleteMany({ where: { email } });
    await db.$disconnect();
  }
});

import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Server } from "node:http";
import { Prisma, PrismaClient } from "@prisma/client";
import { createApp, configuration } from "../src/server";
import {
  cookieOptions,
  hashToken,
  organizationScope,
  SESSION_MS,
  TRIAL_MS,
} from "../src/auth/security";
import { hashPassword, verifyPassword } from "../src/auth/password";

const db = new PrismaClient();
const run = randomUUID();
const password = randomUUID().replaceAll("-", "").slice(0, 8);
const emailA = `auth-a-${run}@example.test`;
const emailB = `auth-b-${run}@example.test`;
const origin = "http://localhost:3000";
const createdOrganizations: string[] = [];
let server: Server;
let base = "";
let cookieA = "";
let cookieB = "";
let orgA = "";
let orgB = "";
let userA = "";
const registrationCodes = new Map<string, string>();

async function request(
  path: string,
  body?: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: origin,
      "X-HRMS-Request": "1",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (path === "/api/auth/register" && response.status === 202) {
    return request("/api/auth/register/verify", { code: registrationCodes.get(data.email) }, response.headers.get("set-cookie")?.split(";")[0]);
  }
  return {
    status: response.status,
    data,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    headers: response.headers,
  };
}
function registration(email: string) {
  return {
    organizationName: `Auth test ${run}`,
    fullName: "Test Administrator",
    employeeSize: "11-50",
    phoneNumber: "+91 98765 43210",
    email,
    password,
    confirmPassword: password,
  };
}

describe(
  "MySQL organization authentication integration",
  { concurrency: false },
  () => {
    before(async () => {
      await db.$connect();
      const app = createApp(db, { frontendOrigin: origin, production: false }, { mailer: { available: true, async send(message) { registrationCodes.set(message.to, message.text.match(/code is: (\d{6})/)![1]!); } } });
      server = await new Promise<Server>((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      });
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    after(async () => {
      // Delete only records created by this test run, never pre-existing data.
      if (createdOrganizations.length)
        await db.organization.deleteMany({
          where: { id: { in: createdOrganizations } },
        });
      if (server)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await db.$disconnect();
    });
    it("preserves health endpoints", async () => {
      assert.equal((await request("/api/health")).data.success, true);
      assert.equal(
        (await request("/api/health/database")).data.database,
        "connected",
      );
    });
    it("registers an organization after email OTP with an eight-character password, session and exact seven-day trial", async () => {
      assert.equal(password.length, 8);
      const result = await request(
        "/api/auth/register",
        registration(emailA.toUpperCase()),
      );
      if (result.data.user)
        createdOrganizations.push(result.data.user.organizationId);
      assert.equal(result.status, 201);
      assert.equal(result.data.verificationRequired, false);
      assert.ok(result.data.user.emailVerifiedAt);
      assert.match(result.cookie, /^hrms_session=/);
      assert.equal((await request("/api/auth/me", undefined, result.cookie)).status, 200);
      const { user } = result.data;
      orgA = user.organizationId;
      userA = user.id;
      cookieA = result.cookie;
      assert.equal(user.role, "ORGANIZATION_ADMIN");
      assert.equal(user.email, emailA);
      assert.equal("passwordHash" in user, false);
      assert.equal("token" in result.data, false);
      const record = await db.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      assert.equal(record.passwordHash.startsWith("scrypt$65536$8$2$"), true);
      assert.equal(await verifyPassword(password, record.passwordHash), true);
      assert.equal(
        await verifyPassword(
          "A completely wrong passphrase",
          record.passwordHash,
        ),
        false,
      );
      assert.equal(
        Date.parse(user.organization.trialExpiresAt) -
          Date.parse(user.organization.trialStartedAt),
        TRIAL_MS,
      );
      assert.match(result.headers.get("set-cookie")!, /HttpOnly/i);
      assert.match(result.headers.get("set-cookie")!, /SameSite=Lax/i);
      const token = cookieA.split("=")[1]!;
      const session = await db.session.findUniqueOrThrow({
        where: { tokenHash: hashToken(token) },
      });
      assert.equal(session.tokenHash === token, false);
      assert.equal(session.userId, user.id);
      assert.equal(session.authVersion, 0);
      assert.ok(
        Math.abs(session.expiresAt.getTime() - Date.now() - SESSION_MS) < 10000,
      );
    });
    it("rejects duplicate email including case changes and rolls back the new organization", async () => {
      const name = `Duplicate rollback ${run}`;
      const result = await request("/api/auth/register", {
        ...registration(emailA.toUpperCase()),
        organizationName: name,
      });
      assert.equal(result.status, 409);
      assert.equal(result.data.success, false);
      assert.equal(await db.organization.count({ where: { name } }), 0);
    });
    it("validates registration on the server and rejects public role and tenant selection", async () => {
      const invalid = [
        { ...registration(emailB), email: "not-email" },
        {
          ...registration(emailB),
          password: "1234567",
          confirmPassword: "1234567",
        },
        { ...registration(emailB), password: "a".repeat(129), confirmPassword: "a".repeat(129) },
        { ...registration(emailB), confirmPassword: "different" },
        { ...registration(emailB), organizationName: " " },
        { ...registration(emailB), role: "ORGANIZATION_ADMIN" },
        { ...registration(emailB), organizationId: orgA },
        { ...registration(emailB), emailVerifiedAt: new Date().toISOString() },
      ];
      for (const payload of invalid) {
        const result = await request("/api/auth/register", payload);
        assert.equal(result.status, 400);
        assert.equal(result.cookie, "");
      }
      assert.equal(await db.user.count({ where: { email: emailB } }), 0);
    });
    it("rejects untrusted, missing-Origin, and missing-custom-header state changes", async () => {
      for (const headers of [
        { Origin: "https://untrusted.example" },
        { Origin: "" },
        { "X-HRMS-Request": "" },
      ])
        assert.equal(
          (await request("/api/auth/logout", {}, cookieA, headers)).status,
          403,
        );
      assert.equal(
        (await request("/api/auth/me", undefined, cookieA)).status,
        200,
      );
    });
    it("returns one generic error for unknown accounts and wrong passwords", async () => {
      const wrong = await request("/api/auth/login", {
        email: emailA,
        password: "A completely wrong passphrase",
      });
      const missing = await request("/api/auth/login", {
        email: `missing-${run}@example.test`,
        password,
      });
      assert.equal(wrong.status, 401);
      assert.equal(missing.status, 401);
      assert.equal(wrong.data.message, missing.data.message);
      assert.equal(wrong.cookie, "");
      assert.equal(missing.cookie, "");
    });
    it("logs in and rotates the supplied session instead of reusing it", async () => {
      const previous = cookieA;
      const result = await request(
        "/api/auth/login",
        { email: emailA, password },
        previous,
      );
      assert.equal(result.status, 200);
      assert.ok(result.cookie && result.cookie !== previous);
      cookieA = result.cookie;
      assert.equal(
        (await request("/api/auth/me", undefined, previous)).status,
        401,
      );
      const me = await request("/api/auth/me", undefined, cookieA);
      assert.equal(me.data.user.id, userA);
      assert.equal(me.data.user.organizationId, orgA);
      assert.match(me.headers.get("cache-control")!, /no-store/);
    });
    it("rejects missing, forged, and expired session cookies", async () => {
      assert.equal((await request("/api/auth/me")).status, 401);
      assert.equal((await request("/api/organization")).status, 401);
      assert.equal(
        (
          await request(
            "/api/auth/me",
            undefined,
            `hrms_session=${"a".repeat(64)}`,
          )
        ).status,
        401,
      );
      const temporary = await request("/api/auth/login", {
        email: emailA,
        password,
      });
      await db.session.update({
        where: { tokenHash: hashToken(temporary.cookie.split("=")[1]!) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      assert.equal(
        (await request("/api/auth/me", undefined, temporary.cookie)).status,
        401,
      );
    });
    it("isolates two organizations despite tampered URL and query parameters", async () => {
      assert.equal(
        (await request("/api/organization", undefined, cookieA)).status,
        200,
      );
      await db.user.update({
        where: { id: userA },
        data: { emailVerifiedAt: new Date() },
      });
      const second = await request("/api/auth/register", registration(emailB));
      if (second.data.user)
        createdOrganizations.push(second.data.user.organizationId);
      assert.equal(second.status, 201);
      orgB = second.data.user.organizationId;
      cookieB = second.cookie;
      await db.user.update({
        where: { id: second.data.user.id },
        data: { emailVerifiedAt: new Date() },
      });
      cookieB = (await request("/api/auth/login", { email: emailB, password })).cookie;
      assert.equal(
        (await request(`/api/organizations/${orgB}`, undefined, cookieA))
          .status,
        403,
      );
      assert.equal(
        (await request(`/api/organizations/${orgA}`, undefined, cookieB))
          .status,
        403,
      );
      assert.equal(
        (await request(`/api/organizations/${orgA}`, undefined, cookieA)).data
          .organization.id,
        orgA,
      );
      assert.equal(
        (
          await request(
            `/api/organization?organizationId=${orgB}`,
            undefined,
            cookieA,
          )
        ).data.organization.id,
        orgA,
      );
      assert.equal(
        organizationScope({
          userId: userA,
          organizationId: orgA,
          role: "ORGANIZATION_ADMIN",
        }).organizationId,
        orgA,
      );
    });
    it("checks current roles on the backend, not client-provided roles", async () => {
      try {
        await db.user.update({
          where: { id: userA },
          data: { role: "EMPLOYEE" },
        });
        assert.equal(
          (await request("/api/organization", undefined, cookieA)).status,
          403,
        );
      } finally {
        await db.user.update({
          where: { id: userA },
          data: { role: "ORGANIZATION_ADMIN" },
        });
      }
    });
    it("logs out and revokes the server session; the other organization stays signed in", async () => {
      assert.equal(
        (await request("/api/auth/logout", {}, cookieA)).status,
        200,
      );
      assert.equal(
        (await request("/api/auth/me", undefined, cookieA)).status,
        401,
      );
      assert.equal(
        (await request("/api/auth/me", undefined, cookieB)).status,
        200,
      );
      assert.equal((await request("/api/auth/logout", {})).status, 200);
    });
    it("uses secure production cookies and rejects unsafe production origin configuration", () => {
      assert.equal(cookieOptions(true).secure, true);
      assert.equal(cookieOptions(true).httpOnly, true);
      const nodeEnv = process.env.NODE_ENV;
      const frontendOrigin = process.env.FRONTEND_URL;
      try {
        process.env.NODE_ENV = "production";
        process.env.FRONTEND_URL = "http://localhost:3000";
        assert.throws(configuration);
        delete process.env.FRONTEND_URL;
        assert.throws(configuration);
      } finally {
        if (nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnv;
        if (frontendOrigin === undefined) delete process.env.FRONTEND_URL;
        else process.env.FRONTEND_URL = frontendOrigin;
      }
    });
    it("returns consistent errors for malformed JSON and rejects compressed bodies", async () => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: {
          Origin: origin,
          "X-HRMS-Request": "1",
          "Content-Type": "application/json",
        },
        body: "{",
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).success, false);
      const compressed = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: {
          Origin: origin,
          "X-HRMS-Request": "1",
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
        },
        body: gzipSync("{}"),
      });
      assert.equal(compressed.status, 415);
      assert.equal((await compressed.json()).success, false);
    });
    it("throttles repeated invalid login attempts", async () => {
      let result;
      for (let attempt = 0; attempt < 21; attempt++) {
        result = await request("/api/auth/login", {});
        if (result.status === 429) break;
      }
      assert.equal(result?.status, 429);
      assert.ok(result?.headers.get("retry-after"));
    });
  },
);

describe("password hashing", () => {
  it("uses independent salts and validates hash formats without accepting malformed hashes", async () => {
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    assert.equal(first === second, false);
    assert.equal(await verifyPassword(password, "invalid"), false);
  });
});

describe("database error handling", () => {
  it("returns a generic unavailable response without disclosing database details", async () => {
    const unavailable = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "session")
          return {
            findUnique: async () => {
              throw new Prisma.PrismaClientInitializationError(
                "Internal database detail",
                "test",
              );
            },
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const app = createApp(unavailable, {
      frontendOrigin: origin,
      production: false,
    });
    const listener = await new Promise<Server>((resolve) => {
      const result = app.listen(0, "127.0.0.1", () => resolve(result));
    });
    try {
      const port = (listener.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
        headers: { Cookie: `hrms_session=${"a".repeat(64)}` },
      });
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.equal(text.includes("Internal database detail"), false);
      assert.equal(JSON.parse(text).success, false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

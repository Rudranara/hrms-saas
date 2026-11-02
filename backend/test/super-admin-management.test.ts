import "dotenv/config";
import assert from "node:assert/strict";
import { before, beforeEach, afterEach, after, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/server";
import { hashPassword, verifyPassword } from "../src/auth/password";
import { newSession } from "../src/auth/security";

if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
const db = new PrismaClient(), origin = "http://localhost:3000", password = "Management fixture passphrase";
let hash = "", actorId = "", organizationId = "", cookie = "", tenantCookie = "", base = "", server: Server;
let createdIds: string[];
const input = () => ({ fullName: "New platform administrator", email: `${randomUUID()}@example.test`, password, confirmPassword: password });
async function request(method = "GET", path = "", body?: unknown, auth = cookie, trusted = true) {
  const response = await fetch(`${base}/api/super-admin/admins${path}`, { method, headers: {
    Cookie: auth, "Content-Type": "application/json", ...(trusted ? { Origin: origin, "X-HRMS-Request": "1" } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (response.status === 201 && data.admin?.id) createdIds.push(data.admin.id);
  return { status: response.status, data };
}
before(async () => { hash = await hashPassword(password); });
beforeEach(async () => {
  createdIds = [];
  const actor = await db.superAdmin.create({ data: { fullName: "Management fixture operator", email: `${randomUUID()}@example.test`, passwordHash: hash } }); actorId = actor.id;
  const session = newSession();
  await db.superAdminSession.create({ data: { superAdminId: actorId, tokenHash: session.tokenHash, expiresAt: session.expiresAt } }); cookie = `hrms_platform_session=${session.token}`;
  const org = await db.organization.create({ data: { name: "Management isolation fixture", users: { create: { fullName: "Tenant operator", email: `${randomUUID()}@example.test`, passwordHash: hash, role: "ORGANIZATION_ADMIN" } } }, include: { users: true } }); organizationId = org.id;
  const tenantSession = newSession();
  await db.session.create({ data: { userId: org.users[0]!.id, tokenHash: tenantSession.tokenHash, expiresAt: tenantSession.expiresAt } }); tenantCookie = `hrms_session=${tenantSession.token}`;
  server = createApp(db, { frontendOrigin: origin, production: false }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  const ids = [actorId, ...createdIds];
  await db.superAdminAuditEvent.deleteMany({ where: { actorSuperAdminId: { in: ids } } });
  await db.superAdmin.deleteMany({ where: { id: { in: ids } } });
  if (organizationId) await db.organization.delete({ where: { id: organizationId } });
});
after(async () => { await db.$disconnect(); });

it("restricts listing and creation to active platform sessions and retains CSRF checks", async () => {
  for (const auth of ["", tenantCookie]) {
    assert.equal((await request("GET", "", undefined, auth)).status, 401);
    assert.equal((await request("POST", "", input(), auth)).status, 401);
  }
  assert.equal((await request("POST", "", input(), cookie, false)).status, 403);
  await db.superAdmin.update({ where: { id: actorId }, data: { isActive: false } });
  assert.equal((await request()).status, 401);
  assert.equal((await request("POST", "", input())).status, 401);
  await db.superAdmin.update({ where: { id: actorId }, data: { isActive: true, authVersion: { increment: 1 } } });
  assert.equal((await request("POST", "", input())).status, 401);
});
it("creates a dedicated super admin with a hashed password, honest verification state and secret-free audit history", async () => {
  const value = input(), tenantBefore = await db.user.findFirstOrThrow({ where: { organizationId } });
  const before = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const result = await request("POST", "", { ...value, fullName: "  New operator  ", email: value.email.toUpperCase() });
  assert.equal(result.status, 201); assert.equal(result.data.admin.fullName, "New operator"); assert.equal(result.data.admin.email, value.email);
  assert.equal(result.data.admin.emailVerifiedAt, null); assert.equal(result.data.admin.isActive, true);
  const admin = await db.superAdmin.findUniqueOrThrow({ where: { id: result.data.admin.id } });
  assert.notEqual(admin.passwordHash, password); assert.equal(await verifyPassword(password, admin.passwordHash), true);
  assert.equal(JSON.stringify(result.data).includes("passwordHash"), false); assert.equal(JSON.stringify(result.data).includes(password), false);
  const events = await db.superAdminAuditEvent.findMany({ where: { actorSuperAdminId: { in: [actorId, admin.id] } } });
  assert.ok(events.some((event) => event.actorSuperAdminId === actorId && event.action === "SUPER_ADMIN_CREATED"));
  assert.ok(events.some((event) => event.actorSuperAdminId === admin.id && event.action === "ACCOUNT_PROVISIONED"));
  assert.equal(JSON.stringify(events).includes(password), false); assert.equal(JSON.stringify(events).includes(admin.passwordHash), false);
  assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: tenantBefore.id } }), tenantBefore);
  assert.deepEqual(await db.organization.findUniqueOrThrow({ where: { id: organizationId } }), before);
  const login = await fetch(`${base}/api/super-admin/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify({ email: value.email, password }) });
  assert.equal(login.status, 200);
  const newCookie = login.headers.getSetCookie().find((item) => item.startsWith("hrms_platform_session="))!.split(";")[0]!;
  assert.equal((await request("POST", "", input(), newCookie)).status, 201, "New super admins have the same creation permission");
});
it("rejects mismatched passwords, invalid fields and attempts to choose IDs, roles or verification status", async () => {
  const value = input();
  for (const body of [
    { ...value, confirmPassword: "different password" }, { ...value, password: "short", confirmPassword: "short" },
    { ...value, email: "invalid" }, { ...value, fullName: " " },
    { ...value, id: actorId }, { ...value, role: "SUPER_ADMIN" }, { ...value, isActive: false }, { ...value, emailVerifiedAt: new Date().toISOString() },
  ]) assert.equal((await request("POST", "", body)).status, 400);
  assert.equal(await db.superAdmin.count({ where: { email: value.email } }), 0);
});
it("rejects duplicates including concurrent creation without updating an existing account", async () => {
  const value = input(), results = await Promise.all([request("POST", "", value), request("POST", "", value)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(await db.superAdmin.count({ where: { email: value.email } }), 1);
  const original = await db.superAdmin.findUniqueOrThrow({ where: { email: value.email } });
  assert.equal((await request("POST", "", { ...value, email: value.email.toUpperCase(), fullName: "Overwrite attempt" })).status, 409);
  assert.deepEqual(await db.superAdmin.findUniqueOrThrow({ where: { email: value.email } }), original);
});
it("returns a bounded read-only directory with no password or session fields", async () => {
  await request("POST", "", input()); // Supply the second row instead of relying on a real existing owner.
  const first = await request("GET", "?page=1&pageSize=1"), second = await request("GET", "?page=2&pageSize=1");
  assert.equal(first.status, 200); assert.equal(first.data.items.length, 1); assert.equal(first.data.pageSize, 1);
  assert.notEqual(first.data.items[0].id, second.data.items[0].id);
  for (const field of ["passwordHash", "authVersion", "tokenHash", "sessions"]) assert.equal(JSON.stringify(first.data).includes(field), false);
  assert.equal((await request("GET", "?pageSize=51")).status, 400);
  assert.equal((await request("GET", "?role=SUPER_ADMIN")).status, 400);
});
it("does not expose edit or delete routes for other super-admin accounts", async () => {
  const created = await request("POST", "", input()), id = created.data.admin.id;
  const original = await db.superAdmin.findUniqueOrThrow({ where: { id } });
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    for (const path of ["", `/${id}`]) assert.equal((await request(method, path, { fullName: "Changed", email: "changed@example.test" })).status, 404);
  }
  assert.equal((await request("POST", `/${id}`, input())).status, 404);
  assert.deepEqual(await db.superAdmin.findUniqueOrThrow({ where: { id } }), original);
});
it("limits account-creation attempts", async () => {
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await request("POST", "", {})).status, 400);
  assert.equal((await request("POST", "", input())).status, 429);
  assert.equal((await request()).status, 200);
});

import "dotenv/config";
import assert from "node:assert/strict";
import { before, beforeEach, afterEach, after, it } from "node:test";
import { randomUUID, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Server } from "node:http";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/server";
import { hashPassword, verifyPassword } from "../src/auth/password";
import { newSession, hashToken } from "../src/auth/security";
import { provisionSuperAdmin, resetSuperAdminPassword } from "../src/super-admin/provision";

if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
const db = new PrismaClient(), origin = "http://localhost:3000", password = "Platform auth fixture password", orgPassword = "Separate organization fixture password";
let hash = "", orgHash = "", adminId = "", userId = "", legacyId = "", orgId = "", email = "", server: Server, base = "", cookie = "", orgCookie = "";
const extra: string[] = [];
async function request(path: string, body?: unknown, auth = "", csrf = true) {
  const response = await fetch(base + "/api" + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(csrf ? { Origin: origin, "X-HRMS-Request": "1" } : {}), Cookie: auth }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
const login = (address = email, pass = password, auth = "") => request("/super-admin/auth/login", { email: address, password: pass }, auth);
before(async () => { hash = await hashPassword(password); orgHash = await hashPassword(orgPassword); });
beforeEach(async () => {
  email = randomUUID()+"@example.test";
  orgId = (await db.organization.create({ data: { name: "Isolated platform authentication " + randomUUID(), trialStartedAt: new Date(), trialExpiresAt: new Date(Date.now() + 7 * 86400000) } })).id;
  userId = (await db.user.create({ data: { organizationId: orgId, fullName: "Tenant", email, passwordHash: orgHash, role: "ORGANIZATION_ADMIN" } })).id;
  legacyId = (await db.user.create({ data: { organizationId: orgId, fullName: "Legacy platform user", email: "legacy-" + email, passwordHash: hash, role: "SUPER_ADMIN" } })).id;
  adminId = (await db.superAdmin.create({ data: { fullName: "Platform owner", email, passwordHash: hash } })).id;
  const platform = newSession(), tenant = newSession();
  await db.superAdminSession.create({ data: { superAdminId: adminId, tokenHash: platform.tokenHash, expiresAt: platform.expiresAt } });
  await db.session.create({ data: { userId, tokenHash: tenant.tokenHash, expiresAt: tenant.expiresAt } });
  cookie = "hrms_platform_session="+platform.token; orgCookie = "hrms_session="+tenant.token;
  server = createApp(db, { frontendOrigin: origin, production: false }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve)); base = "http://127.0.0.1:"+(server.address() as { port: number }).port;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.superAdminAuditEvent.deleteMany({ where: { actorSuperAdminId: { in: [adminId, ...extra] } } });
  await db.superAdmin.deleteMany({ where: { id: { in: [adminId, ...extra] } } }); extra.length = 0;
  await db.adminAuditEvent.deleteMany({ where: { actorUserId: { in: [userId, legacyId] } } });
  await db.organization.delete({ where: { id: orgId } });
});
after(async () => db.$disconnect());
it("authenticates only SuperAdmin, allows independent matching emails, and never falls back to User", async () => {
  const userBefore = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const success = await login(email.toUpperCase()); assert.equal(success.status, 200); assert.equal(success.data.admin.id, adminId); assert.equal(success.data.user, undefined);
  const header = success.headers.getSetCookie().find((value) => value.startsWith("hrms_platform_session="))!; assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Lax/);
  assert.equal(success.headers.getSetCookie().some((value) => value.startsWith("hrms_session=")), false);
  for (const [address, pass] of [[email, orgPassword], ["legacy-"+email, password], [randomUUID()+"@example.test", password]]) {
    const denied = await login(address, pass); assert.equal(denied.status, 401); assert.equal(denied.headers.getSetCookie().length, 0); assert.equal(denied.data.admin, undefined);
  }
  assert.equal((await request("/auth/login", { email, password: orgPassword })).status, 200);
  assert.equal((await request("/auth/login", { email, password })).status, 401);
  assert.equal((await request("/auth/login", { email, password, scope: "platform" })).status, 400);
  assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: userId } }), { ...userBefore, updatedAt: (await db.user.findUniqueOrThrow({ where: { id: userId } })).updatedAt });
});
it("rejects ordinary, legacy, forged and renamed cookies on every platform endpoint, and rejects platform cookies on tenant APIs", async () => {
  const legacy = newSession(); await db.session.create({ data: { userId: legacyId, tokenHash: legacy.tokenHash, expiresAt: legacy.expiresAt } });
  const paths = ["/super-admin/auth/me", "/super-admin/metrics", "/super-admin/revenue", "/super-admin/organizations", "/super-admin/organizations/"+orgId, "/super-admin/organizations/"+orgId+"/subscriptions", "/super-admin/organizations/"+orgId+"/payments", "/super-admin/account"];
  for (const path of paths) for (const auth of ["", orgCookie, "hrms_session="+legacy.token, orgCookie.replace("hrms_session", "hrms_platform_session"), "hrms_platform_session="+"0".repeat(64)]) assert.equal((await request(path, undefined, auth)).status, 401);
  for (const path of ["/auth/me", "/organization", "/billing/status"]) for (const auth of [cookie, cookie.replace("hrms_platform_session", "hrms_session")]) assert.equal((await request(path, undefined, auth)).status, 401);
  assert.equal((await request("/auth/me", undefined, orgCookie)).data.user.id, userId);
  assert.equal((await request("/super-admin/auth/me", undefined, cookie)).data.admin.id, adminId);
});
it("denies inactive, revoked-version, expired, deleted-session and deleted-account access using generic messages", async () => {
  await db.superAdmin.update({ where: { id: adminId }, data: { isActive: false } });
  const inactive = await login(), unknown = await login("missing-"+email); assert.equal(inactive.status, 401); assert.deepEqual(inactive.data, unknown.data);
  assert.equal((await request("/super-admin/auth/me", undefined, cookie)).status, 401);
  await db.superAdmin.update({ where: { id: adminId }, data: { isActive: true, authVersion: { increment: 1 } } });
  assert.equal((await request("/super-admin/metrics", undefined, cookie)).status, 401);
  const renewed = await login(email, password, cookie); assert.equal(renewed.status, 200);
  cookie = renewed.headers.getSetCookie()[0]!.split(";")[0]!;
  assert.equal(await db.superAdminSession.count({ where: { superAdminId: adminId } }), 1);
  await db.superAdminSession.updateMany({ where: { superAdminId: adminId }, data: { expiresAt: new Date(Date.now()-1000) } });
  assert.equal((await request("/super-admin/metrics", undefined, cookie)).status, 401);
  await db.superAdminSession.deleteMany({ where: { superAdminId: adminId } }); assert.equal((await request("/super-admin/auth/me", undefined, cookie)).status, 401);
  await db.superAdmin.delete({ where: { id: adminId } }); assert.equal((await request("/super-admin/auth/me", undefined, cookie)).status, 401);
});
it("scopes logout to its own session namespace and preserves both accounts and tenant sessions", async () => {
  assert.equal((await request("/super-admin/auth/logout", {}, cookie + "; " + orgCookie)).status, 200);
  assert.equal((await request("/super-admin/auth/me", undefined, cookie)).status, 401);
  assert.equal((await request("/auth/me", undefined, orgCookie)).status, 200);
  const success = await login(); cookie = success.headers.getSetCookie()[0]!.split(";")[0]!;
  assert.equal((await request("/auth/logout", {}, cookie + "; " + orgCookie)).status, 200);
  assert.equal((await request("/super-admin/auth/me", undefined, cookie)).status, 200);
  assert.equal((await request("/auth/me", undefined, orgCookie)).status, 401);
});
it("retains CSRF, strict validation, attempt limits and secure production platform cookies", async () => {
  assert.equal((await request("/super-admin/auth/login", { email, password }, "", false)).status, 403);
  assert.equal((await request("/super-admin/auth/logout", {}, cookie, false)).status, 403);
  assert.equal((await request("/super-admin/auth/login", { email, password, userId, role: "SUPER_ADMIN" })).status, 400);
  for (let i=0;i<19;i++) await request("/super-admin/auth/login", {});
  assert.equal((await login()).status, 429);
  const app = createApp(db, { frontendOrigin: "https://platform.example.test", production: true }).listen(0,"127.0.0.1");
  await new Promise<void>((resolve) => app.once("listening",resolve));
  try {
    const result = await fetch("http://127.0.0.1:"+(app.address() as {port:number}).port+"/api/super-admin/auth/login",{method:"POST",headers:{Origin:"https://platform.example.test","Content-Type":"application/json","X-HRMS-Request":"1"},body:JSON.stringify({email,password})});
    assert.equal(result.status,200);assert.match(result.headers.get("set-cookie")!,/Secure/);
  } finally { await new Promise<void>((resolve)=>app.close(()=>resolve())); }
});
it("provisions a new dedicated account with explicit confirmation and never copies or promotes a matching organization account", async () => {
  const before = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const input = { email: "new-"+email, fullName: "Additional owner", password, initialOwner: false, confirmed: true };
  const matchingTenant = await db.user.create({ data: { organizationId: orgId, email: input.email, fullName: "Independent verified tenant", passwordHash: orgHash, role: "ORGANIZATION_ADMIN", emailVerifiedAt: new Date() } });
  await assert.rejects(provisionSuperAdmin(db, { ...input, confirmed: false }), { code: "INVALID_PROVISIONING" });
  await assert.rejects(provisionSuperAdmin(db, { ...input, initialOwner: true }), { code: "BOOTSTRAP_CLOSED" });
  const created = await provisionSuperAdmin(db, input); extra.push(created.id);
  const admin = await db.superAdmin.findUniqueOrThrow({ where: { id: created.id } });
  assert.equal(admin.emailVerifiedAt, null); assert.equal(admin.isActive, true); assert.equal(await verifyPassword(password, admin.passwordHash), true);
  await assert.rejects(provisionSuperAdmin(db, input), { code: "EMAIL_UNAVAILABLE" });
  await assert.rejects(provisionSuperAdmin(db, { ...input, email: "another-"+email, password:"1234567" }), { code: "INVALID_PROVISIONING" });
  assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: userId } }), before);
  assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: matchingTenant.id } }), matchingTenant);
  const cli = spawnSync(process.execPath,["--import","tsx","scripts/provision-super-admin.ts","--user-id",userId,"--confirm-platform-access"],{encoding:"utf8"}); assert.equal(cli.status,1);
  const noTTY = spawnSync(process.execPath,["--import","tsx","scripts/provision-super-admin.ts","--email","not-created@example.test","--name","No TTY","--additional-admin","--confirm-platform-access"],{encoding:"utf8"});assert.equal(noTTY.status,1);assert.ok(noTTY.stderr.includes("Interactive terminal required"));
});
it("trusted CLI recovery revokes platform sessions without trusting an unverified email or modifying organization credentials", async () => {
  const before = await db.user.findUniqueOrThrow({ where: { id: userId } });
  await assert.rejects(resetSuperAdminPassword(db,adminId,"RecoveryNew8",false),{code:"INVALID_RECOVERY"});
  await resetSuperAdminPassword(db,adminId,"RecoveryNew8",true);
  assert.equal((await request("/super-admin/auth/me",undefined,cookie)).status,401);
  assert.equal((await login(email,"RecoveryNew8")).status,200);
  assert.equal((await db.superAdmin.findUniqueOrThrow({where:{id:adminId}})).emailVerifiedAt,null);
  assert.deepEqual(await db.user.findUniqueOrThrow({where:{id:userId}}),before);
  const events=await db.superAdminAuditEvent.findMany({where:{actorSuperAdminId:adminId}});assert.equal(JSON.stringify(events).includes("RecoveryNew8"),false);
});
it("serializes initial owner bootstrap and requires explicit additional-admin mode afterward", async () => {
  await db.superAdmin.delete({ where: { id: adminId } });
  const input = { email: "initial-"+email, fullName: "Initial owner fixture", password, initialOwner: true, confirmed: true };
  if (await db.superAdmin.count() !== 0) {
    await assert.rejects(provisionSuperAdmin(db,input),{code:"BOOTSTRAP_CLOSED"}); return;
  }
  await assert.rejects(provisionSuperAdmin(db,{...input,initialOwner:false}),{code:"OWNER_REQUIRED"});
  const results = await Promise.allSettled([provisionSuperAdmin(db,input),provisionSuperAdmin(db,{...input,email:"second-"+email})]);
  for (const result of results) if (result.status==="fulfilled") extra.push(result.value.id);
  assert.equal(results.filter((result)=>result.status==="fulfilled").length,1);
  assert.equal(results.filter((result)=>result.status==="rejected").length,1);
  await assert.rejects(provisionSuperAdmin(db,{...input,email:"third-"+email}),{code:"BOOTSTRAP_CLOSED"});
});
it("retains legacy User audit/email-change records without exposing or consuming them as platform records", async () => {
  const oldToken = randomBytes(32).toString("hex");
  const legacyAudit = await db.adminAuditEvent.create({ data: { actorUserId: userId, action: "EMAIL_CHANGED", outcome: "SUCCESS" } });
  const legacyChange = await db.adminEmailChange.create({ data: { userId, newEmail: "legacy-pending-"+email, tokenHash: hashToken(oldToken), authVersion: 0, state: "SENT", expiresAt: new Date(Date.now()+1800000) } });
  const before = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const settings = await request("/super-admin/account",undefined,cookie); assert.deepEqual(settings.data.auditEvents,[]); assert.equal(settings.data.pendingEmailChange,null);
  assert.equal((await request("/super-admin/account/email/confirm",{currentPassword:password,token:oldToken},cookie)).status,400);
  assert.equal((await request("/super-admin/account/password",{currentPassword:password,newPassword:"NewPlatform8",confirmPassword:"NewPlatform8"},cookie)).status,200);
  assert.deepEqual(await db.user.findUniqueOrThrow({where:{id:userId}}),before);
  assert.deepEqual(await db.adminAuditEvent.findUniqueOrThrow({where:{id:legacyAudit.id}}),legacyAudit);
  assert.deepEqual(await db.adminEmailChange.findUniqueOrThrow({where:{id:legacyChange.id}}),legacyChange);
  assert.equal((await request("/auth/me",undefined,orgCookie)).status,200);
});

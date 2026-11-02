// Run against the actual local dev or production server. Secrets stay in memory.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
requireBackend("dotenv").config({ path: new URL("../../backend/.env", import.meta.url), quiet: true });
if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
const origin = process.env.UI_TEST_ORIGIN || "http://localhost:3000";
const api = process.env.UI_TEST_API_URL || "http://localhost:4000";
for (const value of [origin, api]) {
  const url = new URL(value);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.username || url.password) throw new Error("Local test origins required.");
}
const { PrismaClient } = requireBackend("@prisma/client"), { hashPassword } = requireBackend("./dist/auth/password.js");
const db = new PrismaClient(), run = randomUUID(), password = randomUUID() + randomUUID();
let adminId, organizationId;
async function request(host, path, cookie = "", body) {
  return fetch(host + path, { method: body === undefined ? "GET" : "POST", headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json", "X-HRMS-Request": "1" }),
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
}
function cookie(response, name) {
  const header = response.headers.getSetCookie().find((value) => value.startsWith(name + "="));
  assert.ok(header, "Login must issue the expected session cookie"); assert.match(header, /HttpOnly/i); assert.match(header, /SameSite=Lax/i);
  return header.split(";")[0];
}
try {
  const hash = await hashPassword(password);
  const admin = await db.superAdmin.create({ data: { email: `proxy-admin-${run}@example.test`, fullName: `Proxy fixture ${run}`, passwordHash: hash } }); adminId = admin.id;
  const org = await db.organization.create({ data: { name: `Proxy fixture ${run}`, trialStartedAt: new Date(), trialExpiresAt: new Date(Date.now() + 7 * 86400000) } }); organizationId = org.id;
  const tenant = await db.user.create({ data: { organizationId, email: `proxy-tenant-${run}@example.test`, fullName: "Proxy tenant fixture", passwordHash: hash, role: "ORGANIZATION_ADMIN" } });
  const platformLogin = await request(origin, "/api/super-admin/auth/login", "", { email: admin.email, password }); assert.equal(platformLogin.status, 200);
  const platformCookie = cookie(platformLogin, "hrms_platform_session");
  const tenantLogin = await request(origin, "/api/auth/login", "", { email: tenant.email, password }); assert.equal(tenantLogin.status, 200);
  const tenantCookie = cookie(tenantLogin, "hrms_session"), both = `${tenantCookie}; ${platformCookie}`;
  const paths = ["auth/me", "metrics", "metrics?from=2026-01-01&to=2026-01-31", "revenue", "organizations", "account", `organizations/${organizationId}`, `organizations/${organizationId}/subscriptions`, `organizations/${organizationId}/payments`];
  for (const path of paths) {
    const url = "/api/super-admin/" + path;
    assert.equal((await request(api, url, platformCookie)).status, 200, "Backend accepts the valid platform session: " + path);
    assert.equal((await request(origin, url, both)).status, 200, "Proxy must forward the same platform session: " + path);
    assert.equal((await request(origin, url, tenantCookie)).status, 401, "Organization cookie cannot authorize platform API: " + path);
  }
  const page = await request(origin, "/super-admin", both); assert.equal(page.status, 200); assert.ok((await page.text()).includes(admin.fullName));
  assert.equal((await request(origin, "/api/auth/me", platformCookie)).status, 401);
  assert.equal((await request(origin, "/api/auth/me", both)).status, 200);
  assert.equal((await request(origin, "/api/super-admin/auth/me", tenantCookie.replace("hrms_session", "hrms_platform_session"))).status, 401);
  assert.equal((await request(origin, "/api/super-admin/account/password", both, { currentPassword: "incorrect fixture password", newPassword: "NewFixture8", confirmPassword: "NewFixture8" })).status, 400, "Authenticated mutations must reach password confirmation");
  // Verify a real expiry still produces 401, without invalidating any real account.
  await db.superAdminSession.updateMany({ where: { superAdminId: adminId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await request(origin, "/api/super-admin/metrics", both)).status, 401);
  assert.equal((await request(origin, "/api/auth/me", both)).status, 200);
  console.log(JSON.stringify({ passed: true, reportEndpoints: paths.length, backendAndProxyAgree: true, protectedPageRecognizesSameSession: true, namespaceIsolation: true, authenticatedMutations: true, realExpiryRejected: true, originalAccountsChanged: false }));
} finally {
  if (adminId) { await db.superAdminAuditEvent.deleteMany({ where: { actorSuperAdminId: adminId } }); await db.superAdmin.delete({ where: { id: adminId } }); }
  if (organizationId) await db.organization.delete({ where: { id: organizationId } });
  await db.$disconnect();
}

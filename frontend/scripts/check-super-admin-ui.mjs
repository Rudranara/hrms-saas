// Dedicated Chrome on 9223; real local sessions and isolated DB fixtures.
// Reporting only: no provider API, checkout, real administrator promotion or external email.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
requireBackend("dotenv").config({ path: new URL("../../backend/.env", import.meta.url), quiet: true });
if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
const { PrismaClient } = requireBackend("@prisma/client");
const { hashPassword } = requireBackend("./dist/auth/password.js");
const db = new PrismaClient(), run = randomUUID(), prefix = `Platform browser ${run}`;
const origin = process.env.UI_TEST_ORIGIN || "http://localhost:3000";
const password = `Platform test passphrase ${run}`, email = `platform-${run}@example.test`, tenantEmail = `tenant-${run}@example.test`;
const ids = [], exceptions = [], paused = [];
let socket, ownPlanId, platformId;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const hash = await hashPassword(password);
  const platformUser = await db.superAdmin.create({ data: { fullName: "Platform Browser Operator", email, passwordHash: hash, emailVerifiedAt: new Date() } });
  platformId = platformUser.id;
  for (let index = 0; index < 24; index++) {
    const org = await db.organization.create({ data: { name: `${prefix} workspace ${String(index).padStart(2, "0")}`, trialStartedAt: new Date(), trialExpiresAt: new Date(Date.now() + 7 * 86400000) } });
    ids.push(org.id);
    await db.user.create({ data: { organizationId: org.id, fullName: `Workspace Admin ${index}`, email: `workspace-${index}-${run}@example.test`, passwordHash: hash, role: "ORGANIZATION_ADMIN" } });
  }
  let plan = await db.billingPlan.findFirst({ where: { enabled: true } });
  if (!plan) {
    ownPlanId = `platform-browser-${run}`;
    plan = await db.billingPlan.create({ data: { id: ownPlanId, name: "Browser fixture", interval: "MONTHLY", currency: "INR", amountMinor: 10000, totalCount: 12 } });
  }
  const paidId = ids[0];
  const sub = await db.subscription.create({ data: { organizationId: paidId, planId: plan.id, providerPlanId: `fixture_${run}`, status: "ACTIVE", amountMinor: 250000, currency: "INR", interval: "MONTHLY", totalCount: 12, lastSyncedAt: new Date(), currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000), paidUntil: new Date(Date.now() + 30 * 86400000) } });
  await db.billingPayment.create({ data: { subscriptionId: sub.id, providerPaymentId: `fixture_${run}`, providerInvoiceId: `fixture_invoice_${run}`, status: "captured", amountMinor: 250000, currency: "INR", paidAt: new Date() } });
  const tabs = await fetch("http://localhost:9223/json/list").then((r) => r.json());
  socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) { const item = pending.get(message.id); pending.delete(message.id); if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result); }
    else if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
    else if (message.method === "Fetch.requestPaused") paused.push(message.params.requestId);
  });
  const evaluate = async (expression) => { const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error("Platform browser evaluation failed."); return result.result.value; };
  const until = async (expression, label) => { for (let index = 0; index < 300; index++) { if (await evaluate(`typeof document !== 'undefined' && !!document.body && (${expression})`)) return; await pause(100); } throw new Error(`Timed out: ${label}`); };
  const navigate = async (path) => { await command("Page.navigate", { url: origin + path }); await until("document.readyState==='complete'", "page load"); await pause(500); };
  const submit = async (values) => { await until("!!document.querySelector('form')", "form"); await pause(300); await evaluate(`(()=>{for(const [name,value] of Object.entries(${JSON.stringify(values)})){const input=document.querySelector('[name="'+name+'"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('form').requestSubmit();})()`); };
  const filter = async (q, status = "ALL") => { await evaluate(`(()=>{const form=document.querySelector('.platform-filters');form.elements.q.value=${JSON.stringify(q)};form.elements.status.value=${JSON.stringify(status)};form.requestSubmit();})()`); await until("!document.body.textContent.includes('Loading organizations')", "filtered organizations"); await pause(200); };
  await command("Page.enable"); await command("Runtime.enable"); await command("Network.enable");
  await command("Network.deleteCookies", { name: "hrms_session", url: origin });
  await command("Network.deleteCookies", { name: "hrms_platform_session", url: origin });
  await navigate("/super-admin"); await until("location.pathname==='/super-admin/login'", "anonymous platform guard");
  assert.equal(await evaluate("new URLSearchParams(location.search).get('next')"), "/super-admin");
  assert.equal(await evaluate("fetch('/api/super-admin/metrics').then(r=>r.status)"), 401);
  const detailPath = `/super-admin/organizations/${paidId}`;
  await navigate(detailPath); await until("location.pathname==='/super-admin/login'", "anonymous detail guard");
  assert.equal(await evaluate("new URLSearchParams(location.search).get('next')"), detailPath);
  await until("document.body.textContent.includes('HRMS Platform Administration')", "platform sign-in explanation");
  assert.equal(await evaluate("document.querySelector('h1').textContent"), "HRMS Platform Administration");
  assert.equal(await evaluate("document.body.textContent.includes('Secure access for platform administrators')"), true);
  assert.equal(await evaluate("!!document.querySelector('a[href=\"/register\"]')"), false, "No public platform signup");
  await evaluate("document.querySelector('form').requestSubmit()");
  await until("document.querySelector('#platform-email')?.getAttribute('aria-invalid')==='true' && document.querySelector('#platform-password')?.getAttribute('aria-invalid')==='true'", "accessible required fields");
  await evaluate("document.querySelector('.auth-password-toggle').click()");
  assert.equal(await evaluate("document.querySelector('#platform-password').type"), "text");
  await evaluate("document.querySelector('.auth-password-toggle').click()");
  assert.equal(await evaluate("document.querySelector('#platform-password').type"), "password");
  for (const width of [320, 390, 768, 1440]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
    await pause(100); assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, `Platform login overflow at ${width}`);
  }
  // Pause transport, observe loading/duplicate-submit prevention, then let the real API deny an ordinary account.
  await command("Fetch.enable", { patterns: [{ urlPattern: "*/api/super-admin/auth/login", requestStage: "Request" }] });
  await submit({ email: `workspace-0-${run}@example.test`, password });
  await until("document.querySelector('form').getAttribute('aria-busy')==='true' && document.querySelector('button[type=submit]').disabled", "platform login loading state");
  for (let index = 0; !paused.length && index < 50; index++) await pause(100);
  assert.equal(paused.length, 1);
  while (paused.length) await command("Fetch.continueRequest", { requestId: paused.shift() });
  await command("Fetch.disable");
  await until("!!document.querySelector('.auth-alert') && document.querySelector('.auth-alert').textContent.includes('Unable to sign in')", "ordinary credentials denied generically");
  assert.equal(await evaluate("fetch('/api/auth/me').then(r=>r.status)"), 401, "No ordinary session is issued by platform login");
  const deniedMessage = await evaluate("document.querySelector('.auth-alert').textContent");
  await submit({ email, password: "Incorrect platform password" });
  await until("!!document.querySelector('.auth-alert') && !document.querySelector('button[type=submit]').disabled", "wrong password rejected");
  assert.equal(await evaluate("document.querySelector('.auth-alert').textContent"), deniedMessage);
  for (const query of ["next=https%3A%2F%2Fevil.test%2Fsuper-admin", "next=%2Fbilling", "next=%2Fsuper-admin%2Fsettings&next=%2Fdashboard"]) {
    await navigate(`/super-admin/login?${query}`); await submit({ email, password });
    await until("location.pathname==='/super-admin' && document.querySelectorAll('.platform-metrics article').length===8", "unsafe and duplicate destinations fall back to overview");
    await evaluate("document.querySelector('.dashboard-logout button').click()");
    await until("location.pathname==='/super-admin/login' && document.body.textContent.includes('signed out securely')", "platform logout uses dedicated login");
    assert.equal(await evaluate("fetch('/api/auth/me').then(r=>r.status)"), 401);
  }
  await navigate("/register");
  await submit({ organizationName: `${prefix} ordinary tenant`, fullName: "Ordinary Browser Administrator", email: tenantEmail, password, confirmPassword: password });
  await until("location.pathname==='/dashboard' && !!document.querySelector('.workspace-details')", "ordinary registration");
  await navigate("/super-admin"); await until("location.pathname==='/super-admin/login'", "ordinary session cannot authenticate platform pages");
  assert.equal(await evaluate("fetch('/api/super-admin/metrics?role=SUPER_ADMIN').then(r=>r.status)"), 401);
  assert.equal(await evaluate(`fetch('/api/super-admin/organizations/${paidId}').then(r=>r.status)`), 401);
  await navigate(`/login?next=${encodeURIComponent(detailPath)}`); await submit({ email: tenantEmail, password });
  await until("location.pathname==='/dashboard' && !!document.querySelector('.workspace-details')", "tenant login ignores platform continuation");
  await navigate(`/super-admin/login?next=${encodeURIComponent(detailPath)}`); await submit({ email, password });
  await until(`location.pathname===${JSON.stringify(detailPath)} && !!document.querySelector('.platform-detail')`, "platform login preserves detail destination");
  await navigate("/super-admin/login");
  await until("location.pathname==='/super-admin' && document.querySelectorAll('.platform-metrics article').length===8 && !!document.querySelector('.platform-table tbody')", "platform login and metrics");
  await navigate(`/super-admin/login?next=${encodeURIComponent(detailPath)}`);
  await until("location.pathname==='/super-admin' && document.querySelectorAll('.platform-metrics article').length===8", "authenticated platform login opens overview");
  for (const unsafe of ["https://evil.test/super-admin", "/login", "/super-admin?role=SUPER_ADMIN"]) {
    await navigate(`/super-admin/login?next=${encodeURIComponent(unsafe)}`);
    await until("location.pathname==='/super-admin' && document.querySelectorAll('.platform-metrics article').length===8", "unsafe platform continuation rejected");
  }
  await db.superAdminSession.updateMany({ where: { superAdminId: platformUser.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await evaluate("document.querySelector('.platform-section-heading button').click()");
  await until("document.body.textContent.includes('Your platform session could not be verified') && !!document.querySelector('.auth-alert a')", "expired session gives re-login action");
  await evaluate("document.querySelector('.auth-alert a').click()");
  await until("location.pathname==='/super-admin/login' && !!document.querySelector('form')", "expired session opens login without a loop");
  await until("!!document.querySelector('.platform-login-notice') && document.querySelector('.platform-login-notice').textContent.includes('expired or been revoked')", "expired-session explanation rendered");
  assert.equal(await evaluate("new URLSearchParams(location.search).get('next')"), "/super-admin");
  await submit({ email, password });
  await until("location.pathname==='/super-admin' && document.querySelectorAll('.platform-metrics article').length===8", "expired session re-login succeeds");
  await db.superAdmin.update({ where: { id: platformUser.id }, data: { authVersion: { increment: 1 } } });
  await navigate(detailPath); await until("location.pathname==='/super-admin/login' && !!document.querySelector('form')", "revoked-version detail session asks for login");
  assert.equal(await evaluate("new URLSearchParams(location.search).get('next')"), detailPath);
  await submit({ email, password });
  await until(`location.pathname===${JSON.stringify(detailPath)} && !!document.querySelector('.platform-detail')`, "re-login after version change restores detail");
  await navigate("/dashboard");
  await until("location.pathname==='/dashboard' && !!document.querySelector('.workspace-details')", "platform login preserves the separate organization session");
  await navigate("/super-admin"); await until("document.querySelectorAll('.platform-metrics article').length===8", "return to platform");
  assert.equal(await evaluate("document.body.textContent.includes('Refund totals: unavailable')"), true);
  await filter(prefix);
  await until("document.querySelectorAll('.platform-table tbody tr').length===20", "first page size");
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.platform-table tbody tr td:first-child a')).every(a=>a.textContent.startsWith(${JSON.stringify(prefix)}))`), true);
  const firstIds = await evaluate("Array.from(document.querySelectorAll('.platform-table tbody tr td:first-child small:first-of-type')).map(e=>e.textContent)");
  await evaluate("document.querySelector('.platform-pager button:last-child').click()");
  await until("!!document.querySelector('.platform-table tbody') && document.querySelector('.platform-pager').textContent.includes('Page 2')", "second page");
  const secondIds = await evaluate("Array.from(document.querySelectorAll('.platform-table tbody tr td:first-child small:first-of-type')).map(e=>e.textContent)");
  assert.equal(firstIds.some((id) => secondIds.includes(id)), false);
  await filter(prefix, "PAID_ACTIVE");
  await until("document.querySelectorAll('.platform-table tbody tr').length===1", "paid filter");
  let responsiveChecks = 0;
  for (const width of [320, 390, 768, 1440]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
    await pause(150);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, `Platform overflow at ${width}`);
    responsiveChecks++;
  }
  if (process.env.UI_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true });
    const shot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    fs.writeFileSync(process.env.UI_SCREENSHOT_DIR + "/super-admin.png", Buffer.from(shot.data, "base64"));
  }
  await evaluate("document.querySelector('.platform-table tbody td a').click()");
  // Cache Components may retain the hidden overview DOM during client navigation.
  await until(`location.pathname.endsWith('/${paidId}') && !!document.querySelector('.platform-detail') && Array.from(document.querySelectorAll('.platform-table tbody')).filter(table=>table.getBoundingClientRect().height>0).length===2`, "organization detail and histories");
  assert.equal(await evaluate("document.body.textContent.includes('₹2,500.00')"), true);
  for (const width of [320, 390, 768, 1440]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
    await pause(100); assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, `Detail overflow at ${width}`); responsiveChecks++;
  }
  await navigate("/super-admin");
  await until("document.querySelectorAll('.platform-metrics article').length===8", "overview reload");
  await filter(`${prefix} impossible`);
  await until("document.body.textContent.includes('No organizations match')", "empty state");
  await evaluate("(()=>{const form=document.querySelector('.platform-date-form');form.elements.from.value='2099-01-01';form.elements.to.value='2099-01-01';form.requestSubmit()})()");
  await until("document.body.textContent.includes('2099-01-01 through 2099-01-01')", "revenue date filter");
  assert.equal(await evaluate("document.querySelector('.platform-revenue-total').textContent"), "₹0.00");
  await command("Fetch.enable", { patterns: [{ urlPattern: "*/api/super-admin/metrics*", requestStage: "Request" }] });
  await evaluate("document.querySelector('.platform-section-heading button').click()");
  await until("document.body.textContent.includes('Loading platform metrics')", "loading state");
  for (let index = 0; !paused.length && index < 50; index++) await pause(100);
  assert.ok(paused.length);
  while (paused.length) await command("Fetch.fulfillRequest", { requestId: paused.shift(), responseCode: 503, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from('{"message":"Fixture reporting outage"}').toString("base64") });
  await until("document.body.textContent.includes('Fixture reporting outage')", "honest API error state");
  await command("Fetch.disable");
  await db.superAdmin.update({ where: { id: platformUser.id }, data: { isActive: false } });
  assert.equal(await evaluate("fetch('/api/super-admin/metrics').then(r=>r.status)"), 401, "Current platform active status must be checked on every request");
  await evaluate("document.querySelector('.platform-section-heading button').click()");
  await until("document.body.textContent.includes('Your platform session could not be verified') && !!document.querySelector('.auth-alert a')", "account deactivation offers safe account sign-in");
  await evaluate("document.querySelector('.auth-alert a').click()");
  await until("location.pathname==='/super-admin/login' && !!document.querySelector('form')", "inactive platform account does not bounce between login and platform");
  await submit({ email, password });
  await until("document.body.textContent.includes('Unable to sign in. Check your credentials')", "inactive account is denied platform login");
  await navigate("/login"); await submit({ email: tenantEmail, password });
  await until("location.pathname==='/dashboard'", "organization login is independent of inactive platform account");
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ authorization: "anonymous and organization administrators rejected", platformLogin: "dedicated login and existing-session landing passed", safeContinuations: "overview and detail preserved; unsafe and tenant continuations rejected", sessionRecovery: "expired, revoked-version and inactive-account re-login passed without loops", searchAndPagination: "passed", detailAndHistories: "passed", revenueDateFilter: "passed", emptyLoadingAndErrorStates: "passed", responsiveChecks, loginResponsiveChecks: 4, liveAccountDeactivation: "passed", realRazorpayTransaction: false }, null, 2));
} finally {
  const tenant = await db.user.findUnique({ where: { email: tenantEmail }, include: { organization: true } });
  if (tenant?.organization.name === `${prefix} ordinary tenant`) ids.push(tenant.organizationId);
  if (ids.length) await db.organization.deleteMany({ where: { id: { in: ids }, name: { startsWith: prefix } } });
  if (ownPlanId) await db.billingPlan.deleteMany({ where: { id: ownPlanId } });
  if (platformId) { await db.superAdminAuditEvent.deleteMany({ where: { actorSuperAdminId: platformId } }); await db.superAdmin.deleteMany({ where: { id: platformId } }); }
  await db.$disconnect(); socket?.close();
}

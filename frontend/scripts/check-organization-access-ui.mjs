// Real local API/browser checks with isolated fixtures. No payment-provider writes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
requireBackend("dotenv").config({ path: new URL("../../backend/.env", import.meta.url), quiet: true });
if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
const origin = process.env.UI_TEST_ORIGIN || "http://localhost:3000";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw new Error("Local browser checks only.");
const { PrismaClient } = requireBackend("@prisma/client"), { hashPassword } = requireBackend("./dist/auth/password.js"), { newSession } = requireBackend("./dist/auth/security.js");
const db = new PrismaClient(), run = randomUUID(), password = `Access browser ${randomUUID()}`, email = `access-browser-${run}@example.test`;
let actorId, orgId, socket, paidPlanId, assignedPlanId;
const now = Date.now(), dayMs = 86400000;
const day = (offset) => new Date(now + offset * dayMs + 330 * 60000).toISOString().slice(0, 10);
try {
  assignedPlanId = 'access-ui-' + run;
  await db.billingPlan.create({ data: { id: assignedPlanId, name: 'Assigned UI plan', interval: 'YEARLY', amountMinor: 10000, currency: 'INR', totalCount: 12 } });
  await db.billingPlan.create({ data: { id: assignedPlanId + '-monthly', name: 'Assigned UI plan', interval: 'MONTHLY', amountMinor: 1000, currency: 'INR', totalCount: 12 } });
  const passwordHash = await hashPassword(password);
  actorId = (await db.superAdmin.create({ data: { fullName: "Access Browser Operator", email, passwordHash } })).id;
  const org = await db.organization.create({ data: { name: `Access browser ${run}`, trialStartedAt: new Date(now - 10 * dayMs), trialExpiresAt: new Date(now - 3 * dayMs), users: { create: { fullName: "Access tenant fixture", email: `tenant-${email}`, passwordHash, role: "ORGANIZATION_ADMIN" } } }, include: { users: true } }); orgId = org.id;
  const tenantSession = newSession();
  await db.session.create({ data: { userId: org.users[0].id, tokenHash: tenantSession.tokenHash, expiresAt: tenantSession.expiresAt } });
  const tenantCookie = `hrms_session=${tenantSession.token}`;
  const login = await fetch(origin + "/api/super-admin/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify({ email, password }) }); assert.equal(login.status, 200);
  const platformCookie = login.headers.getSetCookie().find((value) => value.startsWith("hrms_platform_session=")).split(";")[0];
  const tabs = await fetch(`http://localhost:${process.env.UI_TEST_DEBUG_PORT || "9223"}/json/list`).then((response) => response.json());
  socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let sequence = 0; const pending = new Map(), exceptions = [];
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (message.id) { const item = pending.get(message.id); pending.delete(message.id); if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result); } else if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text); });
  const evaluate = async (expression) => { const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error("Access browser evaluation failed"); return result.result.value; };
  const until = async (expression, label) => { for (let attempt = 0; attempt < 400; attempt++) { if (await evaluate(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${label}`); };
  const settingsPath = `/super-admin/organizations/${orgId}`, apiPath = `/api/super-admin/organizations/${orgId}/access`;
  const navigateToSettings = async () => { await command("Page.navigate", { url: origin + settingsPath }); await until("!!document.querySelector('.organization-access-form')", "access controls loaded"); };
  const effective = async () => {
    const response = await fetch(origin + "/api/billing/status", { headers: { Cookie: tenantCookie } }); assert.equal(response.status, 200); return (await response.json()).access;
  };
  const prepare = async (trial, subscription, values = {}) => {
    await until("(()=>{const form=document.querySelector('.organization-access-form');return !!form && Object.keys(form).some(key=>key.startsWith('__reactProps$') && typeof form[key]?.onSubmit==='function');})()", "interactive access form");
    await evaluate(`(()=>{for(const [id,on] of [['trial-toggle',${trial}],['subscription-toggle',${subscription}]]){const toggle=document.getElementById(id);if(toggle.getAttribute('aria-checked')!==String(on))toggle.click();}})()`);
    await until(`document.getElementById('trial-dates').hidden===${!trial} && document.getElementById('subscription-dates').hidden===${!subscription}`, "conditional date fields");
    if (subscription) {
      await evaluate("(()=>{const select=document.querySelector('#access-plan');select.value='Assigned UI plan';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
      await until("!document.querySelector('#access-interval').disabled && !!document.querySelector('#access-interval option[value=YEARLY]')", "billing periods for selected plan");
      await evaluate("(()=>{const select=document.querySelector('#access-interval');select.value='YEARLY';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
    }
    for (const [name, value] of Object.entries(values)) {
      await evaluate(`(()=>{const input=document.querySelector('.organization-access-form').elements[${JSON.stringify(name)}];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    }
  };
  const confirm = async (previousVersion) => {
    assert.equal((await db.organization.findUniqueOrThrow({ where: { id: orgId } })).accessVersion, previousVersion, "Editing toggles must not change access before Save");
    await evaluate("document.querySelector('.organization-access-form').requestSubmit()");
    await until(`document.querySelector('.organization-access-panel')?.dataset.accessVersion===${JSON.stringify(String(previousVersion + 1))}`, "save and refresh access revision");
  };
  await command("Page.enable"); await command("Runtime.enable"); await command("Network.enable");
  await command("Network.setCookie", { name: "hrms_platform_session", value: platformCookie.slice("hrms_platform_session=".length), url: origin, httpOnly: true, sameSite: "Lax" });
  await command("Network.setCookie", { name: "hrms_session", value: tenantSession.token, url: origin, httpOnly: true, sameSite: "Lax" });
  await navigateToSettings();
  assert.equal((await effective()).allowed, false);
  await prepare(true, false, { trialExpiresAt: day(4) }); await confirm(0);
  assert.equal((await effective()).source, "TRIAL");
  assert.equal((await effective()).checkoutAllowed, true, "An admin trial extension must allow paid checkout");
  const catalog = await fetch(origin + "/api/billing/plans").then((response) => response.json());
  const purchasable = catalog.plans.find((plan) => plan.configured);
  if (purchasable) {
    await command("Page.navigate", { url: origin + `/billing?plan=${encodeURIComponent(purchasable.id)}&period=${purchasable.interval.toLowerCase()}&review=1` });
    await until("!!document.querySelector('[aria-label=\"Selected paid plan\"] button')", "extended trial paid plan review");
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Selected paid plan\"] button').disabled"), false, "Extended trial must not disable the purchase button");
    assert.equal(await db.subscription.count({ where: { organizationId: orgId } }), 0, "Plan review must not initiate payment");
    await navigateToSettings();
  }
  assert.equal((await db.organization.findUniqueOrThrow({ where: { id: orgId } })).trialStartedAt.getTime(), org.trialStartedAt.getTime());
  await prepare(false, true, { startsAt: day(0), expiresAt: day(30) });
  for (const [start, interval, expectedEnd] of [
    ['2026-10-27', 'MONTHLY', '2026-11-26'],
    ['2026-10-27', 'YEARLY', '2027-10-26'],
    ['2027-01-31', 'MONTHLY', '2027-02-28'],
    ['2028-01-31', 'MONTHLY', '2028-02-29'],
    ['2028-02-29', 'YEARLY', '2029-02-28'],
    ['2027-01-01', 'MONTHLY', '2027-01-31'],
  ]) {
    await evaluate(`(()=>{const input=document.querySelector('#access-start');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(start)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await evaluate(`(()=>{const select=document.querySelector('#access-interval');select.value=${JSON.stringify(interval)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(`document.querySelector('#access-end').value===${JSON.stringify(expectedEnd)}`, `automatic ${interval} end for ${start}`);
  }
  await prepare(false, true, { startsAt: day(0), expiresAt: day(30) });
  for (const width of [320, 390, 768, 1440]) { await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 }); assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `Access review overflow at ${width}`); }
  await confirm(1);
  assert.equal((await effective()).source, "MANUAL");
  assert.equal((await effective()).manualAccess.plan.id, assignedPlanId);
  await navigateToSettings();
  assert.equal(await evaluate("document.querySelector('#access-plan').value"), "Assigned UI plan");
  assert.equal(await evaluate("document.querySelector('#access-interval').value"), "YEARLY");
  assert.equal((await effective()).manualAccess.expiresAt, new Date(new Date(`${day(30)}T00:00:00+05:30`).getTime() + dayMs).toISOString(), "Inclusive IST end dates expire at the following midnight");
  await command("Page.navigate", { url: origin + "/billing" });
  await until("document.querySelector('.billing-summary h2')?.textContent==='Assigned UI plan'", "assigned plan in billing");
  assert.equal(await evaluate("document.querySelector('.billing-summary-metrics').textContent.includes('Admin-managed')"), true);
  await command("Page.navigate", { url: origin + "/dashboard" });
  await until("document.querySelector('#dashboard-plan-heading')?.textContent==='Assigned UI plan'", "assigned plan in dashboard");
  await navigateToSettings();
  await prepare(false, true, { startsAt: day(-7), expiresAt: day(-1) }); await confirm(2);
  assert.equal((await effective()).allowed, false);
  await command("Page.navigate", { url: origin + "/dashboard" });
  await until("location.pathname==='/subscription-required'", "expired manual access blocks the dashboard");
  await navigateToSettings();
  await prepare(true, true, { trialExpiresAt: day(4), startsAt: day(0), expiresAt: day(30) }); await confirm(3);
  assert.equal((await effective()).source, "MANUAL");
  if (process.env.UI_TEST_SCREENSHOT) {
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    const clip = await evaluate("(()=>{const rect=document.querySelector('.organization-access-panel').getBoundingClientRect();return {x:rect.left+scrollX,y:rect.top+scrollY,width:rect.width,height:rect.height,scale:1};})()");
    const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
    await writeFile(process.env.UI_TEST_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  }
  await prepare(false, false); await confirm(4); assert.equal((await effective()).state, "SUSPENDED");
  await prepare(true, false, { trialExpiresAt: day(4) }); await confirm(5); assert.equal((await effective()).source, "TRIAL");
  await prepare(true, false, { trialExpiresAt: day(-1) }); await confirm(6); assert.equal((await effective()).allowed, false);
  await prepare(false, false);
  const concurrent = await fetch(origin + apiPath, { method: "POST", headers: { Cookie: platformCookie, Origin: origin, "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify({ action: "EXTEND_TRIAL", days: 2, expectedVersion: 7, requestId: randomUUID(), reason: "Concurrent support update fixture" }) }); assert.equal(concurrent.status, 200);
  await evaluate("document.querySelector('.organization-access-form').requestSubmit()");
  await until("document.querySelector('.organization-access-panel [role=alert]')?.textContent.includes('Another administrator')", "stale review rejected");
  assert.equal((await db.organization.findUniqueOrThrow({ where: { id: orgId } })).accessMode, "CONTROLLED");
  await until("!!document.querySelector('.organization-access-history details')", "audit history visible");
  await evaluate("document.querySelector('.organization-access-history').open=true;document.querySelector('.organization-access-history details').open=true");
  for (const width of [320, 390, 768, 1440]) { await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 }); assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `Audit history overflow at ${width}`); }
  assert.equal(await db.organizationAccessAudit.count({ where: { organizationId: orgId, outcome: "SUCCESS" } }), 8);
  assert.equal(await db.organizationAccessAudit.count({ where: { organizationId: orgId, outcome: "FAILED" } }), 1);
  assert.equal(await db.billingPayment.count({ where: { subscription: { organizationId: orgId } } }), 0);
  // Reproduce the reported save/reload with an older paid subscription present.
  // All financial rows here are scoped fixtures, never provider transactions.
  paidPlanId = `access-browser-${run}`;
  await db.billingPlan.create({ data: { id: paidPlanId, name: "Access switch fixture", enabled: false, interval: "MONTHLY", amountMinor: 10000, currency: "INR", totalCount: 12 } });
  const paidUntil = new Date(Date.now() + 60 * dayMs);
  const paidRecord = await db.subscription.create({ data: { organizationId: orgId, planId: paidPlanId, providerPlanId: "plan_access_switch_fixture", status: "ACTIVE", amountMinor: 10000, currency: "INR", interval: "MONTHLY", totalCount: 12, paidUntil, lastSyncedAt: new Date(), commercialTerms: { accessPolicyVersion: 0 }, payments: { create: { providerPaymentId: `pay_access_switch_${run}`, providerInvoiceId: `inv_access_switch_${run}`, status: "captured", amountMinor: 10000, currency: "INR", paidAt: new Date() } } } });
  await navigateToSettings();
  await prepare(false, true, { startsAt: day(0), expiresAt: day(30) }); await confirm(8);
  await prepare(true, false, { trialExpiresAt: day(4) }); await confirm(9);
  await until("document.querySelector('#trial-toggle')?.getAttribute('aria-checked')==='true' && document.querySelector('#subscription-toggle')?.getAttribute('aria-checked')==='false'", "saved trial-only toggles with an existing paid subscription");
  assert.equal((await effective()).source, "TRIAL");
  await navigateToSettings();
  assert.equal(await evaluate("document.querySelector('#trial-toggle').getAttribute('aria-checked')"), "true");
  assert.equal(await evaluate("document.querySelector('#subscription-toggle').getAttribute('aria-checked')"), "false");
  assert.equal((await effective()).source, "TRIAL");
  const retained = await db.subscription.findUniqueOrThrow({ where: { id: paidRecord.id } });
  assert.equal(retained.status, "ACTIVE"); assert.equal(retained.paidUntil.getTime(), paidUntil.getTime());
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ passed: true, checks: ["protected real API/proxy", "toggles do not mutate until Save", "conditional date fields", "trial extension preserves start", "subscription dates", "required plan selection and save/reload", "assigned plan in billing and dashboard", "both switches enabled", "inclusive IST end boundary", "expiry blocks dashboard", "both off blocks access", "trial shortening", "concurrent edit rejected", "before/after audit history", "trial-only save and reload with existing paid subscription", "provider history preserved", "no provider transactions", "four responsive widths", "no browser exceptions"] }));
} finally {
  if (socket) socket.close();
  if (orgId) { await db.organizationAccessAudit.deleteMany({ where: { organizationId: orgId } }); await db.organization.deleteMany({ where: { id: orgId } }); }
  if (assignedPlanId) await db.billingPlan.deleteMany({ where: { id: { in: [assignedPlanId, assignedPlanId + '-monthly'] } } });
  if (paidPlanId) await db.billingPlan.deleteMany({ where: { id: paidPlanId } });
  if (actorId) { await db.superAdminAuditEvent.deleteMany({ where: { actorSuperAdminId: actorId } }); await db.superAdmin.deleteMany({ where: { id: actorId } }); }
  await db.$disconnect();
}

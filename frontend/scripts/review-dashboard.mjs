// Dashboard visual review with an isolated development account. No provider calls.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire(new URL("../../backend/package.json", import.meta.url));
require("dotenv").config({ path: new URL("../../backend/.env", import.meta.url), quiet: true });
if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
const stage = process.argv[2] || "before";
const name = `Northstar People ${randomUUID().slice(0, 8)}`;
const email = `dashboard-${randomUUID()}@example.test`;
let socket;
try {
  const password = `Review passphrase ${randomUUID()}`;
  const response = await fetch("http://localhost:3000/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json", "X-HRMS-Request": "1", Origin: "http://localhost:3000" }, body: JSON.stringify({ organizationName: name, fullName: "Alex Morgan", email, password, confirmPassword: password }) });
  assert.equal(response.ok, true, `Fixture registration: ${response.status}`);
  const token = response.headers.get("set-cookie")?.match(/hrms_session=([^;]+)/)?.[1];
  assert.ok(token);
  const tabs = await fetch("http://localhost:9223/json/list").then(r => r.json());
  socket = new WebSocket(tabs.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } });
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
  const wait = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(`Timeout: ${expression}`); };
  await command("Page.enable");
  await command("Network.enable");
  await command("Network.setCookie", { name: "hrms_session", value: token, url: "http://localhost:3000", httpOnly: true });
  const folder = new URL("../../artifacts/dashboard/", import.meta.url);
  await fs.mkdir(folder, { recursive: true });
  async function navigate(path) { await command("Page.navigate", { url: "http://localhost:3000" + path }); await wait("!!document.querySelector('.workspace-details')"); await new Promise(r => setTimeout(r, 400)); }
  async function capture(label) { const shot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); await fs.writeFile(new URL(`${stage}-${label}.png`, folder), Buffer.from(shot.data, "base64")); }
  await navigate("/dashboard");
  const checks = [];
  for (const width of [1440, 768, 390, 320]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `Overflow at ${width}`);
    checks.push({ width, noOverflow: true });
    if (width === 1440 || width === 390) await capture(String(width));
  }
  if (stage === "after") {
    assert.equal(await evaluate("document.querySelectorAll('.dashboard-module').length"), 4);
    assert.equal(await evaluate("document.querySelectorAll('.dashboard-module a, .dashboard-module button').length"), 0);
    assert.equal(await evaluate("document.querySelector('.dashboard-nav [aria-current=page]').getAttribute('href')"), "/dashboard");
    assert.equal(await evaluate("document.querySelector('.dashboard-nav a[href=\"/billing\"]') !== null"), true);
    // Check the actual links by following them, then returning to the dashboard.
    await evaluate("document.querySelector('.dashboard-nav a[href=\"/billing\"]').click()");
    await wait("location.pathname === '/billing' && document.querySelectorAll('.billing-plan').length === 3");
    await navigate("/dashboard");
    await evaluate("document.querySelector('.dashboard-security a').click()");
    await wait("location.pathname === '/verification-pending'");
    await navigate("/dashboard");
    await evaluate("document.querySelector('.dashboard-logout > button').focus(); document.querySelector('.dashboard-logout > button').click()");
    await wait("!!document.querySelector('dialog[open]')");
    await evaluate("document.querySelector('.logout-confirmation-cancel').click()");
    assert.equal(await evaluate("!!document.querySelector('dialog[open]')"), false);
    await evaluate("sessionStorage.setItem('hrms.billing.continuation', '/billing?plan=growth-yearly&period=yearly')");
    await navigate("/dashboard");
    await wait("Array.from(document.querySelectorAll('a')).some(a=>a.textContent.includes('Continue with your selected paid plan'))");
    await db.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
    await navigate("/dashboard");
    assert.equal(await evaluate("document.querySelector('.dashboard-security').textContent.includes('Email verified')"), true);
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await capture("verified");
    // Actual long account values check wrapping without fake product metrics.
    await db.organization.updateMany({ where: { name }, data: { name: name + ' international operations and shared services'.repeat(2) } });
    await db.user.update({ where: { email }, data: { fullName: 'Alex Morgan International Operations Administrator' } });
    await navigate("/dashboard");
    await command("Emulation.setDeviceMetricsOverride", { width: 320, height: 1000, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    checks.push({ billingNavigation: true, emailSettingsNavigation: true, logoutCancel: true, selectedPlanContinuation: true, verifiedEmail: true, longValuesAt320: true, unavailableModulesHaveNoDeadActions: true });
  }
  console.log(JSON.stringify({ stage, checks, screenshots: "artifacts/dashboard" }, null, 2));
} finally {
  socket?.close();
  const fixtures = await db.organization.findMany({ where: { users: { some: { email } } }, select: { id: true } });
  for (const fixture of fixtures) await db.organization.delete({ where: { id: fixture.id } });
  await db.$disconnect();
}

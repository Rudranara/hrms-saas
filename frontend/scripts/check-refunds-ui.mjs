// Real local authentication, proxies, request storage and screens. Financial
// provider operations are intercepted and executed against this in-memory mock.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
const backend = createRequire(new URL("../../backend/package.json", import.meta.url));
backend("dotenv").config({ path: new URL("../../backend/.env", import.meta.url), quiet: true });
const url = new URL(process.env.DATABASE_URL), origin = process.env.UI_TEST_ORIGIN || "http://localhost:3000";
if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw Error("Local fixture verification only");
if (!/^\/hrms_billing_audit_[a-f0-9]{12}$/.test(url.pathname)) throw Error("Refund browser checks require the isolated billing fixture database");
const { PrismaClient } = backend("@prisma/client"), { newSession } = backend("./dist/auth/security.js"), { RefundService } = backend("./dist/billing/refunds.js"), { BillingService } = backend("./dist/billing/service.js");
const db = new PrismaClient(), run = randomUUID(), planId = `refund-ui-${run}`, name = `Refund UI ${run}`;
let orgId, actorId, paymentId, socket, count = 0;
try {
  assert.equal((await fetch(origin + "/api/billing/plans").then(r => r.json())).mode, "test");
  const userSession = newSession(), platformSession = newSession(), now = new Date(), start = Math.floor(now.getTime() / 1000) - 60, end = start + 30 * 86400;
  await db.billingPlan.create({ data: { id: planId, name: "Refund browser plan", interval: "MONTHLY", amountMinor: 10000, currency: "INR", enabled: false } });
  const org = await db.organization.create({ data: { name, users: { create: { fullName: "Refund Browser Admin", email: `refund-ui-${run}@example.test`, role: "ORGANIZATION_ADMIN", passwordHash: "unused-fixture", emailVerifiedAt: now, sessions: { create: { tokenHash: userSession.tokenHash, expiresAt: userSession.expiresAt } } } } } }); orgId = org.id;
  actorId = (await db.superAdmin.create({ data: { fullName: "Refund Browser Reviewer", email: `reviewer-${run}@example.test`, passwordHash: "unused-fixture", sessions: { create: { tokenHash: platformSession.tokenHash, expiresAt: platformSession.expiresAt } } } })).id;
  const subscription = await db.subscription.create({ data: { organizationId: orgId, planId, providerPlanId: "plan_refund_ui", providerSubscriptionId: `sub_${run.replaceAll("-", "")}`, status: "ACTIVE", amountMinor: 10000, currency: "INR", interval: "MONTHLY", totalCount: 12, currentPeriodStart: new Date(start * 1000), currentPeriodEnd: new Date(end * 1000), paidUntil: new Date(end * 1000), lastSyncedAt: now } });
  const payment = await db.billingPayment.create({ data: { subscriptionId: subscription.id, providerPaymentId: `pay_${run.replaceAll("-", "")}`, providerInvoiceId: `inv_${run.replaceAll("-", "")}`, amountMinor: 10000, currency: "INR", status: "captured", paidAt: now, captureVerifiedAt: now } }); paymentId = payment.id;
  const refunds = new Map();
  const remotePayment = { id: payment.providerPaymentId, invoice_id: payment.providerInvoiceId, amount: 10000, currency: "INR", status: "captured", amount_refunded: 0, created_at: start };
  let pending = true;
  const provider = {
    available: true, keyId: "rzp_test_fixture", mode: "test",
    fetchPlan: async id => ({ id, interval: 1, period: "monthly", item: { amount: 10000, currency: "INR" } }),
    fetchSubscription: async () => ({ id: subscription.providerSubscriptionId, plan_id: subscription.providerPlanId, status: "active", current_start: start, current_end: end, paid_count: 1, notes: { organizationId: orgId, localSubscriptionId: subscription.id } }),
    invoices: async () => [{ id: payment.providerInvoiceId, subscription_id: subscription.providerSubscriptionId, payment_id: payment.providerPaymentId, status: "paid", amount_paid: 10000, currency: "INR", created_at: start, billing_start: start, billing_end: end }],
    invoice: async () => (await provider.invoices())[0], payment: async () => structuredClone(remotePayment),
    paymentRefunds: async () => [...refunds.values()].map(row => structuredClone(row)), fetchRefund: async id => structuredClone(refunds.get(id)),
    createRefund: async (paymentId, amount, receipt) => { count++; const row = { id: `rfnd_fixture_${count}_${run.replaceAll("-", "")}`, payment_id: paymentId, amount, currency: "INR", receipt, status: pending ? "pending" : "processed", created_at: Math.floor(Date.now() / 1000) }; refunds.set(row.id, row); if (!pending) { remotePayment.amount_refunded += amount; if (remotePayment.amount_refunded === 10000) remotePayment.status = "refunded"; } return structuredClone(row); },
    cancel: async () => { throw Error("Refund checks must not cancel subscriptions"); }, createSubscription: async () => { throw Error("Refund checks must not create subscriptions"); },
  };
  const service = new RefundService(db, new BillingService(db, provider, () => new Date()), () => new Date());
  const tabs = await fetch(`http://localhost:${process.env.UI_TEST_DEBUG_PORT || "9227"}/json/list`).then(r => r.json()); socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl); await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  let sequence = 0; const requests = new Map(), exceptions = [];
  let requestFault, decisionFault;
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; requests.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const fulfill = (requestId, status, body) => command("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)).toString("base64") });
  socket.addEventListener("message", async event => {
    const message = JSON.parse(event.data);
    if (message.id) { const item = requests.get(message.id); requests.delete(message.id); if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result); return; }
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
    if (message.method !== "Fetch.requestPaused") return;
    const { requestId, request } = message.params;
    try {
      if (new URL(request.url).pathname === "/api/billing/refunds" && request.method === "POST" && requestFault) {
        const fault = requestFault; requestFault = undefined;
        if (fault === "timeout") await command("Fetch.failRequest", { requestId, errorReason: "TimedOut" });
        else await fulfill(requestId, 400, { code: "VALIDATION_ERROR", message: "Fixture validation rejection" });
        return;
      }
      const match = new URL(request.url).pathname.match(/\/refunds\/([^/]+)\/(decision|refresh|process|prepared)$/);
      if (!match) { await command("Fetch.continueRequest", { requestId }); return; }
      if (match[2] === "decision" && decisionFault) {
        const fault = decisionFault; decisionFault = undefined;
        if (fault === "timeout") await command("Fetch.failRequest", { requestId, errorReason: "TimedOut" });
        else await fulfill(requestId, 409, { code: "INVALID_REFUND_AMOUNT", message: "Fixture balance conflict" });
        return;
      }
      const row = await db.refundRequest.findFirst({ where: { id: match[1], organizationId: orgId } }); if (!row) throw Error("Cannot mutate another organization's request");
      const body = JSON.parse(request.postData);
      if (match[2] === "decision") await service.decide(row.id, actorId, platformSession.token, body);
      else if (match[2] === "prepared") await service.changePrepared(row.id, actorId, platformSession.token, body);
      else if (match[2] === "process") await service.processApproved(row.id, actorId, platformSession.token, body.amountMinor);
      else await service.refresh(row.id, orgId);
      await fulfill(requestId, 200, { success: true });
    } catch (error) { exceptions.push(error.message); await fulfill(requestId, 500, { message: "Fixture operation failed" }); }
  });
  const evaluate = async expression => { const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error("Browser evaluation failed"); return result.result.value; };
  const until = async (expression, label) => { for (let i = 0; i < 400; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error(`Timed out: ${label}`); };
  const set = async (selector, value) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(el.tagName==='SELECT'){el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));}else{Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  const click = label => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)}).click()`);
  const navigate = async (path, selector) => { await command("Page.navigate", { url: origin + path }); await until(`!!document.querySelector(${JSON.stringify(selector)})`, path); };
  await command("Page.enable"); await command("Runtime.enable"); await command("Network.enable");
  await command("Page.addScriptToEvaluateOnNewDocument", { source: "window.confirm=()=>window.__confirm!==false" });
  await command("Fetch.enable", { patterns: [{ urlPattern: "*/api/*/refunds*", requestStage: "Request" }] });
  await command("Network.setCookie", { name: "hrms_session", value: userSession.token, url: origin, httpOnly: true, sameSite: "Lax" });
  await command("Network.setCookie", { name: "hrms_platform_session", value: platformSession.token, url: origin, httpOnly: true, sameSite: "Lax" });
  const submit = async reason => { await navigate("/billing", "#refund-payment"); await until(`!!document.querySelector('#refund-payment option[value="${paymentId}"]')`, "eligible captured payment"); await set("#refund-payment", paymentId); await set("#refund-reason", reason); await click("Request refund"); await until("document.querySelector('.refund-panel .account-success')?.textContent.includes('Refund request submitted')", "refund request submitted"); };
  const manage = async () => { await navigate("/super-admin/refunds", "#refund-search"); await set("#refund-search", name); await click("Search"); await until("document.querySelector('.refund-card h3')?.textContent===" + JSON.stringify(name), "search scope"); };
  await navigate("/billing", "#refund-payment"); await until(`!!document.querySelector('#refund-payment option[value="${paymentId}"]')`, "eligible captured payment");
  await set("#refund-payment", paymentId); await set("#refund-reason", "Please review a partial refund for this payment");
  requestFault = "validation"; await click("Request refund"); await until("document.querySelector('.refund-panel .auth-alert')?.textContent.includes('Fixture validation')", "definitive request rejection");
  assert.equal(await evaluate("document.querySelector('#refund-reason').readOnly"), false);
  requestFault = "timeout"; await click("Request refund"); await until("document.querySelector('#refund-reason').readOnly", "uncertain request remains locked");
  await until("!document.querySelector('.refund-request-form fieldset').disabled", "request timeout settled"); await click("Retry same request");
  await until("document.querySelector('.refund-panel .account-success')?.textContent.includes('Refund request submitted')", "safe request retry"); assert.equal(count, 0);
  await manage(); const id = (await db.refundRequest.findFirstOrThrow({ where: { organizationId: orgId } })).id;
  await set(`#amount-${id}`, "0"); await click("Review and issue refund"); await until("document.querySelector('.refund-decision [role=alert]')?.textContent.includes('positive amount')", "positive partial amount validation"); assert.equal(count, 0);
  await set(`#amount-${id}`, "100.01"); await click("Review and issue refund"); assert.equal(count, 0);
  await set(`#amount-${id}`, "40.00"); await evaluate("window.__confirm=false"); await click("Review and issue refund"); assert.equal(count, 0);
  await evaluate("window.__confirm=true"); decisionFault = "conflict"; await click("Review and issue refund");
  await until("document.querySelector('.refund-panel > .auth-alert')?.textContent.includes('Fixture balance')", "definitive balance conflict");
  await until(`!document.querySelector('#amount-${id}').readOnly`, "decision editable after conflict");
  decisionFault = "timeout"; await click("Review and issue refund"); await until(`document.querySelector('#amount-${id}').readOnly`, "uncertain decision remains locked");
  await until("!document.querySelector('.refund-decision fieldset').disabled", "decision timeout settled");
  assert.equal(count, 0); await click("Retry same decision"); await until("document.querySelector('.refund-card .platform-badge')?.textContent==='Processing'", "approval is processing, not success"); assert.equal(count, 1);
  const remote = [...refunds.values()][0]; remote.status = "processed"; remotePayment.amount_refunded = 4000;
  await navigate("/billing", "#refunds-heading"); await until("document.querySelector('.refund-card .platform-badge')?.textContent==='Processing'", "organization processing notice"); await click("Check refund status"); await until("document.querySelector('.refund-card .platform-badge')?.textContent==='Partially refunded'", "verified partial completion");
  await submit("Please review the remaining refundable payment balance"); await manage();
  const second = await db.refundRequest.findFirstOrThrow({ where: { organizationId: orgId, status: "PENDING" } });
  await set(`#decision-${second.id}`, "REJECT"); await until(`!!document.querySelector('#reason-${second.id}')`, "rejection form"); assert.equal(await evaluate(`document.querySelector('#reason-${second.id}').checkValidity()`), false);
  await set(`#reason-${second.id}`, "The remaining service was delivered as agreed"); await click("Reject request"); await until("document.querySelector('.refund-card .platform-badge')?.textContent==='Rejected'", "saved rejection");
  await navigate("/billing", "#refunds-heading"); await until("document.querySelector('.refund-list')?.textContent.includes('The remaining service was delivered')", "organization rejection notification");
  await submit("Review a saved approval before provider submission");
  const prepared = await db.refundRequest.findFirstOrThrow({ where: { organizationId: orgId, status: "PENDING" } });
  provider.available = false;
  await assert.rejects(service.decide(prepared.id, actorId, platformSession.token, { action: "APPROVE", amountMinor: 6000, expectedVersion: prepared.version, requestId: randomUUID() }));
  provider.available = true; await manage();
  await until(`!!document.querySelector('#recovery-amount-${prepared.id}')`, "prepared recovery controls");
  await set(`#recovery-amount-${prepared.id}`, "50.00"); await set(`#recovery-reason-${prepared.id}`, "Revised unsubmitted approval after review"); await click("Review approval change");
  await until(`document.querySelector('#recovery-reason-${prepared.id}')?.value===''`, "amended approval refreshed");
  assert.equal((await db.refundRequest.findUniqueOrThrow({ where: { id: prepared.id } })).approvedAmountMinor, 5000); assert.equal(count, 1);
  await set(`#recovery-action-${prepared.id}`, "VOID"); await set(`#recovery-reason-${prepared.id}`, "Void this definitely unsubmitted approval"); await click("Review approval change");
  await until("document.querySelector('.refund-card .platform-badge')?.textContent==='Rejected'", "voided approval"); assert.equal(count, 1);
  await submit("Request full review of the remaining balance"); await manage(); pending = false; await click("Review and issue refund"); await until("document.querySelector('.refund-card .platform-badge')?.textContent==='Refunded'", "verified full remaining refund");
  for (const width of [320,390,768,1440]) { await command("Emulation.setDeviceMetricsOverride", { width, height: 1100, deviceScaleFactor: 1, mobile: width < 768 }); assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, `Admin overflow at ${width}`); }
  await navigate("/billing", "#refunds-heading"); await until("document.querySelector('.refund-list')?.textContent.includes('Refunded')", "organization verified full refund");
  for (const width of [320,390,768,1440]) { await command("Emulation.setDeviceMetricsOverride", { width, height: 1100, deviceScaleFactor: 1, mobile: width < 768 }); assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, `Organization overflow at ${width}`); }
  const saved = await db.billingPayment.findUniqueOrThrow({ where: { id: paymentId } }); assert.equal(saved.amountMinor, 10000); assert.equal(saved.amountRefundedMinor, 10000); assert.equal(count, 2);
  assert.deepEqual(exceptions, []);
  if (process.env.UI_TEST_SCREENSHOT) { const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); await writeFile(process.env.UI_TEST_SCREENSHOT, Buffer.from(screenshot.data, "base64")); }
  console.log(JSON.stringify({ passed: true, checks: ["real organization/platform sessions and proxies", "captured payment selection", "submission", "validation and balance error recovery", "network timeout same-key retries", "prepared amendment and void", "pending/processing/partial/full statuses", "partial amount validation", "explicit confirmation", "mandatory rejection reason", "organization notifications", "history preservation", "refund does not cancel subscription", "four responsive widths"], providerBackedRefunds: false }));
} finally {
  if (socket) socket.close();
  if (orgId) { const ids = (await db.refundRequest.findMany({ where: { organizationId: orgId }, select: { id: true } })).map(row => row.id); await db.refundAuditEvent.deleteMany({ where: { requestId: { in: ids } } }); await db.refundTransaction.deleteMany({ where: { payment: { subscription: { organizationId: orgId } } } }); await db.refundRequest.deleteMany({ where: { organizationId: orgId } }); await db.organization.delete({ where: { id: orgId } }); }
  if (actorId) await db.superAdmin.delete({ where: { id: actorId } });
  await db.billingPlan.deleteMany({ where: { id: planId } }); await db.$disconnect();
}

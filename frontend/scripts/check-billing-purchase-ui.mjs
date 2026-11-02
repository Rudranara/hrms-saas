// Real local API quotes and authorization; intercepted provider checkout only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile, readFile } from "node:fs/promises";
const backend = createRequire(new URL("../../backend/package.json", import.meta.url));
backend("dotenv").config({ path: new URL("../../backend/.env", import.meta.url), quiet: true });
if (process.env.NODE_ENV === "production") throw new Error("Local fixtures only.");
const { PrismaClient } = backend("@prisma/client"), { newSession } = backend("./dist/auth/security.js");
if (process.env.UI_TEST_ISOLATED === "1") {
  const saved = JSON.parse(await readFile(new URL("../../artifacts/billing-audit-database.json", import.meta.url), "utf8"));
  const database = process.env.UI_TEST_DATABASE_NAME || saved.database;
  const url = new URL(process.env.DATABASE_URL);
  if (!/^hrms_billing_audit_[a-f0-9]{12}$/.test(database) || !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Invalid isolated fixture database");
  url.pathname = `/${database}`; process.env.DATABASE_URL = url.toString();
}
const db = new PrismaClient(), origin = process.env.UI_TEST_ORIGIN || "http://localhost:3000", run = randomUUID();
let orgId, socket, subscriptionId, checkoutCount = 0, statusFailure = false, refreshCount = 0, verificationOutage = true, trialResetCase = false, oldSubscriptionId, replacementWaiting = false;
try {
  const catalog = await fetch(origin + "/api/billing/plans").then((response) => response.json());
  const monthly = catalog.plans.find((plan) => plan.id === "growth-monthly" && plan.configured), yearly = catalog.plans.find((plan) => plan.id === "growth-yearly" && plan.configured);
  assert.ok(monthly && yearly, "Configured Test Mode catalog required"); assert.equal(catalog.mode, "test");
  const session = newSession();
  const org = await db.organization.create({ data: { name: `Purchase browser ${run}`, trialStartedAt: new Date(), trialExpiresAt: new Date(Date.now() + 7 * 86400000), users: { create: { fullName: "Purchase Browser Admin", email: `purchase-${run}@example.test`, passwordHash: "unused-browser-fixture", emailVerifiedAt: new Date(), role: "ORGANIZATION_ADMIN", sessions: { create: { tokenHash: session.tokenHash, expiresAt: session.expiresAt } } } } } }); orgId = org.id;
  const tabs = await fetch(`http://localhost:${process.env.UI_TEST_DEBUG_PORT || "9223"}/json/list`).then((response) => response.json()); socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let sequence = 0; const pending = new Map(), exceptions = [], bodies = [];
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const fulfill = (requestId, status, body) => command("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)).toString("base64") });
  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);
    if (message.id) { const item = pending.get(message.id); pending.delete(message.id); if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result); return; }
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
    if (message.method !== "Fetch.requestPaused") return;
    const { requestId, request } = message.params, action = new URL(request.url).pathname.split("/").at(-1);
    try {
      if (action === "history") { await fulfill(requestId, 503, { success: false, message: "Fixture history outage" }); return; }
      if (action === "status") { if (statusFailure) { statusFailure = false; await fulfill(requestId, 503, { success: false }); } else await command("Fetch.continueRequest", { requestId }); return; }
      if (action === "refresh") { refreshCount++; if (verificationOutage) { verificationOutage = false; await fulfill(requestId, 503, { success: false }); } else await fulfill(requestId, 200, { success: true }); return; }
      const body = JSON.parse(request.postData); bodies.push({ action, body });
      if (action === "checkout") {
        checkoutCount++; assert.deepEqual(Object.keys(body), trialResetCase ? ["quoteId", "replaceSubscriptionId"] : ["quoteId"]);
        const quote = await db.billingQuote.findFirstOrThrow({ where: { id: body.quoteId, organizationId: orgId } });
        if (trialResetCase) {
          assert.equal(body.replaceSubscriptionId, oldSubscriptionId);
          if (!replacementWaiting) {
            replacementWaiting = true;
            await db.subscription.update({ where: { id: oldSubscriptionId }, data: { status: "CANCELLED", lastSyncedAt: new Date() } });
            await fulfill(requestId, 409, { success: false, code: "REPLACEMENT_PENDING", message: "The previous subscription is being checked. Refresh provider status before proceeding again." }); return;
          }
          if (subscriptionId === oldSubscriptionId) {
            const organization = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
            const row = await db.subscription.create({ data: { organizationId: orgId, planId: quote.planId, providerPlanId: quote.providerPlanId, providerSubscriptionId: `sub_reset_${run.replaceAll("-", "")}`, status: "CREATED", amountMinor: quote.amountMinor, currency: quote.currency, interval: quote.interval, totalCount: quote.totalCount, commercialTerms: { accessPolicyVersion: organization.accessVersion, planName: quote.planName } } }); subscriptionId = row.id;
          }
        }
        if (!subscriptionId) { const row = await db.subscription.create({ data: { organizationId: orgId, planId: quote.planId, providerPlanId: quote.providerPlanId, providerSubscriptionId: `sub_fixture_${run.replaceAll("-", "")}`, status: "CREATED", amountMinor: quote.amountMinor, currency: quote.currency, interval: quote.interval, totalCount: quote.totalCount } }); subscriptionId = row.id; }
        await db.billingQuote.update({ where: { id: quote.id }, data: { subscriptionId } }); statusFailure = true;
        const pendingSubscription = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
        await fulfill(requestId, 200, { success: true, checkout: { keyId: "rzp_test_fixture", subscriptionId, providerSubscriptionId: pendingSubscription.providerSubscriptionId } });
      } else if (action === "confirm") {
        const row = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
        const end = new Date(Date.now() + 30 * 86400000);
        await db.subscription.update({ where: { id: subscriptionId }, data: { status: "ACTIVE", paidUntil: end, currentPeriodStart: new Date(), currentPeriodEnd: end, nextBillingAt: end, lastSyncedAt: new Date(), payments: { create: { providerPaymentId: `${trialResetCase ? "pay_reset" : "pay_fixture"}_${run}`, providerInvoiceId: `${trialResetCase ? "inv_reset" : "inv_fixture"}_${run}`, status: "captured", amountMinor: row.amountMinor, currency: row.currency, paidAt: new Date() } } } });
        await fulfill(requestId, 200, { success: true, access: { source: "SUBSCRIPTION", allowed: true } });
      }
    } catch (error) { exceptions.push(error.message); await fulfill(requestId, 500, { success: false }); }
  });
  const evaluate = async (expression) => { const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error("Browser evaluation failed"); return result.result.value; };
  const until = async (expression, label) => { for (let i = 0; i < 400; i++) { if (await evaluate(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${label}`); };
  const click = async (text) => { await until(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()===${JSON.stringify(text)}&&!button.disabled)`, text); await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(text)}).click()`); };
  await command("Page.enable"); await command("Runtime.enable"); await command("Network.enable");
  await command("Network.setCookie", { name: "hrms_session", value: session.token, url: origin, httpOnly: true, sameSite: "Lax" });
  await command("Page.addScriptToEvaluateOnNewDocument", { source: "window.Razorpay=class{constructor(options){this.options=options;this.events={}}on(name,fn){this.events[name]=fn}open(){window.__checkout=this}};" });
  await command("Fetch.enable", { patterns: ["checkout", "confirm", "refresh", "history", "status"].map((action) => ({ urlPattern: `*/api/billing/${action}`, requestStage: "Request" })) });
  await command("Page.navigate", { url: origin + "/billing" });
  await until("!!document.querySelector('.billing-plan-grid')", "billing plan selection");
  assert.equal(await evaluate("!!document.querySelector('.billing-purchase')"), false, "Checkout must not appear on the billing overview");
  await click("Choose Growth");
  await until("!!document.querySelector('.billing-purchase-frequency select')", "configuration");
  assert.equal(await evaluate("location.pathname"), "/billing/checkout");
  assert.equal(await evaluate("!!document.querySelector('.billing-checkout-panel .billing-history') || !!document.querySelector('.billing-checkout-panel .billing-plan-grid')"), false, "Checkout must be a focused page");
  assert.equal(await db.billingQuote.count({ where: { organizationId: orgId } }), 0); assert.equal(checkoutCount, 0);
  await evaluate("(()=>{const select=document.querySelector('.billing-purchase-frequency select');select.value='YEARLY';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await until("location.search.includes('growth-yearly') && document.querySelector('.billing-purchase-frequency select')?.value==='YEARLY'", "yearly configuration");
  await click("Continue to payment summary"); await until("!!document.querySelector('.billing-purchase-consent')", "backend yearly quote");
  assert.equal((await db.billingQuote.findFirstOrThrow({ where: { organizationId: orgId } })).amountMinor, yearly.amountMinor); assert.equal(checkoutCount, 0);
  assert.equal(await evaluate("document.querySelector('.billing-purchase').textContent.includes('12 years')"), true);
  await click("Edit subscription");
  await evaluate("(()=>{const select=document.querySelector('.billing-purchase-frequency select');select.value='MONTHLY';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await until("location.search.includes('growth-monthly') && !!document.querySelector('.billing-purchase-frequency select')", "monthly edit");
  await click("Continue to payment summary"); await until("!!document.querySelector('.billing-purchase-consent')", "monthly quote");
  let quoteId = await evaluate("new URLSearchParams(location.search).get('quote')");
  await command("Page.reload"); await until("!!document.querySelector('.billing-purchase-consent')", "summary survives refresh");
  assert.equal(await evaluate("new URLSearchParams(location.search).get('quote')"), quoteId);
  await db.billingQuote.update({ where: { id: quoteId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await command("Page.reload"); await until("document.querySelector('.billing-purchase')?.textContent.includes('This quote expired')", "expired quote");
  await click("Refresh payment summary"); await until(`new URLSearchParams(location.search).get('quote')!==${JSON.stringify(quoteId)}`, "fresh quote");
  for (const width of [320, 390, 768, 1440]) { await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 }); assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, `Summary overflow at ${width}`); }
  if (process.env.UI_TEST_SCREENSHOT) {
    const clip = await evaluate("(()=>{const rect=document.querySelector('.billing-purchase').getBoundingClientRect();return {x:rect.left+scrollX,y:rect.top+scrollY,width:rect.width,height:rect.height,scale:1};})()");
    const shot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
    await writeFile(process.env.UI_TEST_SCREENSHOT, Buffer.from(shot.data, "base64"));
  }
  await evaluate("document.querySelector('.billing-purchase-consent input').click()"); await click("Proceed to payment"); await until("!!window.__checkout", "checkout opens despite secondary fetch outage");
  await new Promise((resolve) => setTimeout(resolve, 25000));
  assert.equal(refreshCount, 0, "Polling must not be consumed while the customer is in Checkout beyond the old twenty-second window");
  await evaluate("window.__checkout.options.modal.ondismiss();window.__checkout=null"); await until("document.querySelector('.billing-payment-status')?.textContent.includes('Provider confirmation is still pending')", "verification network outage");
  assert.equal(await evaluate("document.querySelector('.billing-payment-status')?.textContent.includes('Payment was not completed')"), false, "Network outage must not become a payment failure");
  await click("Back to payment summary"); await until("!!document.querySelector('.billing-purchase-consent')", "closed checkout can return to summary");
  assert.equal(checkoutCount, 1); assert.equal(await db.billingPayment.count({ where: { subscriptionId } }), 0);
  await evaluate("document.querySelector('.billing-purchase-consent input').click()"); await click("Proceed to payment"); await until("!!window.__checkout", "resume same checkout");
  await db.subscription.update({ where: { id: subscriptionId }, data: { status: "AUTHENTICATED", payments: { create: { providerPaymentId: `pay_failed_${run}`, providerInvoiceId: `inv_failed_${run}`, status: "failed", amountMinor: monthly.amountMinor, currency: "INR" } } } });
  await evaluate("window.__checkout.events['payment.failed']();window.__checkout.options.modal.ondismiss()"); await until("document.querySelector('.billing-payment-status')?.textContent.includes('Payment was not completed')", "verified failure");
  await click("Retry payment"); await until("!!document.querySelector('.billing-purchase-consent')", "retry summary");
  await evaluate("document.querySelector('.billing-purchase-consent input').click();window.__checkout=null"); await click("Proceed to payment"); await until("!!window.__checkout", "retry checkout");
  await evaluate("window.__checkout.options.handler({razorpay_payment_id:'pay_fixture',razorpay_subscription_id:window.__checkout.options.subscription_id,razorpay_signature:'fixture'})");
  await until("document.querySelector('.billing-payment-status')?.textContent.includes('Subscription activated')", "authoritative activation");
  const terminalRefreshCount = refreshCount;
  await until("location.pathname==='/dashboard' && document.body?.textContent.includes('Payment verified:')", "dashboard confirmation");
  assert.equal(refreshCount, terminalRefreshCount, "Verified terminal success must stop automatic refresh requests");
  assert.equal(await db.subscription.count({ where: { organizationId: orgId } }), 1); assert.equal(bodies.filter((item) => item.action === "confirm").length, 1); assert.deepEqual(exceptions, []);
  oldSubscriptionId = subscriptionId; trialResetCase = true;
  const previousPayments = await db.billingPayment.findMany({ where: { subscriptionId: oldSubscriptionId } });
  await db.organization.update({ where: { id: orgId }, data: { accessMode: "CONTROLLED", accessVersion: { increment: 1 }, trialEnabled: true, subscriptionEnabled: false, trialExpiresAt: new Date(Date.now() + 7 * 86400000) } });
  await command("Page.navigate", { url: origin + "/billing" });
  await until("Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='Choose Essentials'&&!button.disabled)", "plans selectable after administrator trial reset");
  for (const label of ["Choose Essentials", "Choose Growth", "Choose Organization"]) assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()===${JSON.stringify(label)}&&!button.disabled)`), true);
  await click("Choose Essentials"); await until("!!document.querySelector('.billing-purchase-frequency select')", "replacement configuration");
  await click("Continue to payment summary"); await until("document.querySelector('.billing-purchase-consent')?.textContent.includes('replacement and cancellation')", "explicit prior subscription consent");
  assert.equal((await db.subscription.findUniqueOrThrow({ where: { id: oldSubscriptionId } })).status, "ACTIVE", "Selecting or reviewing a plan must not cancel previous renewals");
  const requestsBeforeConsent = checkoutCount; await click("Proceed to payment"); assert.equal(checkoutCount, requestsBeforeConsent, "Replacement requires consent before submit");
  await evaluate("document.querySelector('.billing-purchase-consent input').click();window.__checkout=null"); await click("Proceed to payment");
  await until("document.querySelector('.billing-checkout-panel [role=alert]')?.textContent.includes('previous subscription is being checked')", "replacement wait displayed");
  assert.equal(await evaluate("!!window.__checkout"), false, "Razorpay must not open until the previous cancellation is confirmed");
  await click("Proceed to payment"); await until("!!window.__checkout", "replacement payment opens after confirmed cancellation");
  await evaluate("window.__checkout.options.handler({razorpay_payment_id:'pay_reset_fixture',razorpay_subscription_id:window.__checkout.options.subscription_id,razorpay_signature:'fixture'})");
  await until("location.pathname==='/dashboard' && document.body?.textContent.includes('Payment verified:')", "new purchase activates after trial reset");
  assert.equal(await db.subscription.count({ where: { organizationId: orgId } }), 2);
  assert.deepEqual(await db.billingPayment.findMany({ where: { subscriptionId: oldSubscriptionId } }), previousPayments);
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ passed: true, checks: ["monthly/yearly configuration", "no automatic payment", "backend quotes", "yearly cycle disclosure", "edit and reload", "quote expiry", "four responsive widths", "secondary API failure", "checkout open beyond old polling window", "checkout closure restarts polling", "verification outage stays pending", "safe retry", "verified failure", "verified success stops polling", "dashboard confirmation", "plans enabled after administrator trial reset", "explicit replacement consent", "wait before replacement payment", "earlier payments preserved"], realProviderPayments: false }));
} finally { if (socket) socket.close(); if (orgId) await db.organization.deleteMany({ where: { id: orgId } }); await db.$disconnect(); }

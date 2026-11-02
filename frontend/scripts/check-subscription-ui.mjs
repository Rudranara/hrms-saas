// Real local auth/database + intercepted checkout. Never creates a provider subscription.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
requireBackend("dotenv").config({ path: new URL("../../backend/.env", import.meta.url), quiet: true });
if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
const { PrismaClient } = requireBackend("@prisma/client");
const db = new PrismaClient();
const run = randomUUID(), prefix = `Subscription browser ${run}`;
const password = `Subscription browser passphrase ${run}`;
const email = `subscription-${run}@example.test`;
const origin = process.env.UI_TEST_ORIGIN || "http://localhost:3000";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket, missingSetup = false;
const checkoutRequests = [], confirmationRequests = [], exceptions = [];
try {
  const catalog = await fetch(`${origin}/api/billing/plans`).then((r) => r.json());
  assert.equal(catalog.plans.length, 6);
  const tabs = await fetch("http://localhost:9223/json/list").then((r) => r.json());
  socket = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const fulfill = (requestId, responseCode, body) => command("Fetch.fulfillRequest", {
    requestId, responseCode, responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    body: Buffer.from(JSON.stringify(body)).toString("base64"),
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
    else if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      if (request.url.endsWith("/checkout")) {
        checkoutRequests.push(JSON.parse(request.postData));
        void fulfill(requestId, 200, { success: true, checkout: { keyId: "rzp_test_mock", subscriptionId: "mock_local", providerSubscriptionId: "sub_mock" } });
      } else if (request.url.endsWith("/confirm")) {
        confirmationRequests.push(JSON.parse(request.postData));
        void fulfill(requestId, 400, { message: "Mock server rejected unverified payment confirmation." });
      } else {
        void fulfill(requestId, 200, { ...catalog, plans: catalog.plans.map((p) => ({ ...p, configured: !missingSetup, unavailableReason: missingSetup ? "Payment setup is incomplete." : null })) });
      }
    }
  });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${result.exceptionDetails.text}`);
    return result.result.value;
  };
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(expression)) return;
      await pause(100);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const navigate = async (path) => {
    await command("Page.navigate", { url: path.startsWith("http") ? path : origin + path });
    await until("document.readyState === 'complete'", path);
    await pause(400);
  };
  const submit = async (values) => {
    await until("!!document.querySelector('form')", "form");
    await pause(300);
    await evaluate(`(()=>{const values=${JSON.stringify(values)}; for(const [name,value] of Object.entries(values)){const input=document.querySelector('[name="'+name+'"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('form').requestSubmit();})()`);
  };
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Network.enable");
  await command("Network.setBlockedURLs", { urls: ["*://*.razorpay.com/*"] });
  await command("Fetch.enable", { patterns: ["checkout", "confirm", "plans"].map((action) => ({ urlPattern: `*/api/billing/${action}`, requestStage: "Request" })) });
  await command("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__checkout = null;
    window.Razorpay = class {
      constructor(options) { this.options=options; this.events={}; }
      on(name,callback) { this.events[name]=callback; }
      open() { window.__checkout=this; }
    };
  ` });
  await command("Network.deleteCookies", { name: "hrms_session", url: origin });
  await navigate("/pricing");
  await until("document.querySelectorAll('.plan-price').length===3 && document.querySelector('.plan-price').textContent.includes('999')", "prices");
  for (const period of ["monthly", "yearly"]) {
    if (period === "yearly") {
      await evaluate("document.querySelectorAll('.billing-toggle button')[1].click()");
      await until("document.querySelector('.plan-price').textContent.includes('9,990')", "yearly prices");
    }
    const links = await evaluate("Array.from(document.querySelectorAll('.plan > a.button')).map(a=>a.getAttribute('href'))");
    assert.equal(links.length, 3);
    for (const [i, tier] of ["essentials", "growth", "organization"].entries()) {
      const query = new URL(links[i], origin).searchParams;
      assert.equal(query.get("plan"), `${tier}-${period}`);
      assert.equal(query.get("period"), period);
    }
  }
  let responsiveChecks = 0;
  for (const width of [320, 390, 768, 1440]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    responsiveChecks++;
  }
  for (const plan of catalog.plans) {
    const destination = `/billing?${new URLSearchParams({ plan: plan.id, period: plan.interval.toLowerCase() })}`;
    await navigate(destination);
    await until("location.pathname==='/login'", "login redirect");
    assert.equal(await evaluate("new URLSearchParams(location.search).get('next')"), destination);
    await until("Array.from(document.querySelectorAll('a')).some(a=>a.getAttribute('href')?.startsWith('/register?next='))", "registration continuation");
  }
  const destination = "/billing?plan=growth-yearly&period=yearly";
  await navigate(`/register?next=${encodeURIComponent(destination)}`);
  await submit({ organizationName: `${prefix} paid`, fullName: "Subscription Browser Admin", email, password, confirmPassword: password });
  await until("location.pathname==='/dashboard' && !!document.querySelector('.workspace-details')", "registration signs in immediately");
  assert.equal(checkoutRequests.length, 0);
  const me = await evaluate("fetch('/api/auth/me').then(r=>r.json())");
  assert.equal(me.success, true);
  assert.equal(me.user.emailVerifiedAt, null, "Signup must not falsely verify the email");
  const account = await db.user.findUniqueOrThrow({ where: { email }, include: { organization: true } });
  const trialStart = account.organization.trialStartedAt.getTime(), trialEnd = account.organization.trialExpiresAt.getTime();
  assert.equal(trialEnd - trialStart, 7 * 86400000);
  await until("Array.from(document.querySelectorAll('a')).some(a=>a.textContent.includes('Continue with your selected paid plan'))", "dashboard preserves plan");
  assert.equal(checkoutRequests.length, 0, "Registration must not open checkout");
  assert.equal(await evaluate("document.body.textContent.includes('trial days remaining')"), true);
  for (const plan of catalog.plans) {
    await command("Network.deleteCookies", { name: "hrms_session", url: origin });
    const next = `/billing?${new URLSearchParams({ plan: plan.id, period: plan.interval.toLowerCase() })}`;
    const before = checkoutRequests.length;
    await navigate(`/login?next=${encodeURIComponent(next)}`);
    await submit({ email, password });
    await until("location.pathname==='/billing' && !!document.querySelector('[aria-label=\"Selected paid plan\"] button')", `authenticated plan review ${plan.id}`);
    await until("!document.querySelector('[aria-label=\"Selected paid plan\"] button').disabled", "eligible checkout");
    assert.equal(checkoutRequests.length, before, "Plan selection must wait for explicit confirmation");
    await navigate("/billing");
    await until("document.querySelectorAll('.billing-plan').length===3", "choose a plan from billing");
    if (plan.interval === "YEARLY") {
      await evaluate("document.querySelectorAll('.billing-toggle button')[1].click()");
      await pause(100);
    }
    await evaluate(`Array.from(document.querySelectorAll('.billing-plan')).find(card=>card.querySelector('h3').textContent===${JSON.stringify(plan.name)}).querySelector('button').click()`);
    await until(`new URLSearchParams(location.search).get('plan')===${JSON.stringify(plan.id)} && !!document.querySelector('[aria-label="Selected paid plan"] button')`, "selected billing plan review");
    assert.equal(checkoutRequests.length, before);
    await evaluate("document.querySelector('[aria-label=\"Selected paid plan\"] button').click()");
    await until("!!window.__checkout", `explicit checkout ${plan.id}`);
    assert.equal(checkoutRequests.length, before + 1);
    assert.deepEqual(checkoutRequests.at(-1), { planId: plan.id, period: plan.interval.toLowerCase() });
    await evaluate("window.__checkout.options.modal.ondismiss()");
    assert.equal(await evaluate("document.body.textContent.includes('Checkout closed')"), true);
    await navigate(next);
    await until("document.querySelectorAll('.billing-plan').length===3", "billing reload");
    await pause(300);
    assert.equal(checkoutRequests.length, before + 1, "Refresh must not reopen checkout");
  }
  // Explicit retries remain available after dismissal; failure and signature rejection are visible.
  await evaluate("document.querySelector('[aria-label=\"Selected paid plan\"] button').click()");
  await until("!!window.__checkout", "explicit retry");
  await evaluate("window.__checkout.events['payment.failed']()");
  assert.equal(await evaluate("document.body.textContent.includes('payment failure')"), true);
  await evaluate("window.__checkout.options.modal.ondismiss()");
  await evaluate("window.__checkout.options.handler({razorpay_payment_id:'pay_mock',razorpay_subscription_id:'sub_mock',razorpay_signature:'invalid'})");
  assert.equal(confirmationRequests.length, 1);
  assert.equal(await evaluate("document.body.textContent.includes('Mock server rejected')"), true);
  for (const width of [320, 390, 768, 1440]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `Billing overflow at ${width}`);
    responsiveChecks++;
  }
  missingSetup = true;
  await navigate(destination + "&review=1");
  await until("document.querySelectorAll('.billing-plan').length===3", "missing configuration");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Selected paid plan\"] button').disabled"), true);
  assert.equal(await evaluate("document.body.textContent.includes('Payment setup is incomplete')"), true);
  missingSetup = false;
  for (const path of ["/billing?plan=growth-yearly&period=monthly", "/billing?plan=unknown", "/billing?plan=growth-yearly&plan=essentials-monthly"]) {
    const count = checkoutRequests.length;
    await navigate(path);
    await until("document.body.textContent.includes('This plan selection is invalid')", "tampered selection");
    assert.equal(checkoutRequests.length, count);
  }
  for (const unsafe of ["https://evil.test", "//evil.test", "/billing?plan=growth-yearly&period=weekly"]) {
    await navigate(`/login?next=${encodeURIComponent(unsafe)}`);
    await submit({ email, password });
    await until("location.pathname==='/dashboard'", "unsafe return rejected");
  }
  const after = await db.organization.findUniqueOrThrow({ where: { id: account.organizationId } });
  assert.equal(after.trialStartedAt.getTime(), trialStart);
  assert.equal(after.trialExpiresAt.getTime(), trialEnd);
  assert.equal(await db.subscription.count({ where: { organizationId: account.organizationId } }), 0);
  await command("Network.deleteCookies", { name: "hrms_session", url: origin });
  await navigate("/pricing");
  assert.equal(await evaluate("Array.from(document.querySelectorAll('a')).filter(a=>a.textContent.includes('Start')&&a.textContent.includes('trial')).every(a=>a.getAttribute('href')==='/register')"), true);
  await navigate("/register");
  const count = checkoutRequests.length;
  await submit({ organizationName: `${prefix} trial`, fullName: "Trial Browser Admin", email: `trial-${run}@example.test`, password, confirmPassword: password });
  await until("location.pathname==='/dashboard' && !!document.querySelector('.workspace-details')", "free trial dashboard without verification");
  assert.equal(checkoutRequests.length, count);
  assert.equal(await evaluate("sessionStorage.getItem('hrms.billing.continuation')"), null);
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ plansTested: 6, responsiveChecks, authenticatedCheckout: "unverified administrator; explicit and mocked", registration: "immediate dashboard sign-in without SMTP", unsafeReturns: "rejected", dismissalAndFailure: "passed", realRazorpayTransaction: false }, null, 2));
} finally {
  const fixtures = await db.organization.findMany({ where: { name: { startsWith: prefix } }, select: { id: true } });
  for (const fixture of fixtures) await db.organization.delete({ where: { id: fixture.id } });
  await db.$disconnect();
  socket?.close();
}

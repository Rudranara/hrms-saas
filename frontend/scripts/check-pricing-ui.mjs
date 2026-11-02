// Local development regression, with a dedicated Chrome debug profile on 9223.
// Requires both apps and MySQL; no SMTP or Razorpay credentials.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const requireBackend = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
requireBackend("dotenv").config({
  path: new URL("../../backend/.env", import.meta.url),
  quiet: true,
});
if (process.env.NODE_ENV === "production")
  throw new Error("Do not run browser fixtures in production.");
const { PrismaClient } = requireBackend("@prisma/client"),
  db = new PrismaClient();
const run = randomUUID(),
  email = `pricing-${run}@example.test`,
  organization = `Pricing browser ${run}`;
const password = `Pricing browser passphrase ${randomUUID()}`;
const origin = process.env.UI_TEST_ORIGIN || "http://localhost:3000",
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
try {
  const tabs = await fetch("http://127.0.0.1:9223/json/list").then((r) =>
    r.json(),
  );
  const tab = tabs.find((t) => t.type === "page");
  assert.ok(tab);
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve) =>
    socket.addEventListener("open", resolve, { once: true }),
  );
  let sequence = 0;
  const pending = new Map(),
    exceptions = [],
    paused = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown")
      exceptions.push(message.params.exceptionDetails.text);
    else if (message.method === "Fetch.requestPaused")
      paused.push(message.params.requestId);
  });
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error("Pricing browser evaluation failed.");
    return result.result.value;
  };
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate(expression)) return;
      await pause(100);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const navigate = async (path) => {
    await command("Page.navigate", { url: origin + path });
    await until("document.readyState === 'complete'", "page load");
    await pause(500);
  };
  const prices = (selector) =>
    evaluate(
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(e=>e.textContent)`,
    );
  const checkAmounts = (values, amounts) => {
    assert.equal(values.length, 3);
    amounts.forEach((amount, i) =>
      assert.ok(
        values[i].includes(
          new Intl.NumberFormat("en-IN", {
            style: "currency",
            currency: "INR",
          }).format(amount),
        ),
        `Expected configured amount in card ${i + 1}`,
      ),
    );
  };
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Network.enable");
  await command("Network.deleteCookies", { name: "hrms_session", url: origin });
  const plans = await fetch(`${origin}/api/billing/plans`).then((r) =>
    r.json(),
  );
  assert.equal(
    plans.providerAvailable,
    false,
    "This regression deliberately requires missing Razorpay configuration.",
  );
  assert.equal(plans.plans.length, 6);
  const checks = [];
  await navigate("/pricing");
  await until(
    "document.querySelectorAll('.plan-price').length===3 && document.querySelector('.plan-price').textContent.includes('999')",
    "configured monthly prices",
  );
  checkAmounts(await prices(".plan-price"), [999, 1999, 3999]);
  assert.equal(
    await evaluate("document.querySelectorAll('.plan button:disabled').length"),
    0,
  );
  assert.equal(
    await evaluate("document.body.textContent.includes('Pricing coming soon')"),
    false,
  );
  assert.equal(
    await evaluate("document.body.textContent.includes('include GST')"),
    true,
  );
  await evaluate(
    "document.querySelectorAll('.billing-toggle button')[1].click()",
  );
  await until(
    "document.querySelector('.plan-price').textContent.includes('9,990')",
    "yearly prices",
  );
  checkAmounts(await prices(".plan-price"), [9990, 19990, 39990]);
  checkAmounts(await prices(".plan-savings"), [1998, 3998, 7998]);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.billing-toggle button')[1].getAttribute('aria-pressed')",
    ),
    "true",
  );
  const href = await evaluate(
    "document.querySelector('.plan > a.button').getAttribute('href')",
  );
  assert.equal(href, "/billing?plan=essentials-yearly&period=yearly");
  checks.push(
    "Six public prices, yearly savings, tax disclosure and plan selection with unconfigured checkout",
  );
  let responsiveChecks = 0;
  for (const width of [320, 390, 768, 1440]) {
    await command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });
    await pause(100);
    assert.equal(
      await evaluate("document.documentElement.scrollWidth <= innerWidth"),
      true,
      `Pricing overflow at ${width}`,
    );
    responsiveChecks++;
  }
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await navigate(href);
  await until("location.pathname==='/login'", "billing sign-in redirect");
  assert.equal(
    await evaluate("new URLSearchParams(location.search).get('next')"),
    href,
  );
  await until("!!document.querySelector('form')", "login hydration");
  await pause(500);
  const registrationLink = await evaluate(
    "document.querySelector('.auth-switch a').getAttribute('href')",
  ).catch(() => null);
  // Registration link selector can change; assert the continuation on any link.
  assert.ok(
    registrationLink?.includes("next=") ||
      (await evaluate(
        "Array.from(document.querySelectorAll('a')).some(a=>a.getAttribute('href')?.startsWith('/register?next='))",
      )),
  );
  await navigate(`/register?next=${encodeURIComponent(href)}`);
  await until("!!document.querySelector('form')", "registration form");
  await pause(500);
  await evaluate(
    `(()=>{const values=${JSON.stringify({ organizationName: organization, fullName: "Pricing Test Administrator", email, password, confirmPassword: password })};for(const [name,value] of Object.entries(values)){const input=document.querySelector('[name="'+name+'"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('form').requestSubmit();})()`,
  );
  await until(
    "location.pathname==='/dashboard' && !!document.querySelector('.workspace-details')",
    "registration opens dashboard without verification",
  );
  await navigate(href);
  await until("document.querySelectorAll('.billing-plan').length===3", "review preserved plan in billing");
  assert.equal(
    await evaluate("new URLSearchParams(location.search).get('plan')"),
    "essentials-yearly",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.billing-plan[data-selected]').querySelector('h3').textContent",
    ),
    "Essentials",
  );
  checkAmounts(await prices(".billing-price"), [9990, 19990, 39990]);
  const user = await db.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, organization: { select: { name: true } } },
  });
  assert.equal(user.organization.name, organization);
  await navigate(href);
  await until(
    "document.querySelectorAll('.billing-plan').length===3",
    "verified billing",
  );
  for (const label of [
    "Trial started",
    "Trial time remaining",
    "Current period starts",
    "Current period ends",
    "Latest payment",
    "Cancellation",
  ]) {
    assert.equal(
      await evaluate(
        `document.body.textContent.includes(${JSON.stringify(label)})`,
      ),
      true,
    );
  }
  assert.equal(
    await evaluate(
      `document.body.textContent.includes(${JSON.stringify(plans.checkoutReadiness.message)})`,
    ),
    true,
    "Show the exact backend checkout-readiness reason",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.billing-plan button:disabled').length",
    ),
    3,
  );
  const denied = await evaluate(
    "fetch('/api/billing/checkout',{method:'POST',headers:{'Content-Type':'application/json','X-HRMS-Request':'1'},body:JSON.stringify({planId:'essentials-yearly'})}).then(async r=>({status:r.status,body:await r.json()}))",
  );
  assert.equal(denied.status, 503);
  assert.equal(denied.body.code, "BILLING_UNAVAILABLE");
  for (const width of [320, 390, 768, 1440]) {
    await command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });
    await pause(100);
    assert.equal(
      await evaluate("document.documentElement.scrollWidth <= innerWidth"),
      true,
      `Billing overflow at ${width}`,
    );
    responsiveChecks++;
  }
  checks.push(
    "Selected yearly plan survives authentication; billing displays prices and rejects direct checkout while setup is incomplete",
  );
  await command("Fetch.enable", {
    patterns: [{ urlPattern: "*/api/billing/plans", requestStage: "Request" }],
  });
  await navigate("/pricing");
  await until(
    "document.body.textContent.includes('Loading plan prices')",
    "loading state",
  );
  for (let attempt = 0; !paused.length && attempt < 100; attempt++)
    await pause(100);
  assert.ok(paused.length);
  // Development Strict Mode can issue two effects; release both intercepted
  // requests so the live effect receives the failure as well as the aborted one.
  while (paused.length) {
    await command("Fetch.fulfillRequest", {
      requestId: paused.shift(),
      responseCode: 503,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from('{"success":false}').toString("base64"),
    }).catch(() => {});
  }
  await until(
    "document.body.textContent.includes('Pricing service temporarily unavailable')",
    "API failure state",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.plan button:disabled').length"),
    3,
  );
  await command("Fetch.disable");
  checks.push(
    "Explicit loading and API-error states without placeholder prices or enabled checkout",
  );
  await navigate("/");
  await until(
    "document.querySelectorAll('.plan-price').length===3 && document.querySelector('.plan-price').textContent.includes('999')",
    "homepage prices",
  );
  checkAmounts(await prices(".plan-price"), [999, 1999, 3999]);
  assert.equal((await fetch("http://localhost:4000/api/health")).status, 200);
  assert.deepEqual(exceptions, []);
  console.log(
    JSON.stringify(
      {
        checks,
        responsiveChecks,
        checkoutConfigured: plans.providerAvailable,
        realRazorpayTransaction: false,
      },
      null,
      2,
    ),
  );
} finally {
  const fixture = await db.user.findUnique({
    where: { email },
    select: { organizationId: true, organization: { select: { name: true } } },
  });
  if (fixture?.organization.name === organization)
    await db.organization.delete({ where: { id: fixture.organizationId } });
  await db.$disconnect();
  socket?.close();
}

// Explicit development E2E test. Requires the local-only SMTP inbox, both apps,
// and a dedicated headless Chrome debugging instance (see backend/BILLING.md).
// Test credentials/tokens stay in memory; only this run's organization is removed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const backendRequire = createRequire(
  path.resolve(scriptDirectory, "../../backend/package.json"),
);
backendRequire("dotenv").config({
  path: path.resolve(scriptDirectory, "../../backend/.env"),
  quiet: true,
});
if (process.env.NODE_ENV === "production")
  throw new Error("Browser fixtures must not run in production.");
const { PrismaClient } = backendRequire("@prisma/client");
const db = new PrismaClient();
const run = randomUUID();
const email = `browser-lifecycle-${run}@example.test`;
const organizationName = `Browser lifecycle ${run}`;
const password = `First browser passphrase ${randomUUID()}`;
const nextPassword = `Second browser passphrase ${randomUUID()}`;
const frontend = process.env.UI_TEST_ORIGIN || "http://localhost:3000";
const backend = process.env.UI_TEST_API_URL || "http://localhost:4000";
const debug = process.env.CHROME_DEBUG_URL || "http://localhost:9223";
const inbox = "http://127.0.0.1:8025";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
async function emailLink(page) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const list = await fetch(inbox).then((r) => r.text());
    const ids = [...list.matchAll(/href="\/\?message=([a-z0-9-]+)"/g)].map(
      (m) => m[1],
    );
    for (const id of ids) {
      const message = await fetch(`${inbox}/?message=${id}`).then((r) =>
        r.text(),
      );
      if (!message.includes(email)) continue;
      const match = message.match(
        new RegExp(`href="(${frontend.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${page}#token=[a-f0-9]{64})"`),
      );
      if (match) return match[1];
    }
    await pause(100);
  }
  throw new Error(
    "No matching email reached the local SMTP inbox. Check the API's local SMTP configuration.",
  );
}
async function emailOtp() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const list = await fetch(inbox).then((r) => r.text());
    const ids = [...list.matchAll(/href="\/\?message=([a-z0-9-]+)"/g)].map(
      (m) => m[1],
    );
    for (const id of ids) {
      const message = await fetch(`${inbox}/?message=${id}`).then((r) =>
        r.text(),
      );
      if (!message.includes(email)) continue;
      const match = message.match(/password reset code is: (\d{8})/);
      if (match) return match[1];
    }
    await pause(100);
  }
  throw new Error("No reset OTP reached the local SMTP inbox. Check the API's local SMTP configuration.");
}
(async () => {
  try {
    const tabs = await fetch(`${debug}/json/list`).then((r) => r.json());
    const tab = tabs.find((t) => t.type === "page");
    assert.ok(tab, "A dedicated Chrome test tab is required.");
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve) =>
      socket.addEventListener("open", resolve, { once: true }),
    );
    let sequence = 0;
    const pending = new Map();
    const exceptions = [];
    const networkURLs = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const task = pending.get(message.id);
        pending.delete(message.id);
        if (message.error)
          task.reject(new Error("Browser protocol request failed."));
        else task.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown")
        exceptions.push(message.params.exceptionDetails.text);
      else if (message.method === "Network.responseReceived")
        networkURLs.push(message.params.response.url);
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
        throw new Error("An account UI check raised a browser exception.");
      return result.result.value;
    };
    const until = async (expression, label) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(expression)) return;
        await pause(150);
      }
      throw new Error(`Timed out: ${label}`);
    };
    const navigate = async (url) => {
      await command("Page.navigate", {
        url: url.startsWith("http") ? url : frontend + url,
      });
      await until('document.readyState === "complete"', "page readiness");
      await pause(650);
    };
    const fill = async (values) =>
      evaluate(
        `(()=>{for(const [name,value] of Object.entries(${JSON.stringify(values)})){const input=document.querySelector('[name="'+name+'"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}})()`,
      );
    await command("Page.enable");
    await command("Runtime.enable");
    await command("Network.enable");
    await command("Network.deleteCookies", {
      name: "hrms_session",
      url: frontend,
    });
    await command("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const checks = [];
    await navigate("/dashboard");
    await until('location.pathname === "/login"', "unauthenticated redirect");
    checks.push("Unauthenticated dashboard redirects to login");
    await navigate("/register");
    await fill({
      organizationName,
      fullName: "Browser Test Administrator",
      email,
      password,
      confirmPassword: password,
    });
    await evaluate('document.querySelector("form").requestSubmit()');
    await until(
      'location.pathname === "/dashboard" && !!document.querySelector(".workspace-details")',
      "registration",
    );
    assert.equal(
      await evaluate(
        'document.body.textContent.includes("Email verification is optional")',
      ),
      true,
    );
    await navigate("/verification-pending");
    await until('!!document.querySelector(".verification-panel button")', "optional verification settings");
    await evaluate('document.querySelector(".verification-panel button").click()');
    await until('!!document.querySelector(".account-success")', "optional verification request");
    const firstVerification = await emailLink("verify-email");
    await evaluate(
      'document.querySelector(".verification-panel button").click()',
    );
    await until('!!document.querySelector(".auth-alert")', "resend rate limit");
    const user = await db.user.findUniqueOrThrow({
      where: { email },
      select: { id: true, organizationId: true },
    });
    await db.accountToken.update({
      where: { userId_purpose: { userId: user.id, purpose: "VERIFY_EMAIL" } },
      data: { createdAt: new Date(Date.now() - 61000) },
    });
    await evaluate(
      'document.querySelector(".verification-panel button").click()',
    );
    await until(
      '!!document.querySelector(".account-success")',
      "confirmed resend",
    );
    const verification = await emailLink("verify-email");
    assert.equal(
      verification === firstVerification,
      false,
      "Resend must replace the old link.",
    );
    await navigate(verification);
    await until('!!document.querySelector("form button")', "verification form");
    assert.equal(await evaluate("location.hash"), "");
    await evaluate('document.querySelector("form").requestSubmit()');
    await until(
      'location.pathname === "/dashboard" && !!document.querySelector(".workspace-details")',
      "email verification signs in automatically",
    );
    checks.push(
      "Immediate registration, optional SMTP verification, resend, rate-limit UI and fragment scrubbing",
    );
    await navigate("/forgot-password");
    await fill({ email });
    await evaluate('document.querySelector("form").requestSubmit()');
    await until(
      '!!document.querySelector("input[name=code]")',
      "reset OTP form",
    );
    const code = await emailOtp();
    await fill({ code });
    await evaluate('document.querySelector("form").requestSubmit()');
    await until(
      '!!document.querySelector("input[name=password]")',
      "new password form",
    );
    await fill({ password: nextPassword, confirmPassword: nextPassword });
    await evaluate('document.querySelector("form").requestSubmit()');
    await until(
      '!!document.querySelector(".account-success")',
      "password reset",
    );
    assert.equal(
      await evaluate(
        '(async()=>{const response=await fetch("/api/auth/me");return response.status})()',
      ),
      401,
    );
    await navigate("/login");
    await fill({ email, password: nextPassword });
    await evaluate('document.querySelector("form").requestSubmit()');
    await until(
      'location.pathname === "/dashboard" && !!document.querySelector(".workspace-details")',
      "new-password login",
    );
    checks.push(
      "Password recovery, OTP reset, session revocation and new-password login",
    );
    const layouts = {};
    for (const route of [
      "/forgot-password",
      "/reset-password",
      "/verify-email",
      "/verification-pending",
      "/billing",
    ]) {
      await navigate(route);
      for (const width of [1440, 768, 390, 320]) {
        await command("Emulation.setDeviceMetricsOverride", {
          width,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: width < 540,
        });
        await pause(80);
        const dimensions = await evaluate(
          "({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})",
        );
        assert.ok(
          dimensions.scrollWidth <= dimensions.width,
          `${route} overflows at ${width}px`,
        );
        layouts[`${route}@${width}`] = true;
        if (process.env.UI_SCREENSHOT_DIR) {
          fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true });
          const shot = await command("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
          });
          fs.writeFileSync(
            path.join(
              process.env.UI_SCREENSHOT_DIR,
              `hrms-${route.slice(1)}-${width}.png`,
            ),
            Buffer.from(shot.data, "base64"),
          );
        }
      }
    }
    await navigate("/billing");
    await until('document.querySelectorAll(".billing-plan").length === 3', "billing catalog");
    const readiness = await fetch(`${frontend}/api/billing/plans`).then((r) => r.json());
    assert.equal(
      await evaluate(
        '[...document.querySelectorAll(".billing-plan button")].every(button=>button.disabled)',
      ),
      !readiness.providerAvailable,
    );
    await evaluate(
      'document.querySelectorAll(".billing-toggle button")[1].click()',
    );
    await pause(100);
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".billing-toggle button")[1].getAttribute("aria-pressed")',
      ),
      "true",
    );
    checks.push(
      "Billing respects provider readiness and yearly selection works without automatic checkout",
    );
    const cutoff = new Date(Date.now() - 1000);
    await db.organization.update({
      where: { id: user.organizationId },
      data: {
        trialStartedAt: new Date(cutoff.getTime() - 7 * 86400000),
        trialExpiresAt: cutoff,
      },
    });
    await navigate("/dashboard");
    await until(
      'location.pathname === "/subscription-required"',
      "expired-trial navigation",
    );
    await until(
      'document.querySelectorAll(".billing-plan").length === 3',
      "subscription page hydration",
    );
    await pause(500);
    const business = await evaluate(
      `(async()=>{const response=await fetch(${JSON.stringify(`${backend}/api/organization`)},{credentials:"include"});const body=await response.json();return {status:response.status,code:body.code}})()`,
    );
    assert.deepEqual(business, { status: 402, code: "TRIAL_EXPIRED" });
    assert.equal(
      await evaluate(
        '(async()=>{const response=await fetch("/api/billing/status");return response.status})()',
      ),
      200,
    );
    checks.push(
      "Expired trial blocks direct business API; billing stays available",
    );
    await evaluate(
      'document.querySelector(".dashboard-logout button").click()',
    );
    await until('location.pathname === "/login"', "logout");
    await navigate("/");
    await until(
      'document.querySelector(".backend-status p")?.textContent.includes("Connected")',
      "homepage health",
    );
    assert.equal(
      networkURLs.some((url) => /[?&]token=/.test(url)),
      false,
    );
    assert.deepEqual(exceptions, []);
    checks.push(
      "Logout, homepage health, no token query strings and no browser runtime exceptions",
    );
    console.log(
      JSON.stringify(
        {
          checks,
          responsiveChecks: Object.keys(layouts).length,
          realExternalEmail: false,
          realRazorpayTransaction: false,
        },
        null,
        2,
      ),
    );
  } finally {
    if (socket) socket.close();
    const owned = await db.organization.findMany({
      where: { name: organizationName, users: { some: { email } } },
      select: { id: true },
    });
    if (owned.length)
      await db.organization.deleteMany({
        where: {
          id: { in: owned.map((row) => row.id) },
          name: organizationName,
        },
      });
    await db.$disconnect();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

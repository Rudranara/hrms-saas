// Isolated headless Chrome on 9223. Mock recovery responses; never send real mail.
import assert from "node:assert/strict";

const origin = process.env.UI_TEST_ORIGIN || "http://localhost:3000";
const organization = process.argv.includes("--organization");
const ui = organization
  ? { form: ".organization-recovery-form", email: "#recovery-email", otp: "#reset-code", password: "#reset-password", resend: ".recovery-otp-resend", page: "/forgot-password", prefix: "/api/auth/" }
  : { form: ".platform-recovery-form", email: "#platform-recovery-email", otp: "#platform-reset-code", password: "#platform-reset-password", resend: ".platform-recovery-resend", page: "/super-admin/forgot-password", prefix: "/api/super-admin/auth/" };
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw new Error("Local browser checks only.");
const tabs = await fetch("http://localhost:9223/json/list").then((response) => response.json());
const socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
let sequence = 0;
const pending = new Map(), exceptions = [];
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const item = pending.get(message.id); pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
  } else if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
});
const evaluate = async (expression) => {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error("Recovery browser evaluation failed.");
  return result.result.value;
};
const until = async (expression, label) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
};
const submit = async (values) => {
  await until("(()=>{const form=window.__recoveryElement('form');return !!form && Object.keys(form).some(key=>key.startsWith('__reactProps$') && typeof form[key]?.onSubmit==='function');})()", "interactive recovery form");
  await evaluate(`(()=>{const form=window.__recoveryElement('form');for(const [name,value] of Object.entries(${JSON.stringify(values)}))form.elements[name].value=value;form.requestSubmit();})()`);
};
const changeEmail = () => evaluate("Array.from(window.__recoveryElement('form').querySelectorAll('button')).find(button=>button.textContent==='Change email').click()");
try {
  await command("Page.enable"); await command("Runtime.enable");
  await command("Page.addScriptToEvaluateOnNewDocument", { source: `
    (() => {
      const originalFetch = window.fetch.bind(window), originalNow = Date.now.bind(Date);
      const ui = ${JSON.stringify(ui)};
      window.__recoveryElement = name => document.querySelector(ui[name]);
      window.__recoveryTest = { offset: 0, requests: [] };
      Date.now = () => originalNow() + window.__recoveryTest.offset;
      window.fetch = async (input, options) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!url.startsWith(ui.prefix)) return originalFetch(input, options);
        const body = JSON.parse(options.body);
        window.__recoveryTest.requests.push({ url, body });
        return new Response(JSON.stringify({ success: true, valid: true,
          message: 'A new reset OTP was sent.', resendAvailableAt: new Date(Date.now() + 60000).toISOString()
        }), { status: url.endsWith('forgot-password') ? 202 : 200, headers: { 'Content-Type': 'application/json' } });
      };
    })();
  ` });
  await command("Page.navigate", { url: origin + ui.page });
  await submit({ email: "first@example.test" });
  await until("!!window.__recoveryElement('otp')", "OTP step");
  assert.equal(await evaluate("window.__recoveryElement('resend').disabled"), true);
  assert.match(await evaluate("window.__recoveryElement('resend').textContent"), /^Resend OTP in [01]:\d{2}$/);
  await changeEmail();
  await until("!!window.__recoveryElement('email') && !window.__recoveryElement('otp')", "change email returns to email entry");
  assert.equal(await evaluate("window.__recoveryElement('email').value"), "first@example.test");
  await submit({ email: "second@example.test" });
  await until("!!window.__recoveryElement('otp')", "OTP for replacement email");
  assert.equal(await evaluate("window.__recoveryElement('otp').value"), "");
  // Advance the browser clock; the backend separately tests the exact cooldown boundary.
  await evaluate("window.__recoveryTest.offset += 54000");
  await until("/Resend OTP in 0:0[1-6]/.test(window.__recoveryElement('resend').textContent)", "countdown ticks");
  assert.equal(await evaluate("window.__recoveryElement('resend').disabled"), true);
  await evaluate("window.__recoveryTest.offset += 7000");
  await until("!window.__recoveryElement('resend').disabled", "resend enabled after cooldown");
  await evaluate("window.__recoveryElement('otp').value='12345678';window.__recoveryElement('resend').click()");
  await until("window.__recoveryElement('resend').disabled && !!document.querySelector('[role=status]')", "resend resets cooldown without leaving OTP step");
  assert.equal(await evaluate("window.__recoveryElement('otp').value"), "");
  assert.deepEqual(await evaluate("window.__recoveryTest.requests.map(request=>request.body.email)"), ["first@example.test", "second@example.test", "second@example.test"]);
  assert.deepEqual(await evaluate("window.__recoveryTest.requests.map(request=>request.body.resend ?? false)"), [false, false, true], "Only the dedicated resend action requests a cooldown-limited resend");
  for (const width of [320, 390, 768, 1440]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `Recovery controls overflow at ${width}`);
  }
  await submit({ code: "12345678" });
  await until("!!window.__recoveryElement('password')", "password step remains available");
  await changeEmail();
  await until("!!window.__recoveryElement('email')", "change email from password step");
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ passed: true, account: organization ? "organization" : "platform", checks: ["visible disabled countdown", "timer enables resend", "resend uses the selected email", "resend resets timer and clears old code", "change email returns to editable email entry", "password step preserved", "four responsive widths", "no browser exceptions"], recoveryResponses: "mocked; delivery and cooldown verified by backend tests" }));
} finally { socket.close(); }

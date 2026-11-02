// Exercise the real registration UI with intercepted mail/API responses. No real signup or email.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const origin = "http://localhost:3000";
const tabs = await fetch("http://localhost:9223/json/list").then((response) => response.json());
const socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
let sequence = 0; const pending = new Map(), requests = [], exceptions = [];
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) { const item = pending.get(message.id); pending.delete(message.id); if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result); }
  else if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
  else if (message.method === "Fetch.requestPaused") {
    const { requestId, request } = message.params;
    const path = new URL(request.url).pathname;
    if (path === "/dashboard") { void command("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }], body: Buffer.from("<main>Verified registration destination</main>").toString("base64") }); return; }
    const body = JSON.parse(request.postData || "{}"); requests.push({ path, body });
    const valid = path !== "/api/auth/register/verify" || body.code === "123456";
    const result = path === "/api/auth/register" ? { success: true, verificationRequired: true, email: body.email, resendAfter: 60 } : valid ? { success: true } : { success: false, message: "The code is incorrect or expired." };
    void command("Fetch.fulfillRequest", { requestId, responseCode: valid ? path === "/api/auth/register" ? 202 : 201 : 400, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(result)).toString("base64") });
  }
});
const evaluate = async (expression) => { const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error("Browser evaluation failed"); return result.result.value; };
const until = async (expression) => { for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${expression}`); };
try {
  await command("Page.enable"); await command("Runtime.enable");
  await command("Fetch.enable", { patterns: [{ urlPattern: "*/api/auth/register*", requestStage: "Request" }, { urlPattern: "*/dashboard", requestStage: "Request" }] });
  await command("Page.navigate", { url: origin + "/register?next=" + encodeURIComponent("/billing?plan=growth-monthly&period=monthly") });
  await until("!!document.getElementById('auth-email')");
  const fill = async (email, phoneNumber = "98765 43210", employeeSize = "11-50") => evaluate(`(()=>{const form=document.querySelector('.auth-form');for(const [name,value] of Object.entries({organizationName:'UI fixture',employeeSize:${JSON.stringify(employeeSize)},fullName:'UI Administrator',phoneNumber:${JSON.stringify(phoneNumber)},email:${JSON.stringify(email)},password:'Fixture passphrase',confirmPassword:'Fixture passphrase'}))form.elements[name].value=value;form.requestSubmit();})()`);
  await until("(()=>{const form=document.querySelector('.auth-form');return Object.keys(form).some(key=>key.startsWith('__reactProps$')&&form[key]?.onSubmit)})()");
  await fill("first@example.test", "98765 43210", "");
  await until("document.querySelector('[name=employeeSize]').getAttribute('aria-invalid')==='true'");
  assert.equal(requests.length, 0, "Employee size must be selected before sending OTP");
  if (process.env.UI_TEST_SCREENSHOT) {
    await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    const clip = await evaluate("(()=>{const rect=document.querySelector('.auth-container').getBoundingClientRect();return {x:rect.left+scrollX,y:rect.top+scrollY,width:rect.width,height:rect.height,scale:1};})()");
    const shot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
    await writeFile(process.env.UI_TEST_SCREENSHOT, Buffer.from(shot.data, "base64"));
  }
  assert.equal(await evaluate("document.getElementById('auth-countryCode').textContent.includes('+91') && !!document.querySelector('#auth-countryCode svg')"), true);
  await evaluate("document.getElementById('auth-countryCode').click()");
  await until("!!document.querySelector('.auth-country-option svg')");
  for (const width of [320, 390, 768, 1440]) { await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 }); assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, `Country picker overflow at ${width}`); }
  await evaluate("document.querySelector('.auth-country-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await until("!document.querySelector('.auth-country-picker')");
  await fill("first@example.test", "123");
  await until("document.querySelector('[name=phoneNumber]').getAttribute('aria-invalid')==='true'");
  assert.equal(requests.length, 0, "Invalid phone must be rejected before sending OTP");
  await fill("first@example.test"); await until("!!document.getElementById('registration-code')");
  assert.equal(await evaluate("location.pathname"), "/register");
  assert.equal(await evaluate("document.querySelector('.auth-form').textContent.includes('first@example.test')"), true);
  assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes('Resend OTP')).disabled"), true);
  await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Change email').click()");
  await until("!!document.getElementById('auth-email')");
  await evaluate("document.getElementById('auth-countryCode').click()");
  await until("!!document.querySelector('.auth-country-search')");
  await evaluate("(()=>{const input=document.querySelector('.auth-country-search');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'United Kingdom');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until("document.querySelectorAll('.auth-country-option').length===1 && document.querySelector('.auth-country-option').textContent.includes('United Kingdom')");
  await evaluate("document.querySelector('.auth-country-option').click()");
  assert.equal(await evaluate("document.querySelector('[name=countryCode]').value"), "+44");
  await fill("second@example.test", "2079460958"); await until("!!document.getElementById('registration-code')");
  await evaluate("document.getElementById('registration-code').value='000000';document.querySelector('.auth-form').requestSubmit()");
  await until("document.querySelector('[role=alert]')?.textContent.includes('incorrect')");
  assert.equal(await evaluate("location.pathname"), "/register");
  for (const width of [320, 390, 768, 1440]) { await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 }); assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true); }
  await evaluate("document.getElementById('registration-code').value='123456';document.querySelector('.auth-form').requestSubmit()");
  await until("location.pathname==='/dashboard'");
  assert.equal(await evaluate("sessionStorage.getItem('hrms.billing.continuation')?.includes('growth-monthly')"), true);
  assert.equal(requests.filter((request) => request.path === "/api/auth/register").length, 2);
  assert.equal(requests.find((request) => request.path === "/api/auth/register").body.phoneNumber, "+919876543210");
  assert.equal("countryCode" in requests.find((request) => request.path === "/api/auth/register").body, false);
  assert.equal(requests.find((request) => request.path === "/api/auth/register").body.employeeSize, "11-50");
  assert.equal(requests.filter((request) => request.path === "/api/auth/register")[1].body.phoneNumber, "+442079460958");
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ passed: true, checks: ["inline OTP after signup", "no dashboard before verification", "submitted email shown", "resend initially disabled", "change email", "wrong code error", "correct code continues", "paid intent retained", "four responsive widths"] }));
} finally { socket.close(); }

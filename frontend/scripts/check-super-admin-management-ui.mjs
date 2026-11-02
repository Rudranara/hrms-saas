// Local, isolated browser fixtures only. No mail or real operator changes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
requireBackend("dotenv").config({ path: new URL("../../backend/.env", import.meta.url), quiet: true });
if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
const origin = process.env.UI_TEST_ORIGIN || "http://localhost:3000";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw new Error("Local browser checks only.");
const { PrismaClient } = requireBackend("@prisma/client"), { hashPassword } = requireBackend("./dist/auth/password.js");
const db = new PrismaClient(), run = randomUUID(), password = `Management browser ${randomUUID()}`;
const email = `manager-${run}@example.test`, nextEmail = `created-${run}@example.test`, fullName = `New operator ${run}`;
let actorId, socket;
try {
  actorId = (await db.superAdmin.create({ data: { fullName: "Management browser fixture", email, passwordHash: await hashPassword(password) } })).id;
  const tabs = await fetch("http://localhost:9223/json/list").then((response) => response.json());
  socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let sequence = 0; const pending = new Map(), exceptions = [];
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (message.id) { const item = pending.get(message.id); pending.delete(message.id); if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result); } else if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text); });
  const evaluate = async (expression) => { const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error("Management browser evaluation failed"); return result.result.value; };
  const until = async (expression, label) => { for (let attempt = 0; attempt < 300; attempt++) { if (await evaluate(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${label}`); };
  const submit = async (values) => {
    await until("(()=>{const form=document.querySelector('#platform-add-admin');return !!form && Object.keys(form).some(key=>key.startsWith('__reactProps$') && typeof form[key]?.onSubmit==='function');})()", "interactive creation form");
    await evaluate(`(()=>{const form=document.querySelector('#platform-add-admin');for(const [name,value] of Object.entries(${JSON.stringify(values)}))form.elements[name].value=value;form.requestSubmit();})()`);
  };
  const login = async (address) => {
    const response = await fetch(origin + "/api/super-admin/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify({ email: address, password }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("hrms_platform_session=")); assert.ok(cookie);
    await command("Network.setCookie", { name: "hrms_platform_session", value: cookie.split(";")[0].slice("hrms_platform_session=".length), url: origin, httpOnly: true, sameSite: "Lax" });
    await command("Page.navigate", { url: origin + "/super-admin" });
    await until("!!document.querySelector('#platform-metrics')", "platform overview");
    assert.equal(await evaluate("!!document.querySelector('.platform-admins')"), false, "Management is not embedded in the dashboard");
    await evaluate("document.querySelector('header a[href=\"/super-admin/admins\"]').click()");
    await until("!!document.querySelector('.platform-admin-table tbody tr')", "super-admin directory");
    assert.equal(await evaluate("location.pathname"), "/super-admin/admins");
  };
  await command("Page.enable"); await command("Runtime.enable"); await command("Network.enable");
  await command("Page.navigate", { url: origin + "/super-admin/admins" });
  await until("location.pathname==='/super-admin/login'", "management page requires platform login");
  assert.equal(await evaluate("new URLSearchParams(location.search).get('next')"), "/super-admin/admins");
  await login(email);
  await until("(()=>{const button=document.querySelector('.platform-admins .platform-section-heading button');return !!button && Object.keys(button).some(key=>key.startsWith('__reactProps$') && typeof button[key]?.onClick==='function');})()", "interactive add button");
  await evaluate("document.querySelector('.platform-admins .platform-section-heading button').click()");
  await submit({ fullName, email: nextEmail, password, confirmPassword: "different fixture password" });
  await until("document.querySelector('.platform-admins [role=alert]')?.textContent.includes('Passwords do not match')", "password mismatch");
  assert.equal(await db.superAdmin.count({ where: { email: nextEmail } }), 0);
  for (const width of [320, 390, 768, 1440]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `Management form overflow at ${width}`);
  }
  await submit({ fullName, email: nextEmail, password, confirmPassword: password });
  await until("!!document.querySelector('.platform-admins [role=status]') && !document.querySelector('#platform-add-admin')", "creation success");
  await until(`document.querySelector('.platform-admin-table').textContent.includes(${JSON.stringify(nextEmail)})`, "new admin appears in directory");
  assert.equal(await db.superAdmin.count({ where: { email: nextEmail } }), 1);
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.platform-admins button')).filter(button=>/edit|delete/i.test(button.textContent)).map(button=>button.textContent)"), []);
  await evaluate("document.querySelector('.platform-admins .platform-section-heading button').click()");
  await submit({ fullName: "Overwrite attempt", email: nextEmail, password, confirmPassword: password });
  await until("document.querySelector('.platform-admins [role=alert]')?.textContent.includes('already uses')", "duplicate rejected");
  assert.equal((await db.superAdmin.findUniqueOrThrow({ where: { email: nextEmail } })).fullName, fullName);
  await login(nextEmail);
  assert.equal(await evaluate("document.querySelector('.platform-admins .platform-section-heading button').textContent"), "Add super admin");
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ passed: true, checks: ["dedicated protected management page", "dashboard has navigation link only", "safe login continuation", "real authenticated proxy", "password mismatch", "four responsive widths", "real account creation", "directory refresh", "duplicate rejected", "no edit/delete controls", "new super admin signs in", "no browser exceptions"] }));
} finally {
  if (socket) socket.close();
  const admins = await db.superAdmin.findMany({ where: { email: { in: [email, nextEmail] } }, select: { id: true } });
  const ids = admins.map((admin) => admin.id);
  if (actorId && !ids.includes(actorId)) ids.push(actorId);
  if (ids.length) {
    await db.superAdminAuditEvent.deleteMany({ where: { actorSuperAdminId: { in: ids } } });
    await db.superAdmin.deleteMany({ where: { id: { in: ids } } });
  }
  await db.$disconnect();
}

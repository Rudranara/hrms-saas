// Local browser regression for client-side marketing-page scroll restoration.
import assert from "node:assert/strict";

const origin = process.env.UI_TEST_ORIGIN || "http://localhost:3000";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabs = await fetch("http://127.0.0.1:9223/json/list").then((response) => response.json());
const tab = tabs.find((item) => item.type === "page");
assert.ok(tab, "Open Chrome with remote debugging on port 9223 first.");

const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const item = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) item.reject(new Error(message.error.message));
  else item.resolve(message.result);
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const waitFor = async (expression, label) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(expression)) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
};
const navigate = async (path) => {
  await command("Page.navigate", { url: origin + path });
  await waitFor("document.readyState === 'complete'", "initial page load");
};
const click = async (selector) => {
  const result = await evaluate(`(() => { const link = document.querySelector(${JSON.stringify(selector)}); if (!link) return false; link.click(); return true; })()`);
  assert.equal(result, true, `Missing link: ${selector}`);
};

try {
  await command("Page.enable");
  await command("Runtime.enable");
  await navigate("/");
  await waitFor("document.documentElement.scrollHeight > innerHeight + 500", "home content");
  await pause(750);
  await evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
  await pause(50);
  const homePosition = await evaluate("({ scrollY, height: document.documentElement.scrollHeight, viewport: innerHeight })");
  assert.ok(homePosition.scrollY > 500, `Home page should be scrolled before the route change: ${JSON.stringify(homePosition)}`);
  await click('a[href="/pricing"]');
  await waitFor("location.pathname === '/pricing'", "pricing navigation");
  await waitFor("document.documentElement.scrollHeight > innerHeight + 500", "pricing content");
  await waitFor("scrollY === 0", "pricing reset to top");

  await evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
  assert.ok(await evaluate("scrollY > 500"), "Pricing page should be scrolled before the route change.");
  await click('a.brand[href="/"]');
  await waitFor("location.pathname === '/'", "home navigation");
  await waitFor("scrollY === 0", "home reset to top");
  console.log(JSON.stringify({ passed: true, homeAndPricingStartAtTopAfterClientNavigation: true }));
} finally {
  socket.close();
}

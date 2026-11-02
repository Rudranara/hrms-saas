// Dedicated local servers and fixture DB; never point browser tests at customer data.
import { readFileSync, mkdtempSync, rmSync, cpSync, existsSync, symlinkSync, unlinkSync } from "node:fs";
import { resolve, join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const backend = join(root, "backend"), frontend = join(root, "frontend");
const require = createRequire(join(backend, "package.json"));
const config = require("dotenv").parse(readFileSync(join(backend, ".env")));
const fixture = JSON.parse(readFileSync(join(root, "artifacts/billing-audit-database.json"))).database;
const database = new URL(config.DATABASE_URL);
if (!/^hrms_billing_audit_[a-f0-9]{12}$/.test(fixture) || !["localhost", "127.0.0.1"].includes(database.hostname)) throw Error("Isolated local fixture DB required");
database.pathname = `/${fixture}`;
const origin = "http://localhost:3001", api = "http://localhost:4001", debug = 9407;
const env = { ...process.env, ...config, DATABASE_URL: database.toString(), NODE_ENV: "development", PORT: "4001", FRONTEND_URL: origin, APP_ORIGIN: origin, NEXT_PUBLIC_API_URL: api, UI_TEST_ORIGIN: origin, UI_TEST_DEBUG_PORT: String(debug), NODE_OPTIONS: `--require=${join(backend, "test/block-provider-network.cjs")}` };
delete env.BILLING_RECONCILE_INTERVAL_MS;
const children = [], output = new Map();
function start(binary, args, cwd) {
  const child = spawn(binary, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); output.set(child, "");
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => output.set(child, (output.get(child) + data.toString()).slice(-12000)));
  return child;
}
async function ready(url, child) {
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null) throw Error(`Fixture server exited: ${output.get(child)}`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error(`Fixture server did not start: ${url}`);
}
const profile = mkdtempSync(join(tmpdir(), "hrms-refund-browser-"));
const webFixture = mkdtempSync(join(root, "artifacts/refund-web-"));
try {
  // A separate frontend directory avoids the project's existing Next dev lock.
  for (const item of ["app", "public", "package.json", "package-lock.json", "tsconfig.json", "next-env.d.ts", "next.config.ts", "postcss.config.mjs"]) {
    if (existsSync(join(frontend, item))) cpSync(join(frontend, item), join(webFixture, item), { recursive: true });
  }
  symlinkSync(join(frontend, "node_modules"), join(webFixture, "node_modules"), "junction");
  const server = start(process.execPath, ["dist/app.js"], backend); await ready(api + "/api/health", server);
  const web = start(process.execPath, [join(frontend, "node_modules/next/dist/bin/next"), "dev", "--webpack", "-p", "3001"], webFixture); await ready(origin, web);
  const chrome = start("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--no-sandbox", "--disable-gpu-sandbox", "--disable-gpu", "--disable-software-rasterizer", "--no-first-run", "--disable-background-networking", `--remote-debugging-port=${debug}`, `--user-data-dir=${profile}`, "about:blank"], frontend);
  await ready(`http://localhost:${debug}/json/version`, chrome);
  const tests = start(process.execPath, ["scripts/check-refunds-ui.mjs"], frontend);
  const status = await new Promise(resolve => tests.once("exit", resolve));
  console.log(output.get(tests));
  if (status !== 0) throw Error(`Isolated refund browser workflow failed. Browser diagnostics: ${output.get(chrome)}`);
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.pid) {
      try { if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); else child.kill("SIGTERM"); } catch {}
      // The managed Windows token can deny taskkill's process lookup while the
      // handle returned by spawn still permits terminating our own child.
      child.kill("SIGTERM");
    }
    child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
  }
  const absolute = resolve(profile), temporary = resolve(tmpdir()) + sep;
  if (absolute.startsWith(temporary) && absolute.includes("hrms-refund-browser-")) {
    try { rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { console.warn("Temporary browser cache retained by Windows; test browser has been stopped."); }
  }
  if (resolve(webFixture).startsWith(resolve(root, "artifacts") + sep) && dirname(webFixture) === join(root, "artifacts")) {
    try { unlinkSync(join(webFixture, "node_modules")); rmSync(webFixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { console.warn("Temporary frontend files retained; test servers have been stopped."); }
  }
}

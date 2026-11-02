import assert from "node:assert/strict";
import { it } from "node:test";
import { spawnSync } from "node:child_process";
import { startBillingReconciler } from "../src/billing/reconciler";
import type { PrismaClient } from "@prisma/client";
import type { BillingService } from "../src/billing/service";

it("drains an in-flight request and recovery, disconnects once and exits normally after repeated signals", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const {createServer}=require('node:http'); const {installShutdown}=require('./src/shutdown.ts');
    let stopped=0,disconnected=0;
    const server=createServer((req,res)=>setTimeout(()=>{res.end('done'); console.log('request-finished')},80));
    server.listen(0,'127.0.0.1',async()=>{
      installShutdown(server,async()=>{stopped++;await new Promise(r=>setTimeout(r,110));console.log('recovery-finished')},async()=>{disconnected++; console.log('disconnected:'+stopped+':'+disconnected)},2000);
      const request=fetch('http://127.0.0.1:'+server.address().port).then(r=>r.text());
      setTimeout(()=>{process.emit('SIGTERM');process.emit('SIGINT')},30);
      await request;
    });
  `], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stdout + child.stderr); assert.match(child.stdout, /request-finished/); assert.match(child.stdout, /recovery-finished/); assert.match(child.stdout, /disconnected:1:1/);
  assert.ok(child.stdout.indexOf("disconnected:") > child.stdout.indexOf("recovery-finished"));
});
it("forces a bounded exit if recovery never drains", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const {createServer}=require('node:http');const {installShutdown}=require('./src/shutdown.ts');
    const server=createServer();server.listen(0,'127.0.0.1',()=>{installShutdown(server,()=>new Promise(()=>{}),async()=>{},100);process.emit('SIGTERM')});
  `], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 1, child.stderr);
});
it("stops new recovery batches and waits for the running subscription before draining", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  let release!: () => void, entered!: () => void, calls = 0;
  const running = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const db = { billingReplacement: { findMany: async () => [] }, subscription: { findMany: async () => [{ id: "first" }, { id: "second" }] } } as unknown as PrismaClient;
  const service = { provider: { available: true }, reconcile: async () => { calls++; entered(); await running; } } as unknown as BillingService;
  const stop = startBillingReconciler(db, service, 60000); context.mock.timers.tick(60000); await started;
  let drained = false; const drain = stop().then(() => { drained = true; });
  context.mock.timers.tick(600000); assert.equal(drained, false); assert.equal(calls, 1);
  release(); await drain; assert.equal(drained, true); assert.equal(calls, 1);
});

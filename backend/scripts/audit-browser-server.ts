import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { createApp } from "../src/server";
import { RazorpayProvider } from "../src/billing/provider";
import { installShutdown } from "../src/shutdown";

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  const name = JSON.parse(readFileSync("../artifacts/billing-audit-database.json", "utf8")).database;
  if (!/^hrms_billing_audit_[a-f0-9]{12}$/.test(name) || !["localhost", "127.0.0.1"].includes(url.hostname) || process.env.NODE_ENV === "production") throw new Error("Isolated local fixtures only.");
  url.pathname = `/${name}`;
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  const plans = JSON.parse(readFileSync("config/billing-plans.json", "utf8"));
  for (const plan of plans) await db.billingPlan.upsert({ where: { id: plan.id }, create: { ...plan, providerPlanId: `plan_fixture_${plan.id.replaceAll("-", "_")}` }, update: {} });
  // No payment operation can reach Razorpay; the browser runner intercepts checkout.
  const provider = new RazorpayProvider({ RAZORPAY_MODE: "test", RAZORPAY_KEY_ID: "rzp_test_fixture", RAZORPAY_KEY_SECRET: "fixture", RAZORPAY_WEBHOOK_SECRET: "fixture" });
  const app = createApp(db, { frontendOrigin: "http://localhost:3101", production: false }, { provider });
  const server = app.listen(4000, "127.0.0.1", () => console.log("Isolated browser API ready on 4000; real provider network is blocked."));
  installShutdown(server, () => Promise.resolve(), () => db.$disconnect());
}
main().catch(() => { console.error("Isolated browser API startup failed."); process.exitCode = 1; });

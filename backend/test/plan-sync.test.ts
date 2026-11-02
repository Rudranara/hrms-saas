import "dotenv/config";
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { planConfiguration, syncPlans } from "../src/billing/plan-sync";
import { RazorpayProvider, type RemotePlan } from "../src/billing/provider";
import { BillingService } from "../src/billing/service";
import { ServiceError } from "../src/services/errors";
import { billingTaxNote } from "../src/billing/tax";
if (process.env.NODE_ENV === "production")
  throw new Error("Do not run fixtures in production.");
const db = new PrismaClient(),
  run = randomUUID().replaceAll("-", "");
const ids: string[] = [],
  references: string[] = [];
let sequence = 0;
function definition() {
  const plan = {
    id: `sync-${run}-${++sequence}`,
    name: "Sync fixture",
    interval: "MONTHLY" as const,
    amountMinor: 99900,
    currency: "INR",
    providerPlanId: null as string | null,
    totalCount: 12,
    enabled: true,
  };
  ids.push(plan.id);
  return plan;
}
class PlanFixture {
  apiAvailable = true;
  keyId = `rzp_test_${run}`;
  mode = "test" as const;
  created = 0;
  timeout = false;
  rows = new Map<string, RemotePlan>();
  async fetchPlan(id: string) {
    const plan = this.rows.get(id);
    assert.ok(plan);
    return structuredClone(plan);
  }
  async findPlan(reference: string) {
    return structuredClone(
      [...this.rows.values()].find(
        (p) =>
          !Array.isArray(p.notes) && p.notes?.hrmsPlanReference === reference,
      ) || null,
    );
  }
  async createPlan(
    plan: {
      name: string;
      amountMinor: number;
      currency: string;
      interval: "MONTHLY" | "YEARLY";
    },
    reference: string,
  ) {
    references.push(reference);
    this.created++;
    const row: RemotePlan = {
      id: `plan_${run}${sequence}${this.created}`,
      period: plan.interval.toLowerCase() as "monthly" | "yearly",
      interval: 1,
      item: { amount: plan.amountMinor, currency: plan.currency },
      notes: { hrmsPlanReference: reference },
    };
    this.rows.set(row.id, row);
    if (this.timeout)
      throw new ServiceError(
        "PROVIDER_UNAVAILABLE",
        503,
        "Fixture timeout after remote creation.",
      );
    return structuredClone(row);
  }
}
after(async () => {
  await db.providerPlanProvisioning.deleteMany({
    where: { reference: { in: references } },
  });
  await db.billingPlan.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
it("configures all six exact introductory INR amounts in integer paise", async () => {
  const plans = planConfiguration.parse(
    JSON.parse(await readFile("config/billing-plans.json", "utf8")),
  );
  assert.deepEqual(
    plans.map((p) => [p.id, p.amountMinor, p.interval, p.currency]),
    [
      ["essentials-monthly", 99900, "MONTHLY", "INR"],
      ["essentials-yearly", 999000, "YEARLY", "INR"],
      ["growth-monthly", 199900, "MONTHLY", "INR"],
      ["growth-yearly", 1999000, "YEARLY", "INR"],
      ["organization-monthly", 399900, "MONTHLY", "INR"],
      ["organization-yearly", 3999000, "YEARLY", "INR"],
    ],
  );
  assert.equal(
    planConfiguration.safeParse([{ ...plans[0], amountMinor: 999.5 }]).success,
    false,
  );
});
it("publishes prices without Razorpay keys and keeps checkout disabled", async () => {
  const plan = definition(),
    provider = new RazorpayProvider({});
  assert.equal(
    (await syncPlans(db, [plan], provider, false)).providerPending,
    true,
  );
  const billing = new BillingService(db, provider, () => new Date());
  const published = (await billing.plans()).find((p) => p.id === plan.id)!;
  assert.equal(published.amountMinor, 99900);
  assert.equal(published.configured, false);
  assert.match(published.taxNote, /No additional taxes/);
  await assert.rejects(
    billing.checkout("not-a-tenant", plan.id),
    (e: unknown) =>
      e instanceof ServiceError && e.code === "BILLING_UNAVAILABLE",
  );
});
it("explains the missing webhook secret while preserving prices with valid API configuration", async () => {
  const plan = definition();
  await db.billingPlan.create({
    data: { ...plan, providerPlanId: `plan_${run}ready` },
  });
  const provider = new RazorpayProvider({
    RAZORPAY_MODE: "test",
    RAZORPAY_KEY_ID: `rzp_test_${run}`,
    RAZORPAY_KEY_SECRET: "fixture-secret",
  });
  const billing = new BillingService(db, provider, () => new Date());
  const entry = (await billing.plans()).find((p) => p.id === plan.id)!;
  assert.equal(entry.amountMinor, 99900);
  assert.equal(entry.configured, false);
  assert.match(entry.unavailableReason!, /RAZORPAY_WEBHOOK_SECRET/);
  assert.equal(billing.checkoutReadiness().ready, false);
  assert.equal(
    billing.checkoutReadiness().message.includes("fixture-secret"),
    false,
  );
});
it("fails sync with the exact mode mismatch instead of reporting missing setup", async (context) => {
  const plan = definition();
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("Must not call live provider");
  });
  const provider = new RazorpayProvider({
    RAZORPAY_MODE: "test",
    RAZORPAY_KEY_ID: "rzp_live_fixture",
    RAZORPAY_KEY_SECRET: "fixture-secret",
  });
  await assert.rejects(
    syncPlans(db, [plan], provider, false),
    (e: unknown) =>
      e instanceof ServiceError && e.code === "RAZORPAY_MODE_KEY_MISMATCH",
  );
  assert.equal(requests, 0);
  assert.equal(
    (await db.billingPlan.findUniqueOrThrow({ where: { id: plan.id } }))
      .amountMinor,
    plan.amountMinor,
  );
});
it("propagates HTTP 401 as authentication failure without creating a plan or checkpoint", async (context) => {
  const plan = definition();
  let posts = 0;
  context.mock.method(
    globalThis,
    "fetch",
    async (_input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") posts++;
      return Response.json(
        { error: { description: "private response" } },
        { status: 401 },
      );
    },
  );
  const provider = new RazorpayProvider({
    RAZORPAY_MODE: "test",
    RAZORPAY_KEY_ID: `rzp_test_${run}`,
    RAZORPAY_KEY_SECRET: "fixture-secret",
  });
  await assert.rejects(
    syncPlans(db, [plan], provider, false),
    (e: unknown) =>
      e instanceof ServiceError &&
      e.code === "PROVIDER_AUTHENTICATION_FAILED" &&
      !e.message.includes("private response"),
  );
  assert.equal(posts, 0);
  assert.equal(
    (await db.billingPlan.findUniqueOrThrow({ where: { id: plan.id } }))
      .providerPlanId,
    null,
  );
});
it("reuses persisted provider IDs across repeated syncs without duplicate creation", async () => {
  const plan = definition(),
    provider = new PlanFixture();
  await syncPlans(db, [plan], provider, false);
  const first = await db.billingPlan.findUniqueOrThrow({
    where: { id: plan.id },
  });
  await syncPlans(db, [plan], provider, false);
  const second = await db.billingPlan.findUniqueOrThrow({
    where: { id: plan.id },
  });
  assert.equal(first.providerPlanId, second.providerPlanId);
  assert.equal(provider.created, 1);
});
it("uses an explicitly supplied matching provider plan without creating one", async () => {
  const plan = definition(),
    provider = new PlanFixture();
  plan.providerPlanId = `plan_${run}existing`;
  provider.rows.set(plan.providerPlanId, {
    id: plan.providerPlanId,
    period: "monthly",
    interval: 1,
    item: { amount: plan.amountMinor, currency: "INR" },
  });
  const ref = createHash("sha256")
    .update(
      JSON.stringify([
        provider.mode,
        provider.keyId,
        plan.id,
        plan.amountMinor,
        plan.currency,
        plan.interval,
      ]),
    )
    .digest("hex");
  references.push(ref);
  await syncPlans(db, [plan], provider, false);
  assert.equal(provider.created, 0);
});
it("discovers a provider plan after ambiguous creation without sending another POST", async () => {
  const plan = definition(),
    provider = new PlanFixture();
  provider.timeout = true;
  await assert.rejects(syncPlans(db, [plan], provider, false));
  provider.timeout = false;
  await syncPlans(db, [plan], provider, false);
  assert.equal(provider.created, 1);
  assert.ok(
    (await db.billingPlan.findUniqueOrThrow({ where: { id: plan.id } }))
      .providerPlanId,
  );
});
it("blocks blind retry when an unresolved plan cannot be discovered", async () => {
  const plan = definition(),
    provider = new PlanFixture();
  provider.timeout = true;
  await assert.rejects(syncPlans(db, [plan], provider, false));
  provider.rows.clear();
  provider.timeout = false;
  await assert.rejects(
    syncPlans(db, [plan], provider, false),
    (e: unknown) =>
      e instanceof ServiceError && e.code === "PLAN_RECONCILIATION_REQUIRED",
  );
  assert.equal(provider.created, 1);
});
it("rejects mismatched configured provider amounts", async () => {
  const plan = definition(),
    provider = new PlanFixture();
  plan.providerPlanId = `plan_${run}mismatch`;
  provider.rows.set(plan.providerPlanId, {
    id: plan.providerPlanId,
    period: "monthly",
    interval: 1,
    item: { amount: plan.amountMinor + 1, currency: "INR" },
  });
  await assert.rejects(
    syncPlans(db, [plan], provider, false),
    (e: unknown) =>
      e instanceof ServiceError && e.code === "PLAN_CONFIGURATION_MISMATCH",
  );
  assert.equal(provider.created, 0);
});
it("makes final-charge tax disclosure configurable without hidden additions", () => {
  assert.match(billingTaxNote({}), /include GST/);
  assert.match(
    billingTaxNote({ BILLING_TAX_TREATMENT: "not_applicable" }),
    /not applicable/,
  );
  assert.throws(() => billingTaxNote({ BILLING_TAX_TREATMENT: "exclusive" }));
});
it("provisions and reconciles all six plan intervals without duplicates", async () => {
  const input = planConfiguration.parse(
    JSON.parse(await readFile("config/billing-plans.json", "utf8")),
  );
  const plans = input.map((source) => ({
    ...definition(),
    name: source.name,
    interval: source.interval,
    amountMinor: source.amountMinor,
  }));
  const provider = new PlanFixture();
  await syncPlans(db, plans, provider, false);
  await syncPlans(db, plans, provider, false);
  assert.equal(provider.created, 6);
  assert.deepEqual(
    [...provider.rows.values()].map((p) => [p.period, p.item.amount]),
    input.map((p) => [p.interval.toLowerCase(), p.amountMinor]),
  );
});
it("does not create duplicate provider plans from simultaneous synchronizations", async () => {
  const plan = definition(),
    provider = new PlanFixture();
  const results = await Promise.allSettled([
    syncPlans(db, [plan], provider, false),
    syncPlans(db, [plan], provider, false),
  ]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.equal(provider.created, 1);
  await syncPlans(db, [plan], provider, false);
  assert.equal(provider.created, 1);
});
it("reuses the stored provider plan after API key rotation within the same account", async () => {
  const plan = definition(),
    provider = new PlanFixture();
  await syncPlans(db, [plan], provider, false);
  provider.keyId += "rotated";
  await syncPlans(db, [plan], provider, false);
  assert.equal(provider.created, 1);
});

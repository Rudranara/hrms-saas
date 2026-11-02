import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { syncPlans, planConfiguration } from "../src/billing/plan-sync";
import { RazorpayProvider } from "../src/billing/provider";
import { ServiceError } from "../src/services/errors";
const db = new PrismaClient();
(async () => {
  const input = JSON.parse(
    await readFile(
      path.resolve(
        process.env.BILLING_PLANS_FILE || "config/billing-plans.json",
      ),
      "utf8",
    ),
  );
  const validated = planConfiguration.safeParse(input);
  if (!validated.success)
    throw new ServiceError(
      "PLAN_CONFIGURATION_INVALID",
      503,
      "Billing plan configuration is invalid. Check IDs, intervals, positive integer amounts, currency and duplicate IDs; configuration values have not been logged.",
    );
  const provider = new RazorpayProvider();
  const result = await syncPlans(db, validated.data, provider);
  console.log(
    `Synchronized ${result.count} local prices. ${result.providerPending ? "RAZORPAY_CREDENTIALS_MISSING: Set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env or the process environment. Prices remain visible; no provider synchronization was attempted." : `Razorpay API confirmed plan reconciliation. ${provider.available ? "Webhook secret is configured; verify webhook delivery before using checkout." : "Checkout remains unavailable until RAZORPAY_WEBHOOK_SECRET is configured."}`}`,
  );
})()
  .catch((error) => {
    console.error(
      error instanceof ServiceError
        ? `${error.code}: ${error.message}`
        : "Plan synchronization failed. Check configuration, migration status and database; no payment was initiated.",
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

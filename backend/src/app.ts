import "dotenv/config";
import { prisma } from "./config/prisma";
import { configuration, createApp } from "./server";
import { createServices } from "./services";
import { reconciliationInterval, startBillingReconciler } from "./billing/reconciler";
import { installShutdown } from "./shutdown";
const PORT = Number(process.env.PORT) || 4000;
async function startServer() {
  try {
    if (!process.env.DATABASE_URL)
      throw new Error("Missing DATABASE_URL configuration.");
    const app = createApp(prisma, configuration());
    await prisma.$connect();
    const stopRecovery = process.env.NODE_ENV === "production" || process.env.BILLING_RECONCILE_INTERVAL_MS !== undefined
      ? startBillingReconciler(prisma, createServices(prisma, configuration().frontendOrigin).billing, reconciliationInterval(process.env.BILLING_RECONCILE_INTERVAL_MS))
      : () => Promise.resolve();
    const server = app.listen(PORT);
    installShutdown(server, stopRecovery, () => prisma.$disconnect());
    server.on("listening", () => {
      console.log(`HRMS API running at http://localhost:${PORT}`);
    });
    server.on("error", () => {
      console.error(
        "HRMS API could not listen on the configured port. Check for an existing backend process.",
      );
      void prisma.$disconnect().finally(() => process.exit(1));
    });
  } catch {
    console.error(
      "Failed to start HRMS API. Check database connectivity and DATABASE_URL / FRONTEND_URL configuration.",
    );
    process.exit(1);
  }
}

startServer();

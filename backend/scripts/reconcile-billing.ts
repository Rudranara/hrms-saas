import "dotenv/config";
import { prisma } from "../src/config/prisma";
import { configuration } from "../src/server";
import { createServices } from "../src/services";
import { reconcileDue } from "../src/billing/reconciler";
const services = createServices(prisma, configuration().frontendOrigin);
void reconcileDue(prisma, services.billing).then((result) => console.log(JSON.stringify(result))).catch(() => { console.error("Billing recovery failed; no payment was initiated."); process.exitCode = 1; }).finally(() => prisma.$disconnect());

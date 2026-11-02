import type { PrismaClient } from "@prisma/client";
import { AccountRecovery } from "../auth/recovery";
import { BillingService } from "../billing/service";
import { AccessPolicy } from "../billing/access";
import { RazorpayProvider, type PaymentProvider } from "../billing/provider";
import { smtpMailer, type Mailer } from "./mail";
import { systemClock, type Clock } from "./errors";
export type ServiceOverrides = {
  clock?: Clock;
  mailer?: Mailer;
  provider?: PaymentProvider;
  graceHours?: number;
};
export function createServices(
  db: PrismaClient,
  origin: string,
  overrides: ServiceOverrides = {},
) {
  const clock = overrides.clock ?? systemClock;
  return {
    clock,
    recovery: new AccountRecovery(
      db,
      overrides.mailer ?? smtpMailer(),
      origin,
      clock,
    ),
    billing: new BillingService(
      db,
      overrides.provider ?? new RazorpayProvider(),
      clock,
    ),
    access: new AccessPolicy(db, clock, overrides.graceHours),
  };
}
export type Services = ReturnType<typeof createServices>;

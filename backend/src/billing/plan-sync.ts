import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { RazorpayProvider, RemotePlan } from "./provider";
import { ServiceError } from "../services/errors";
import { definiteProviderRejection } from "./provider";

export const planConfiguration = z
  .array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9-]{1,80}$/),
      name: z.string().min(1).max(80),
      interval: z.enum(["MONTHLY", "YEARLY"]),
      amountMinor: z.number().int().positive().max(2147483647).nullable(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      providerPlanId: z
        .string()
        .regex(/^plan_[A-Za-z0-9]+$/)
        .max(100)
        .nullable(),
      totalCount: z.number().int().positive().max(120),
      enabled: z.boolean(),
    }),
  )
  .min(1)
  .superRefine((plans, ctx) => {
    if (new Set(plans.map((p) => p.id)).size !== plans.length)
      ctx.addIssue({ code: "custom", message: "Duplicate plan IDs." });
  });
type Definition = z.infer<typeof planConfiguration>[number];
type PlanProvider = Pick<
  RazorpayProvider,
  "apiAvailable" | "keyId" | "mode" | "fetchPlan" | "findPlan" | "createPlan"
> & { apiConfigurationError?: ServiceError | null };
function assertMatch(local: Definition, remote: RemotePlan) {
  if (
    remote.item.amount !== local.amountMinor ||
    remote.item.currency !== local.currency ||
    remote.interval !== 1 ||
    remote.period !== local.interval.toLowerCase()
  )
    throw new ServiceError(
      "PLAN_CONFIGURATION_MISMATCH",
      503,
      `Provider plan does not match ${local.id}. Existing subscriptions are unchanged.`,
    );
}
export async function syncPlans(
  db: PrismaClient,
  input: unknown,
  provider: PlanProvider,
  disableAbsent = true,
) {
  const definitions = planConfiguration.parse(input);
  // Publish local prices independently of credentials; retain provider mappings
  // only while their immutable price/currency/interval still match.
  await db.$transaction(async (tx) => {
    for (const plan of definitions) {
      const old = await tx.billingPlan.findUnique({ where: { id: plan.id } });
      const unchanged =
        old &&
        old.amountMinor === plan.amountMinor &&
        old.currency === plan.currency &&
        old.interval === plan.interval;
      await tx.billingPlan.upsert({
        where: { id: plan.id },
        create: { ...plan, providerPlanId: null },
        update: {
          ...plan,
          providerPlanId:
            unchanged &&
            (!plan.providerPlanId || plan.providerPlanId === old.providerPlanId)
              ? old.providerPlanId
              : null,
        },
      });
    }
    if (disableAbsent)
      await tx.billingPlan.updateMany({
        where: { id: { notIn: definitions.map((p) => p.id) } },
        data: { enabled: false },
      });
  });
  if (!provider.apiAvailable) {
    if (
      provider.apiConfigurationError &&
      provider.apiConfigurationError.code !== "RAZORPAY_CREDENTIALS_MISSING"
    )
      throw provider.apiConfigurationError;
    return { count: definitions.length, providerPending: true };
  }
  for (const plan of definitions.filter(
    (p) => p.enabled && p.amountMinor !== null,
  )) {
    const row = await db.billingPlan.findUniqueOrThrow({
      where: { id: plan.id },
    });
    const reference = createHash("sha256")
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
    let checkpoint = await db.providerPlanProvisioning.findUnique({
      where: { reference },
    });
    const knownId =
      plan.providerPlanId || checkpoint?.providerPlanId || row.providerPlanId;
    let remote = knownId
      ? await provider.fetchPlan(knownId)
      : await provider.findPlan(reference);
    if (!remote) {
      let claimed = false;
      if (!checkpoint) {
        try {
          checkpoint = await db.providerPlanProvisioning.create({
            data: { reference, state: "PENDING" },
          });
          claimed = true;
        } catch (error) {
          if (!(
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          ))
            throw error;
        }
      } else if (checkpoint.state === "REJECTED") {
        const claim = await db.providerPlanProvisioning.updateMany({
          where: { reference, state: "REJECTED" },
          data: { state: "PENDING" },
        });
        claimed = claim.count === 1;
      }
      if (!claimed)
        throw new ServiceError(
          "PLAN_RECONCILIATION_REQUIRED",
          503,
          `Plan ${plan.id} has an unresolved creation. Re-run sync to discover the provider plan; do not delete its checkpoint or blindly retry creation.`,
        );
      try {
        remote = await provider.createPlan(
          { ...plan, amountMinor: plan.amountMinor! },
          reference,
        );
      } catch (error) {
        // Only a definitive HTTP 4xx allows retry. Ambiguous outcomes keep their
        // durable checkpoint until discovered from provider notes/operator review.
        if (definiteProviderRejection(error))
          await db.providerPlanProvisioning.update({
            where: { reference },
            data: { state: "REJECTED" },
          });
        throw error;
      }
    }
    assertMatch(plan, remote);
    await db.$transaction(async (tx) => {
      // A known provider ID needs no new creation checkpoint. This also lets
      // API keys rotate within the same Razorpay account without attempting to
      // map an existing provider plan into a second unique checkpoint.
      if (!knownId)
        await tx.providerPlanProvisioning.upsert({
          where: { reference },
          create: { reference, state: "CONFIRMED", providerPlanId: remote!.id },
          update: { state: "CONFIRMED", providerPlanId: remote!.id },
        });
      const updated = await tx.billingPlan.updateMany({
        where: {
          id: plan.id,
          amountMinor: plan.amountMinor,
          currency: plan.currency,
          interval: plan.interval,
        },
        data: { providerPlanId: remote!.id },
      });
      if (updated.count !== 1)
        throw new Error(
          "Plan configuration changed during sync; run sync again.",
        );
    });
  }
  return { count: definitions.length, providerPending: false };
}

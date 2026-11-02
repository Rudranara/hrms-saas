import type { Prisma } from "@prisma/client";

export function historicalPlanName(terms: Prisma.JsonValue | null, fallback: string) {
  return terms && typeof terms === "object" && !Array.isArray(terms) &&
    typeof terms.planName === "string" && terms.planName.trim()
    ? terms.planName : fallback;
}

import type { BillingPlan } from "./billing-types";

// A narrow allowlist: never pass arbitrary browser input to router.replace.
export function billingReturn(value: string | null): string | null {
  if (!value || !value.startsWith("/billing?") || /[\\#\s]/.test(value)) return null;
  const query = new URLSearchParams(value.slice(9));
  if ([...query.keys()].some((key) => !["plan", "period", "review", "quote", "purchase"].includes(key))) return null;
  if ([...query.keys()].some((key) => query.getAll(key).length !== 1)) return null;
  const plan = query.get("plan");
  if (!plan || !/^[a-z0-9-]{1,80}$/.test(plan)) return null;
  const period = query.get("period");
  if (period !== null && !["monthly", "yearly"].includes(period)) return null;
  if (query.has("review") && query.get("review") !== "1") return null;
  if (query.has("quote") && !/^[a-zA-Z0-9_-]{1,100}$/.test(query.get("quote") || "")) return null;
  if (query.has("purchase") && !/^[a-zA-Z0-9_-]{1,100}$/.test(query.get("purchase") || "")) return null;
  return `/billing?${query}`;
}

export function selectedBillingPlan(value: string | null, plans: BillingPlan[]) {
  const safe = billingReturn(value);
  if (!safe) return null;
  const query = new URLSearchParams(safe.slice(9));
  return plans.find((plan) => plan.id === query.get("plan") &&
    (!query.has("period") || plan.interval.toLowerCase() === query.get("period"))) || null;
}

export function billingHref(plan: BillingPlan, review = false) {
  return `/billing?${new URLSearchParams({ plan: plan.id, period: plan.interval.toLowerCase(), ...(review ? { review: "1" } : {}) })}`;
}

export function checkoutHref(plan: BillingPlan) {
  return billingHref(plan, true).replace("/billing?", "/billing/checkout?");
}

export const BILLING_CONTINUATION = "hrms.billing.continuation";

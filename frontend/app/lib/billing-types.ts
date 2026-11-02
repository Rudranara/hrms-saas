export type BillingPlan = {
  id: string;
  name: string;
  interval: "MONTHLY" | "YEARLY";
  amountMinor: number | null;
  currency: string;
  totalCount: number;
  configured: boolean;
  taxNote: string;
  unavailableReason?: string | null;
};
export type CheckoutReadiness = {
  ready: boolean;
  code: string;
  message: string;
};
export type BillingQuote = {
  id: string; version: number; organizationName: string; planId: string; planName: string;
  interval: "MONTHLY" | "YEARLY"; amountMinor: number; currency: string; totalCount: number;
  discountMinor: number; renewalAmountMinor: number; taxNote: string; terms: string;
  expiresAt: string; serverTime: string; subscriptionId: string | null; capacity: null; features: string[];
  replacesSubscriptionId?: string | null;
};
export type BillingPurchase = {
  state: "SUCCESS" | "PENDING" | "FAILED" | "RESTRICTED" | "REVIEW"; subscriptionId: string; planId: string;
  planName: string; interval: "MONTHLY" | "YEARLY"; amountMinor: number; paidAmountMinor: number | null;
  currency: string; transactionReference: string | null; nextBillingAt: string | null;
  paidUntil: string | null; cancelAtCycleEnd: boolean; invoiceUrl: string | null;
};
export function parsePlanCatalog(value: unknown): BillingPlan[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every(
      (plan) =>
        plan &&
        typeof plan.id === "string" &&
        /^[a-z0-9-]{1,80}$/.test(plan.id) &&
        typeof plan.name === "string" &&
        ["MONTHLY", "YEARLY"].includes(plan.interval) &&
        (plan.amountMinor === null ||
          (Number.isSafeInteger(plan.amountMinor) && plan.amountMinor > 0)) &&
        typeof plan.currency === "string" &&
        /^[A-Z]{3}$/.test(plan.currency) &&
        Number.isInteger(plan.totalCount) &&
        plan.totalCount > 0 &&
        typeof plan.configured === "boolean" &&
        typeof plan.taxNote === "string",
    )
  )
    throw new Error(
      "Plan configuration is unavailable. Please try again later.",
    );
  return value;
}
export type BillingAccess = {
  serverTime: string;
  state: string;
  allowed: boolean;
  checkoutAllowed?: boolean;
  checkoutBlockedBySubscription?: boolean;
  checkoutReplacementRequired?: boolean;
  billingRecovery?: { state: string; subscriptionId: string } | null;
  source: "SUBSCRIPTION" | "TRIAL" | "GRACE" | "MANUAL" | "NONE";
  accessMode?: "AUTO" | "MANUAL" | "SUSPENDED" | "CONTROLLED";
  manualAccess?: { startsAt: string; expiresAt: string; plan?: { id: string; name: string; interval: string } | null } | null;
  trialStartedAt: string | null;
  trialExpiresAt: string | null;
  remainingTrialSeconds: number;
  graceHours: number;
  subscription: null | {
    id: string;
    supersededByAccessPolicy?: boolean;
    planName: string;
    planId: string;
    status: string;
    interval: string;
    amountMinor: number;
    currency: string;
    paidUntil: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelledAt: string | null;
    latestPayment: null | {
      status: string;
      amountMinor: number;
      currency: string;
      paidAt: string | null;
      createdAt: string;
    };
    nextBillingAt: string | null;
    cancelAtCycleEnd: boolean;
    totalCount: number;
    lastSyncedAt: string | null;
  };
};
export function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(
    amount / 100,
  );
}
export function yearlySavings(yearly: BillingPlan, plans: BillingPlan[]) {
  const monthly = plans.find(
    (p) =>
      p.name === yearly.name &&
      p.interval === "MONTHLY" &&
      p.currency === yearly.currency,
  );
  if (
    yearly.interval !== "YEARLY" ||
    yearly.amountMinor == null ||
    monthly?.amountMinor == null
  )
    return null;
  const amount = monthly.amountMinor * 12 - yearly.amountMinor;
  return amount > 0 ? amount : null;
}
export function formatDate(value: string | null) {
  return value
    ? new Date(value).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " IST"
    : "Not available";
}
export function formatAccessState(value: string) {
  const labels: Record<string, string> = {
    TRIALING: "Trial active",
    ACTIVE: "Subscription active",
    TRIAL_EXPIRED: "Trial expired",
    SUBSCRIPTION_REQUIRED: "Subscription required",
    PAST_DUE: "Payment overdue",
    CANCELLED: "Subscription cancelled",
    CREATING: "Checkout pending",
    CREATE_UNKNOWN: "Provider confirmation pending",
    CREATED: "Checkout pending",
    AUTHENTICATED: "Authorization received",
    FAILED: "Checkout could not be started",
    COMPLETED: "Subscription completed",
    EXPIRED: "Subscription expired",
    PAUSED: "Subscription paused",
    SUSPENDED: "Workspace access suspended",
    ADMIN_ACTIVE: "Admin-managed access active",
    ADMIN_SCHEDULED: "Admin-managed access scheduled",
    ADMIN_EXPIRED: "Admin-managed access expired",
  };
  return labels[value] || "Subscription status pending";
}

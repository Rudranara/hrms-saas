import { Prisma } from "@prisma/client";

export const paidStatuses = ["ACTIVE", "PENDING", "HALTED", "CANCELLED", "COMPLETED", "PAUSED"];
// A saved admin policy overrides subscriptions created under an older policy.
// A fresh purchase during the current trial-only policy can still activate paid access.
export function matchesAccessPolicy(organization: { accessMode: string; accessVersion: number }, subscription: { commercialTerms: Prisma.JsonValue | null }) {
  const terms = subscription.commercialTerms;
  return organization.accessMode !== "CONTROLLED" || !!(terms && typeof terms === "object" && !Array.isArray(terms) &&
    typeof terms.accessPolicyVersion === "number" && terms.accessPolicyVersion === organization.accessVersion);
}
export function matchesAccessPolicySql(alias: "s" | "candidate") {
  const s = Prisma.raw(alias);
  return Prisma.sql`(o.accessMode <> 'CONTROLLED' OR (
    JSON_TYPE(JSON_EXTRACT(${s}.commercialTerms, '$.accessPolicyVersion')) = 'INTEGER'
    AND JSON_EXTRACT(${s}.commercialTerms, '$.accessPolicyVersion') = o.accessVersion))`;
}
export const checkoutBlockingStatuses = ["CREATING", "CREATE_UNKNOWN", "CREATED", "AUTHENTICATED", "ACTIVE", "PENDING", "HALTED", "PAUSED"];
type CheckoutPolicy = { accessMode: string; accessVersion: number; trialEnabled: boolean; subscriptionEnabled: boolean };
type CheckoutSubscription = { status: string; commercialTerms: Prisma.JsonValue | null; paidUntil: Date | null; lastSyncedAt: Date | null; providerSubscriptionId: string | null };
export function supersededForCheckout(organization: CheckoutPolicy, subscription: CheckoutSubscription) {
  return organization.accessMode === "CONTROLLED" && allowsSelfServiceCheckout(organization) && !matchesAccessPolicy(organization, subscription);
}
export function blocksCheckout(organization: CheckoutPolicy, subscription: CheckoutSubscription, now: Date) {
  // Verified terminal mandates from an older, disabled access policy no longer
  // block a new purchase. Their historical paid-through dates remain untouched.
  if (supersededForCheckout(organization, subscription) && subscription.lastSyncedAt &&
    ["CANCELLED", "COMPLETED", "EXPIRED"].includes(subscription.status)) return false;
  return checkoutBlockingStatuses.includes(subscription.status) || !!(subscription.paidUntil && subscription.paidUntil > now);
}
export function replaceableAfterTrialReset(organization: CheckoutPolicy, subscription: CheckoutSubscription) {
  return supersededForCheckout(organization, subscription) && !!subscription.providerSubscriptionId &&
    ["CREATED", "AUTHENTICATED", "ACTIVE", "PENDING", "HALTED", "PAUSED"].includes(subscription.status);
}
export function graceMilliseconds(hours = Number(process.env.BILLING_GRACE_HOURS || 0)) {
  return Number.isFinite(hours) && hours >= 0 && hours <= 168 ? hours * 3600000 : 0;
}
export function verifiedPaymentSql(alias: "s" | "candidate", now: Date) {
  const s = Prisma.raw(alias);
  return Prisma.sql`${s}.lastSyncedAt IS NOT NULL AND EXISTS (
    SELECT 1 FROM BillingPayment proof WHERE proof.subscriptionId = ${s}.id
    AND proof.status = 'captured'
    AND proof.providerInvoiceId IS NOT NULL
    AND ((proof.captureVerifiedAt IS NOT NULL AND proof.captureVerifiedAt <= ${now})
      OR (proof.paidAt IS NOT NULL AND proof.paidAt <= ${now}))
    AND proof.amountMinor >= ${s}.amountMinor AND proof.currency = ${s}.currency
  )`;
}
export function paidAccessSql(alias: "s" | "candidate", now: Date) {
  const s = Prisma.raw(alias);
  return Prisma.sql`${s}.paidUntil > ${now} AND ${s}.status IN (${Prisma.join(paidStatuses)}) AND ${verifiedPaymentSql(alias, now)}`;
}
export function graceAccessSql(alias: "s" | "candidate", now: Date, milliseconds: number) {
  const s = Prisma.raw(alias);
  return Prisma.sql`${milliseconds} > 0 AND ${s}.status IN ('PENDING','HALTED')
    AND ${s}.paidUntil IS NOT NULL AND TIMESTAMPADD(SECOND, ${milliseconds / 1000}, ${s}.paidUntil) > ${now}
    AND ${verifiedPaymentSql(alias, now)}`;
}
export function allowsSelfServiceCheckout(organization: { accessMode: string; trialEnabled: boolean; subscriptionEnabled: boolean }) {
  return organization.accessMode === "AUTO" || (organization.accessMode === "CONTROLLED" && organization.trialEnabled && !organization.subscriptionEnabled);
}

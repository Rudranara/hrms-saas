export type OrganizationReport = {
  id: string; name: string; phoneNumber: string | null; employeeSize: string | null; createdAt: string; trialStartedAt: string | null; trialEnd: string | null;
  trialActive: boolean; hasPaidAccess: boolean; convertedAt: string | null;
  administratorName: string | null; administratorEmail: string | null;
  manualPlanName?: string | null; manualPlanCycle?: string | null;
  subscriptionId: string | null; planName: string | null; planId: string | null; billingCycle: string | null;
  subscriptionStatus: string | null; amountMinor: number | null; currency: string | null;
  currentPeriodStart: string | null; currentPeriodEnd: string | null; nextBillingAt: string | null;
  paidUntil: string | null; cancelledAt: string | null; cancelAtCycleEnd: boolean;
  lastSyncedAt: string | null; paymentStatus: string | null; paymentPaidAt: string | null; classification: string;
  accessMode: string; accessVersion: number; accessAllowed: boolean; accessSource: string;
  manualAccessStartsAt: string | null; manualAccessExpiresAt: string | null;
};
export type Paginated<T> = { items: T[]; total: number; page: number; pageSize: number };
export type Revenue = { capturedAmountMinor: number; paymentCount: number; from: string; to: string; note: string; refundsMinor: null; netRevenueMinor: null };
export type AdminMetrics = { asOf: string; counts: Record<string, number>; revenue: Revenue };
export type AdminSubscription = {
  id: string; plan: { name: string }; status: string; interval: string; amountMinor: number; currency: string;
  createdAt: string; currentPeriodStart: string | null; currentPeriodEnd: string | null; paidUntil: string | null;
  nextBillingAt: string | null; cancelAtCycleEnd: boolean; cancelledAt: string | null; lastSyncedAt: string | null;
};
export type AdminPayment = { id: string; subscriptionId: string; amountMinor: number; currency: string; status: string; paidAt: string | null; captureVerifiedAt?: string | null; paidAtSource?: string | null; createdAt: string; subscription: { plan: { name: string }; interval: string } };
export const statusLabels: Record<string, string> = {
  ALL: "All organizations", TRIALING: "Active free trial", PAID_ACTIVE: "Active paid",
  TRIAL_EXPIRED: "Expired trial", PENDING: "Payment / authorization pending", PAST_DUE: "Payment failed / past due",
  CHECKOUT_FAILED: "Checkout creation failed", PAUSED: "Subscription paused",
  CANCELLED: "Cancelled subscription", EXPIRED: "Expired subscription", NO_SUBSCRIPTION: "No subscription",
  SUSPENDED: "Access suspended", ADMIN_ACTIVE: "Admin-managed access", ADMIN_SCHEDULED: "Admin access scheduled", ADMIN_EXPIRED: "Admin access expired",
};

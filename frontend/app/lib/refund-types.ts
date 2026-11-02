export const refundStatuses = ["PENDING", "APPROVED", "REJECTED", "PROCESSING", "PARTIALLY_REFUNDED", "REFUNDED", "FAILED"] as const;
const labels: Record<string, string> = { PENDING: "Pending", APPROVED: "Approved", REJECTED: "Rejected", PROCESSING: "Processing", PARTIALLY_REFUNDED: "Partially refunded", REFUNDED: "Refunded", FAILED: "Failed" };
export const refundLabel = (status: string) => labels[status] || status;
export type RefundItem = {
  id: string; organizationName: string; paymentId: string; providerPaymentId: string; planName: string; subscriptionStatus: string; interval: string; paymentDate: string | null;
  amountMinor: number; currency: string; refundedMinor: number; remainingMinor: number; requestedAmountMinor: number; approvedAmountMinor: number | null; reason: string; status: string; rejectionReason: string | null; decidedAt: string | null; decisionName: string | null; createdAt: string; version: number;
  transaction: { id: string; providerRefundId: string | null; amountMinor: number; status: string; providerStatus: string | null; failureCode: string | null; verifiedAt: string | null; processedAt: string | null } | null;
  audit: { action: string; actorName: string | null; amountMinor: number | null; detail: string | null; createdAt: string }[];
};
export type RefundPage = { items: RefundItem[]; total: number; page: number; pageSize: number };
export type RefundPayment = { id: string; amountMinor: number; currency: string; status: string; paidAt: string | null; captureVerifiedAt?: string | null; amountRefundedMinor?: number; remainingRefundableMinor?: number; refundEligible?: boolean; subscription: { plan: { name: string } } };
export function refundNotice(row: RefundItem) {
  if (row.status === "REJECTED") return `Request rejected: ${row.rejectionReason}`;
  if (row.status === "PENDING") return "Your request is awaiting super-admin review. No refund has been issued.";
  if (row.status === "APPROVED") return "Approved for processing. This does not confirm that money has been refunded.";
  if (row.status === "PROCESSING") return row.transaction?.status === "RECONCILING" ? "The provider response is unconfirmed. Further verification is required; no second refund will be sent." : "The provider is processing this refund. Completion has not yet been verified.";
  if (row.status === "FAILED") return "The refund failed. Contact your platform administrator. Subscription cancellation is separate.";
  return "Refund completion was verified with the provider. The original payment method and bank determine when funds appear in your account.";
}
export function minorAmount(value: string) {
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) && result > 0 && result <= 2147483647 ? result : null;
}
export class RefundApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
export function definitiveRefundError(error: unknown) {
  // A 5xx can follow a committed approval; only a definite client rejection
  // permits changing the saved mutation. Network/parse errors remain uncertain.
  return error instanceof RefundApiError && error.status >= 400 && error.status < 500;
}
export async function refundRequest(path: string, body?: unknown) {
  const response = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new RefundApiError(data.message || "The refund request could not be completed.", response.status, data.code); return data;
}

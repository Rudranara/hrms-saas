"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDate, formatMoney, type BillingPurchase } from "../lib/billing-types";
import { BILLING_CONTINUATION } from "../lib/billing-continuation";

export function PaymentStatus({ subscriptionId, onBack, pollingEnabled = true }: { subscriptionId: string; onBack: () => void; pollingEnabled?: boolean }) {
  const [purchase, setPurchase] = useState<BillingPurchase | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false), alive = useRef(true);
  const terminal = useRef(false);
  const check = useCallback(async (refresh = true) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      let syncError = "";
      if (refresh) {
        try { const response = await fetch("/api/billing/refresh", { method: "POST", headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify({ subscriptionId }) }); if (!response.ok) syncError = "Provider confirmation is still pending. Check again shortly."; } catch { syncError = "Unable to reach the provider. You can safely check again."; }
      }
      const response = await fetch(`/api/billing/purchase?subscriptionId=${encodeURIComponent(subscriptionId)}`, { cache: "no-store" });
      const result = await response.json(); if (!response.ok) throw new Error(result.message || "Unable to check payment status.");
      if (alive.current) { terminal.current = ["SUCCESS", "FAILED", "RESTRICTED", "REVIEW"].includes(result.purchase.state); setPurchase(result.purchase); if (syncError && result.purchase.state !== "SUCCESS") setError(syncError); }
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : "Payment verification is unavailable. Please check again."); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }, [subscriptionId]);
  useEffect(() => {
    alive.current = true;
    if (!pollingEnabled) return () => { alive.current = false; };
    terminal.current = false;
    queueMicrotask(() => { if (alive.current) void check(); });
    let attempts = 1;
    const timer = setInterval(() => { if (terminal.current || attempts >= 12) clearInterval(timer); else { attempts++; void check(); } }, 5000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [check, pollingEnabled]);
  const dashboard = useCallback(() => { try { sessionStorage.removeItem(BILLING_CONTINUATION); } catch { /* Optional storage. */ } window.location.replace(`/dashboard?payment=success&subscription=${encodeURIComponent(subscriptionId)}`); }, [subscriptionId]);
  useEffect(() => { if (purchase?.state !== "SUCCESS") return; const timer = setTimeout(dashboard, 5000); return () => clearTimeout(timer); }, [purchase?.state, dashboard]);
  const state = purchase?.state || "PENDING";
  return <section className="billing-purchase billing-payment-status" aria-label="Payment status" aria-busy={busy}>
    <span className="eyebrow">PAYMENT VERIFICATION</span><h2>{!pollingEnabled ? "Complete your Razorpay checkout" : state === "REVIEW" ? "Payment needs review" : state === "SUCCESS" ? "Payment verified. Subscription activated." : state === "FAILED" ? "Payment was not completed" : state === "RESTRICTED" ? "Payment verified. Workspace access is restricted." : "Checking your payment"}</h2>
    <p role="status">{state === "SUCCESS" ? "Your paid access is ready. You will return to your dashboard in a few seconds." : state === "FAILED" ? "No new paid access has been activated. Review the payment summary to retry safely." : state === "RESTRICTED" ? "Your platform administrator manages access for this organization. Contact them to restore it; do not pay again." : "We are waiting for authoritative provider confirmation. This is not a payment failure. Check again before retrying payment."}</p>
    {error && <p className="auth-alert" role="alert">{error}</p>}
    {state === "REVIEW" && <p role="alert">Payment and cancellation overlapped. Your financial records and verified paid time are retained. Contact your platform administrator; do not pay again.</p>}
    {purchase && <dl className="billing-purchase-summary"><div><dt>Plan</dt><dd>{purchase.planName}</dd></div><div><dt>Billing frequency</dt><dd>{purchase.interval === "MONTHLY" ? "Monthly" : "Yearly"}</dd></div>{purchase.paidAmountMinor !== null && <div><dt>Amount paid</dt><dd>{formatMoney(purchase.paidAmountMinor, purchase.currency)}</dd></div>}{purchase.transactionReference && <div><dt>Transaction reference</dt><dd>{purchase.transactionReference}</dd></div>}<div><dt>{purchase.cancelAtCycleEnd ? "Paid access through" : "Next renewal"}</dt><dd>{formatDate(purchase.cancelAtCycleEnd ? purchase.paidUntil : purchase.nextBillingAt)}</dd></div></dl>}
    <div className="billing-actions">{state === "SUCCESS" ? <button className="button primary" onClick={dashboard}>Go to dashboard</button> : <><button className="button primary" disabled={busy || !pollingEnabled} onClick={() => void check()}>{busy ? "Checking…" : "Check payment status"}</button><button className="button secondary" disabled={busy || !pollingEnabled} onClick={onBack}>{state === "FAILED" ? "Retry payment" : "Back to payment summary"}</button></>}</div>
  </section>;
}

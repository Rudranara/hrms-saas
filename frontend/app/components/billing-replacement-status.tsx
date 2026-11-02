"use client";
import { useEffect, useState } from "react";
import type { BillingAccess } from "../lib/billing-types";

export function BillingReplacementStatus({ recovery, serverTime, busy, onCheck }: {
  recovery: NonNullable<BillingAccess["billingRecovery"]>;
  serverTime: string;
  busy: boolean;
  onCheck: () => void;
}) {
  const delay = recovery.settleAfter ? Math.max(0, Date.parse(recovery.settleAfter) - Date.parse(serverTime)) : 0;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const timer = window.setInterval(() => setElapsed(performance.now() - start), 1000);
    return () => window.clearInterval(timer);
  }, [serverTime, recovery.settleAfter]);
  const seconds = Math.max(0, Math.ceil((delay - elapsed) / 1000));
  if (recovery.state === "CONFLICT") return <p className="auth-alert" role="alert">Payment and cancellation need review. Payment records and verified paid time are retained. Contact your platform administrator; do not pay again.</p>;
  return <div className="billing-neutral" role="status">
    <strong>Confirming your previous subscription</strong>
    <p>{seconds > 0 ? `Please wait ${seconds} seconds before checking cancellation. No new payment has started.` : "Check that the previous cancellation is confirmed, then choose Proceed to payment. Checking status does not start a payment."}</p>
    <button className="button secondary" type="button" disabled={busy || seconds > 0} onClick={onCheck}>{busy ? "Checking status…" : seconds > 0 ? `Check status in ${seconds}s` : "Check subscription status"}</button>
  </div>;
}

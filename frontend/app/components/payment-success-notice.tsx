"use client";
import { useEffect, useState } from "react";
import { formatMoney, type BillingPurchase } from "../lib/billing-types";
export function PaymentSuccessNotice() {
  const [purchase, setPurchase] = useState<BillingPurchase | null>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search), id = query.get("subscription");
    if (query.get("payment") !== "success" || !id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return;
    const controller = new AbortController();
    fetch(`/api/billing/purchase?subscriptionId=${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal }).then(async (response) => response.ok ? response.json() : null).then((result) => { if (result?.purchase?.state === "SUCCESS") setPurchase(result.purchase); }).catch(() => {});
    return () => controller.abort();
  }, []);
  return purchase ? <div className="account-success" role="status" style={{ marginBottom: 24 }}>Payment verified: {purchase.planName} is active. {formatMoney(purchase.paidAmountMinor || purchase.amountMinor, purchase.currency)} paid.</div> : null;
}

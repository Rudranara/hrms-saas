"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { checkoutHref } from "../lib/billing-continuation";
import { formatDate, formatMoney, type BillingPlan, type BillingQuote } from "../lib/billing-types";

export function SubscriptionPurchase({ plan, plans, organizationName, disabled, onPay }: { plan: BillingPlan; plans: BillingPlan[]; organizationName: string; disabled: boolean; onPay: (quote: BillingQuote) => Promise<void> }) {
  const router = useRouter();
  const [quote, setQuote] = useState<BillingQuote | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [expired, setExpired] = useState(false), [restore, setRestore] = useState(true);
  const pending = useRef(false);
  useEffect(() => {
    const quoteId = new URLSearchParams(window.location.search).get("quote");
    if (!quoteId) { queueMicrotask(() => setRestore(false)); return; }
    const controller = new AbortController();
    fetch(`/api/billing/quote?quoteId=${encodeURIComponent(quoteId)}`, { cache: "no-store", signal: controller.signal }).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.message || "Unable to restore payment summary."); if (data.quote.planId !== plan.id) throw new Error("Choose a new quote for this plan."); return data.quote as BillingQuote; }).then(setQuote).catch((error) => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setRestore(false); });
    return () => controller.abort();
  }, [plan.id]);
  useEffect(() => {
    if (!quote) return;
    const remaining = Date.parse(quote.expiresAt) - Date.parse(quote.serverTime);
    const timeout = setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => clearTimeout(timeout);
  }, [quote]);
  async function summarize(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault(); if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const response = await fetch("/api/billing/quote", { method: "POST", headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify({ planId: plan.id, period: plan.interval.toLowerCase() }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message || "Unable to prepare your payment summary.");
      setQuote(result.quote); setExpired(false);
      const url = new URL(window.location.href); url.searchParams.set("quote", result.quote.id); window.history.replaceState(null, "", url.pathname + url.search);
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to prepare payment summary."); }
    finally { pending.current = false; setBusy(false); }
  }
  function edit() { setQuote(null); setExpired(false); setError(""); const url = new URL(window.location.href); url.searchParams.delete("quote"); window.history.replaceState(null, "", url.pathname + url.search); }
  return <section className="billing-purchase" aria-label="Selected paid plan" aria-busy={busy || restore}>
    <ol className="billing-purchase-steps" aria-label="Subscription purchase steps"><li>1. Select plan</li><li aria-current={!quote ? "step" : undefined}>2. Configure</li><li aria-current={quote ? "step" : undefined}>3. Payment summary</li><li>4. Verification</li></ol>
    {error && <p className="auth-alert" role="alert">{error}</p>}
    {restore ? <p role="status">Loading your selection…</p> : !quote ? <form onSubmit={summarize}>
      <span className="eyebrow">CONFIGURE SUBSCRIPTION</span><h2>{plan.name}</h2><p>Review your subscription for {organizationName}. Payment starts only when you proceed from the summary.</p>
      <label className="billing-purchase-frequency">Billing frequency<select aria-label="Subscription billing frequency" value={plan.interval} disabled={busy || disabled} onChange={(event) => { const selected = plans.find((item) => item.name === plan.name && item.interval === event.target.value); if (selected) router.replace(checkoutHref(selected)); }}><option value="MONTHLY">Monthly recurring</option><option value="YEARLY">Yearly recurring</option></select></label>
      <div className="billing-purchase-config"><strong>{formatMoney(plan.amountMinor || 0, plan.currency)} / {plan.interval === "MONTHLY" ? "month" : "year"}</strong><p>{plan.totalCount} scheduled {plan.interval === "MONTHLY" ? "monthly" : "annual"} charges maximum, unless cancelled.{plan.interval === "YEARLY" ? ` This can span up to ${plan.totalCount} years.` : ""}</p><p>{plan.taxNote}</p></div>
      <p className="account-help">Organization-level pricing. Employee capacity is not a purchased entitlement in these plans. HR operation modules remain in development.</p>
      <button className="button primary" disabled={busy || disabled} type="submit">{busy ? "Preparing summary…" : "Continue to payment summary"}</button>
    </form> : <form onSubmit={(event) => { event.preventDefault(); if (!expired && !busy && !disabled) void onPay(quote); }}>
      <span className="eyebrow">REVIEW BEFORE PAYMENT</span><h2>Payment summary</h2><p>Your first billing-period charge and future recurring charges are shown separately.</p>
      <dl className="billing-purchase-summary"><div><dt>Organization</dt><dd>{quote.organizationName}</dd></div><div><dt>Selected plan</dt><dd>{quote.planName}</dd></div><div><dt>Billing frequency</dt><dd>{quote.interval === "MONTHLY" ? "Monthly" : "Yearly"}</dd></div><div><dt>Plan price</dt><dd>{formatMoney(quote.amountMinor, quote.currency)}</dd></div><div><dt>Additional discount</dt><dd>{formatMoney(quote.discountMinor, quote.currency)}</dd></div><div><dt>Tax treatment</dt><dd>{quote.taxNote}</dd></div></dl>
      <div className="billing-purchase-total"><span>Total payable now</span><strong>{formatMoney(quote.amountMinor - quote.discountMinor, quote.currency)}</strong><small>One {quote.interval === "MONTHLY" ? "monthly" : "yearly"} billing period. This is not the total of future charges.</small></div>
      <p className="billing-purchase-renewal"><strong>Future renewal: {formatMoney(quote.renewalAmountMinor, quote.currency)} per {quote.interval === "MONTHLY" ? "month" : "year"}.</strong></p><p className="account-help">{quote.terms}</p>
      <p className="account-help">Quote valid until {formatDate(quote.expiresAt)}. Razorpay may require mandate authentication; authentication alone does not activate paid access.</p>
      {quote.replacesSubscriptionId && <p className="billing-warning" role="status">Your earlier subscription can still renew. Proceeding confirms cancellation of its future renewals before the new subscription starts. Previous payments are retained and are not automatically refunded. A confirmation wait may be required before payment opens.</p>}
      {expired && <p className="auth-alert" role="alert">This quote expired. Generate a new summary before paying.</p>}
      <label className="billing-purchase-consent"><input key={quote.id} type="checkbox" required disabled={disabled || busy || expired} /> I understand the recurring amount, billing frequency and cancellation terms.{quote.replacesSubscriptionId ? " I also confirm replacement and cancellation of my previous recurring subscription." : ""}</label>
      <div className="billing-actions"><button className="button secondary" type="button" disabled={disabled || busy} onClick={edit}>Edit subscription</button>{expired ? <button className="button primary" type="button" disabled={busy || disabled} onClick={() => void summarize()}>Refresh payment summary</button> : <button className="button primary" type="submit" disabled={busy || disabled}>Proceed to payment</button>}</div>
    </form>}
  </section>;
}

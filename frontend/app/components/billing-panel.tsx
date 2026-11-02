"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  formatDate,
  formatAccessState,
  formatMoney,
  yearlySavings,
  parsePlanCatalog,
  type BillingAccess,
  type BillingPlan,
  type CheckoutReadiness,
  type BillingQuote,
} from "../lib/billing-types";
import type { CurrentUser } from "../lib/auth-types";
import { billingHref, checkoutHref, BILLING_CONTINUATION } from "../lib/billing-continuation";
import { Icon } from "./ui-icon";
import { SubscriptionPurchase } from "./subscription-purchase";
import { PaymentStatus } from "./payment-status";

type CheckoutResponse = {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
};
type RazorpayInstance = {
  open(): void;
  on(event: string, callback: () => void): void;
};
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}
let checkoutScript: Promise<void> | null = null;
function loadCheckout() {
  if (window.Razorpay) return Promise.resolve();
  if (checkoutScript) return checkoutScript;
  checkoutScript = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      checkoutScript = null;
      script.remove();
      reject(new Error("Checkout could not be loaded. Please try again."));
    };
    document.head.appendChild(script);
  });
  return checkoutScript;
}
async function billingRequest(action: string, data?: unknown) {
  const response = await fetch(
    `/api/billing/${action}`,
    data === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-HRMS-Request": "1",
          },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.message || "The billing service could not complete this request.",
    );
  return result;
}
type Payment = {
  id: string;
  amountMinor: number;
  currency: string;
  status: string;
  paidAt: string | null;
  captureVerifiedAt?: string | null;
  paymentCreatedAt?: string | null;
  paidAtSource?: string | null;
  amountRefundedMinor?: number;
  createdAt: string;
  subscription: { plan: { name: string }; interval: string };
};
export function BillingPanel({
  user,
  initial,
  required = false,
  checkoutOnly = false,
  selectedPlan = "",
  review = false,
  invalidSelection = false,
}: {
  user: CurrentUser;
  initial: {
    access: BillingAccess;
    providerAvailable: boolean;
    mode: "test" | "live";
    checkoutReadiness: CheckoutReadiness;
  };
  required?: boolean;
  checkoutOnly?: boolean;
  selectedPlan?: string;
  review?: boolean;
  invalidSelection?: boolean;
}) {
  const router = useRouter();
  const [access, setAccess] = useState(initial.access),
    [interval, setInterval] = useState<"MONTHLY" | "YEARLY">(
      selectedPlan.endsWith("-yearly") ? "YEARLY" : "MONTHLY",
    );
  const [plans, setPlans] = useState<BillingPlan[]>([]),
    [payments, setPayments] = useState<Payment[]>([]);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(user.role === "ORGANIZATION_ADMIN");
  const [historyError, setHistoryError] = useState("");
  const pending = useRef(false);
  const [purchaseId, setPurchaseId] = useState("");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  useEffect(() => { const id = new URLSearchParams(window.location.search).get("purchase"); if (id && /^[a-zA-Z0-9_-]{1,100}$/.test(id)) queueMicrotask(() => setPurchaseId(id)); }, []);
  function showPurchase(id: string) { setPurchaseId(id); const url = new URL(window.location.href); if (id) url.searchParams.set("purchase", id); else url.searchParams.delete("purchase"); window.history.replaceState(null, "", url.pathname + url.search); }
  useEffect(() => {
    let alive = true;
    billingRequest("plans")
      .then((data) => {
        const plans = parsePlanCatalog(data.plans);
        if (alive) setPlans(plans);
      })
      .catch((error) => {
        if (alive) setError(error.message);
      })
      .finally(() => {
        if (alive) setCatalogLoading(false);
      });
    if (user.role === "ORGANIZATION_ADMIN")
      billingRequest("history")
        .then((data) => {
          if (alive) setPayments(data.payments);
        })
        .catch((error) => {
          if (alive) setHistoryError(error.message);
        })
        .finally(() => {
          if (alive) setHistoryLoading(false);
        });
    return () => {
      alive = false;
    };
  }, [user.role]);
  async function retryHistory() {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const history = await billingRequest("history");
      setPayments(history.payments);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Please try again.");
    } finally {
      setHistoryLoading(false);
    }
  }
  async function updateStatus() {
    const result = await billingRequest("status");
    setAccess(result.access);
    if (user.role === "ORGANIZATION_ADMIN") {
      try { const history = await billingRequest("history"); setPayments(history.payments); setHistoryError(""); }
      catch { setHistoryError("Payment history is temporarily unavailable. Your subscription status is unchanged."); }
    }
    return result.access as BillingAccess;
  }
  async function action(kind: "refresh" | "cancel") {
    if (pending.current || !access.subscription) return;
    const hasCycle =
      !!access.subscription.currentPeriodStart &&
      !!access.subscription.currentPeriodEnd;
    if (
      kind === "cancel" &&
      !window.confirm(
        hasCycle
          ? "Cancel renewal at the end of the current billing cycle? Verified paid access remains until the paid-through date."
          : "Cancel this pending subscription immediately? Your existing free trial dates will remain unchanged.",
      )
    )
      return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const data = await billingRequest(kind, {
        subscriptionId: access.subscription.id,
        ...(kind === "cancel" ? { atCycleEnd: hasCycle } : {}),
      });
      setAccess(data.access);
      setMessage(data.message || "Subscription status refreshed.");
      await updateStatus();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to complete this request.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function checkout(quote: BillingQuote) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await loadCheckout();
      const data = await billingRequest("checkout", { quoteId: quote.id, ...(quote.replacesSubscriptionId ? { replaceSubscriptionId: quote.replacesSubscriptionId } : {}) });
      void updateStatus().catch(() => {});
      if (!window.Razorpay) throw new Error("Checkout is unavailable.");
      const details = data.checkout;
      setCheckoutOpen(true);
      showPurchase(details.subscriptionId);
      let callbackStarted = false;
      const instance = new window.Razorpay({
        key: details.keyId,
        subscription_id: details.providerSubscriptionId,
        name: "HRMS",
        description: `${quote.planName} · ${quote.interval === "MONTHLY" ? "Monthly" : "Yearly"}`,
        prefill: { name: user.fullName, email: user.email },
        theme: { color: "#4F46E5" },
        handler: async (result: CheckoutResponse) => {
          callbackStarted = true;
          try {
            const confirmed = await billingRequest("confirm", {
              subscriptionId: details.subscriptionId,
              ...result,
            });
            setAccess(confirmed.access);
            setMessage(
              confirmed.access.source === "SUBSCRIPTION" &&
                confirmed.access.allowed
                ? "Payment verified. Your paid subscription access is available."
                : "Payment confirmation checked. Paid access is pending provider confirmation; refresh the subscription status shortly.",
            );
            void updateStatus().catch(() => {});
          } catch (error) {
            setError(
              error instanceof Error
                ? error.message
                : "Payment confirmation could not be verified. Refresh your subscription status.",
            );
          } finally {
            setCheckoutOpen(false);
            pending.current = false;
            setBusy(false);
          }
        },
        modal: {
          ondismiss: () => {
            if (callbackStarted) return;
            setCheckoutOpen(false);
            setMessage(
              "Checkout closed. No payment result is assumed. Refresh your subscription status before trying again.",
            );
            pending.current = false;
            setBusy(false);
          },
        },
      });
      instance.on("payment.failed", () => {
        setError(
          "Checkout reported a payment failure. Refresh the subscription status for the provider-confirmed result.",
        );
        pending.current = false;
        setBusy(false);
      });
      instance.open();
    } catch (error) {
      setCheckoutOpen(false);
      setError(
        error instanceof Error
          ? error.message
          : "Checkout could not be initiated.",
      );
      pending.current = false;
      setBusy(false);
      // Resolve an uncertain provider creation through its persisted subscription;
      // never issue another creation merely because the network response failed.
      try { const response = await fetch(`/api/billing/quote?quoteId=${encodeURIComponent(quote.id)}`, { cache: "no-store" }); const result = await response.json(); if (response.ok && result.quote.subscriptionId) showPurchase(result.quote.subscriptionId); } catch { /* The same quote can be checked again safely. */ }
    }
  }
  const current = access.subscription;
  const currentPlanId = access.source === "MANUAL" ? access.manualAccess?.plan?.id : current?.supersededByAccessPolicy ? null : current?.planId;
  const trialDays = Math.ceil(access.remainingTrialSeconds / 86400);
  const trialActive = access.source === "TRIAL" && trialDays > 0;
  const trialLength = access.trialStartedAt && access.trialExpiresAt
    ? (new Date(access.trialExpiresAt).getTime() - new Date(access.trialStartedAt).getTime()) / 1000 : 0;
  const trialPercent = trialLength > 0 ? Math.max(0, Math.min(100, access.remainingTrialSeconds / trialLength * 100)) : 0;
  const selected = plans.find((plan) => plan.id === selectedPlan);
  const blockedBySubscription = access.checkoutBlockedBySubscription ?? (!!current && (
    !["CANCELLED", "COMPLETED", "EXPIRED", "FAILED"].includes(current.status) ||
    !!(current.paidUntil && new Date(current.paidUntil).getTime() > new Date(access.serverTime).getTime())
  ));
  const resumable = !!current && ["CREATED", "AUTHENTICATED"].includes(current.status) && !current.currentPeriodStart && !current.paidUntil;
  const canCheckout = (plan: BillingPlan) => plan.configured &&
    (access.checkoutAllowed ?? (!access.accessMode || access.accessMode === "AUTO")) &&
    access.billingRecovery?.state !== "CONFLICT" &&
    user.role === "ORGANIZATION_ADMIN" && (!blockedBySubscription || resumable);
  useEffect(() => {
    if (!selected) return;
    try { sessionStorage.setItem(BILLING_CONTINUATION, billingHref(selected, review)); } catch { /* URL still carries intent. */ }
  }, [selected, review]);
  if (checkoutOnly) return <div className="billing-panel billing-checkout-panel">
    <Link className="billing-text-link" href="/billing">← Back to plans and billing</Link>
    {access.billingRecovery?.state === "CONFLICT" && <p className="auth-alert" role="alert">Payment and cancellation need review. Your payment records and verified paid time are retained. Contact your platform administrator; do not pay again.</p>}
    {error && <p className="auth-alert" role="alert">{error}</p>}
    {message && <p className="billing-neutral" role="status">{message}</p>}
    {purchaseId ? <PaymentStatus key={purchaseId} subscriptionId={purchaseId} pollingEnabled={!checkoutOpen} onBack={() => { showPurchase(""); void updateStatus().catch(() => {}); }} /> : selected ? <SubscriptionPurchase key={selected.id} plan={selected} plans={plans} organizationName={user.organization.name} disabled={busy || !canCheckout(selected)} onPay={checkout} /> : <p role="status">Loading your selected plan…</p>}
    {selected && blockedBySubscription && !resumable && <p className="billing-neutral">An existing subscription prevents a new checkout. <Link href="/billing">Manage your current subscription</Link> before choosing another plan.</p>}
    {selected && resumable && current?.planId !== selected.id && <p className="billing-neutral">You can choose this plan. Proceeding to payment safely replaces your previous unpaid authorization. No payment starts from selecting a plan.</p>}
  </div>;
  return (
    <div className="billing-panel">
      {access.billingRecovery && <p className="billing-neutral" role="status">{access.billingRecovery.state === "CONFLICT" ? "Payment and cancellation need review. Payment records and verified paid time are retained. Contact your platform administrator; do not pay again." : "Your previous subscription is being checked before a plan change. Wait one minute, then refresh provider status before proceeding."}</p>}
      {access.accessMode === "SUSPENDED" && <div className="billing-warning" role="status"><h2>Workspace access is suspended.</h2><p>Contact your platform administrator to restore access. Existing billing history and cancellation remain available. A new payment will not remove this suspension.</p></div>}
      {access.accessMode === "CONTROLLED" && <div className="billing-neutral" role="status"><h2>{formatAccessState(access.state)}</h2><p>{access.checkoutAllowed ? "Your platform administrator updated your trial dates. You can purchase a plan at any time; paid access starts after payment is verified." : "Your platform administrator manages trial and subscription access dates. Contact them to adjust access. Existing payment-provider charges and billing history remain separate."}</p></div>}
      {access.accessMode === "MANUAL" && access.manualAccess && <div className="billing-neutral" role="status"><h2>{formatAccessState(access.state)}</h2><p>Your platform administrator set workspace access from {formatDate(access.manualAccess.startsAt)} until {formatDate(access.manualAccess.expiresAt)}. These dates are separate from payment-provider billing dates. Contact your platform administrator to adjust them.</p></div>}
      {invalidSelection && <p className="auth-alert" role="alert">This plan selection is invalid or no longer available. Choose a plan below.</p>}
      {required && (
        <div className="billing-warning" role="status">
          <h2>{access.checkoutAllowed || access.accessMode === "AUTO" || !access.accessMode ? "A subscription is needed to continue." : "Contact your platform administrator to restore access."}</h2>
          <p>
            Your organization’s business operations are restricted. Account
            settings, email verification, recovery, billing, and logout remain
            available. Your data has not been deleted.
          </p>
        </div>
      )}
      {!initial.providerAvailable && (
        <div className="billing-neutral">
          <strong>Billing setup is not complete.</strong>
          <p>
            {initial.checkoutReadiness.message} Configured prices remain
            visible.
          </p>
        </div>
      )}
      {error && (
        <p className="auth-alert" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="account-success" role="status">
          {message}
        </p>
      )}
      <section
        className="billing-overview"
        aria-label="Current subscription and trial"
      >
        <div className="billing-summary">
          <div className="billing-summary-heading">
            <span className="billing-summary-icon"><Icon name="wallet" /></span>
            <span className={`billing-status ${access.allowed ? "is-active" : "is-restricted"}`}>{formatAccessState(access.state)}</span>
          </div>
          <span className="billing-label">CURRENT PLAN</span>
          <h2>{access.source === "MANUAL" ? access.manualAccess?.plan?.name || "Admin-managed access" : trialActive ? "Free trial" : current?.planName || "No paid subscription"}</h2>
          <p>{trialActive ? "Explore your workspace before choosing a paid plan." : access.allowed ? "Your organization has access to the workspace." : "Choose an available plan to restore workspace access."}</p>
          <a className="billing-text-link" href="#billing-plans-heading">Explore plans <Icon name="arrow" /></a>
        </div>
        <div className="billing-summary-metrics">
          {access.source === "MANUAL" && access.manualAccess ? <><div><span className="billing-label">ACCESS TYPE</span><strong>Admin-managed</strong><small>{access.manualAccess.plan ? `${access.manualAccess.plan.interval === "MONTHLY" ? "Monthly" : "Yearly"} plan - No payment collected by this assignment` : "Access assigned by your platform administrator"}</small></div><div><span className="billing-label">ACCESS ENDS</span><strong className="billing-date">{formatDate(access.manualAccess.expiresAt)}</strong><small>Dates set by your platform administrator</small></div></> : <><div><span className="billing-label">{trialActive ? "TRIAL REMAINING" : "BILLING CYCLE"}</span><strong>{trialActive ? `${trialDays} day${trialDays === 1 ? "" : "s"}` : current ? current.interval === "MONTHLY" ? "Monthly" : "Yearly" : "No active cycle"}</strong>{trialActive ? <><progress value={trialPercent} max={100} aria-label="Free trial time remaining" /><small>Days remaining, rounded up</small></> : <small>{current ? formatMoney(current.amountMinor, current.currency) + " per billing cycle" : "Choose monthly or yearly billing"}</small>}</div>
          <div><span className="billing-label">{trialActive ? "TRIAL ENDS" : current?.cancelAtCycleEnd ? "PAID ACCESS UNTIL" : "NEXT BILLING DATE"}</span><strong className="billing-date">{formatDate(trialActive ? access.trialExpiresAt : current?.cancelAtCycleEnd ? current.paidUntil : current?.nextBillingAt || null)}</strong><small>{trialActive ? "No payment details required for your trial" : current?.cancelAtCycleEnd ? "Renewal cancellation is scheduled" : "Based on the latest verified billing status"}</small></div></>}
        </div>
      </section>
      <details className="billing-details">
        <summary>Subscription details <Icon name="chevron" /></summary>
        <dl>
          <div>
            <dt>Trial started</dt>
            <dd>{formatDate(access.trialStartedAt)}</dd>
          </div>
          <div>
            <dt>Trial ends</dt>
            <dd>{formatDate(access.trialExpiresAt)}</dd>
          </div>
          <div>
            <dt>Trial time remaining</dt>
            <dd>
              {access.remainingTrialSeconds > 0
                ? `${Math.ceil(access.remainingTrialSeconds / 86400)} day${Math.ceil(access.remainingTrialSeconds / 86400) === 1 ? "" : "s"} (rounded up)`
                : "Trial not active"}
            </dd>
          </div>
          <div>
            <dt>Current plan</dt>
            <dd>{access.source === "MANUAL" ? access.manualAccess?.plan?.name || "Admin-managed access" : current?.planName || "No paid subscription"}</dd>
          </div>
          <div>
            <dt>Provider billing period</dt>
            <dd>
              {current
                ? current.interval === "MONTHLY"
                  ? "Monthly"
                  : "Yearly"
                : "No paid plan selected"}
            </dd>
          </div>
          <div>
            <dt>Provider subscription status</dt>
            <dd>
              {current ? formatAccessState(current.status) : "No subscription"}
            </dd>
          </div>
          <div>
            <dt>Current period starts</dt>
            <dd>{formatDate(current?.currentPeriodStart || null)}</dd>
          </div>
          <div>
            <dt>Current period ends</dt>
            <dd>{formatDate(current?.currentPeriodEnd || null)}</dd>
          </div>
          <div>
            <dt>Latest payment</dt>
            <dd>
              {current?.latestPayment
                ? `${current.latestPayment.status} · ${formatMoney(current.latestPayment.amountMinor, current.latestPayment.currency)}`
                : "No verified payment attempts recorded"}
            </dd>
          </div>
          <div>
            <dt>Cancellation</dt>
            <dd>
              {current?.cancelAtCycleEnd
                ? `Scheduled for ${formatDate(current.currentPeriodEnd)}`
                : current?.cancelledAt
                  ? formatDate(current.cancelledAt)
                  : "No cancellation recorded"}
            </dd>
          </div>
          <div>
            <dt>Verified paid through</dt>
            <dd>{formatDate(current?.paidUntil || null)}</dd>
          </div>
          <div>
            <dt>Next billing date</dt>
            <dd>
              {current?.cancelAtCycleEnd
                ? "Renewal cancellation scheduled"
                : formatDate(current?.nextBillingAt || null)}
            </dd>
          </div>
        </dl>
      </details>
      {current && (
        <div className="billing-actions">
          <button
            className="button secondary"
            disabled={busy || !initial.providerAvailable}
            onClick={() => action("refresh")}
          >
            Refresh provider status
          </button>
          {["CREATED", "AUTHENTICATED"].includes(current.status) &&
            plans.find((plan) => plan.id === current.planId)?.configured && (
              <button
                className="button primary"
                disabled={busy || user.role !== "ORGANIZATION_ADMIN"}
                onClick={() => {
                  const plan = plans.find((plan) => plan.id === current.planId);
                  if (plan) router.push(checkoutHref(plan));
                }}
              >
                Complete payment authorization
              </button>
            )}
          {["CREATING", "CREATE_UNKNOWN"].includes(current.status) && (
            <p role="status">
              Provider creation is unresolved. Refresh status before another
              checkout; a duplicate subscription will not be created.
            </p>
          )}
          {access.state === "PAST_DUE" && (
            <p role="status">
              A payment is overdue. Razorpay manages retries according to the
              payment method and mandate. Review the provider result; access
              ends at the verified paid cutoff plus any configured grace.
            </p>
          )}
          {!["CANCELLED", "COMPLETED", "EXPIRED", "FAILED"].includes(
            current.status,
          ) &&
            !current.cancelAtCycleEnd && (
              <button
                className="button secondary"
                disabled={
                  busy || !initial.providerAvailable || user.role !== "ORGANIZATION_ADMIN"
                }
                onClick={() => action("cancel")}
              >
                {current.currentPeriodStart
                  ? "Cancel renewal"
                  : "Cancel pending subscription"}
              </button>
            )}
          {current.cancelAtCycleEnd && (
            <p>
              Cancellation is scheduled. Paid access is retained through the
              verified paid-through date.
            </p>
          )}
        </div>
      )}
      <section aria-labelledby="billing-plans-heading">
        <div className="section-heading">
          <div>
            <h2 id="billing-plans-heading">Find the right plan</h2>
            <p>Simple, organization-level pricing. Choose the billing cycle that works for you.</p>
          </div>
          <div
            className="billing-toggle"
            role="group"
            aria-label="Billing interval"
          >
            <button
              aria-pressed={interval === "MONTHLY"}
              onClick={() => setInterval("MONTHLY")}
            >
              Monthly
            </button>
            <button
              aria-pressed={interval === "YEARLY"}
              onClick={() => setInterval("YEARLY")}
            >
              Yearly
            </button>
          </div>
        </div>
        {catalogLoading ? (
          <p role="status">Loading plan configuration…</p>
        ) : !plans.some((plan) => plan.interval === interval) ? (
          <p className="billing-neutral" role="alert">
            Plan configuration for this billing period is unavailable. Please
            try again later.
          </p>
        ) : (
          <div className="billing-plan-grid">
            {plans
              .filter((plan) => plan.interval === interval)
              .map((plan) => (
                <article
                  className="billing-plan"
                  key={plan.id}
                  data-selected={plan.id === selectedPlan || undefined}
                  data-current={plan.id === currentPlanId && !resumable || undefined}
                >
                  <div className="billing-plan-title"><h3>{plan.name}</h3>{plan.id === selectedPlan ? <span className="billing-plan-badge">Selected</span> : plan.id === currentPlanId ? <span className="billing-plan-badge">{access.source === "MANUAL" ? "Admin-assigned" : resumable ? "Payment pending" : "Current plan"}</span> : null}</div>
                  <div className="billing-price">
                    {plan.amountMinor !== null
                      ? formatMoney(plan.amountMinor, plan.currency)
                      : "Price unavailable"}
                    {plan.amountMinor !== null && <span> / {plan.interval === "MONTHLY" ? "month" : "year"}</span>}
                  </div>
                  <p>
                    {plan.interval === "MONTHLY" ? "Monthly" : "Yearly"} billing
                    · Per organization
                  </p>
                  {yearlySavings(plan, plans) !== null && (
                    <p className="billing-savings">
                      Save{" "}
                      {formatMoney(yearlySavings(plan, plans)!, plan.currency)}{" "}
                      per year compared with 12 monthly payments.
                    </p>
                  )}
                  <p className="account-help">{plan.taxNote}</p>
                  <p className="billing-plan-inclusion"><Icon name="check" /> Billed per organization</p>
                  <p className="billing-plan-inclusion"><Icon name="check" /> Cancel future renewals</p>
                  <p className="account-help">
                    {`Renews every ${plan.interval === "MONTHLY" ? "month" : "year"} for up to ${plan.totalCount} payment${plan.totalCount === 1 ? "" : "s"}, unless cancelled. The subscription ends after its final cycle.`}
                    {!plan.configured &&
                      ` ${plan.unavailableReason || "Razorpay setup is pending."}`}
                  </p>
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      !canCheckout(plan)
                    }
                    onClick={() => router.push(checkoutHref(plan))}
                  >
                    {busy
                      ? "Please wait…"
                      : plan.id === currentPlanId && !resumable
                        ? access.source === "MANUAL" ? "Admin-assigned plan" : "Current plan"
                      : plan.configured
                        ? `Choose ${plan.name}`
                        : "Checkout unavailable"}
                  </button>
                </article>
              ))}
          </div>
        )}
        {access.checkoutReplacementRequired && <p className="billing-neutral">You can choose a plan after your administrator switched this organization to trial. The payment summary will ask you to confirm ending previous renewals before a replacement starts. Earlier payments remain in your history.</p>}
        {current?.supersededByAccessPolicy ? <p className="small-note">A new paid period starts after verified payment. Earlier payments and trial dates are retained. No automatic refunds or proration.</p> : <p className="small-note">
          Plan changes require cancelling the existing subscription and waiting
          until its paid period ends. No automatic proration. Failed renewals
          restrict access after the paid period
          {access.graceHours
            ? ` plus ${access.graceHours} hours of grace`
            : "; no grace period is configured"}
          .
        </p>}
        {user.role !== "ORGANIZATION_ADMIN" && <p className="billing-neutral">Only an organization administrator can choose a plan or manage payments.</p>}
        {blockedBySubscription && <p className="account-help">{resumable ? "You can choose any plan. Proceeding to payment replaces the previous unpaid authorization safely." : "An existing subscription prevents a new checkout. Manage renewal above; another plan becomes available after the verified paid period ends."}</p>}
      </section>
      <section
        className="billing-history"
        aria-labelledby="billing-history-heading"
      >
        <div className="billing-history-heading"><div><h2 id="billing-history-heading">Payment history</h2><p>Your organization’s recorded payments, all in one place.</p></div><span className="billing-history-icon"><Icon name="wallet" /></span></div>
        {user.role !== "ORGANIZATION_ADMIN" ? <p className="billing-history-feedback">Payment history is available to your organization administrator.</p> : historyLoading ? <p className="billing-history-feedback" role="status">Loading payment history…</p> : historyError ? <div className="billing-history-error"><p className="auth-alert" role="alert">Payment history could not be loaded. {historyError}</p><button className="button secondary" onClick={retryHistory}>Try again</button></div> : payments.length ? (
          <div className="billing-table-scroll"><table className="billing-payment-table">
            <caption className="billing-sr-only">Recorded subscription payments</caption>
            <thead><tr><th scope="col">Plan</th><th scope="col">Date (IST)</th><th scope="col">Status</th><th scope="col">Amount</th></tr></thead>
            <tbody>
            {payments.map((payment) => (
              <tr key={payment.id}>
                <th scope="row">{payment.subscription.plan.name}</th>
                 <td>{formatDate(payment.paidAt || payment.captureVerifiedAt || payment.paymentCreatedAt || payment.createdAt)}{!payment.paidAt && payment.captureVerifiedAt && <small> Capture verified</small>}</td>
                <td><span className="billing-payment-status">{payment.status.replaceAll("_", " ").toLowerCase()}</span></td>
                 <td>{formatMoney(payment.amountMinor, payment.currency)}{!!payment.amountRefundedMinor && <small> Refunded: {formatMoney(payment.amountRefundedMinor, payment.currency)}</small>}</td>
              </tr>
            ))}
            </tbody>
          </table></div>
        ) : (
          <div className="billing-empty-history"><span className="billing-empty-icon"><Icon name="wallet" /></span><h3>No payments yet</h3><p>Your payment history will appear here once a payment is recorded.</p></div>
        )}
      </section>
      <footer className="billing-footer"><p>Employee, attendance, leave, and payroll modules are still in development. A subscription does not make unfinished modules operational.</p><Link href="/pricing">Compare all plans <Icon name="arrow" /></Link></footer>
    </div>
  );
}

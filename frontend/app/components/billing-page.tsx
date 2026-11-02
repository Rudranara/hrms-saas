import { redirect } from "next/navigation";
import { connection } from "next/server";
import Link from "next/link";
import { getBillingStatus, getCurrentUser } from "../lib/auth-server";
import { BillingPanel } from "./billing-panel";
import { LogoutButton } from "./logout-button";
import { Icon } from "./ui-icon";
import { apiBaseUrl } from "../lib/auth-server";
import { parsePlanCatalog } from "../lib/billing-types";
import { billingReturn, billingHref, selectedBillingPlan } from "../lib/billing-continuation";
import "../auth.css";
import "../account.css";
import "../billing/billing.css";
export async function BillingPageContent({
  required = false,
  checkoutOnly = false,
  searchParams,
}: {
  required?: boolean;
  checkoutOnly?: boolean;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Plan lookups and their timeout must run for a real request, not a prerender.
  await connection();
  const query = searchParams ? await searchParams : {};
  const selectionRequested = Object.keys(query).length > 0;
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) value.forEach((item) => parameters.append(key, item));
    else if (value !== undefined) parameters.append(key, value);
  }
  const continuation = billingReturn(`/billing?${parameters}`);
  let selectedPlan = "";
  let destination = "";
  if (continuation) {
    const response = await fetch(`${apiBaseUrl()}/api/billing/plans`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Plan configuration is temporarily unavailable. Please retry.");
    const plan = selectedBillingPlan(continuation, parsePlanCatalog((await response.json()).plans));
    if (plan) {
      selectedPlan = plan.id;
      destination = billingHref(plan, query.review === "1");
    }
  }
  const user = await getCurrentUser();
  if (!user)
    redirect(
      selectedPlan
        ? `/login?next=${encodeURIComponent(destination)}`
        : "/login",
    );
  const status = await getBillingStatus();
  // Preserve old selected-plan links, quotes and pending-payment bookmarks.
  if (!checkoutOnly && selectedPlan) redirect(`/billing/checkout?${parameters}`);
  if (checkoutOnly && !selectedPlan) redirect("/billing");
  if (required && status.access.allowed) redirect("/billing");
  return (
    <main className={`workspace-page billing-workspace${checkoutOnly ? " billing-checkout-workspace" : ""}`}>
      <header className="workspace-header section-shell">
        <Link className="brand" href="/dashboard" aria-label="HRMS dashboard">
          <span className="brand-mark">
            <Icon name="organization" />
          </span>
          HRMS
        </Link>
        <div className="billing-header-actions">
          <Link href="/dashboard" className="billing-workspace-link"><Icon name="grid" /> Workspace</Link>
          <LogoutButton />
        </div>
      </header>
      <div className="section-shell workspace-content">
        <nav className="billing-breadcrumb" aria-label="Breadcrumb">
          <Link href="/dashboard">Workspace</Link><span aria-hidden="true">/</span>{checkoutOnly ? <><Link href="/billing">Billing</Link><span aria-hidden="true">/</span><span aria-current="page">Checkout</span></> : <span aria-current="page">Billing</span>}
        </nav>
        <div className="billing-page-heading">
          <div>
            <h1>{checkoutOnly ? "Complete your subscription" : required ? "Restore your workspace access" : "Plans & billing"}</h1>
            <p>{checkoutOnly ? "Review your plan and recurring terms before proceeding to payment." : "Manage your subscription, compare plans, and track payments."}</p>
          </div>
          <span className="billing-organization"><Icon name="organization" />{user.organization.name}</span>
        </div>
        <BillingPanel
          user={user}
          checkoutOnly={checkoutOnly}
          initial={status}
          required={required}
          selectedPlan={selectedPlan}
          review={query.review === "1"}
          invalidSelection={selectionRequested && !selectedPlan}
        />
      </div>
    </main>
  );
}

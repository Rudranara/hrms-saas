"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { formatDate, formatMoney } from "../lib/billing-types";
import { statusLabels, type AdminMetrics, type OrganizationReport, type Paginated, type AdminSubscription, type AdminPayment } from "../lib/super-admin-types";
import { platformLoginHref } from "../lib/auth-redirects";
import { OrganizationAccessControls } from "./organization-access-controls";

class ReportingError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
type ReportIssue = { message: string; signIn: boolean };
function reportIssue(error: unknown): ReportIssue {
  if (error instanceof ReportingError && error.status === 401)
    return { message: "Your platform session could not be verified. Sign in again to continue.", signIn: true };
  if (error instanceof ReportingError && error.status === 403)
    return { message: "This account no longer has platform access. Sign in with an existing provisioned Super Admin account.", signIn: true };
  return { message: error instanceof Error ? error.message : "Reporting is temporarily unavailable. Please retry.", signIn: false };
}

async function request<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/super-admin/${path}`, { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) throw new ReportingError(result.message || "Reporting is temporarily unavailable. Please retry.", response.status);
  return result;
}
export function AdminBadge({ value }: { value: string | null }) {
  return <span className="platform-badge" data-state={value || "NONE"}>{value ? statusLabels[value] || value.replaceAll("_", " ").toLowerCase() : "No record"}</span>;
}
function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (page: number) => void }) {
  return <nav className="platform-pager" aria-label="Report pagination"><span>{total.toLocaleString("en-IN")} records · Page {page} of {Math.max(1, Math.ceil(total / pageSize))}</span><div><button className="button secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button><button className="button secondary" disabled={page * pageSize >= total} onClick={() => onPage(page + 1)}>Next</button></div></nav>;
}
export function SuperAdminPanel() {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null), [list, setList] = useState<Paginated<OrganizationReport> | null>(null);
  const [filters, setFilters] = useState({ q: "", status: "ALL", page: 1 }), [range, setRange] = useState({ from: "", to: "" });
  const [error, setError] = useState<ReportIssue | null>(null), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams();
    if (range.from) query.set("from", range.from);
    if (range.to) query.set("to", range.to);
    request<AdminMetrics>(`metrics?${query}`, controller.signal).then(setMetrics).catch((error) => { if (!controller.signal.aborted) setError(reportIssue(error)); });
    return () => controller.abort();
  }, [range, revision]);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ q: filters.q, status: filters.status, page: String(filters.page), pageSize: "20" });
    request<Paginated<OrganizationReport>>(`organizations?${query}`, controller.signal).then(setList).catch((error) => { if (!controller.signal.aborted) setError(reportIssue(error)); });
    return () => controller.abort();
  }, [filters, revision]);
  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    setError(null); setList(null); setFilters({ q: String(form.get("q") || ""), status: String(form.get("status") || "ALL"), page: 1 });
  }
  function applyDates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    setError(null); setMetrics(null); setRange({ from: String(form.get("from") || ""), to: String(form.get("to") || "") });
  }
  return <div className="platform-panel">
    {error && <div className="auth-alert" role="alert">{error.message} {error.signIn ? <Link href={platformLoginHref("/super-admin")}>Sign in again</Link> : <button onClick={() => { setError(null); setRevision((value) => value + 1); }}>Retry reports</button>}</div>}
    <section aria-labelledby="platform-metrics"><div className="platform-section-heading"><div><span className="eyebrow">LIVE DATABASE REPORTS</span><h2 id="platform-metrics">Platform at a glance</h2></div><button className="button secondary" onClick={() => { setError(null); setMetrics(null); setList(null); setRevision((value) => value + 1); }}>Refresh reports</button></div>
      {!metrics ? !error && <p role="status">Loading platform metrics…</p> : <>
        <div className="platform-metrics">{[
          ["totalOrganizations", "Registered organizations"], ["activeTrials", "Active free trials"], ["paidActive", "Verified active paid"], ["expiredTrials", "Expired trials"],
          ["paymentPending", "Payment / authorization pending"], ["paymentFailed", "Payment / checkout issues"], ["cancelled", "Cancelled subscriptions"], ["expiredSubscriptions", "Expired subscription state"],
          ["manualAccess", "Admin-managed active access"], ["suspendedOrganizations", "Suspended organizations"],
        ].map(([key, label]) => <article key={key}><span>{label}</span><strong>{metrics.counts[key].toLocaleString("en-IN")}</strong></article>)}</div>
        <p className="account-help">As of {formatDate(metrics.asOf)}. Each metric counts an organization once. Trial and billing metrics can overlap. Converted trials: {metrics.counts.convertedTrials.toLocaleString("en-IN")} (historical conversion, separate from current status).</p>
      </>}
    </section>
    <section className="platform-revenue" aria-labelledby="platform-revenue"><div className="platform-section-heading"><div><span className="eyebrow">PROVIDER-CONFIRMED RECORDS</span><h2 id="platform-revenue">Captured payments</h2></div><form onSubmit={applyDates} className="platform-date-form"><label>From <input type="date" name="from" defaultValue={range.from} required /></label><label>Through <input type="date" name="to" defaultValue={range.to} required /></label><button className="button secondary">Apply dates</button></form></div>
      {metrics ? <><strong className="platform-revenue-total">{formatMoney(metrics.revenue.capturedAmountMinor, "INR")}</strong><p>{metrics.revenue.paymentCount} captured payments · {metrics.revenue.from} through {metrics.revenue.to} · Asia/Kolkata</p><p className="account-help">{metrics.revenue.note}</p><div className="platform-revenue-limits"><span>Refund totals: unavailable</span><span>Net revenue: unavailable</span></div></> : !error && <p role="status">Loading confirmed revenue…</p>}
    </section>
    <section aria-labelledby="platform-organizations"><div className="platform-section-heading"><div><span className="eyebrow">ORGANIZATION DIRECTORY</span><h2 id="platform-organizations">Every workspace, accounted for</h2></div></div>
      <form className="platform-filters" onSubmit={applySearch}><label>Search organizations<input name="q" type="search" placeholder="Name, ID or administrator email" maxLength={120} defaultValue={filters.q} /></label><label>Filter by status<select name="status" defaultValue={filters.status}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="button primary">Apply filters</button></form>
      {!list ? !error && <p role="status">Loading organizations…</p> : <>
        {list.items.length === 0 ? <div className="platform-empty">No organizations match these filters.</div> : <div className="platform-table-scroll"><table className="platform-table"><caption>Organizations and their current trial and billing status</caption><thead><tr><th>Organization</th><th>Administrator</th><th>Plan / cycle</th><th>Classification</th><th>Trial dates</th><th>Subscription period</th><th>Payment / renewal</th><th>Cancellation / failure</th></tr></thead><tbody>{list.items.map((org) => <tr key={org.id}>
          <td><Link href={`/super-admin/organizations/${encodeURIComponent(org.id)}`}>{org.name}</Link><small>{org.id}</small><small>Registered {formatDate(org.createdAt)}</small></td>
          <td>{org.administratorName || "Unavailable"}<small>{org.administratorEmail || "No administrator record"}</small></td>
          <td>{org.accessSource === "MANUAL" ? org.manualPlanName || "Admin-managed access" : org.planName || "No paid plan"}<small>{org.accessSource === "MANUAL" ? org.manualPlanCycle?.toLowerCase() || "Admin-managed" : org.billingCycle ? org.billingCycle.toLowerCase() : "—"}</small><small>Provider: {org.subscriptionStatus || "No subscription"}</small></td>
          <td><AdminBadge value={org.classification} /><small>{org.accessAllowed ? `Workspace allowed · ${org.accessSource.toLowerCase()}` : "Workspace access blocked"}</small><small>{org.hasPaidAccess ? "Verified provider-paid time remaining" : org.convertedAt ? "Converted from trial" : "No recorded conversion"}</small></td>
          <td>{formatDate(org.trialStartedAt)}<small>Ends {formatDate(org.trialEnd)}</small></td>
          <td>{formatDate(org.currentPeriodStart)}<small>Ends {formatDate(org.currentPeriodEnd)}</small></td>
          <td><AdminBadge value={org.paymentStatus} /><small>Next {org.cancelAtCycleEnd ? "Renewal cancelled" : formatDate(org.nextBillingAt)}</small></td>
          <td>{org.cancelAtCycleEnd ? "Cancellation scheduled" : org.cancelledAt ? `Cancelled ${formatDate(org.cancelledAt)}` : org.classification === "PAST_DUE" ? "Failed / overdue; inspect payment history" : "No cancellation recorded"}<small>{org.lastSyncedAt ? `Synced ${formatDate(org.lastSyncedAt)}` : "No provider synchronization recorded"}</small></td>
        </tr>)}</tbody></table></div>}
        <Pager {...list} onPage={(page) => { setList(null); setFilters({ ...filters, page }); }} />
      </>}
    </section>
  </div>;
}

export function SuperAdminDetail({ id }: { id: string }) {
  const [organization, setOrganization] = useState<OrganizationReport | null>(null);
  const [subscriptions, setSubscriptions] = useState<Paginated<AdminSubscription> | null>(null), [payments, setPayments] = useState<Paginated<AdminPayment> | null>(null);
  const [subscriptionPage, setSubscriptionPage] = useState(1), [paymentPage, setPaymentPage] = useState(1), [revision, setRevision] = useState(0), [error, setError] = useState<ReportIssue | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    request<{ organization: OrganizationReport }>(`organizations/${encodeURIComponent(id)}`, controller.signal).then((data) => setOrganization(data.organization)).catch((error) => { if (!controller.signal.aborted) setError(reportIssue(error)); });
    return () => controller.abort();
  }, [id, revision]);
  useEffect(() => {
    const controller = new AbortController();
    request<Paginated<AdminSubscription>>(`organizations/${encodeURIComponent(id)}/subscriptions?page=${subscriptionPage}&pageSize=10`, controller.signal).then(setSubscriptions).catch((error) => { if (!controller.signal.aborted) setError(reportIssue(error)); });
    return () => controller.abort();
  }, [id, subscriptionPage, revision]);
  useEffect(() => {
    const controller = new AbortController();
    request<Paginated<AdminPayment>>(`organizations/${encodeURIComponent(id)}/payments?page=${paymentPage}&pageSize=10`, controller.signal).then(setPayments).catch((error) => { if (!controller.signal.aborted) setError(reportIssue(error)); });
    return () => controller.abort();
  }, [id, paymentPage, revision]);
  return <div className="platform-panel organization-detail-panel"><Link className="organization-back-link" href="/super-admin">← All organizations</Link>
    {error && <div className="auth-alert" role="alert">{error.message} {error.signIn ? <Link href={platformLoginHref(`/super-admin/organizations/${id}`)}>Sign in again</Link> : <button onClick={() => { setError(null); setRevision((value) => value + 1); }}>Retry details</button>}</div>}
    {!organization ? !error && <p role="status">Loading organization details…</p> : <section className="platform-detail"><span className="eyebrow">ORGANIZATION DETAIL</span><h2>{organization.name}</h2><p>{organization.id}</p><AdminBadge value={organization.classification} /><dl>
      <div><dt>Registered</dt><dd>{formatDate(organization.createdAt)}</dd></div><div><dt>Initial administrator</dt><dd>{organization.administratorName || "Unavailable"} · {organization.administratorEmail || "Unavailable"}</dd></div>
      <div><dt>Contact phone</dt><dd>{organization.phoneNumber ? <a href={`tel:${organization.phoneNumber}`}>{organization.phoneNumber}</a> : "Not provided"}</dd></div>
      <div><dt>Organization employee size</dt><dd>{organization.employeeSize ? `${organization.employeeSize} employees` : "Not provided"}</dd></div>
      <div><dt>Current plan / cycle</dt><dd>{organization.accessSource === "MANUAL" ? organization.manualPlanName || "Admin-managed access" : organization.planName || "No plan"} · {organization.accessSource === "MANUAL" ? organization.manualPlanCycle || "Admin-managed" : organization.billingCycle || "—"}</dd></div><div><dt>Trial</dt><dd>{formatDate(organization.trialStartedAt)} — {formatDate(organization.trialEnd)}</dd></div>
      <div><dt>Historical conversion</dt><dd>{formatDate(organization.convertedAt)}</dd></div><div><dt>Verified paid through</dt><dd>{formatDate(organization.paidUntil)}</dd></div><div><dt>Next renewal</dt><dd>{organization.cancelAtCycleEnd ? "Cancellation scheduled" : formatDate(organization.nextBillingAt)}</dd></div>
    </dl><p className="account-help">Administrator is the earliest retained user record. Historical user-role changes and detailed provider failure reasons are not stored.</p></section>}
    <OrganizationAccessControls id={id} onChange={() => setRevision((value) => value + 1)} />
    <section><h2>Subscription history</h2>{!subscriptions ? !error && <p role="status">Loading subscription history…</p> : <>{subscriptions.items.length ? <div className="platform-table-scroll"><table className="platform-table"><thead><tr><th>Plan</th><th>Status</th><th>Billing period</th><th>Paid through / renewal</th><th>Cancellation</th></tr></thead><tbody>{subscriptions.items.map((sub) => <tr key={sub.id}><td>{sub.plan.name}<small>{sub.interval.toLowerCase()} · {formatMoney(sub.amountMinor, sub.currency)}</small><small>{sub.id}</small></td><td><AdminBadge value={sub.status} /><small>Synced {formatDate(sub.lastSyncedAt)}</small></td><td>{formatDate(sub.currentPeriodStart)}<small>Ends {formatDate(sub.currentPeriodEnd)}</small></td><td>{formatDate(sub.paidUntil)}<small>Next {sub.cancelAtCycleEnd ? "Cancelled" : formatDate(sub.nextBillingAt)}</small></td><td>{sub.cancelAtCycleEnd ? "Scheduled at cycle end" : formatDate(sub.cancelledAt)}</td></tr>)}</tbody></table></div> : <p className="platform-empty">No subscriptions recorded.</p>}<Pager {...subscriptions} onPage={(page) => { setSubscriptions(null); setSubscriptionPage(page); }} /></>}</section>
    <section><h2>Provider-confirmed payment history</h2>{!payments ? !error && <p role="status">Loading payment history…</p> : <>{payments.items.length ? <div className="platform-table-scroll"><table className="platform-table"><thead><tr><th>Plan / record</th><th>Amount</th><th>Status</th><th>Payment date</th></tr></thead><tbody>{payments.items.map((payment) => <tr key={payment.id}><td>{payment.subscription.plan.name}<small>{payment.subscription.interval.toLowerCase()} · {payment.id}</small></td><td>{formatMoney(payment.amountMinor, payment.currency)}</td><td><AdminBadge value={payment.status} /></td><td>{payment.paidAt ? formatDate(payment.paidAt) : "No captured payment date"}<small>Recorded {formatDate(payment.createdAt)}</small></td></tr>)}</tbody></table></div> : <p className="platform-empty">No provider-confirmed payment records.</p>}<Pager {...payments} onPage={(page) => { setPayments(null); setPaymentPage(page); }} /></>}</section>
  </div>;
}

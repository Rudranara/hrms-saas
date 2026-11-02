"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatDate, type BillingAccess } from "../lib/billing-types";
import type { Paginated } from "../lib/super-admin-types";
import { platformLoginHref } from "../lib/auth-redirects";

type AccessPlan = { id: string; name: string; interval: string };
type Snapshot = { accessMode: string; accessVersion: number; trialEnabled?: boolean; subscriptionEnabled?: boolean; manualAccessPlan?: AccessPlan | null; trialStartedAt: string | null; trialExpiresAt: string | null; manualAccessStartsAt: string | null; manualAccessExpiresAt: string | null };
type Event = { id: string; actorName: string; action: string; outcome: string; reason: string; before: Snapshot | null; after: Snapshot | null; failureCode: string | null; createdAt: string };
type Settings = { organization: Snapshot & { id: string; name: string }; plans: AccessPlan[]; access: BillingAccess; history: Paginated<Event> };
type Change = { action: "SET_CONTROLS"; requestId: string; expectedVersion: number; trialEnabled: boolean; subscriptionEnabled: boolean; planId?: string; trialExpiresAt?: string; startsAt?: string; expiresAt?: string };
const labels: Record<string, string> = { SET_CONTROLS: "Trial and subscription updated", MANUAL: "Subscription dates updated", EXTEND_TRIAL: "Trial extended", TRIAL_END: "Trial end updated", SUSPEND: "Access suspended", RESTORE: "Automatic access restored" };
const fields: [keyof Snapshot, string][] = [["manualAccessPlan", "Subscription plan"], ["accessMode", "Access policy"], ["trialEnabled", "Trial enabled"], ["subscriptionEnabled", "Subscription enabled"], ["trialStartedAt", "Original trial start"], ["trialExpiresAt", "Trial end"], ["manualAccessStartsAt", "Subscription start"], ["manualAccessExpiresAt", "Subscription end"], ["accessVersion", "Revision"]];
function day(value: string | null) { return value ? new Date(new Date(value).getTime() + 330 * 60000).toISOString().slice(0, 10) : ""; }
function endDay(value: string | null) { return value ? day(new Date(new Date(value).getTime() - 1).toISOString()) : ""; }
function istDate(value: string, end = false) { return new Date(new Date(`${value}T00:00:00+05:30`).getTime() + (end ? 86400000 : 0)).toISOString(); }
function periodEnd(start: string, interval: string) {
  if (!start || !["MONTHLY", "YEARLY"].includes(interval)) return "";
  const [year, month, date] = start.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + (interval === "YEARLY" ? 12 : 1), 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  // End dates are inclusive. Clamp to month end instead of overflowing short
  // months or leap years; starting on the first ends on the prior month's last day.
  target.setUTCDate(Math.min(date - 1, lastDay));
  return target.toISOString().slice(0, 10);
}
function display(field: keyof Snapshot, value: Snapshot[keyof Snapshot]) {
  if (field === "manualAccessPlan") return value && typeof value === "object" ? `${value.name} (${value.interval === "MONTHLY" ? "Monthly" : "Yearly"})` : "Not assigned";
  if (field === "trialEnabled" || field === "subscriptionEnabled") return value === undefined ? "Not recorded" : value ? "On" : "Off";
  return field === "accessMode" || field === "accessVersion" ? String(value) : formatDate(typeof value === "string" ? value : null);
}

function AccessForm({ data, busy, onSave }: { data: Settings; busy: boolean; onSave: (change: Change) => void }) {
  const org = data.organization;
  const [trial, setTrial] = useState(org.accessMode === "CONTROLLED" ? !!org.trialEnabled : data.access.allowed && data.access.source === "TRIAL");
  const [subscription, setSubscription] = useState(org.accessMode === "CONTROLLED" ? !!org.subscriptionEnabled : data.access.allowed && ["SUBSCRIPTION", "GRACE", "MANUAL"].includes(data.access.source));
  const savedPlan = data.plans.find((plan) => plan.id === org.manualAccessPlan?.id);
  const [planName, setPlanName] = useState(savedPlan?.name || "");
  const [billingInterval, setBillingInterval] = useState(savedPlan?.interval || "");
  const [startsAt, setStartsAt] = useState(day(org.manualAccessStartsAt || data.access.subscription?.currentPeriodStart || null) || day(data.access.serverTime));
  const [expiresAt, setExpiresAt] = useState(endDay(org.manualAccessExpiresAt || data.access.subscription?.paidUntil || null));
  function changeInterval(interval: string) {
    setBillingInterval(interval);
    if (interval) setExpiresAt(periodEnd(startsAt, interval));
  }
  function changeStart(start: string) {
    setStartsAt(start);
    if (billingInterval) setExpiresAt(periodEnd(start, billingInterval));
  }
  const planNames = [...new Set(data.plans.map((plan) => plan.name))];
  const selectedPlan = data.plans.find((plan) => plan.name === planName && plan.interval === billingInterval);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (subscription && !selectedPlan) return;
    const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    onSave({ action: "SET_CONTROLS", requestId: crypto.randomUUID(), expectedVersion: org.accessVersion, trialEnabled: trial, subscriptionEnabled: subscription,
      ...(trial ? { trialExpiresAt: istDate(values.trialExpiresAt, true) } : {}),
      ...(subscription ? { planId: selectedPlan!.id, startsAt: istDate(values.startsAt), expiresAt: istDate(values.expiresAt, true) } : {}) });
  }
  return <form className="auth-form organization-access-form" onSubmit={submit} aria-busy={busy}>
    <fieldset disabled={busy}>
      <div className="organization-access-options">
        <div className="organization-access-option" data-enabled={trial}>
          <div className="organization-access-option-heading"><div><h3 id="trial-toggle-label">Trial access</h3><p>Allow access until the trial end date.</p></div><button id="trial-toggle" type="button" role="switch" aria-checked={trial} aria-labelledby="trial-toggle-label" aria-controls="trial-dates" className="organization-access-switch" onClick={() => setTrial(!trial)}><span />{trial ? "On" : "Off"}</button></div>
          <div id="trial-dates" hidden={!trial}><div className="auth-field"><label htmlFor="trial-end">Trial end date</label><input id="trial-end" name="trialExpiresAt" type="date" min={day(org.trialStartedAt) || day(data.access.serverTime)} max="2100-12-30" defaultValue={endDay(org.trialExpiresAt)} required={trial} disabled={!trial} /></div></div>
        </div>
        <div className="organization-access-option" data-enabled={subscription}>
          <div className="organization-access-option-heading"><div><h3 id="subscription-toggle-label">Subscription access</h3><p>Allow access between the dates you set.</p></div><button id="subscription-toggle" type="button" role="switch" aria-checked={subscription} aria-labelledby="subscription-toggle-label" aria-controls="subscription-dates" className="organization-access-switch" onClick={() => setSubscription(!subscription)}><span />{subscription ? "On" : "Off"}</button></div>
          <div id="subscription-dates" hidden={!subscription}>
            <div className="auth-field"><label htmlFor="access-plan">Subscription plan</label><select id="access-plan" name="planName" value={planName} onChange={(event) => { setPlanName(event.target.value); setBillingInterval(""); }} required={subscription} disabled={!subscription}><option value="">Select a plan</option>{planNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></div>
            <div className="auth-field"><label htmlFor="access-interval">Billing period</label><select id="access-interval" name="billingInterval" value={billingInterval} onChange={(event) => changeInterval(event.target.value)} required={subscription} disabled={!subscription || !planName}><option value="">{planName ? "Select monthly or yearly" : "Select a plan first"}</option>{["MONTHLY", "YEARLY"].filter((interval) => data.plans.some((plan) => plan.name === planName && plan.interval === interval)).map((interval) => <option key={interval} value={interval}>{interval === "MONTHLY" ? "Monthly" : "Yearly"}</option>)}</select><p className="auth-field-help">Assigns plan access for the dates below. This does not collect payment or change existing renewal charges.</p>{!data.plans.length && <p role="alert">No plans are available. Contact your platform administrator.</p>}</div>
            <div className="organization-access-fields"><div className="auth-field"><label htmlFor="access-start">Start date</label><input id="access-start" name="startsAt" type="date" min="2000-01-01" max="2100-12-30" value={startsAt} onChange={(event) => changeStart(event.target.value)} required={subscription} disabled={!subscription} /></div><div className="auth-field"><label htmlFor="access-end">End date</label><input id="access-end" name="expiresAt" type="date" min="2000-01-01" max="2100-12-30" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required={subscription} disabled={!subscription} /></div></div><p className="auth-field-help">The end date is filled from the billing period and start date. You can adjust it before saving.</p></div>
        </div>
      </div>
      <p className="auth-field-help">Dates use IST and include the full end day. Either enabled option can allow access.</p>
      {!trial && !subscription && <p className="billing-warning" role="status">Both options are off. Workspace access will be blocked until the organization purchases a plan or access is enabled again. Billing remains available.</p>}
      <button className="button primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
    </fieldset>
  </form>;
}

export function OrganizationAccessControls({ id, onChange }: { id: string; onChange: () => void }) {
  const [data, setData] = useState<Settings | null>(null), [revision, setRevision] = useState(0), [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [signIn, setSignIn] = useState(false);
  const pending = useRef(false);
  const [retry, setRetry] = useState<Change | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/super-admin/organizations/${encodeURIComponent(id)}/access?page=${page}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const result = await response.json(); if (!response.ok) { setSignIn([401, 403].includes(response.status)); throw new Error(result.message || "Unable to load access settings."); } return result; })
      .then(setData).catch((error) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Access settings are unavailable."); });
    return () => controller.abort();
  }, [id, page, revision]);
  async function save(change: Change) {
    if (pending.current || data?.organization.id !== id) return;
    if (change.startsAt && change.expiresAt && change.expiresAt <= change.startsAt) { setError("The subscription end date must be on or after the start date."); return; }
    const payload = retry ?? change;
    setRetry(payload);
    pending.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/super-admin/organizations/${encodeURIComponent(id)}/access`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify(payload) });
      const result = await response.json();
      setRetry(null);
      if (!response.ok) { setSignIn([401, 403].includes(response.status)); setError(result.message || "The change could not be saved."); setRevision((value) => value + 1); return; }
      setMessage("Access settings saved."); setPage(1); setRevision((value) => value + 1); onChange();
    } catch { setError("The save could not be confirmed. Use Retry save to check the same change safely."); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section className="platform-detail organization-access-panel" aria-labelledby="organization-access-heading" data-access-version={data?.organization.accessVersion}>
    <div className="organization-access-title"><div><span className="eyebrow">ACCESS MANAGEMENT</span><h2 id="organization-access-heading">Trial and subscription</h2></div>{data && <span className="platform-badge" data-state={data.access.allowed ? "ACTIVE" : "FAILED"}>{data.access.allowed ? "Workspace access on" : "Workspace access off"}</span>}</div>
    <p className="account-help">Switch access on or off and choose the dates. Existing subscription charges continue separately.</p>
    {data && <p className="account-help" role="status"><strong>Current access: </strong>{!data.access.allowed ? "No active trial or subscription" : data.access.source === "TRIAL" ? "Free trial" : data.access.source === "GRACE" ? "Subscription (payment grace period)" : data.access.manualAccess?.plan && data.access.source === "MANUAL" ? `Subscription - ${data.access.manualAccess.plan.name} (${data.access.manualAccess.plan.interval === "MONTHLY" ? "Monthly" : "Yearly"})` : "Subscription"}</p>}
    {error && <p className="auth-alert" role="alert">{error} {signIn ? <a href={platformLoginHref(`/super-admin/organizations/${id}`)}>Sign in again</a> : retry ? <button type="button" className="button-link" disabled={busy} onClick={() => void save(retry)}>Retry save</button> : !data && <button type="button" className="button-link" onClick={() => { setError(""); setRevision((value) => value + 1); }}>Retry</button>}</p>}
    {message && <p className="account-success" role="status">{message}</p>}
    {!data || data.organization.id !== id ? !error && <p role="status">Loading access settings…</p> : <>
      <AccessForm key={`${id}:${data.organization.accessVersion}:${data.organization.accessMode === "CONTROLLED" ? "saved" : data.access.source}`} data={data} busy={busy || !!retry} onSave={(change) => void save(change)} />
      <details className="organization-access-history"><summary>Access change history ({data.history.total})</summary><p className="account-help">Every change records who made it and why.</p>{data.history.items.length ? <ul>{data.history.items.map((event) => <li key={event.id}><div className="organization-access-event-heading"><strong>{labels[event.action] || event.action}</strong><span className="platform-badge" data-state={event.outcome === "SUCCESS" ? "ACTIVE" : "FAILED"}>{event.outcome === "SUCCESS" ? "Saved" : "Rejected"}</span></div><p>{event.actorName} · {formatDate(event.createdAt)}</p><p>{event.reason}</p>{event.failureCode && <small>{event.failureCode.replaceAll("_", " ").toLowerCase()}</small>}{event.before && event.after && <details><summary>View previous and new values</summary><div className="platform-table-scroll"><table className="platform-table organization-access-audit-table"><thead><tr><th>Setting</th><th>Previous</th><th>New</th></tr></thead><tbody>{fields.map(([field, label]) => <tr key={field}><td>{label}</td><td>{display(field, event.before![field])}</td><td>{display(field, event.after![field])}</td></tr>)}</tbody></table></div></details>}</li>)}</ul> : <p className="platform-empty">No access changes recorded.</p>}{data.history.total > 20 && <nav className="platform-pager" aria-label="Access history pagination"><span>Page {page} of {Math.ceil(data.history.total / 20)}</span><div><button className="button secondary" type="button" disabled={busy || page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><button className="button secondary" type="button" disabled={busy || page * 20 >= data.history.total} onClick={() => setPage((value) => value + 1)}>Next</button></div></nav>}</details>
    </>}
  </section>;
}

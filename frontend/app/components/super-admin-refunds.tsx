"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { formatDate, formatMoney } from "../lib/billing-types";
import { definitiveRefundError, minorAmount, refundLabel, refundNotice, refundRequest, refundStatuses, type RefundItem, type RefundPage } from "../lib/refund-types";
import "../refunds.css";

function Decision({ row, busy, onDecide }: { row: RefundItem; busy: boolean; onDecide: (body: unknown) => Promise<void> }) {
  const [action, setAction] = useState("APPROVE"), [amount, setAmount] = useState((Math.min(row.remainingMinor, row.requestedAmountMinor) / 100).toFixed(2)), [error, setError] = useState("");
  const replay = useRef<unknown>(null);
  const [submitted, setSubmitted] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); const values = new FormData(event.currentTarget);
    const approved = minorAmount(amount);
    if (!replay.current) {
      if (action === "APPROVE" && (approved === null || approved > row.remainingMinor || approved > row.requestedAmountMinor)) { setError("Enter a positive amount within the remaining balance and requested amount, with at most two decimal places."); return; }
      if (action === "APPROVE" && !window.confirm(`Issue a ${formatMoney(approved!, row.currency)} refund for payment ${row.providerPaymentId}? This sends money back through Razorpay. Subscription renewals are not cancelled.`)) return;
      replay.current = action === "APPROVE" ? { action, amountMinor: approved, confirmed: true, expectedVersion: row.version, requestId: crypto.randomUUID() } : { action, reason: String(values.get("reason") || "").trim(), expectedVersion: row.version, requestId: crypto.randomUUID() };
    }
    setSubmitted(true);
    try { await onDecide(replay.current); }
    catch (error) {
      if (definitiveRefundError(error)) { replay.current = null; setSubmitted(false); }
      setError(error instanceof Error ? error.message : "The decision could not be confirmed. Retry the same decision safely.");
    }
  }
  return <form className="auth-form refund-decision" onSubmit={submit}><fieldset disabled={busy}><div className="auth-field"><label htmlFor={`decision-${row.id}`}>Decision</label><select id={`decision-${row.id}`} value={action} disabled={submitted} onChange={event => setAction(event.target.value)}><option value="APPROVE">Approve refund</option><option value="REJECT">Reject request</option></select></div>{action === "APPROVE" ? <div className="auth-field"><label htmlFor={`amount-${row.id}`}>Approved amount ({row.currency})</label><input id={`amount-${row.id}`} inputMode="decimal" value={amount} readOnly={submitted} onChange={event => setAmount(event.target.value)} required /><p className="auth-field-help">Use the full remaining balance or enter a smaller amount for a partial refund.</p></div> : <div className="auth-field"><label htmlFor={`reason-${row.id}`}>Rejection reason</label><textarea id={`reason-${row.id}`} name="reason" minLength={5} maxLength={1000} required readOnly={submitted} /></div>}{error && <p className="auth-alert" role="alert">{error}</p>}<button className="button primary" type="submit">{busy ? "Saving…" : submitted ? "Retry same decision" : action === "APPROVE" ? "Review and issue refund" : "Reject request"}</button></fieldset></form>;
}
function PreparedRecovery({ row, busy, onSave }: { row: RefundItem; busy: boolean; onSave: (body: unknown) => Promise<void> }) {
  const [action, setAction] = useState("AMEND"), [amount, setAmount] = useState((Math.min(row.remainingMinor, row.approvedAmountMinor ?? 0) / 100).toFixed(2)), [submitted, setSubmitted] = useState(false), [error, setError] = useState("");
  const replay = useRef<unknown>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (!replay.current) {
      const values = new FormData(event.currentTarget), approved = minorAmount(amount), reason = String(values.get("reason") || "").trim();
      if (reason.length < 5) { setError("Explain the approval change in at least five characters."); return; }
      if (action === "AMEND" && (approved === null || approved > row.remainingMinor || approved > row.requestedAmountMinor)) { setError("Enter a positive amount within the remaining balance."); return; }
      if (!window.confirm(action === "AMEND" ? "Save this revised approval? No refund is sent until you continue the approved refund." : "Void this unsubmitted approval and release its reservation?")) return;
      replay.current = { action, reason, requestId: crypto.randomUUID(), expectedVersion: row.version, confirmed: true, ...(action === "AMEND" ? { amountMinor: approved } : {}) };
    }
    setSubmitted(true);
    try { await onSave(replay.current); }
    catch (error) { if (definitiveRefundError(error)) { replay.current = null; setSubmitted(false); } setError(error instanceof Error ? error.message : "Save could not be confirmed. Retry the same change."); }
  }
  return <form className="auth-form refund-decision" onSubmit={submit}><h4>Amend or void approval</h4><p>This approval has not been submitted. Submitted or uncertain refunds cannot be changed here.</p><fieldset disabled={busy || submitted}><div className="auth-field"><label htmlFor={`recovery-action-${row.id}`}>Approval change</label><select id={`recovery-action-${row.id}`} value={action} onChange={event => setAction(event.target.value)}><option value="AMEND">Amend approved amount</option><option value="VOID">Void approval</option></select></div>{action === "AMEND" && <div className="auth-field"><label htmlFor={`recovery-amount-${row.id}`}>Revised amount ({row.currency})</label><input id={`recovery-amount-${row.id}`} inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} required /></div>}<div className="auth-field"><label htmlFor={`recovery-reason-${row.id}`}>Reason for approval change</label><textarea id={`recovery-reason-${row.id}`} name="reason" minLength={5} maxLength={500} required /></div></fieldset>{error && <p className="auth-alert" role="alert">{error}</p>}<button className="button secondary" disabled={busy}>{submitted ? "Retry same approval change" : "Review approval change"}</button></form>;
}
export function SuperAdminRefunds() {
  const [data, setData] = useState<RefundPage | null>(null), [page, setPage] = useState(1), [q, setQ] = useState(""), [status, setStatus] = useState(""), [search, setSearch] = useState(""), [revision, setRevision] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const locked = useRef(false);
  const load = useCallback(async () => { const query = new URLSearchParams({ page: String(page), q: search }); if (status) query.set("status", status); setData(await refundRequest(`/api/super-admin/refunds?${query}`)); }, [page, search, status]);
  useEffect(() => { let alive = true; const query = new URLSearchParams({ page: String(page), q: search }); if (status) query.set("status", status); refundRequest(`/api/super-admin/refunds?${query}`).then(value => { if (alive) setData(value); }).catch(error => { if (alive) setError(error.message); }); return () => { alive = false; }; }, [page, search, status, revision]);
  async function mutate(id: string, kind: "decision" | "refresh" | "process" | "prepared", body: unknown, propagate = false) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(""); setMessage("");
    try { await refundRequest(`/api/super-admin/refunds/${encodeURIComponent(id)}/${kind}`, body); setMessage(kind === "decision" ? "Decision saved. Refund completion is shown only after verified provider evidence." : "Refund status checked."); await load(); }
    catch (error) {
      setError(error instanceof Error ? error.message : "The operation could not be confirmed. Retry the same decision safely.");
      if (definitiveRefundError(error)) await load().catch(() => {});
      if (propagate) throw error;
    }
    finally { locked.current = false; setBusy(false); }
  }
  return <section className="platform-detail refund-panel" aria-labelledby="refund-management-heading"><h2 id="refund-management-heading">Refund management</h2><p className="account-help">Review requests case by case. Refunds and subscription cancellations are separate actions. Approval does not guarantee bank credit or cancel future renewals.</p>
    <form className="refund-filters auth-form" onSubmit={event => { event.preventDefault(); setSearch(q.trim()); setPage(1); setRevision(value => value + 1); }}><div className="auth-field"><label htmlFor="refund-search">Organization or payment ID</label><input id="refund-search" value={q} maxLength={120} onChange={event => setQ(event.target.value)} /></div><div className="auth-field"><label htmlFor="refund-status-filter">Status</label><select id="refund-status-filter" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option>{refundStatuses.map(value => <option key={value} value={value}>{refundLabel(value)}</option>)}</select></div><button className="button secondary" disabled={busy}>Search</button></form>
    {error && <p className="auth-alert" role="alert">{error}</p>}{message && <p className="account-success" role="status">{message}</p>}
    {!data ? <p role="status">Loading refund requests…</p> : !data.items.length ? <p className="platform-empty">No refund requests match these filters.</p> : <div className="refund-list">{data.items.map(row => <article className="refund-card" key={row.id}><div className="refund-card-heading"><div><h3>{row.organizationName}</h3><p>{row.planName} · {row.interval.toLowerCase()} · Subscription {row.subscriptionStatus.toLowerCase()}</p></div><span className="platform-badge" data-state={row.status}>{refundLabel(row.status)}</span></div><p>{refundNotice(row)}</p><dl className="refund-facts"><div><dt>Payment ID</dt><dd>{row.providerPaymentId}</dd></div><div><dt>Paid / capture verified</dt><dd>{formatDate(row.paymentDate)}</dd></div><div><dt>Original amount</dt><dd>{formatMoney(row.amountMinor, row.currency)}</dd></div><div><dt>Previously refunded</dt><dd>{formatMoney(row.refundedMinor, row.currency)}</dd></div><div><dt>Remaining refundable</dt><dd>{formatMoney(row.remainingMinor, row.currency)}</dd></div><div><dt>Requested amount</dt><dd>{formatMoney(row.requestedAmountMinor, row.currency)}</dd></div></dl><p><strong>Request reason:</strong> {row.reason}</p><p>Submitted {formatDate(row.createdAt)}{row.decisionName && <> · Decision by {row.decisionName} on {formatDate(row.decidedAt)}</>}</p>{row.transaction?.providerRefundId && <p>Razorpay refund: {row.transaction.providerRefundId} · {row.transaction.providerStatus}</p>}{row.status === "PENDING" ? <Decision key={`${row.id}:${row.version}`} row={row} busy={busy} onDecide={body => mutate(row.id, "decision", body, true)} /> : row.transaction && <div className="billing-actions"><button className="button secondary" disabled={busy} onClick={() => void mutate(row.id, "refresh", {})}>Check provider status</button>{row.transaction.status === "PREPARED" && <button className="button primary" disabled={busy} onClick={() => { if (window.confirm(`Continue the approved ${formatMoney(row.approvedAmountMinor!, row.currency)} refund?`)) void mutate(row.id, "process", { amountMinor: row.approvedAmountMinor, confirmed: true }); }}>Continue approved refund</button>}</div>}{row.status === "APPROVED" && row.transaction?.status === "PREPARED" && <PreparedRecovery key={`${row.id}:${row.version}`} row={row} busy={busy} onSave={body => mutate(row.id, "prepared", body, true)} />}<details><summary>Refund audit trail</summary><ul>{row.audit.map((event, index) => <li key={index}>{event.action.replaceAll("_", " ")} · {formatDate(event.createdAt)}{event.actorName && <> · {event.actorName}</>}{event.detail && <p>{event.detail}</p>}</li>)}</ul></details></article>)}</div>}
    {data && <nav className="platform-pager" aria-label="Refund management pages"><span>{data.total} requests · Page {page}</span><div><button className="button secondary" disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button className="button secondary" disabled={busy || page * 20 >= data.total} onClick={() => setPage(page + 1)}>Next</button></div></nav>}
  </section>;
}

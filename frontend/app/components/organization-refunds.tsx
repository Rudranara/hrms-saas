"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { formatDate, formatMoney } from "../lib/billing-types";
import { definitiveRefundError, refundLabel, refundNotice, refundRequest, type RefundPage, type RefundPayment } from "../lib/refund-types";
import "../refunds.css";

export function OrganizationRefunds({ payments, onChange }: { payments: RefundPayment[]; onChange: () => Promise<unknown> }) {
  const [data, setData] = useState<RefundPage | null>(null), [page, setPage] = useState(1), [paymentId, setPaymentId] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [retrying, setRetrying] = useState(false);
  const retry = useRef<{ paymentId: string; reason: string; requestId: string } | null>(null), lock = useRef(false);
  const load = useCallback(async () => setData(await refundRequest(`/api/billing/refunds?page=${page}`)), [page]);
  useEffect(() => { let alive = true; refundRequest(`/api/billing/refunds?page=${page}`).then(value => { if (alive) setData(value); }).catch(error => { if (alive) setError(error.message); }); return () => { alive = false; }; }, [page]);
  useEffect(() => { if (!data?.items.some(row => ["PENDING", "APPROVED", "PROCESSING"].includes(row.status))) return; const timer = setInterval(() => { void load().catch(() => {}); }, 20000); return () => clearInterval(timer); }, [data, load]);
  const eligible = payments.filter(payment => payment.refundEligible), selected = eligible.find(payment => payment.id === paymentId);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (lock.current) return;
    const form = event.currentTarget, values = new FormData(form);
    retry.current ??= { paymentId, reason: String(values.get("reason") || "").trim(), requestId: crypto.randomUUID() };
    setRetrying(true); lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await refundRequest("/api/billing/refunds", retry.current); retry.current = null; setRetrying(false); setMessage("Refund request submitted for review. No payment has been refunded or subscription cancelled."); form.reset(); setPaymentId(""); await load(); await onChange(); }
    catch (error) {
      if (definitiveRefundError(error)) { retry.current = null; setRetrying(false); await Promise.allSettled([load(), onChange()]); }
      setError(error instanceof Error ? error.message : "Submission could not be confirmed. Retry the same request safely.");
    }
    finally { lock.current = false; setBusy(false); }
  }
  async function refresh(id?: string) { if (lock.current) return; lock.current = true; setBusy(true); setError(""); try { if (id) await refundRequest(`/api/billing/refunds/${encodeURIComponent(id)}/refresh`, {}); await load(); await onChange(); } catch (error) { setError(error instanceof Error ? error.message : "Unable to refresh refunds."); } finally { lock.current = false; setBusy(false); } }
  return <section className="billing-history refund-panel" aria-labelledby="refunds-heading">
    <div className="section-heading"><div><h2 id="refunds-heading">Refund requests</h2><p>Requests are reviewed case by case. Cancelling a plan does not automatically refund a payment.</p></div><button className="button secondary" disabled={busy} onClick={() => void refresh()}>Refresh requests</button></div>
    {error && <p className="auth-alert" role="alert">{error}</p>}{message && <p className="account-success" role="status">{message}</p>}
    <form className="auth-form refund-request-form" onSubmit={submit}>
      <fieldset disabled={busy}><div className="auth-field"><label htmlFor="refund-payment">Payment</label><select id="refund-payment" value={paymentId} onChange={event => { if (!retry.current) setPaymentId(event.target.value); }} required disabled={retrying}><option value="">Select a refundable payment</option>{eligible.map(payment => <option key={payment.id} value={payment.id}>{payment.subscription.plan.name} - {formatMoney(payment.amountMinor, payment.currency)} - {formatDate(payment.paidAt || payment.captureVerifiedAt || null)}</option>)}</select></div>
      {selected && <p className="account-help">Original: {formatMoney(selected.amountMinor, selected.currency)}. Previously refunded: {formatMoney(selected.amountRefundedMinor || 0, selected.currency)}. Requested refund: the full remaining {formatMoney(selected.remainingRefundableMinor ?? selected.amountMinor - (selected.amountRefundedMinor || 0), selected.currency)}.</p>}
      <div className="auth-field"><label htmlFor="refund-reason">Reason for refund</label><textarea id="refund-reason" name="reason" minLength={5} maxLength={1000} required readOnly={retrying} /></div>
      <p className="auth-field-help">A request does not cancel renewals, extend access, or guarantee approval. An administrator may approve the full remaining balance or a partial amount.</p>
      <button type="submit" className="button primary" disabled={!selected && !retrying}>{busy ? "Submitting…" : retrying ? "Retry same request" : "Request refund"}</button></fieldset>
    </form>
    {!eligible.length && <p className="account-help">No payment is currently available for a new refund request. A payment may already have an unresolved request or be fully refunded.</p>}
    {!data ? <p role="status">Loading requests…</p> : !data.items.length ? <p>No refund requests yet.</p> : <div className="refund-list" aria-live="polite">{data.items.map(row => <article className="refund-card" key={row.id}><div className="refund-card-heading"><h3>{row.planName}</h3><span className="platform-badge" data-state={row.status}>{refundLabel(row.status)}</span></div><p>{refundNotice(row)}</p><dl className="refund-facts"><div><dt>Payment</dt><dd>{row.providerPaymentId}</dd></div><div><dt>Requested</dt><dd>{formatMoney(row.requestedAmountMinor, row.currency)}</dd></div><div><dt>Approved</dt><dd>{row.approvedAmountMinor === null ? "Not decided" : formatMoney(row.approvedAmountMinor, row.currency)}</dd></div><div><dt>Total refunded</dt><dd>{formatMoney(row.refundedMinor, row.currency)}</dd></div><div><dt>Remaining refundable</dt><dd>{formatMoney(row.remainingMinor, row.currency)}</dd></div><div><dt>Requested on</dt><dd>{formatDate(row.createdAt)}</dd></div></dl><p><strong>Your reason:</strong> {row.reason}</p>{row.transaction?.providerRefundId && <p>Refund reference: {row.transaction.providerRefundId}{row.transaction.processedAt && <> · Verified {formatDate(row.transaction.processedAt)}</>}</p>}{row.transaction && <button className="button secondary" disabled={busy} onClick={() => void refresh(row.id)}>Check refund status</button>}</article>)}</div>}
    {data && data.total > 20 && <nav className="platform-pager" aria-label="Refund request pages"><button disabled={busy || page === 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page}</span><button disabled={busy || page * 20 >= data.total} onClick={() => setPage(page + 1)}>Next</button></nav>}
  </section>;
}

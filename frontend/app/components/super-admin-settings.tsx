"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { platformLoginHref } from "../lib/auth-redirects";
import { formatDate } from "../lib/billing-types";
import { Icon } from "./ui-icon";

type Account = {
  admin: { id: string; fullName: string; email: string; emailVerifiedAt: string | null };
  pendingEmailChange: { newEmail: string; state: string; createdAt: string; expiresAt: string; expired: boolean; requestId: string } | null;
  emailDeliveryAvailable: boolean;
  auditEvents: { id: string; action: string; outcome: string; reasonCode: string | null; createdAt: string }[];
};
type Issue = { message: string; signIn?: boolean };
type EmailRequest = { newEmail: string; requestId: string; createdAt: string; expiresAt: string; message: string };
class AccountError extends Error { constructor(message: string, public status: number) { super(message); } }
async function accountRequest(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/super-admin/account${path}`, body === undefined ? { cache: "no-store", signal } : {
    method: "POST", headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" }, credentials: "same-origin", body: JSON.stringify(body), signal,
  });
  const result = await response.json();
  if (!response.ok) throw new AccountError(result.message || "Unable to update your account.", response.status);
  return result;
}
function issue(error: unknown): Issue {
  if (error instanceof AccountError && [401, 403].includes(error.status)) return { message: "Your session ended or platform access changed. Sign in again with your Super Admin account.", signIn: true };
  return { message: error instanceof Error ? error.message : "The service could not confirm this request. Please try again." };
}
const auditLabels: Record<string, string> = {
  EMAIL_CHANGE_REQUESTED: "Email change requested", EMAIL_CHANGE_SENT: "Verification email accepted for delivery",
  EMAIL_CHANGE_FAILED: "Email change delivery failed", EMAIL_CHANGE_REJECTED: "Email change authentication rejected",
  EMAIL_CHANGED: "Email changed and verified", PASSWORD_CHANGED: "Password changed; sessions revoked", PASSWORD_CHANGE_REJECTED: "Password change authentication rejected",
};
export function SuperAdminSettings() {
  const [account, setAccount] = useState<Account | null>(null), [error, setError] = useState<Issue | null>(null), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0), [reauthenticate, setReauthenticate] = useState(false);
  const [editEmail, setEditEmail] = useState(false);
  const [now, setNow] = useState(() => Date.now()), [resending, setResending] = useState(false);
  const pending = useRef(false), otpInput = useRef<HTMLInputElement>(null);
  const requestCreatedAt = account?.pendingEmailChange?.createdAt;
  const resendSeconds = requestCreatedAt ? Math.max(0, Math.ceil((new Date(requestCreatedAt).getTime() + 60000 - now) / 1000)) : 0;
  useEffect(() => {
    if (!requestCreatedAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [requestCreatedAt]);
  useEffect(() => {
    const controller = new AbortController();
    accountRequest("", undefined, controller.signal).then(setAccount).catch((error) => { if (!controller.signal.aborted) setError(issue(error)); });
    return () => controller.abort();
  }, [revision]);
  function receiveEmailRequest(result: EmailRequest) {
    setEditEmail(false); setNow(Date.now()); setMessage(result.message);
    setAccount((previous) => previous && { ...previous, pendingEmailChange: { newEmail: result.newEmail, requestId: result.requestId, expiresAt: result.expiresAt, createdAt: result.createdAt, state: "SENT", expired: false } });
    setRevision((value) => value + 1);
  }
  async function resendOtp() {
    if (pending.current || resendSeconds > 0 || !account?.pendingEmailChange) return;
    pending.current = true; setBusy(true); setResending(true); setError(null); setMessage("");
    try {
      receiveEmailRequest(await accountRequest("/email/resend", { requestId: account.pendingEmailChange.requestId }));
    } catch (error) { setError(issue(error)); setRevision((value) => value + 1); }
    finally { pending.current = false; setBusy(false); setResending(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>, kind: "email" | "confirm") {
    event.preventDefault(); if (pending.current) return;
    const form = event.currentTarget, values = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setError(null); setMessage("");
    if (kind === "email" && (!values.currentPassword || values.currentPassword.length > 128)) { setError({ message: "Enter your current password." }); return; }
    if (kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.newEmail?.trim() || "")) { setError({ message: "Enter a valid new email address." }); return; }
    if (kind === "confirm" && (!account?.pendingEmailChange || !/^\d{6}$/.test(values.code?.trim() || ""))) { setError({ message: "Enter the six-digit verification code from your new email." }); return; }
    pending.current = true; setBusy(true);
    try {
      const result = await accountRequest(kind === "confirm" ? "/email/confirm" : "/email", kind === "confirm" ? { code: values.code.trim(), requestId: account!.pendingEmailChange!.requestId } : values);
      form.reset(); setMessage(result.message);
      if (result.requiresReauthentication) {
        setReauthenticate(true);
      } else receiveEmailRequest(result);
    } catch (error) { setError(issue(error)); if (kind === "confirm") setRevision((value) => value + 1); }
    finally {
      const passwordInput = form.querySelector<HTMLInputElement>('[name="currentPassword"]');
      if (passwordInput) passwordInput.value = "";
      pending.current = false; setBusy(false);
    }
  }
  const verifying = !editEmail && account?.pendingEmailChange?.state === "SENT" && !account.pendingEmailChange.expired;
  const verificationRequest = verifying ? account.pendingEmailChange?.requestId : null;
  useEffect(() => { if (verificationRequest) otpInput.current?.focus(); }, [verificationRequest]);
  const password = (label = "Current password") => <div className="auth-field"><label>{label}<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></label></div>;
  // A full navigation discards protected route snapshots captured before revocation.
  if (reauthenticate) return <section className="platform-detail"><h2>Account updated</h2><p className="account-success" role="status">{message}</p><a className="button primary" href={platformLoginHref("/super-admin/settings")}>Sign in again</a></section>;
  return <div className="platform-panel platform-settings">
    <Link href="/super-admin" className="settings-back"><Icon name="arrow" />Platform overview</Link>
    {error && <div className="auth-alert" role="alert">{error.message} {error.signIn ? <a href={platformLoginHref("/super-admin/settings")}>Sign in again</a> : !account && <button onClick={() => { setError(null); setRevision((value) => value + 1); }}>Retry account settings</button>}</div>}
    {message && <p className="account-success" role="status">{message}</p>}
    {!account ? !error && <p role="status">Loading account settings…</p> : <>
      <section className="platform-detail settings-profile">
        <div className="settings-identity"><span className="settings-avatar" aria-hidden="true">{account.admin.fullName.trim().split(/\s+/).slice(0, 2).map((name) => name[0]).join("").toUpperCase()}</span><div><span className="eyebrow">YOUR SIGN-IN ACCOUNT</span><h2>{account.admin.fullName}</h2><span className="settings-role">Super administrator</span></div></div>
        <dl><div><dt>Current email</dt><dd>{account.admin.email}</dd></div><div><dt>Email status</dt><dd><span className="settings-status" data-verified={!!account.admin.emailVerifiedAt}>{account.admin.emailVerifiedAt ? <><Icon name="check" />Verified</> : "Not verified"}</span>{account.admin.emailVerifiedAt && <span className="settings-verified-date">{formatDate(account.admin.emailVerifiedAt)}</span>}</dd></div></dl>
        <p className="account-help">Only your own account can be changed here. Your current email stays active until the replacement address is verified. Completing an email change signs out all sessions.</p>
      </section>
      <div className="platform-settings-grid">
        <section className="platform-detail settings-email"><div className="settings-card-heading"><span className="settings-card-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m3 7 9 6 9-6" /></svg></span><div><span className="eyebrow">EMAIL ADDRESS</span><h2>{verifying ? "Verify your new email" : "Change sign-in email"}</h2></div></div><p>{verifying ? "Enter the six-digit OTP sent to your new email address. Your email will update only after the code is verified." : "Enter your new email and current password. We’ll send a six-digit OTP to the new address to verify it. The code expires in 10 minutes."}</p>
          {account.pendingEmailChange && <div className="billing-neutral" role="status"><strong>Requested address: {account.pendingEmailChange.newEmail}</strong><p>{account.pendingEmailChange.state === "FAILED" ? "Delivery failed. Your existing address remains active; you can try again." : account.pendingEmailChange.state === "LOCKED" ? "Too many incorrect codes. Request a new OTP below." : account.pendingEmailChange.expired ? "This code has expired. Request a new OTP below." : account.pendingEmailChange.state === "SENT" ? "Verification is pending. The new address is not active or verified yet." : "Email delivery is pending confirmation."}</p><small>Expires {formatDate(account.pendingEmailChange.expiresAt)}</small></div>}
          {!account.admin.emailVerifiedAt && <p className="account-help">To verify your current email, enter that address in the form below.</p>}
          {!account.emailDeliveryAvailable && <p className="billing-warning" role="status">Email delivery is not configured. Email changes are unavailable; your current account remains usable.</p>}
          {verifying ? <form key={verificationRequest} onSubmit={(event) => submit(event, "confirm")} className="auth-form settings-otp-form" aria-busy={busy}><fieldset disabled={busy}><div className="auth-field"><label htmlFor="email-change-otp">Verification code<input ref={otpInput} id="email-change-otp" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required aria-describedby="email-change-otp-help" /></label><p id="email-change-otp-help" className="auth-field-help">Check your inbox and spam folder. Enter all six digits.</p></div><button className="button primary" type="submit">{busy && !resending ? "Verifying…" : "Verify OTP and update email"}</button><div className="settings-otp-actions"><button type="button" className="button-link settings-resend" disabled={busy || resendSeconds > 0 || !account.emailDeliveryAvailable} onClick={resendOtp}>{resending ? "Sending…" : resendSeconds > 0 ? `Resend OTP in ${Math.floor(resendSeconds / 60)}:${String(resendSeconds % 60).padStart(2, "0")}` : "Resend OTP"}</button><button type="button" className="button-link" onClick={() => { setEditEmail(true); setError(null); setMessage(""); }}>Change email</button></div></fieldset></form>
          : <form onSubmit={(event) => submit(event, "email")} className="auth-form" aria-busy={busy}><fieldset disabled={busy || !account.emailDeliveryAvailable}><div className="auth-field"><label>New email address<input name="newEmail" type="email" autoComplete="email" required maxLength={254} defaultValue={account.pendingEmailChange?.newEmail || ""} /></label></div>{password()}<button className="button primary" type="submit">{busy ? "Sending OTP…" : "Send OTP to new email"}</button>{editEmail && account.pendingEmailChange?.state === "SENT" && !account.pendingEmailChange.expired && <button type="button" className="button-link settings-otp-back" onClick={() => { setEditEmail(false); setError(null); }}>Back to verification</button>}<p className="auth-field-help">Submitting this form sends a new OTP. Only the latest code works.</p></fieldset></form>}
        </section>
      </div>
      <section className="platform-detail settings-activity"><div className="settings-card-heading"><span className="settings-card-icon"><Icon name="clock" /></span><div><span className="eyebrow">SECURITY HISTORY</span><h2>Recent account activity</h2></div></div><p className="account-help">The latest 10 events for your account. Passwords, hashes and verification tokens are never recorded in this audit history.</p>{account.auditEvents.length ? <ul className="platform-audit-list">{account.auditEvents.map((event) => <li key={event.id}><span className="settings-event-dot" aria-hidden="true" /><div><strong>{auditLabels[event.action] || event.action.replaceAll("_", " ").toLowerCase()}</strong><small>{event.outcome.toLowerCase()}{event.reasonCode ? ` · ${event.reasonCode.replaceAll("_", " ").toLowerCase()}` : ""}</small></div><time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time></li>)}</ul> : <div className="settings-empty"><span className="settings-empty-icon"><Icon name="clock" /></span><p>No account changes recorded yet.</p><span>Your recent account activity will appear here.</span></div>}</section>
    </>}
  </div>;
}

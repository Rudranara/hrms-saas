"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";

export function PlatformRecoveryForm() {
  const [stage, setStage] = useState<"email" | "code" | "password">("email");
  const [email, setEmail] = useState(""), [code, setCode] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [notice, setNotice] = useState(""), [resending, setResending] = useState(false);
  const [resendAvailableAt, setResendAvailableAt] = useState(0), [now, setNow] = useState(0);
  const resendSeconds = Math.max(0, Math.ceil((resendAvailableAt - now) / 1000));
  const pending = useRef(false);
  useEffect(() => {
    if (stage !== "code") return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [stage]);
  function startCooldown(value?: string) {
    const timestamp = value ? Date.parse(value) : NaN;
    setNow(Date.now()); setResendAvailableAt(Number.isFinite(timestamp) ? timestamp : Date.now() + 60000);
  }
  function changeEmail() {
    setStage("email"); setCode(""); setError(""); setNotice("");
  }
  async function resendOtp() {
    if (pending.current || resendSeconds > 0) return;
    pending.current = true; setBusy(true); setResending(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/super-admin/auth/forgot-password", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify({ email, resend: true }) });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message || "Unable to resend the code.");
        if (response.status === 429) startCooldown();
        return;
      }
      startCooldown(data.resendAvailableAt); setCode("");
      setNotice(data.message || "A new OTP has been sent. Check your inbox and spam folder.");
      const input = document.getElementById("platform-reset-code") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch { setError("The service is temporarily unavailable. Please try again."); }
    finally { pending.current = false; setBusy(false); setResending(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending.current) return;
    const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const currentEmail = stage === "email" ? values.email.trim().toLowerCase() : email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(currentEmail)) { setError("Enter a valid email address."); return; }
    if (stage !== "email" && !/^\d{8}$/.test(stage === "code" ? values.code.trim() : code)) { setError("Enter the eight-digit code from your email."); return; }
    if (stage === "password" && (values.password.length < 8 || values.password.length > 128 || values.password !== values.confirmPassword)) { setError("Use 8–128 characters and matching passwords."); return; }
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const path = stage === "email" ? "forgot-password" : stage === "code" ? "reset/verify-otp" : "reset-password";
      const body = stage === "email" ? { email: currentEmail } : stage === "code" ? { email, code: values.code.trim() } : { email, code, password: values.password, confirmPassword: values.confirmPassword };
      const response = await fetch(`/api/super-admin/auth/${path}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) { setError(data.message || "Unable to complete this request."); return; }
      if (stage === "email") { setEmail(currentEmail); setStage("code"); startCooldown(data.resendAvailableAt); }
      else if (stage === "code") { setCode(values.code.trim()); setStage("password"); }
      else setMessage(data.message || "Your password has been updated.");
    } catch { setError("The service is temporarily unavailable. Please try again."); }
    finally { pending.current = false; setBusy(false); }
  }
  if (message) return <div><p className="account-success" role="status">{message}</p><Link className="button primary" href="/super-admin/login">Back to platform sign in</Link></div>;
  return <form className="auth-form platform-recovery-form" onSubmit={submit} noValidate aria-busy={busy}>
    {error && <p className="auth-alert" role="alert">{error}</p>}
    {notice && <p className="account-success" role="status">{notice}</p>}
    <fieldset disabled={busy}>
      {stage === "email" && <div className="auth-field"><label htmlFor="platform-recovery-email">Platform administrator email</label><input id="platform-recovery-email" name="email" type="email" autoComplete="username" maxLength={254} defaultValue={email} required /></div>}
      {stage === "code" && <><p className="auth-field-help">Enter the code sent to your registered platform email.</p><div className="auth-field"><label htmlFor="platform-reset-code">Email code</label><input id="platform-reset-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" minLength={8} maxLength={8} required /></div></>}
      {stage === "password" && <><div className="auth-field"><label htmlFor="platform-reset-password">New password</label><input id="platform-reset-password" name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /><p className="auth-field-help">Use a unique passphrase with 8–128 characters.</p></div><div className="auth-field"><label htmlFor="platform-reset-confirm">Confirm new password</label><input id="platform-reset-confirm" name="confirmPassword" type="password" autoComplete="new-password" maxLength={128} required /></div></>}
      <button className="button primary auth-submit" type="submit">{busy ? "Please wait…" : stage === "email" ? "Request password reset" : stage === "code" ? "Verify code" : "Update password"}</button>
      {stage === "code" && <div className="platform-recovery-actions"><button className="button-link platform-recovery-resend" type="button" disabled={busy || resendSeconds > 0} onClick={resendOtp}>{resending ? "Sending…" : resendSeconds > 0 ? `Resend OTP in ${Math.floor(resendSeconds / 60)}:${String(resendSeconds % 60).padStart(2, "0")}` : "Resend OTP"}</button><button className="button-link" type="button" onClick={changeEmail}>Change email</button></div>}
    </fieldset>
    <p className="auth-switch">{stage === "password" && <><button className="button-link" type="button" disabled={busy} onClick={changeEmail}>Change email</button><span aria-hidden="true"> · </span></>}<Link href="/super-admin/login">Back to platform sign in</Link></p>
  </form>;
}

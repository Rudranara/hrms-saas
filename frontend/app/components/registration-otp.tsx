"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";

export function RegistrationOtp({ email, onComplete, onChangeEmail }: { email: string; onComplete: () => void; onChangeEmail: () => void }) {
  const [seconds, setSeconds] = useState(60), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const pending = useRef(false);
  useEffect(() => { if (!seconds) return; const timer = setTimeout(() => setSeconds((value) => Math.max(0, value - 1)), 1000); return () => clearTimeout(timer); }, [seconds]);
  async function send(path: "verify" | "resend", body: { code: string } | Record<string, never>) {
    if (pending.current || (path === "resend" && seconds)) return;
    pending.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/auth/register/${path}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok || !result.success) { setError(result.message || "Unable to verify your email. Please try again."); return; }
      if (path === "verify") { onComplete(); return; }
      setSeconds(result.resendAfter || 60); setMessage("A new code has been sent. Only the latest code works.");
    } catch { setError("We could not reach the server. Please try again."); }
    finally { pending.current = false; setBusy(false); }
  }
  function verify(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void send("verify", { code: String(new FormData(event.currentTarget).get("code") || "").trim() }); }
  return <form className="auth-form" onSubmit={verify} aria-busy={busy}>
    <h2>Verify your email</h2><p className="auth-field-help">Enter the six-digit code sent to <strong>{email}</strong>. The code expires in 10 minutes. Your account and free trial start after verification.</p>
    {error && <div className="auth-alert" role="alert">{error}</div>}{message && <p className="account-success" role="status">{message}</p>}
    <fieldset disabled={busy} style={{ marginTop: 24 }}><div className="auth-field"><label htmlFor="registration-code">Verification code</label><input id="registration-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required autoFocus /><p className="auth-field-help">Check your inbox and spam folder.</p></div><button className="button primary auth-submit" type="submit" disabled={busy}>{busy ? "Please wait…" : "Verify email and create account"}</button></fieldset>
    <div className="billing-actions" style={{ display: "flex", flexWrap: "wrap", gap: 24, marginTop: 20 }}><button className="button-link" type="button" disabled={busy || seconds > 0} onClick={() => void send("resend", {})}>{seconds > 0 ? `Resend OTP in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Resend OTP"}</button><button className="button-link" type="button" disabled={busy} onClick={onChangeEmail}>Change email</button></div>
  </form>;
}

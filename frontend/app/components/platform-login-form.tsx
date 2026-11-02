"use client";
import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { platformReturn } from "../lib/auth-redirects";
type FieldErrors = { email?: string; password?: string };
export function PlatformLoginForm({ destination }: { destination: string }) {
  const [showPassword, setShowPassword] = useState(false), [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({}), [message, setMessage] = useState("");
  const pending = useRef(false), alert = useRef<HTMLDivElement>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending.current) return;
    const form = event.currentTarget, values = new FormData(form);
    const email = String(values.get("email") || "").trim(), password = String(values.get("password") || "");
    const invalid: FieldErrors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) invalid.email = "Enter a valid email address.";
    if (!password || password.length > 128) invalid.password = "Enter your password (up to 128 characters).";
    setErrors(invalid); setMessage("");
    const first = Object.keys(invalid)[0];
    if (first) { form.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus(); return; }
    pending.current = true; setLoading(true);
    let completed = false;
    try {
      const response = await fetch("/api/super-admin/auth/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify({ email, password }) });
      const result = await response.json();
      if (!response.ok || !result.success || !result.admin) {
        setMessage(response.status === 429 ? "Too many sign-in attempts. Please try again in 15 minutes." : response.status >= 500 ? "The sign-in service is unavailable. Please try again." : "Unable to sign in. Check your credentials or contact your platform administrator.");
        requestAnimationFrame(() => alert.current?.focus()); return;
      }
      completed = true;
      // Discard any protected snapshots retained before authentication.
      window.location.replace(platformReturn(destination) || "/super-admin");
    } catch {
      setMessage("The sign-in service could not be reached. Please try again.");
      requestAnimationFrame(() => alert.current?.focus());
    } finally {
      if (!completed) { pending.current = false; setLoading(false); }
    }
  }
  return <form className="auth-form platform-login-form" method="post" action="/api/super-admin/auth/login" onSubmit={submit} noValidate aria-busy={loading}>
    {message && <div className="auth-alert" role="alert" tabIndex={-1} ref={alert}>{message}</div>}
    <div className="auth-field"><label htmlFor="platform-email">Email</label><div className="auth-input-wrap"><input id="platform-email" name="email" type="email" autoComplete="username" required maxLength={254} disabled={loading} aria-invalid={!!errors.email} aria-describedby={errors.email ? "platform-email-error" : undefined} /></div>{errors.email && <p className="auth-field-error" id="platform-email-error">{errors.email}</p>}</div>
    <div className="auth-field"><label htmlFor="platform-password">Password</label><div className="auth-input-wrap"><input id="platform-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required maxLength={128} disabled={loading} aria-invalid={!!errors.password} aria-describedby={errors.password ? "platform-password-error" : undefined} /><button className="auth-password-toggle" type="button" disabled={loading} aria-controls="platform-password" aria-pressed={showPassword} aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((value) => !value)}>{showPassword ? "Hide" : "Show"}</button></div>{errors.password && <p className="auth-field-error" id="platform-password-error">{errors.password}</p>}</div>
    <button type="submit" className="button primary auth-submit" disabled={loading}>{loading ? "Signing in…" : "Sign in to platform"}</button>
    <p className="auth-switch"><Link href="/super-admin/forgot-password">Forgot your password?</Link></p>
  </form>;
}

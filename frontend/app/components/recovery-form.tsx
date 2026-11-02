"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { VERIFICATION_DELIVERY } from "../lib/auth-types";
import { BillingReturnLink } from "./billing-return-link";

async function post(path: string, body: unknown) {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}
export function RecoveryForm({
  mode,
}: {
  mode: "forgot" | "reset" | "verify";
}) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [validation, setValidation] = useState<
    "checking" | "ready" | "invalid"
  >("checking");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [code, setCode] = useState("");
  const [forgotStage, setForgotStage] = useState<"email" | "otp" | "password">("email");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [notice, setNotice] = useState(""), [resending, setResending] = useState(false);
  const [resendAvailableAt, setResendAvailableAt] = useState(0), [now, setNow] = useState(0);
  const resendSeconds = Math.max(0, Math.ceil((resendAvailableAt - now) / 1000));
  const resetOtpInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const capturedToken = useRef<string | null>(null);
  const showingReset = mode === "reset" || (mode === "forgot" && forgotStage === "password");
  const showingOtp = mode === "forgot" && forgotStage === "otp";
  useEffect(() => {
    if (!showingOtp) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [showingOtp]);
  function startCooldown(value?: string) {
    const timestamp = value ? Date.parse(value) : NaN;
    setNow(Date.now()); setResendAvailableAt(Number.isFinite(timestamp) ? timestamp : Date.now() + 60000);
  }
  function changeRecoveryEmail() {
    setForgotStage("email"); setError(""); setCode(""); setNotice("");
  }
  async function resendOtp() {
    if (pending.current || !showingOtp || resendSeconds > 0) return;
    pending.current = true; setBusy(true); setResending(true); setError(""); setNotice("");
    try {
      const { response, data } = await post("forgot-password", { email: recoveryEmail, resend: true });
      if (!response.ok) {
        setError(data.message || "Unable to resend the code.");
        if (response.status === 429) startCooldown();
        return;
      }
      startCooldown(data.resendAvailableAt); setCode("");
      if (resetOtpInput.current) resetOtpInput.current.value = "";
      setNotice("A new reset code has been requested. Check your inbox and spam folder.");
    } catch { setError("The service is temporarily unavailable. Please try again."); }
    finally { pending.current = false; setBusy(false); setResending(false); }
  }
  useEffect(() => {
    if (mode !== "verify") return;
    let alive = true;
    function capture() {
      if (window.location.hash || capturedToken.current === null)
        capturedToken.current =
          new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
      const value = capturedToken.current || "";
      // Retain only in component memory, including a newer email opened in the
      // same tab. The ref also survives development Strict Mode effect replay.
      window.history.replaceState(null, "", window.location.pathname);
      queueMicrotask(() => {
        if (alive) {
          setToken(/^[a-f0-9]{64}$/.test(value) ? value : "");
          setError("");
          setCode("");
          setMessage("");
          setValidation("checking");
        }
      });
    }
    capture();
    window.addEventListener("hashchange", capture);
    return () => {
      alive = false;
      window.removeEventListener("hashchange", capture);
    };
  }, [mode]);
  useEffect(() => {
    if (mode !== "verify" || !token) return;
    let alive = true;
    post("reset/validate", { token })
      .then(({ response, data }) => {
        if (!alive) return;
        if (response.ok) setValidation("ready");
        else {
          setValidation("invalid");
          setCode(data.code || "");
          setError(data.message || "Unable to validate this link.");
        }
      })
      .catch(() => {
        if (alive) {
          setValidation("invalid");
          setError(
            "Unable to validate this link. Open the email again when the service is available.",
          );
        }
      });
    return () => {
      alive = false;
    };
  }, [mode, token]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const values = Object.fromEntries(
      new FormData(event.currentTarget),
    ) as Record<string, string>;
    setError("");
    setNotice("");
    setCode("");
    if (
      mode === "forgot" &&
      forgotStage === "email" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email?.trim() || "")
    ) {
      setError("Enter a valid work email.");
      return;
    }
    if (
      showingReset &&
      (values.password.length < 8 ||
        values.password.length > 128 ||
        values.password !== values.confirmPassword)
    ) {
      setError("Use 8–128 characters and matching passwords.");
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const path = mode === "verify"
        ? "verification/confirm"
        : showingOtp
          ? "reset/verify-otp"
        : showingReset
          ? "reset-password"
          : "forgot-password";
      const payload =
        mode === "verify"
          ? { token }
          : !showingReset && !showingOtp
            ? { email: values.email.trim().toLowerCase() }
            : showingOtp
              ? { email: recoveryEmail, code: values.code.trim() }
            : {
                email: mode === "forgot" ? recoveryEmail : values.email.trim(),
                // The separate password step has no OTP input; retain only the
                // previously validated code in component memory.
                code: mode === "forgot" ? code : values.code.trim(),
                password: values.password,
                confirmPassword: values.confirmPassword,
              };
      const { response, data } = await post(path, payload);
      if (!response.ok) {
        setError(data.message || "Unable to complete this request.");
        setCode(data.code || "");
        return;
      }
      if (mode === "verify") {
        try { sessionStorage.removeItem(VERIFICATION_DELIVERY); } catch {}
        router.replace("/dashboard");
        router.refresh();
        return;
      }
      if (mode === "forgot" && !showingReset && !showingOtp) {
        setRecoveryEmail(values.email.trim().toLowerCase());
        setForgotStage("otp");
        startCooldown(data.resendAvailableAt);
        return;
      }
      if (mode === "forgot" && showingOtp) {
        setCode(values.code.trim());
        setForgotStage("password");
        return;
      }
      setMessage(data.message || "Your request is complete.");
    } catch {
      setError("The service is temporarily unavailable. Please try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  if (mode === "verify" && token === null)
    return <p role="status">Reading your link…</p>;
  if (mode === "verify" && token === "")
    return (
      <div>
        <p className="auth-alert" role="alert">
          This link is missing or invalid. Please request a new email.
        </p>
        <Link
          className="button secondary"
          href={
            mode === "verify" ? "/verification-pending" : "/forgot-password"
          }
        >
          Request a new link
        </Link>
      </div>
    );
  if (message)
    return (
      <div>
        {mode === "verify" && <BillingReturnLink />}
        <p className="account-success" role="status">
          {message}
        </p>
        <Link
          className="button primary"
          href={mode === "verify" ? "/dashboard" : "/login"}
        >
          {mode === "verify" ? "Continue to your workspace" : "Back to login"}
        </Link>
        {mode === "forgot" && (
          <p className="account-help">
            Check spam folders too. This message does not confirm that an
            account exists or that delivery succeeded.
          </p>
        )}
      </div>
    );
  const tokenError =
    mode === "verify" &&
    ["TOKEN_INVALID", "TOKEN_EXPIRED", "TOKEN_USED"].includes(code);
  return (
    <form
      method="post"
      onSubmit={submit}
      noValidate
      className={mode === "forgot" ? "auth-form organization-recovery-form" : "auth-form"}
      aria-busy={busy}
    >
      {error && (
        <p className="auth-alert" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="account-success" role="status">{notice}</p>}
      {mode === "verify" && validation === "checking" ? (
        <p role="status">Checking your reset link…</p>
      ) : (
        <>
          {!tokenError && (mode !== "verify" || validation !== "invalid") && (
            <fieldset disabled={busy}>
              {!showingReset && !showingOtp && mode === "forgot" && (
                <div className="auth-field">
                  <label htmlFor="recovery-email">Work email</label>
                  <input
                    id="recovery-email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    maxLength={254}
                    defaultValue={recoveryEmail}
                    required
                    aria-invalid={!!error}
                  />
                </div>
              )}
              {showingOtp && (
                <>
                  <p className="auth-field-help">We sent a code to your registered email address. Enter it to continue.</p>
                  <div className="auth-field"><label htmlFor="reset-code">Email code</label><input ref={resetOtpInput} id="reset-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" minLength={8} maxLength={8} required /><p className="auth-field-help">Enter the eight-digit code sent to your registered email.</p></div>
                </>
              )}
              {showingReset && (
                <>
                  {mode === "reset" && <div className="auth-field"><label htmlFor="reset-email">Registered email</label><input id="reset-email" name="email" type="email" autoComplete="username" maxLength={254} required /></div>}
                  {mode === "reset" && <div className="auth-field"><label htmlFor="reset-code">Email code</label><input id="reset-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" minLength={8} maxLength={8} required /><p className="auth-field-help">Enter the eight-digit code sent to your registered email.</p></div>}
                  <div className="auth-field">
                    <label htmlFor="reset-password">New password</label>
                    <input
                      id="reset-password"
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      required
                      aria-describedby="reset-help"
                    />
                    <p className="auth-field-help" id="reset-help">
                      Use a unique passphrase with 8–128 characters.
                    </p>
                  </div>
                  <div className="auth-field">
                    <label htmlFor="reset-confirm">Confirm new password</label>
                    <input
                      id="reset-confirm"
                      name="confirmPassword"
                      type="password"
                      autoComplete="new-password"
                      maxLength={128}
                      required
                    />
                  </div>
                </>
              )}
              <button className="button primary auth-submit" type="submit">
                {busy
                  ? "Please wait…"
                  : mode === "forgot" && !showingReset && !showingOtp
                    ? "Request password reset"
                    : showingOtp
                      ? "Verify code"
                    : showingReset
                      ? "Update password"
                      : "Verify my email"}
              </button>
              {showingOtp && <div className="recovery-otp-actions"><button className="button-link recovery-otp-resend" type="button" disabled={busy || resendSeconds > 0} onClick={resendOtp}>{resending ? "Sending…" : resendSeconds > 0 ? `Resend OTP in ${Math.floor(resendSeconds / 60)}:${String(resendSeconds % 60).padStart(2, "0")}` : "Resend OTP"}</button><button className="button-link" type="button" onClick={changeRecoveryEmail}>Change email</button></div>}
            </fieldset>
          )}
          {(tokenError || (mode === "verify" && validation === "invalid")) && (
            <Link
              className="button secondary"
              href={
                mode === "verify" ? "/verification-pending" : "/forgot-password"
              }
            >
              {code === "TOKEN_USED"
                ? "Already verified? Check your account"
                : "Request a new link"}
            </Link>
          )}
        </>
      )}
      <p className="auth-switch">
        {mode === "forgot" && showingReset && <><button className="button-link" type="button" disabled={busy} onClick={changeRecoveryEmail}>Change email</button><span aria-hidden="true"> · </span></>}
        <Link href="/login">Back to login</Link>
      </p>
    </form>
  );
}

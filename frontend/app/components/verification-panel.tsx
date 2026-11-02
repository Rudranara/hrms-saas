"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BillingReturnLink } from "./billing-return-link";
import { VERIFICATION_DELIVERY } from "../lib/auth-types";
export function VerificationPanel({ verified, deliveryAvailable = true, deliveryConfigurationMessage }: { verified: boolean; deliveryAvailable?: boolean; deliveryConfigurationMessage?: string }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const pending = useRef(false);
  useEffect(() => {
    try {
      const delivery = JSON.parse(sessionStorage.getItem(VERIFICATION_DELIVERY) || "null");
      if (verified || !deliveryAvailable || !delivery) return;
      if (delivery.status === "accepted") queueMicrotask(() => setMessage("Your verification email was accepted for delivery. Check your inbox and spam folder."));
      else if (delivery.status === "unconfirmed") queueMicrotask(() => setError(
        typeof delivery.message === "string" && delivery.message.length <= 500 ? delivery.message : "The initial verification email could not be confirmed. Your organization is saved. Please request a new link."
      ));
    } catch { /* Storage is optional; resend and server configuration checks remain available. */ }
  }, [verified, deliveryAvailable]);
  async function resend() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/auth/verification/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" },
        body: "{}",
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message || "Could not request verification.");
        try { sessionStorage.setItem(VERIFICATION_DELIVERY, JSON.stringify({ status: "unconfirmed", message: data.message || "Could not request verification." })); } catch {}
        return;
      }
      setMessage(data.message);
      try { sessionStorage.setItem(VERIFICATION_DELIVERY, JSON.stringify({ status: "accepted" })); } catch {}
    } catch {
      setError("Email delivery is temporarily unavailable. Please try again.");
      try { sessionStorage.setItem(VERIFICATION_DELIVERY, JSON.stringify({ status: "unconfirmed", message: "Email delivery is temporarily unavailable. Please try again." })); } catch {}
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="verification-panel">
      {!verified && !deliveryAvailable && <p className="auth-alert" role="alert">{deliveryConfigurationMessage || "Verification email delivery is not configured. Your organization is saved. Contact your administrator to configure email, then request a new link; you do not need to register again."}</p>}
      <BillingReturnLink />
      {verified ? (
        <p className="account-success">Your email is already verified.</p>
      ) : (
        <>
          <p>
            Verification is optional. Request a link here when you want to enable password recovery for your email address. {" "}
            Only the newest verification link works. Links expire after the
            period stated in the email. Your dashboard, trial and billing remain
            available without verification.
          </p>
          {message && (
            <p className="account-success" role="status">
              {message}
            </p>
          )}
          {error && (
            <p className="auth-alert" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={resend}
          >
            {busy ? "Requesting email…" : "Send or resend verification email"}
          </button>
        </>
      )}
      <p className="auth-switch">
        <Link href="/dashboard">Back to your account</Link> ·{" "}
        <Link href="/billing">Billing and trial status</Link>
      </p>
    </div>
  );
}

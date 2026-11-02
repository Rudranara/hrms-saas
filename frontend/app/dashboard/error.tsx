"use client";
import Link from "next/link";
import "../auth.css";
export default function DashboardError({ reset }: { reset: () => void }) {
  return (
    <main className="auth-loading">
      <h1>Your workspace is temporarily unavailable.</h1>
      <p>
        We couldn’t verify your session. Please retry when the API is available.
      </p>
      <button type="button" className="button primary" onClick={reset}>
        Try again
      </button>
      <Link href="/login">Back to login</Link>
    </main>
  );
}

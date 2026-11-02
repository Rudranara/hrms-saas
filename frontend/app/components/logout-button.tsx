"use client";
import { useId, useRef, useState } from "react";
import { Icon } from "./ui-icon";
import "./logout-button.css";
export function LogoutButton({ platform = false }: { platform?: boolean }) {
  const pending = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function logout() {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(platform ? "/api/super-admin/auth/logout" : "/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" },
        body: "{}",
      });
      if (!response.ok) throw new Error();
      // A full navigation clears any in-memory Next router content for this session.
      window.location.replace(platform ? "/super-admin/login?reason=signed-out" : "/login");
    } catch {
      setError("Could not log out. Please try again.");
      pending.current = false;
      setLoading(false);
    }
  }
  return (
    <div className="dashboard-logout">
      <button
        type="button"
        className="button secondary"
        onClick={() => {
          setError("");
          dialog.current?.showModal();
        }}
        aria-haspopup="dialog"
        disabled={loading}
      >
        {loading ? "Logging out…" : "Log out"}
      </button>
      <dialog
        ref={dialog}
        className="logout-confirmation"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(event) => { if (pending.current) event.preventDefault(); }}
      >
        <button type="button" className="logout-confirmation-close" aria-label="Close logout confirmation" disabled={loading} onClick={() => dialog.current?.close()}><Icon name="close" /></button>
        <h2 id={titleId}>Log out of {platform ? "Platform Administration" : "your account"}?</h2>
        <p id={descriptionId}>Do you really want to log out? You’ll need to sign in again to {platform ? "access platform administration" : "access your workspace"}.</p>
        {error && <p className="logout-confirmation-error" role="alert">{error}</p>}
        <div className="logout-confirmation-actions">
          <button type="button" className="logout-confirmation-cancel" autoFocus disabled={loading} onClick={() => dialog.current?.close()}>Stay signed in</button>
          <button type="button" className="logout-confirmation-submit" disabled={loading} onClick={logout}>{loading ? "Logging out…" : "Yes, log out"}</button>
        </div>
      </dialog>
    </div>
  );
}

"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatDate } from "../lib/billing-types";
import { platformLoginHref } from "../lib/auth-redirects";
import type { Paginated } from "../lib/super-admin-types";

type Admin = { id: string; fullName: string; email: string; emailVerifiedAt: string | null; isActive: boolean; createdAt: string };
type Issue = { message: string; signIn?: boolean };
class AdminError extends Error { constructor(message: string, public status: number) { super(message); } }
function issue(error: unknown): Issue {
  return { message: error instanceof Error ? error.message : "Unable to load super-admin accounts. Please try again.", signIn: error instanceof AdminError && [401, 403].includes(error.status) };
}
async function adminRequest(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/super-admin/admins${path}`, body === undefined ? { cache: "no-store", signal } : {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" }, body: JSON.stringify(body), signal,
  });
  const data = await response.json();
  if (!response.ok) throw new AdminError(data.message || "Unable to add this super admin. Please try again.", response.status);
  return data;
}

export function SuperAdminManagement() {
  const [list, setList] = useState<Paginated<Admin> | null>(null), [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<Issue | null>(null), [message, setMessage] = useState("");
  const pending = useRef(false), nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    adminRequest(`?page=${page}&pageSize=10`, undefined, controller.signal).then(setList).catch((error) => { if (!controller.signal.aborted) setError(issue(error)); });
    return () => controller.abort();
  }, [page, revision]);
  useEffect(() => { if (open) nameInput.current?.focus(); }, [open]);
  async function addAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending.current) return;
    const form = event.currentTarget, values = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setError(null); setMessage("");
    if (values.password !== values.confirmPassword) { setError({ message: "Passwords do not match." }); return; }
    pending.current = true; setBusy(true);
    try {
      const result = await adminRequest("", values);
      form.reset(); setOpen(false); setMessage(result.message); setPage(1); setRevision((value) => value + 1);
    } catch (error) { setError(issue(error)); }
    finally {
      form.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => { input.value = ""; });
      pending.current = false; setBusy(false);
    }
  }
  return <section className="platform-detail platform-admins" aria-labelledby="platform-admins-heading">
    <div className="platform-section-heading"><div><span className="eyebrow">PLATFORM ACCESS</span><h2 id="platform-admins-heading">Super administrators</h2><p className="account-help">Add trusted people to manage the platform. Accounts are read-only after creation in this directory.</p></div>{!open && <button className="button primary" type="button" aria-expanded={open} aria-controls="platform-add-admin" onClick={() => { setOpen(true); setError(null); setMessage(""); }}>Add super admin</button>}</div>
    {error && <p className="auth-alert" role="alert">{error.message} {error.signIn ? <a href={platformLoginHref("/super-admin/admins")}>Sign in again</a> : !list && <button type="button" className="button-link" onClick={() => { setError(null); setRevision((value) => value + 1); }}>Retry</button>}</p>}
    {message && <p className="account-success" role="status">{message}</p>}
    {open && <form id="platform-add-admin" className="auth-form platform-admin-create" onSubmit={addAdmin} aria-busy={busy}>
      <h3>Add a super admin</h3><p className="account-help">They can sign in at the platform login using the email and password below. They can verify their email in their own account settings.</p>
      <fieldset disabled={busy}><div className="platform-admin-fields">
        <div className="auth-field"><label htmlFor="new-admin-name">Full name</label><input ref={nameInput} id="new-admin-name" name="fullName" autoComplete="off" minLength={2} maxLength={120} required /></div>
        <div className="auth-field"><label htmlFor="new-admin-email">Email address</label><input id="new-admin-email" name="email" type="email" autoComplete="off" maxLength={254} required /></div>
        <div className="auth-field"><label htmlFor="new-admin-password">Password</label><input id="new-admin-password" name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required aria-describedby="new-admin-password-help" /><p id="new-admin-password-help" className="auth-field-help">Use a unique passphrase with 8–128 characters.</p></div>
        <div className="auth-field"><label htmlFor="new-admin-confirm">Confirm password</label><input id="new-admin-confirm" name="confirmPassword" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></div>
      </div><div className="platform-admin-actions"><button className="button primary" type="submit">{busy ? "Adding…" : "Create super admin"}</button><button className="button secondary" type="button" onClick={() => { setOpen(false); setError(null); }}>Cancel</button></div></fieldset>
    </form>}
    {!list ? !error && <p role="status">Loading super administrators…</p> : <>
      <div className="platform-table-scroll"><table className="platform-table platform-admin-table"><caption>Super-admin accounts · {list.total} total</caption><thead><tr><th>Name</th><th>Email address</th><th>Account status</th><th>Created</th></tr></thead><tbody>{list.items.map((admin) => <tr key={admin.id}><td>{admin.fullName}</td><td>{admin.email}<small>{admin.emailVerifiedAt ? "Email verified" : "Email not verified"}</small></td><td><span className="platform-badge" data-state={admin.isActive ? "ACTIVE" : "INACTIVE"}>{admin.isActive ? "Active" : "Inactive"}</span></td><td>{formatDate(admin.createdAt)}</td></tr>)}</tbody></table></div>
      {list.total > list.pageSize && <nav className="platform-pager" aria-label="Super-admin pagination"><span>Page {list.page} of {Math.ceil(list.total / list.pageSize)}</span><div><button className="button secondary" type="button" disabled={busy || list.page <= 1} onClick={() => { setList(null); setError(null); setPage((value) => value - 1); }}>Previous</button><button className="button secondary" type="button" disabled={busy || list.page * list.pageSize >= list.total} onClick={() => { setList(null); setError(null); setPage((value) => value + 1); }}>Next</button></div></nav>}
    </>}
  </section>;
}

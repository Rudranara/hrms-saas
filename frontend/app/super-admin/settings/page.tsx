import { Suspense } from "react";
import type { Metadata } from "next";
import { SuperAdminShell } from "../../components/super-admin-shell";
import { SuperAdminSettings } from "../../components/super-admin-settings";
import "./settings.css";
export const metadata: Metadata = { title: "Account Settings | HRMS Super Admin", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function SettingsPage() {
  return <div className="platform-settings-page"><Suspense fallback={<main className="auth-loading" role="status">Checking account access…</main>}><SuperAdminShell returnTo="/super-admin/settings" heading="Account settings" description="Manage your sign-in email and review your account security."><SuperAdminSettings /></SuperAdminShell></Suspense></div>;
}

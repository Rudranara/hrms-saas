import { Suspense } from "react";
import type { Metadata } from "next";
import { SuperAdminShell } from "../../components/super-admin-shell";
import { SuperAdminRefunds } from "../../components/super-admin-refunds";
export const metadata: Metadata = { title: "Refund management | HRMS", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function RefundManagementPage() { return <Suspense fallback={<main className="auth-loading" role="status">Checking platform access…</main>}><SuperAdminShell returnTo="/super-admin/refunds" heading="Refund management" description="Review organization requests, issue approved refunds and verify provider results."><div className="platform-panel"><SuperAdminRefunds /></div></SuperAdminShell></Suspense>; }

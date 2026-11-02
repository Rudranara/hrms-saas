import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { SuperAdminShell } from "../../components/super-admin-shell";
import { SuperAdminManagement } from "../../components/super-admin-management";

export const metadata: Metadata = {
  title: "Super administrators | HRMS Super Admin",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function SuperAdminsPage() {
  return <Suspense fallback={<main className="auth-loading" role="status">Checking platform access…</main>}>
    <SuperAdminShell returnTo="/super-admin/admins" heading="Super administrators" description="View platform administrators and add new accounts.">
      <div className="platform-panel"><Link href="/super-admin">← Platform overview</Link><SuperAdminManagement /></div>
    </SuperAdminShell>
  </Suspense>;
}

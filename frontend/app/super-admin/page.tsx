import { Suspense } from "react";
import type { Metadata } from "next";
import { SuperAdminShell } from "../components/super-admin-shell";
import { SuperAdminPanel } from "../components/super-admin-panel";
export const metadata: Metadata = { title: "Platform overview | HRMS Super Admin", robots: { index: false, follow: false } };
export default function SuperAdminPage() {
  return <Suspense fallback={<main className="auth-loading" role="status">Checking platform access…</main>}><SuperAdminShell><SuperAdminPanel /></SuperAdminShell></Suspense>;
}

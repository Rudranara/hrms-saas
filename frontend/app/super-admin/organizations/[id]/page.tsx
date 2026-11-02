import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { SuperAdminShell } from "../../../components/super-admin-shell";
import { SuperAdminDetail } from "../../../components/super-admin-panel";
import "../organization-detail.css";
export const metadata: Metadata = { title: "Organization detail | HRMS Super Admin", robots: { index: false, follow: false } };
async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) notFound();
  return <div className="organization-detail-page"><SuperAdminShell returnTo={`/super-admin/organizations/${id}`} heading="Organization overview" description="Review workspace details, manage access and track billing activity."><SuperAdminDetail id={id} /></SuperAdminShell></div>;
}
export default function OrganizationDetailPage(props: { params: Promise<{ id: string }> }) {
  return <Suspense fallback={<main className="auth-loading" role="status">Checking platform access…</main>}><Detail {...props} /></Suspense>;
}

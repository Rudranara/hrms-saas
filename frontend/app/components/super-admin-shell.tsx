import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getPlatformAdmin } from "../lib/auth-server";
import { platformLoginHref } from "../lib/auth-redirects";
import { LogoutButton } from "./logout-button";
import { Icon } from "./ui-icon";
import "../auth.css";
import "../account.css";
import "../super-admin/admin.css";

export async function SuperAdminShell({ children, returnTo = "/super-admin", heading = "Your organizations. One clear view.", description = "Monitor trials, subscriptions and confirmed payments across the platform." }: { children: ReactNode; returnTo?: string; heading?: string; description?: string }) {
  const user = await getPlatformAdmin();
  if (!user) redirect(platformLoginHref(returnTo));
  return <main className="workspace-page platform-page">
    <header className="workspace-header section-shell">
      <Link className="brand" href="/super-admin"><span className="brand-mark"><Icon name="organization" /></span>HRMS <small>PLATFORM</small></Link>
      <div className="platform-session"><span>{user.fullName}</span><Link href="/super-admin/refunds">Refund management</Link><Link href="/super-admin/admins">Super admins</Link><Link href="/super-admin/settings">Account Settings</Link><LogoutButton platform /></div>
    </header>
    <div className="section-shell workspace-content">
      <div className="platform-intro"><span className="eyebrow">SUPER ADMIN · PLATFORM OPERATIONS</span><h1>{heading}</h1><p>{description}</p><span className="platform-scope">Platform account · Organization administrator access stays separate</span></div>
      {children}
    </div>
  </main>;
}

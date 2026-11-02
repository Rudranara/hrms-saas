import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, getBillingStatus } from "../lib/auth-server";
import { LogoutButton } from "../components/logout-button";
import { Icon } from "../components/ui-icon";
import { formatAccessState, formatDate } from "../lib/billing-types";
import { BillingReturnLink } from "../components/billing-return-link";
import { PaymentSuccessNotice } from "../components/payment-success-notice";
import "../auth.css";
import "../account.css";
import "./dashboard.css";
export const metadata: Metadata = {
  title: "Your organization | HRMS",
  robots: { index: false, follow: false },
};
async function Workspace() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { access } = await getBillingStatus();
  if (!access.allowed) redirect("/subscription-required");
  const administrator = user.role === "ORGANIZATION_ADMIN";
  const role = administrator ? "Administrator" : "Employee";
  const trial = access.source === "TRIAL";
  const days = Math.ceil(access.remainingTrialSeconds / 86400);
  const subscription = access.subscription;
  const initials = user.fullName.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("");
  const trialLength = access.trialStartedAt && access.trialExpiresAt
    ? (new Date(access.trialExpiresAt).getTime() - new Date(access.trialStartedAt).getTime()) / 1000 : 0;
  const trialPercent = trialLength > 0 ? Math.max(0, Math.min(100, access.remainingTrialSeconds / trialLength * 100)) : 0;
  const today = new Date(access.serverTime).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric" });
  return (
    <main className="workspace-page dashboard-page">
      <header className="workspace-header section-shell">
        <Link className="brand" href="/dashboard" aria-label="HRMS dashboard">
          <span className="brand-mark">
            <Icon name="organization" />
          </span>
          HRMS
        </Link>
        <div className="dashboard-header-actions"><span className="dashboard-header-role">{role}</span><LogoutButton /></div>
      </header>
      <nav className="dashboard-nav section-shell" aria-label="Workspace navigation">
        <Link href="/dashboard" aria-current="page"><Icon name="grid" />Overview</Link>
        <Link href="/billing"><Icon name="wallet" />Billing</Link>
        {!user.emailVerifiedAt && <Link href="/verification-pending"><Icon name="organization" />Verify email</Link>}
      </nav>
      <div className="section-shell workspace-content">
        <PaymentSuccessNotice />
        <div className="dashboard-intro">
          <div><span className="dashboard-kicker">WORKSPACE OVERVIEW</span><h1>Welcome back, {user.fullName}.</h1><p>Here’s an overview of your organization and account.</p></div>
          <span className="dashboard-today"><Icon name="calendar" />{today}</span>
        </div>
        <section className="dashboard-summary" aria-label="Account overview">
          <div className="dashboard-stat"><span className="dashboard-stat-icon"><Icon name="grid" /></span><div><span>Workspace access</span><strong>{formatAccessState(access.state)}</strong><small>{access.source === "GRACE" ? "Payment grace period" : "Your workspace is available"}</small></div></div>
          <div className="dashboard-stat"><span className="dashboard-stat-icon"><Icon name="people" /></span><div><span>Your role</span><strong>{role}</strong><small>{administrator ? "Organization account management" : "Organization member"}</small></div></div>
          <div className="dashboard-stat"><span className="dashboard-stat-icon"><Icon name={user.emailVerifiedAt ? "check" : "organization"} /></span><div><span>Account security</span><strong>{user.emailVerifiedAt ? "Email verified" : "Verification optional"}</strong><small>{user.emailVerifiedAt ? "Email ready for password recovery" : "Verify to enable password recovery"}</small></div></div>
        </section>
        <div className="dashboard-main-grid">
          <section className="workspace-details dashboard-account" aria-labelledby="account-details">
            <div className="dashboard-card-heading"><div><h2 id="account-details">Organization account</h2><p>Your workspace and profile details.</p></div><Icon name="organization" /></div>
            <div className="dashboard-identity"><span className="dashboard-avatar" aria-hidden="true">{initials}</span><div><h3>{user.organization.name}</h3><p>Signed in as {user.fullName}</p></div></div>
            <dl>
              <div><dt>Account holder</dt><dd>{user.fullName}</dd></div>
              <div><dt>Work email</dt><dd>{user.email}</dd></div>
              <div><dt>Role</dt><dd>{administrator ? "Organization administrator" : "Employee"}</dd></div>
              <div><dt>Email status</dt><dd><span className={`dashboard-badge ${user.emailVerifiedAt ? "is-verified" : "is-neutral"}`}>{user.emailVerifiedAt ? "Verified" : "Not verified"}</span></dd></div>
            </dl>
            <div className="dashboard-security"><span className="dashboard-security-icon"><Icon name={user.emailVerifiedAt ? "check" : "organization"} /></span><div><h3>{user.emailVerifiedAt ? "Email verified" : "Add a recovery option"}</h3><p>{user.emailVerifiedAt ? "Your verified email can be used for secure password recovery." : "Verify your email to enable password recovery. Your trial and billing remain available."}</p>{!user.emailVerifiedAt && <Link href="/verification-pending">Verify email <Icon name="arrow" /></Link>}</div></div>
          </section>
          <aside className="dashboard-subscription" aria-labelledby="dashboard-plan-heading">
            <div className="dashboard-plan-heading"><span className="dashboard-plan-icon"><Icon name="wallet" /></span><span className="dashboard-badge is-plan">{formatAccessState(access.state)}</span></div>
            <span className="dashboard-kicker">YOUR SUBSCRIPTION</span><h2 id="dashboard-plan-heading">{access.source === "MANUAL" ? access.manualAccess?.plan?.name || "Admin-managed access" : trial ? "Free trial" : subscription?.planName || "Workspace access"}</h2>
            {access.source === "MANUAL" && access.manualAccess && <p>Workspace access is provided by your platform administrator until {formatDate(access.manualAccess.expiresAt)}. Provider renewal dates below are separate.</p>}
            <p>{trial ? "Get to know your workspace before choosing a plan." : "Manage your organization’s plan and renewal preferences."}</p>
            {access.source === "MANUAL" ? <dl className="dashboard-plan-details"><div><dt>Access type</dt><dd>Admin-managed{access.manualAccess?.plan ? ` - ${access.manualAccess.plan.interval === "MONTHLY" ? "Monthly" : "Yearly"} plan` : ""}</dd></div><div><dt>Access ends</dt><dd>{formatDate(access.manualAccess?.expiresAt || null)}</dd></div></dl> : trial ? <div className="dashboard-trial"><strong>{days}<span> trial days remaining</span></strong><progress value={trialPercent} max={100} aria-label="Free trial time remaining" /><small>Days remaining, rounded up</small><dl><div><dt>Trial ends</dt><dd>{formatDate(access.trialExpiresAt)}</dd></div></dl><p>No payment details are required for your trial.</p></div> : <dl className="dashboard-plan-details"><div><dt>Billing cycle</dt><dd>{subscription ? subscription.interval === "MONTHLY" ? "Monthly" : "Yearly" : "No paid plan"}</dd></div><div><dt>{subscription?.cancelAtCycleEnd ? "Verified paid through" : "Next billing date"}</dt><dd>{formatDate(subscription?.cancelAtCycleEnd ? subscription.paidUntil : subscription?.nextBillingAt || null)}</dd></div>{subscription?.cancelAtCycleEnd && <div><dt>Renewal</dt><dd>Cancellation scheduled</dd></div>}</dl>}
            <BillingReturnLink fallbackLabel={administrator ? trial ? "Explore plans" : "Manage billing" : "View billing"} />
          </aside>
        </div>
        <section className="dashboard-modules" aria-labelledby="dashboard-modules-heading">
          <div className="dashboard-modules-heading"><div><h2 id="dashboard-modules-heading">Your people workspace</h2><p>A look at the modules being built for your organization.</p></div><span className="dashboard-badge is-neutral">In development</span></div>
          <div className="dashboard-module-grid">
            {([
              { icon: "people", title: "Employees", description: "Employee profiles and team information." },
              { icon: "clock", title: "Attendance", description: "Attendance records and working hours." },
              { icon: "calendar", title: "Leave", description: "Time-off requests and leave balances." },
              { icon: "wallet", title: "Payroll", description: "Payroll processing and pay records." },
            ] as const).map(module => <article className="dashboard-module" key={module.title}><span className="dashboard-module-icon"><Icon name={module.icon} /></span><h3>{module.title}</h3><p>{module.description}</p><span className="dashboard-module-status">In development</span></article>)}
          </div>
          <p className="dashboard-module-note">These modules are not available yet. A subscription does not make unfinished modules operational.</p>
        </section>
        <footer className="dashboard-footer"><span><Icon name="organization" />HRMS workspace</span><p>Dates and times are shown in Indian Standard Time (IST).</p></footer>
      </div>
    </main>
  );
}
export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <main className="auth-loading" role="status">
          Opening your workspace…
        </main>
      }
    >
      <Workspace />
    </Suspense>
  );
}

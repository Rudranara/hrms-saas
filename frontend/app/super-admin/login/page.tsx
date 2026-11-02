import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getPlatformAdmin } from "../../lib/auth-server";
import { platformReturn } from "../../lib/auth-redirects";
import { PlatformLoginForm } from "../../components/platform-login-form";
import { Icon } from "../../components/ui-icon";
import "../../auth.css";
import "./login.css";

export const metadata: Metadata = { title: "Platform Administration | HRMS", robots: { index: false, follow: false }, referrer: "no-referrer" };
type Props = { searchParams: Promise<{ next?: string | string[]; reason?: string | string[] }> };
async function LoginContent({ searchParams }: Props) {
  const [user, query] = await Promise.all([getPlatformAdmin(), searchParams]);
  if (user) redirect("/super-admin");
  const destination = platformReturn(typeof query.next === "string" ? query.next : null) || "/super-admin";
  const notice = query.reason === "signed-out" ? "You have been signed out securely."
    : query.reason === "session-ended" ? "Sign in to continue. Your previous session may have expired or been revoked." : null;
  return <main className="auth-page platform-login-page">
    <a className="skip-link" href="#platform-login-form">Skip to sign-in form</a>
    <div className="platform-login-container">
      <aside className="platform-login-story">
        <Link className="brand" href="/"><span className="brand-mark"><Icon name="organization" /></span>HRMS <small>PLATFORM</small></Link>
        <div><span className="eyebrow">PLATFORM OPERATIONS</span><h2>One platform.<br />A clear view.</h2><p>Manage organizations, monitor subscriptions, and keep your platform account secure.</p></div>
        <p className="platform-login-restricted">Access is restricted to authorized platform administrators.</p>
      </aside>
      <section className="auth-panel" id="platform-login-form" aria-labelledby="platform-login-title">
        <div className="auth-heading"><span className="eyebrow">ADMINISTRATOR SIGN IN</span><h1 id="platform-login-title">HRMS Platform Administration</h1><p>Secure access for platform administrators</p></div>
        {notice && <p className="platform-login-notice" role="status">{notice}</p>}
        <PlatformLoginForm destination={destination} />
        <p className="auth-disclosure">Use your existing platform account. Contact your platform administrator if you need access.</p>
      </section>
    </div>
  </main>;
}
export default function PlatformLoginPage(props: Props) {
  return <Suspense fallback={<main className="auth-loading" role="status">Checking your session…</main>}><LoginContent {...props} /></Suspense>;
}

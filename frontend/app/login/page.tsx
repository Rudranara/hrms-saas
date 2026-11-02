import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthShell } from "../components/auth-shell";
export const metadata: Metadata = {
  title: "Log in | HRMS",
  description: "Log in to your HRMS organization workspace.",
};
async function LoginContent({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  await searchParams;
  return <AuthShell mode="login" />;
}
export default function LoginPage(props: { searchParams: Promise<{ next?: string | string[] }> }) {
  return <Suspense fallback={<main className="auth-loading" role="status">Checking your session…</main>}><LoginContent {...props} /></Suspense>;
}

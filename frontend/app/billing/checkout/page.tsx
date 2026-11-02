import { Suspense } from "react";
import type { Metadata } from "next";
import { BillingPageContent } from "../../components/billing-page";

export const metadata: Metadata = { title: "Subscription checkout | HRMS", robots: { index: false, follow: false } };
export default function CheckoutPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <Suspense fallback={<main className="auth-loading" role="status">Loading subscription checkout…</main>}><BillingPageContent checkoutOnly searchParams={searchParams} /></Suspense>;
}

import { Suspense } from "react";
import type { Metadata } from "next";
import { BillingPageContent } from "../components/billing-page";
export const metadata: Metadata = {
  title: "Billing and subscription | HRMS",
  robots: { index: false, follow: false },
};
export default function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense
      fallback={
        <main className="auth-loading" role="status">
          Loading billing settings…
        </main>
      }
    >
      <BillingPageContent searchParams={searchParams} />
    </Suspense>
  );
}

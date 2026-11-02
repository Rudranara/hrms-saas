import { Suspense } from "react";
import type { Metadata } from "next";
import { BillingPageContent } from "../components/billing-page";
export const metadata: Metadata = {
  title: "Subscription required | HRMS",
  robots: { index: false, follow: false },
};
export default function SubscriptionRequiredPage() {
  return (
    <Suspense
      fallback={
        <main className="auth-loading" role="status">
          Loading subscription options…
        </main>
      }
    >
      <BillingPageContent required />
    </Suspense>
  );
}

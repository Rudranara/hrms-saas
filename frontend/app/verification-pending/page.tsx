import { Suspense } from "react";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getVerificationStatus } from "../lib/auth-server";
import { AccountCard } from "../components/account-card";
import { VerificationPanel } from "../components/verification-panel";
export const metadata: Metadata = {
  title: "Email and recovery settings | HRMS",
  robots: { index: false, follow: false },
};
async function Pending() {
  const user = await getVerificationStatus();
  if (!user) redirect("/login");
  if (user.verified) redirect("/dashboard");
  return (
    <AccountCard
      title={
        user.verified ? "Your email is verified." : "Verify your email (optional)."
      }
      description={`Email: ${user.email}. Verification enables password recovery. You can use your dashboard, trial and billing without it.`}
    >
      <VerificationPanel verified={user.verified} deliveryAvailable={user.deliveryAvailable} deliveryConfigurationMessage={user.deliveryConfigurationError?.message} />
    </AccountCard>
  );
}
export default function VerificationPendingPage() {
  return (
    <Suspense
      fallback={
        <main className="auth-loading" role="status">
          Opening verification settings…
        </main>
      }
    >
      <Pending />
    </Suspense>
  );
}

import type { Metadata } from "next";
import { AccountCard } from "../components/account-card";
import { RecoveryForm } from "../components/recovery-form";
export const metadata: Metadata = {
  title: "Verify your email | HRMS",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};
export default function VerifyEmailPage() {
  return (
    <AccountCard
      title="One step closer to your workspace."
      description="Confirm that this is your email address. Opening this page does not consume the link; choose Verify my email to continue."
    >
      <RecoveryForm mode="verify" />
    </AccountCard>
  );
}

import type { Metadata } from "next";
import { AccountCard } from "../components/account-card";
import { RecoveryForm } from "../components/recovery-form";
export const metadata: Metadata = {
  title: "Password recovery | HRMS",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};
export default function ForgotPasswordPage() {
  return (
    <AccountCard
      title="Let’s get you back in."
      description="Enter the email address registered to your organisation account to receive a one-time password reset code."
    >
      <RecoveryForm mode="forgot" />
    </AccountCard>
  );
}

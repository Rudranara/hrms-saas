import type { Metadata } from "next";
import { AccountCard } from "../components/account-card";
import { RecoveryForm } from "../components/recovery-form";
export const metadata: Metadata = {
  title: "Reset your password | HRMS",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};
export default function ResetPasswordPage() {
  return (
    <AccountCard
      title="A fresh start for your password."
      description="Choose a new password. All existing sessions will end after a successful reset; you’ll need to log in again."
    >
      <RecoveryForm mode="reset" />
    </AccountCard>
  );
}

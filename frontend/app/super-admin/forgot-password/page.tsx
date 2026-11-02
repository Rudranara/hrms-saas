import type { Metadata } from "next";
import { AccountCard } from "../../components/account-card";
import { PlatformRecoveryForm } from "../../components/platform-recovery-form";

export const metadata: Metadata = { title: "Platform password recovery | HRMS", referrer: "no-referrer", robots: { index: false, follow: false } };
export default function PlatformForgotPasswordPage() {
  return <AccountCard title="Reset your platform password." description="Enter the email address for your platform administrator account to receive a one-time password reset code."><PlatformRecoveryForm /></AccountCard>;
}

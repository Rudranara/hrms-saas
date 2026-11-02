import type { Metadata } from "next";
import { AuthShell } from "../components/auth-shell";
import "./register.css";
export const metadata: Metadata = {
  title: "Create your organization | HRMS",
  description:
    "Create your organization and administrator account. Seven-day trial period with no payment details required.",
};
export default function RegisterPage() {
  return <AuthShell mode="register" />;
}

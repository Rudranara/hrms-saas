import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HRMS for Growing Indian MSMEs",
  description:
    "A practical HRMS workspace for growing Indian MSMEs to organise employee records, attendance, leave, and payroll workflows. Explore a planned 7-day trial period.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "./ui-icon";
import "../auth.css";
import "../account.css";
export function AccountCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="account-card-page">
      <section className="account-card" aria-labelledby="account-title">
        <Link className="brand" href="/">
          <span className="brand-mark">
            <Icon name="organization" />
          </span>
          HRMS
        </Link>
        <h1 id="account-title">{title}</h1>
        <p className="account-description">{description}</p>
        {children}
      </section>
    </main>
  );
}

"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { billingHref as planBillingHref } from "../lib/billing-continuation";
import { Icon } from "./ui-icon";
import {
  formatMoney,
  yearlySavings,
  parsePlanCatalog,
  type BillingPlan,
} from "../lib/billing-types";

// Keep existing marketing button styling while routing to the real auth pages.
export function AvailabilityButton({
  children,
  kind = "trial",
  className = "",
}: {
  children: ReactNode;
  kind?: "trial" | "login" | "plan";
  planName?: string;
  className?: string;
}) {
  return (
    <Link
      href={
        kind === "login" ? "/login" : kind === "plan" ? "/billing" : "/register"
      }
      className={className}
    >
      {children}
    </Link>
  );
}

export function Header({ page = "home" }: { page?: "home" | "pricing" }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="site-header">
      <nav className="section-shell nav" aria-label="Main navigation">
        <Link
          className="brand"
          href={page === "home" ? "#" : "/"}
          aria-label="HRMS home"
        >
          <span className="brand-mark">
            <Icon name="organization" />
          </span>
          HRMS
        </Link>
        <button
          className="menu-toggle"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="navigation-links"
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? "close" : "menu"} />
        </button>
        <div
          id="navigation-links"
          className={`nav-links ${open ? "is-open" : ""}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>(".menu-toggle")
                ?.focus();
            }
          }}
        >
          <div className="nav-pages">
            {[
              ["Features", page === "home" ? "#features" : "/#features"],
              ["Modules", page === "home" ? "#product" : "/#product"],
              ["Pricing", "/pricing"],
              ["About", page === "home" ? "#about" : "/#about"],
            ].map(([label, href]) => (
              <Link
                key={label}
                href={href}
                aria-current={
                  page === "pricing" && label === "Pricing" ? "page" : undefined
                }
                onClick={() => setOpen(false)}
              >
                {label}
              </Link>
            ))}
          </div>
          <div className="nav-actions">
            <AvailabilityButton kind="login" className="login-button">
              Log in <Icon name="arrow" />
            </AvailabilityButton>
            <AvailabilityButton className="button primary nav-trial">
              Start Free Trial <Icon name="arrow" />
            </AvailabilityButton>
          </div>
        </div>
      </nav>
    </header>
  );
}

export function Pricing({ dedicated = false }: { dedicated?: boolean }) {
  const [billing, setBilling] = useState<"monthly" | "yearly">("monthly");
  const [catalog, setCatalog] = useState<BillingPlan[]>([]);
  const [catalogError, setCatalogError] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    fetch("/api/billing/plans", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((data) => {
        const plans = parsePlanCatalog(data.plans);
        if (alive) setCatalog(plans);
      })
      .catch(() => {
        if (alive) setCatalogError(true);
      })
      .finally(() => {
        if (alive) setCatalogLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const plans = [
    {
      name: "Essentials",
      text: "A practical starting point for small businesses organising core HR.",
      features: [
        "Employee profiles & records",
        "Attendance & leave management",
        "Organisation structure",
        "Workforce summaries",
      ],
    },
    {
      name: "Growth",
      text: "More connected workflows for a growing MSME.",
      features: [
        "Everything in Essentials",
        "Payroll management",
        "Reports & analytics",
        "Connected approval workflows",
      ],
    },
    {
      name: "Organization",
      text: "Broader visibility for businesses managing multiple teams.",
      features: [
        "Everything in Growth",
        "Organisation-wide oversight",
        "Department & team structure",
        "A plan for your business needs",
      ],
    },
  ];
  return (
    <>
      <div
        className="billing-toggle"
        role="group"
        aria-label="Billing frequency"
      >
        <button
          aria-pressed={billing === "monthly"}
          onClick={() => setBilling("monthly")}
        >
          Monthly
        </button>
        <button
          aria-pressed={billing === "yearly"}
          onClick={() => setBilling("yearly")}
        >
          Yearly
        </button>
      </div>
      <p
        className="billing-note"
        aria-live="polite"
        role={catalogError ? "alert" : "status"}
      >
        {billing === "monthly" ? "Monthly flexibility" : "Annual planning"} ·
        {catalogLoading
          ? "Loading plan prices…"
          : catalogError
            ? "Pricing service temporarily unavailable"
            : "Introductory prices per organisation"}
      </p>
      <div className="pricing-grid">
        {plans.map((plan, index) => {
          const configured = catalog.find(
            (item) =>
              item.name === plan.name &&
              item.interval === billing.toUpperCase(),
          );
          const savings = configured
            ? yearlySavings(configured, catalog)
            : null;
          const billingHref = configured
            ? planBillingHref(configured)
            : "/billing";
          return (
            <article
              className={`plan ${index === 1 ? "featured-plan" : ""}`}
              key={plan.name}
            >
              {index === 1 && (
                <span className="plan-ribbon">FOR GROWING MSMES</span>
              )}
              <span className="plan-number">0{index + 1}</span>
              <h3>{plan.name}</h3>
              <p>{plan.text}</p>
              <div className="plan-price">
                {configured?.amountMinor != null
                  ? formatMoney(configured.amountMinor, configured.currency)
                  : catalogLoading
                    ? "Loading…"
                    : "Price unavailable"}
                <small>
                  {configured?.amountMinor != null
                    ? `${billing === "monthly" ? "Monthly" : "Yearly"} billing · up to ${configured.totalCount} payments${configured.configured ? "" : " · checkout not configured"}`
                    : "Check plan configuration or try again later"}
                </small>
              </div>
              {savings !== null && configured && (
                <p className="plan-savings">
                  Save {formatMoney(savings, configured.currency)} per year
                  compared with 12 monthly payments.
                </p>
              )}
              {configured ? (
                <Link
                  href={billingHref}
                  className={`button ${index === 1 ? "primary" : "secondary"}`}
                >
                  Choose {plan.name} <Icon name="arrow" />
                </Link>
              ) : (
                <>
                  <button
                    disabled
                    className={`button ${index === 1 ? "primary" : "secondary"}`}
                  >
                    Checkout unavailable
                  </button>
                  <p className="account-help">
                    {catalogLoading
                      ? "Loading checkout availability…"
                      : catalogError || "Plan configuration is unavailable."}{" "}
                    <Link href={billingHref}>View billing setup</Link>
                  </p>
                </>
              )}
              {configured && !configured.configured && (
                <p className="account-help">{configured.unavailableReason || "Payment setup is pending. You can select a plan and review billing."}</p>
              )}
              <div className="plan-divider" />
              <span className="plan-includes">PLANNED IN THIS PACKAGE</span>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Icon name="check" />
                    {feature}
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
      <p className="small-note">
        {catalog[0]?.taxNote}{" "}
        {dedicated && "Introductory prices apply to one organisation."}
        Proposed packages only. Features and packaging may change. No payments
        or subscriptions are activated here.
      </p>
    </>
  );
}

export function BackendStatus() {
  const [status, setStatus] = useState({
    connected: null as boolean | null,
    message: "Checking backend connection...",
  });
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let cancelled = false;
    async function checkBackend() {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL;
      try {
        if (!apiUrl) throw new Error("API URL is not configured.");
        const response = await fetch(`${apiUrl}/api/health`, {
          signal: controller.signal,
        });
        const data: { success: boolean; message?: string } =
          await response.json();
        if (!response.ok || !data.success)
          throw new Error("Backend health check failed.");
        if (!cancelled)
          setStatus({
            connected: true,
            message: data.message ?? "Backend connected successfully.",
          });
      } catch {
        if (!cancelled)
          setStatus({
            connected: false,
            message: apiUrl
              ? "Could not connect to the backend. Check that the API server is running."
              : "API URL is not configured.",
          });
      } finally {
        clearTimeout(timeout);
      }
    }
    void checkBackend();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);
  return (
    <details className="backend-status">
      <summary>
        <span
          className={`little-dot ${status.connected === true ? "connected" : status.connected === false ? "offline" : ""}`}
        />
        API status
      </summary>
      <p role="status">
        {status.message}
        <br />
        {status.connected === null
          ? "Checking"
          : status.connected
            ? "Connected"
            : "Not connected"}
      </p>
    </details>
  );
}

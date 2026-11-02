import type { Metadata } from "next";
import {
  AvailabilityButton,
  Header,
  Pricing,
} from "../components/home-interactions";
import { SiteFooter } from "../components/site-footer";
import { Icon } from "../components/ui-icon";
import { MarketingScrollReset } from "../components/marketing-scroll-reset";
import "./pricing.css";
import Link from "next/link";

export const metadata: Metadata = {
  title: "MSME HRMS Pricing | HRMS",
  description:
    "Explore proposed organisation-level HRMS plans for growing Indian MSMEs, with monthly or yearly billing and a seven-day trial period without payment details upfront.",
};

// Proposed packaging only. These values are not subscription entitlements.
const comparison = [
  {
    feature: "Core employee records",
    detail: "A central place for employee profiles and organisation records",
    values: ["Proposed", "Proposed", "Proposed"],
  },
  {
    feature: "Attendance visibility",
    detail: "Daily records and attendance summaries for everyday follow-up",
    values: ["Proposed", "Proposed", "Proposed"],
  },
  {
    feature: "Leave coordination",
    detail: "Requests, balances, and approval workflows in one place",
    values: ["Proposed", "Proposed", "Proposed"],
  },
  {
    feature: "Payroll workflows",
    detail: "Salary information organised for your payroll process",
    values: ["To be confirmed", "Proposed", "Proposed"],
  },
  {
    feature: "Workforce visibility",
    detail: "Useful summaries and reporting for owners and administrators",
    values: [
      "Workforce summaries¹",
      "Reports & analytics¹",
      "Reports & analytics¹",
    ],
  },
  {
    feature: "Support options",
    detail: "Onboarding and support arrangements to be confirmed",
    values: ["To be confirmed", "To be confirmed", "To be confirmed"],
  },
];
const questions = [
  [
    "Is pricing charged per employee?",
    "The proposed plans are priced per organisation, not per employee. Review the displayed amount, billing interval, tax treatment, renewal cycles, and checkout availability before choosing a plan.",
  ],
  [
    "Which plan is right for my MSME?",
    "Essentials is intended as a starting point for organising core people information. Growth is proposed for businesses that need more connected workflows, while Organization is intended for broader oversight. Final features and entitlements are still to be confirmed.",
  ],
  [
    "What is the difference between monthly and yearly billing?",
    "Monthly plans bill once per month; yearly plans bill once per year. Yearly savings are calculated against twelve payments at the current monthly price. Changing the billing option does not start a subscription.",
  ],
  [
    "Will the seven-day trial require payment details?",
    "Registration creates an organisation account and records a seven-day trial period without payment details upfront. HR operation modules are still in development, and no paid subscription starts automatically.",
  ],
  [
    "Are the features in each plan confirmed?",
    "No. The cards and comparison table show proposed packaging. Features, availability, support arrangements, and plan entitlements are subject to confirmation before launch.",
  ],
  [
    "Can I create an account or pay today?",
    "You can create your organisation account now. Available plan buttons open billing with your selected plan, asking you to sign in if needed. Checkout stays unavailable until payment setup is complete. Paid access requires provider-verified captured payment.",
  ],
];

export default function PricingPage() {
  return (
    <>
      <MarketingScrollReset />
      <a className="skip-link" href="#pricing-main">
        Skip to content
      </a>
      <Header page="pricing" />
      <main id="pricing-main" className="pricing-page">
        <section
          className={`pricing-hero section-shell`}
          aria-labelledby="pricing-title"
        >
          <span className="eyebrow pill">
            <span className="little-dot" /> PRICING FOR GROWING INDIAN MSMES
          </span>
          <h1 id="pricing-title">
            Simple plans for <br />
            a growing <span>business.</span>
          </h1>
          <p>
            Organisation-level plans designed to give MSMEs a practical starting
            point for people operations. <br className="pricing-desktop-break" />
            Explore three proposed plans with monthly and yearly billing options.
          </p>
          <div className="pricing-hero-notes">
            <span>
              <Icon name="calendar" /> 7-day trial period
            </span>
            <span>
              <Icon name="wallet" /> No payment details upfront¹
            </span>
            <span>
              <Icon name="people" /> Organisation-level plans
            </span>
          </div>
          <a className="pricing-compare-link" href="#compare-plans">
            Compare the proposed plans <Icon name="arrow" />
          </a>
        </section>

        <section
          id="plans"
          className={`pricing-plans section-shell`}
          aria-label="Proposed HRMS plans"
        >
          <Pricing dedicated />
          <p className="pricing-policy-note">
            ¹ Your trial period starts after successful registration. HR
            operation modules are still in development. Paid checkout requires
            configured prices and payment-provider credentials.
          </p>
        </section>

        <section
          id="compare-plans"
          className={`pricing-comparison-section section-space`}
          aria-labelledby="comparison-title"
        >
          <div className="section-shell">
            <div className="section-heading">
              <div>
                <span className="eyebrow">COMPARE WHAT MATTERS</span>
                <h2 id="comparison-title">Choose a practical starting point.</h2>
              </div>
              <p>
                A clear view of the proposed packages for MSME owners and lean
                HR teams. Final features and support details will be confirmed
                before subscription billing opens.
              </p>
            </div>
            <div className="pricing-comparison">
              <table>
                <caption>
                  Proposed plan comparison · All entitlements are subject to
                  confirmation
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Everyday HR needs</th>
                    <th scope="col">Essentials</th>
                    <th scope="col" className="pricing-growth-column">
                      Growth<span>For growing MSMEs</span>
                    </th>
                    <th scope="col">Organization</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((row) => (
                    <tr key={row.feature}>
                      <th scope="row">
                        {row.feature}
                        <span>{row.detail}</span>
                      </th>
                      {row.values.map((value, i) => (
                        <td
                          key={i}
                          data-plan={
                            ["Essentials", "Growth", "Organization"][i]
                          }
                          className={
                            i === 1 ? "pricing-growth-column" : undefined
                          }
                        >
                          <span
                            className={
                              value === "Proposed"
                                ? "pricing-proposed"
                                : "pricing-unconfirmed"
                            }
                          >
                            {value === "Proposed" && <Icon name="check" />}
                            {value}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small-note">
              ¹ Reporting entries are proposed. “To be confirmed” means the
              entitlement or service details have not been decided.
            </p>
          </div>
        </section>

        <section
          id="trial"
          className={`pricing-trial section-shell section-space`}
          aria-labelledby="trial-title"
        >
          <div className="pricing-trial-intro">
            <span className="pricing-trial-number">
              7<span>days to explore</span>
            </span>
            <span className="eyebrow">A SIMPLE WAY TO EXPLORE</span>
            <h2 id="trial-title">
              See if it fits your
              <br />
              growing business.
            </h2>
            <p>
              A seven-day trial period without payment details upfront starts
              when you register. HR operation modules are still in development.
            </p>
            <AvailabilityButton className="button primary">
              Create your organisation <Icon name="arrow" />
            </AvailabilityButton>
          </div>
          <div className="pricing-trial-details">
            {[
              [
                "01",
                "Time to assess the fit",
                "Successful organisation registration records a seven-day trial period. Use that time to see whether the platform suits how your business manages people. HR operation modules are still in development.",
              ],
              [
                "02",
                "No payment details upfront",
                "Registration does not collect payment details. There is no checkout on this page, and creating an account does not charge you.",
              ],
              [
                "03",
                "A clear next step",
                "Create your administrator account and open your dashboard immediately. Explore during your trial, then choose a plan and billing cycle from Billing when you are ready. Email verification is optional.",
              ],
            ].map(([number, title, text]) => (
              <article key={number}>
                <span>{number}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section
          id="pricing-faq"
          className={`faq-section section-shell section-space pricing-faq`}
          aria-labelledby="pricing-faq-title"
        >
          <div>
            <span className="eyebrow">PRICING FOR PRACTICAL DECISIONS</span>
            <h2 id="pricing-faq-title">
              Questions small businesses
              <br />
              need answered.
            </h2>
            <p>
              What’s planned, what’s still being decided, and what happens next.
            </p>
          </div>
          <div className="faq-list">
            {questions.map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <span className="faq-plus" aria-hidden="true">
                    +
                  </span>
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section
          className={`closing section-shell pricing-closing`}
          aria-labelledby="pricing-cta-title"
        >
          <div className="closing-art" aria-hidden="true">
            <span />
            <span />
            <span />
            <Icon name="people" />
          </div>
          <span className="eyebrow">MAKE MORE TIME FOR YOUR BUSINESS</span>
          <h2 id="pricing-cta-title">
            Start simplifying
            <br />
            your people operations.
          </h2>
          <p>
            Explore the platform and find the proposed plan that could fit your
            growing MSME.
          </p>
          <div className="button-row">
            <AvailabilityButton className="button light">
              Create your organisation <Icon name="arrow" />
            </AvailabilityButton>
            <Link className="pricing-closing-link" href="/#product">
              See the product preview <Icon name="arrow" />
            </Link>
          </div>
          <span className="closing-note">
            No payment details for registration · Paid checkout requires
            configuration
          </span>
        </section>
      </main>
      <SiteFooter home={false} />
    </>
  );
}

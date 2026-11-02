import { SiteFooter } from "./components/site-footer";
import { DashboardPreview } from "./components/dashboard-preview";
import { FeaturePreview } from "./components/feature-preview";
import { MarketingScrollReset } from "./components/marketing-scroll-reset";
import { Icon, type IconName } from "./components/ui-icon";
import {
  AvailabilityButton,
  Header,
  Pricing,
} from "./components/home-interactions";

const features: { icon: IconName; title: string; description: string }[] = [
  {
    icon: "people",
    title: "Your employee records, in one place",
    description:
      "Move essential people information out of scattered spreadsheets and into one organised workspace.",
  },
  {
    icon: "clock",
    title: "A clearer view of every workday",
    description:
      "Bring daily attendance and time records together, so owners and operations teams can see what needs attention.",
  },
  {
    icon: "calendar",
    title: "Leave requests without the follow-up",
    description:
      "Give leave requests, balances, and approvals one clear place instead of relying on calls, messages, and email threads.",
  },
  {
    icon: "wallet",
    title: "Payroll-ready information, organised",
    description:
      "Keep salary information and payroll workflows alongside employee data, ready for your payroll process.",
  },
  {
    icon: "organization",
    title: "Simple structure as your team grows",
    description:
      "Set up departments, teams, and organisation details without adding complexity to your day.",
  },
  {
    icon: "chart",
    title: "Useful visibility for busy owners",
    description:
      "Use easy-to-read workforce summaries to make everyday people decisions with more confidence.",
  },
];
const faqs = [
  [
    "What is an HRMS?",
    "A Human Resource Management System brings employee information and everyday HR processes into one place. It helps teams organize their people operations with a shared view of the workforce.",
  ],
  [
    "Who is this platform designed for?",
    "HRMS SaaS is being designed for Indian MSMEs and growing teams that want a simpler way to organise employee records, attendance, leave, payroll workflows, and workforce reporting. The previews illustrate the intended experience; they are not live tools.",
  ],
  [
    "How does the seven-day free trial work?",
    "Successful registration creates your organisation and administrator account and starts a seven-day trial period. No payment details are required. HR operation modules are still in development; paid access requires configured checkout and a verified captured payment.",
  ],
  [
    "Can we manage our employees in one place?",
    "Centralised employee profiles and organisation information are at the heart of the planned platform. The sample dashboard demonstrates how these records and HR summaries can come together.",
  ],
  [
    "Will monthly and yearly subscriptions be available?",
    "Monthly and yearly billing are supported through configured Razorpay plans. Prices come from the server and remain unannounced until configured. No subscription starts by switching the billing toggle.",
  ],
];

export default function Home() {
  return (
    <>
      <MarketingScrollReset />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main">
        <section className="hero section-shell">
          <div className="hero-copy">
            <div className="eyebrow pill">
              <span className="little-dot" /> HRMS FOR GROWING INDIAN MSMES
            </div>
            <h1>
              <span className="headline-line">Less HR admin.</span>
              <span className="headline-line">
                More time to run
              </span>
              <span className="headline-line">your <em>business.</em></span>
            </h1>
            <p className="hero-description">
              Built for MSME owners and lean HR teams. Bring employee records,
              attendance, leave, and payroll workflows into one simple,
              connected workspace.
            </p>
            <div className="button-row">
              <AvailabilityButton className="button primary">
                Create Your Organisation <Icon name="arrow" />
              </AvailabilityButton>
              <a className="button secondary" href="#features">
                Explore Features <Icon name="arrow" />
              </a>
            </div>
            <div className="hero-notes">
              <span>
                <Icon name="check" /> 7-day trial period
              </span>
              <span>
                <Icon name="check" /> No payment details upfront
              </span>
            </div>
          </div>
          <div className="hero-product">
            <div className="preview-overline">
              <span className="little-dot" /> YOUR PEOPLE. ONE CLEAR VIEW.
            </div>
            <DashboardPreview compact />
            <div className="floating-note">
              <span className="note-icon">
                <Icon name="calendar" />
              </span>
              <div>
                <strong>Time off, all in view.</strong>
                <span>Alex Smith · 2 days · Sample request</span>
              </div>
              <span className="pending-badge">Pending review</span>
            </div>
            <p className="sample-caption">
              Illustrative product preview · Sample data
            </p>
          </div>
        </section>
        <section
          className="value-strip section-shell"
          aria-label="Platform benefits"
        >
          <p>
            Designed for your people.
            <br />
            <strong>Practical for your business.</strong>
          </p>
          {(
            [
              ["organization", "One simple HR workspace"],
              ["clock", "Less manual follow-up"],
              ["chart", "A clearer workforce view"],
              ["people", "Records beyond spreadsheets"],
            ] as [IconName, string][]
          ).map(([icon, text]) => (
            <div key={text}>
              <Icon name={icon} />
              <span>{text}</span>
            </div>
          ))}
        </section>
        <section id="features" className="features section-shell section-space">
          <div className="section-heading">
            <div>
              <span className="eyebrow">HR ESSENTIALS FOR MSMES</span>
              <h2>
                The everyday HR work.
                <br />
                One simpler system.
              </h2>
            </div>
            <p>
              Give your business a practical starting point for people operations,
              without the cost or complexity of an enterprise HR system.
            </p>
          </div>
          <div className="feature-grid">
            {features.map((feature, index) => (
              <article
                className={`feature feature-${feature.icon}`}
                id={`feature-${index}`}
                key={feature.title}
              >
                <div className="feature-copy">
                  <span className={`feature-icon tone-${index}`}>
                    <Icon name={feature.icon} />
                  </span>
                  <h3>{feature.title}</h3>
                  <p>{feature.description}</p>
                  <a
                    href="#product"
                    aria-label={`Preview ${feature.title.toLowerCase()}`}
                  >
                    Explore the platform <Icon name="arrow" />
                  </a>
                </div>
                <FeaturePreview kind={feature.icon} />
              </article>
            ))}
          </div>
        </section>
        <section id="product" className="product-section section-space">
          <div className="section-shell">
            <div className="center-heading">
              <span className="eyebrow">CLARITY AT A GLANCE</span>
              <h2>
                A clearer view of your team.
                <br />
                Without the spreadsheet chase.
              </h2>
              <p>
                From who’s in today to what needs your attention.
                <br />A calmer, more connected way to start your workday.
              </p>
            </div>
            <div className="large-preview">
              <DashboardPreview />
            </div>
            <p className="sample-caption">
              Product concept with illustrative sample data. Charts, records,
              and activity are not connected to live employee data.
            </p>
          </div>
        </section>
        <section id="about" className="how-section section-shell section-space">
          <div className="section-heading">
            <div>
              <span className="eyebrow">
                SIMPLE TO START. READY TO GROW.
              </span>
              <h2>Built around the way MSMEs work.</h2>
            </div>
            <p>
              Whether you are an owner, administrator, or small HR team, getting
              your people operations organised should feel straightforward.
            </p>
          </div>
          <div className="steps">
            {[
              [
                "01",
                "Set up your organisation",
                "Create your organisation account and give essential people information a central home.",
              ],
              [
                "02",
                "Bring your team information together",
                "Set up employee details, departments, and your workforce structure in one place.",
              ],
              [
                "03",
                "Build a better everyday routine",
                "Use one connected workspace for the HR work your growing business needs.",
              ],
            ].map(([number, title, text]) => (
              <article key={number}>
                <span>{number}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
          <p className="small-note">
            Create your organisation account today. HR operation modules are
            still in development.
          </p>
        </section>
        <section id="pricing" className="pricing-section section-space">
          <div className="section-shell">
            <div className="center-heading">
              <span className="eyebrow">ROOM TO GROW</span>
              <h2>Simple plans for growing businesses.</h2>
              <p>
                Start with a 7-day trial period. Organisation-level pricing is
                designed to give MSMEs a clearer starting point as they grow.
                <br />
                We’re putting the finishing touches on our plans and pricing.
              </p>
            </div>
            <Pricing />
          </div>
        </section>
        <section id="faq" className="faq-section section-shell section-space">
          <div>
            <span className="eyebrow">A LITTLE MORE CLARITY</span>
            <h2>
              Good questions.
              <br />
              Straightforward answers.
            </h2>
            <p>
              Get to know the platform
              <br />
              before you take the next step.
            </p>
          </div>
          <div className="faq-list">
            {faqs.map(([question, answer]) => (
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
        <section className="closing section-shell">
          <div className="closing-art" aria-hidden="true">
            <span />
            <span />
            <span />
            <Icon name="people" />
          </div>
          <span className="eyebrow">MAKE MORE TIME FOR YOUR BUSINESS</span>
          <h2>
            Better people operations start
            <br />
            with a simpler system.
          </h2>
          <p>Bring your HR information together. Keep your growing team moving.</p>
          <div className="button-row">
            <AvailabilityButton className="button light">
              Create Your Organisation <Icon name="arrow" />
            </AvailabilityButton>
            <AvailabilityButton kind="login" className="closing-login">
              Already have an account? Log in <Icon name="arrow" />
            </AvailabilityButton>
          </div>
          <span className="closing-note">
            7-day trial period · No payment details required
          </span>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

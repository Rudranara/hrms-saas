import Link from "next/link";
import { Icon } from "./ui-icon";
import { AuthForm } from "./auth-form";
import "../auth.css";

export function AuthShell({ mode }: { mode: "register" | "login" }) {
  const registration = mode === "register";
  return (
    <main className={`auth-page${registration ? " registration-page" : ""}`}>
      <a className="skip-link" href="#auth-form">
        Skip to form
      </a>
      <div className="auth-container">
        <aside className="auth-story">
          <Link className="brand" href="/">
            <span className="brand-mark">
              <Icon name="organization" />
            </span>
            HRMS
          </Link>
          <div>
            <span className="eyebrow">YOUR PEOPLE. ONE CONNECTED HOME.</span>
            <div className="auth-story-title" aria-hidden="true">
              Make room
              <br />
              for your
              <br />
              <span>next chapter.</span>
            </div>
            <p>
              A thoughtful foundation for your organization, starting with you.
            </p>
            <div className="auth-benefits">
              <span>
                <Icon name="check" /> One organization. Your own workspace.
              </span>
              <span>
                <Icon name="check" /> A seven-day trial period.
              </span>
              <span>
                <Icon name="check" /> No payment details required.
              </span>
            </div>
          </div>
          <Link className="auth-back" href="/">
            <Icon name="arrow" /> Back to the homepage
          </Link>
        </aside>
        <section
          className="auth-panel"
          id="auth-form"
          aria-labelledby="auth-title"
        >
          <div className="auth-heading">
            <span className="eyebrow">
              {registration ? "LET’S GET YOU SET UP" : "GOOD TO SEE YOU AGAIN"}
            </span>
            <h1 id="auth-title">
              {registration
                ? "Create your organization"
                : "Welcome to your workspace."}
            </h1>
            <p>
              {registration
                ? "Set up your workspace, then verify your work email to start your seven-day trial. No payment details required."
                : "Log in with your work email to manage your organization account."}
            </p>
          </div>
          <AuthForm mode={mode} />
          <p className="auth-disclosure">
            {registration
              ? "This creates your organization account and trial record. HR operation modules are still in development. Creating an account does not charge you. Billing requires configured provider checkout."
              : "For your privacy, log out when using a shared device."}
          </p>
        </section>
      </div>
    </main>
  );
}

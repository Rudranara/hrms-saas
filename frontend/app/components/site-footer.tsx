import { AvailabilityButton, BackendStatus } from "./home-interactions";
import { Icon } from "./ui-icon";
import Link from "next/link";

export function SiteFooter({ home = true }: { home?: boolean }) {
  return (
    <footer className="footer section-shell">
      <div className="footer-top">
        <div>
          <Link href={home ? "#" : "/"} className="brand">
            <span className="brand-mark">
              <Icon name="organization" />
            </span>
            HRMS
          </Link>
          <p>
            A simpler HR workspace for growing
            <br />
            Indian MSMEs and their people.
          </p>
        </div>
        <div>
          <strong>Platform</strong>
          <a href={home ? "#features" : "/#features"}>Features</a>
          <a href={home ? "#product" : "/#product"}>Product preview</a>
          <Link href="/pricing">Pricing</Link>
        </div>
        <div>
          <strong>Resources</strong>
          <a href={home ? "#about" : "/#about"}>About us</a>
          <a href={home ? "#faq" : "#pricing-faq"}>FAQs</a>
          <AvailabilityButton kind="login">Log in</AvailabilityButton>
        </div>
        <div className="footer-message">
          <span className="eyebrow">BUILT FOR GROWING MSMES</span>
          <p>
            Less manual administration.
            <br />
            <strong>More time for your business.</strong>
          </p>
        </div>
      </div>
      <div className="footer-bottom">
        <span>© 2026 HRMS SaaS. All rights reserved.</span>
        <BackendStatus />
        <span>Made for the way growing teams work.</span>
      </div>
    </footer>
  );
}

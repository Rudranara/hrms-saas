"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Icon } from "./ui-icon";
import type { AuthResult } from "../lib/auth-types";
import { VERIFICATION_DELIVERY } from "../lib/auth-types";
import { billingReturn, BILLING_CONTINUATION } from "../lib/billing-continuation";
import { loginDestination } from "../lib/auth-redirects";
import { RegistrationOtp } from "./registration-otp";
import { CountryCodeSelect } from "./country-code-select";

type Fields =
  "organizationName" | "employeeSize" | "fullName" | "email" | "countryCode" | "phoneNumber" | "password" | "confirmPassword";
const employeeSizes = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001+"];
type FieldErrors = Partial<Record<Fields, string>>;
export function AuthForm({ mode }: { mode: "register" | "login" }) {
  const registration = mode === "register";
  const [errors, setErrors] = useState<FieldErrors>({});
  const [apiError, setApiError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const pending = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const [continuation, setContinuation] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  useEffect(() => {
    const next = billingReturn(new URLSearchParams(window.location.search).get("next"));
    if (next)
      queueMicrotask(() =>
        setContinuation(`?next=${encodeURIComponent(next)}`),
      );
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const countryCode = String(formData.get("countryCode") || "").trim();
    formData.delete("countryCode");
    const values = Object.fromEntries(formData) as Record<
      Fields,
      string
    >;
    const invalid: FieldErrors = {};
    if (registration) {
      if (
        !values.organizationName?.trim() ||
        values.organizationName.trim().length < 2
      )
        invalid.organizationName =
          "Enter an organization name with at least 2 characters.";
      if (!values.fullName?.trim() || values.fullName.trim().length < 2)
        invalid.fullName = "Enter your full name.";
      if (!employeeSizes.includes(values.employeeSize))
        invalid.employeeSize = "Select your organization's employee size.";
      if (!/^\+[1-9][0-9]{0,2}$/.test(countryCode))
        invalid.countryCode = "Enter a country code, e.g. +91.";
      const combinedPhone = countryCode + (values.phoneNumber || "").replace(/[\s().-]/g, "");
      if (!/^[0-9\s().-]+$/.test(values.phoneNumber?.trim() || "") || !/^\+[1-9][0-9]{9,14}$/.test(combinedPhone))
        invalid.phoneNumber = "Enter a valid phone number with 10–15 digits including the country code.";
      if (!invalid.phoneNumber && !invalid.countryCode) values.phoneNumber = combinedPhone;
      if (values.password?.length < 8)
        invalid.password = "Use at least 8 characters.";
      if (values.confirmPassword !== values.password)
        invalid.confirmPassword = "Passwords do not match.";
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email?.trim() || ""))
      invalid.email = "Enter a valid work email.";
    if (!values.password) invalid.password = "Enter your password.";
    else if (values.password.length > 128)
      invalid.password = "Use no more than 128 characters.";
    setErrors(invalid);
    setApiError("");
    const firstError = Object.keys(invalid)[0];
    if (firstError) {
      form.querySelector<HTMLInputElement>(`[name="${firstError}"]`)?.focus();
      return;
    }
    pending.current = true;
    setLoading(true);
    let completed = false;
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-HRMS-Request": "1" },
        body: JSON.stringify(values),
      });
      const data: AuthResult = await response.json();
      if (!response.ok || !data.success) {
        if (data.errors)
          setErrors(
            Object.fromEntries(
              Object.entries(data.errors).map(([key, messages]) => [
                key,
                messages[0],
              ]),
            ),
          );
        setApiError(data.message || "Unable to continue. Please try again.");
        requestAnimationFrame(() => alert.current?.focus());
        return;
      }
      if (registration && data.verificationRequired) { setSignupEmail(data.email || values.email.trim()); return; }
      completed = true;
      const rawNext = new URLSearchParams(window.location.search).getAll("next");
      const next = rawNext.length === 1 ? billingReturn(rawNext[0]) : null;
      // Billing validates the selection against the current backend catalog.
      // Registration always opens the dashboard; paid intent can be resumed in Billing.
      let destination = "/dashboard";
      if (next) {
        const query = new URLSearchParams(next.slice(9));
        if (registration) query.set("review", "1");
        destination = `/billing?${query}`;
      }
      try {
        sessionStorage.removeItem(VERIFICATION_DELIVERY);
        if (destination.startsWith("/billing?plan=")) sessionStorage.setItem(BILLING_CONTINUATION, destination);
        else sessionStorage.removeItem(BILLING_CONTINUATION);
      } catch { /* Storage is optional; the URL retains the selection. */ }
      // A hard same-origin navigation guarantees that the just-issued HttpOnly
      // session cookie is present on the dashboard's first server request.
      // It also avoids retaining an unauthenticated RSC route snapshot.
      window.location.replace(
        registration
          ? "/dashboard"
          : loginDestination(
              data.user?.role,
              rawNext.length === 1 ? rawNext[0] : null,
            ),
      );
    } catch {
      setApiError("We couldn’t reach the server. Please try again.");
      requestAnimationFrame(() => alert.current?.focus());
    } finally {
      if (!completed) {
        pending.current = false;
        setLoading(false);
      }
    }
  }
  if (registration && signupEmail) return <RegistrationOtp email={signupEmail} onChangeEmail={() => { setSignupEmail(""); setApiError(""); }} onComplete={() => {
    const rawNext = new URLSearchParams(window.location.search).getAll("next");
    const next = rawNext.length === 1 ? billingReturn(rawNext[0]) : null;
    try {
      sessionStorage.removeItem(VERIFICATION_DELIVERY);
      if (next) { const query = new URLSearchParams(next.slice(9)); query.set("review", "1"); sessionStorage.setItem(BILLING_CONTINUATION, `/billing?${query}`); }
      else sessionStorage.removeItem(BILLING_CONTINUATION);
    } catch { /* Storage is optional. */ }
    window.location.replace("/dashboard");
  }} />;
  const field = (
    name: Fields,
    label: string,
    type = "text",
    autocomplete?: string,
    help?: string,
  ) => (
    <div className={`auth-field auth-field-${name}`} key={name}>
      <label htmlFor={`auth-${name}`}>{label}</label>
      <div className="auth-input-wrap">
        <input
          id={`auth-${name}`}
          name={name}
          type={type}
          autoComplete={autocomplete}
          required
          minLength={registration && (name === "password" || name === "confirmPassword") ? 8 : undefined}
          maxLength={
            name === "email"
              ? 254
              : name === "phoneNumber"
                ? 32
              : name === "password" || name === "confirmPassword"
                ? 128
                : 120
          }
          aria-invalid={!!errors[name]}
          aria-describedby={
            [help ? `${name}-help` : "", errors[name] ? `${name}-error` : ""]
              .filter(Boolean)
              .join(" ") || undefined
          }
        />
        {name === "password" && (
          <button
            type="button"
            className="password-toggle"
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            onClick={() => setShowPassword(!showPassword)}
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        )}
      </div>
      {help && (
        <p className="auth-field-help" id={`${name}-help`}>
          {help}
        </p>
      )}
      {errors[name] && (
        <p className="auth-field-error" id={`${name}-error`}>
          {errors[name]}
        </p>
      )}
    </div>
  );
  return (
    <form
      method="post"
      action={`/api/auth/${mode}`}
      onSubmit={submit}
      noValidate
      className="auth-form"
      aria-busy={loading}
    >
      {apiError && (
        <div ref={alert} className="auth-alert" role="alert" tabIndex={-1}>
          {apiError}
        </div>
      )}
      <fieldset disabled={loading}>
        {registration &&
          field(
            "organizationName",
            "Organization name",
            "text",
            "organization",
          )}
        {registration && <div className="auth-field auth-field-employeeSize">
          <label htmlFor="auth-employeeSize">Organization employee size</label>
          <select id="auth-employeeSize" name="employeeSize" defaultValue="" required aria-invalid={!!errors.employeeSize} aria-describedby={errors.employeeSize ? "employeeSize-error" : undefined}>
            <option value="" disabled>Select employee size</option>
            {employeeSizes.map((size) => <option value={size} key={size}>{size.replace("-", "–")} employees</option>)}
          </select>
          {errors.employeeSize && <p className="auth-field-error" id="employeeSize-error">{errors.employeeSize}</p>}
        </div>}
        {registration &&
          field("fullName", "Administrator’s full name", "text", "name")}
        {field("email", "Work email", "email", "username")}
        {registration && <div className="auth-field auth-field-phoneNumber">
          <label htmlFor="auth-phoneNumber">Phone number</label>
          <div className="auth-phone-row">
            <CountryCodeSelect error={errors.countryCode} />
            <input id="auth-phoneNumber" name="phoneNumber" type="tel" inputMode="tel" autoComplete="tel-national" maxLength={20} required aria-invalid={!!errors.phoneNumber} aria-describedby={errors.phoneNumber ? "phoneNumber-error" : "phoneNumber-help"} />
          </div>
          <p className="auth-field-help" id="phoneNumber-help">Country code on the left, phone number on the right.</p>
          {errors.countryCode && <p className="auth-field-error" id="countryCode-error">{errors.countryCode}</p>}
          {errors.phoneNumber && <p className="auth-field-error" id="phoneNumber-error">{errors.phoneNumber}</p>}
        </div>}
        {field(
          "password",
          "Password",
          showPassword ? "text" : "password",
          registration ? "new-password" : "current-password",
          registration
            ? "Use 8–128 characters. A long, unique passphrase works well."
            : undefined,
        )}
        {registration &&
          field(
            "confirmPassword",
            "Confirm password",
            showPassword ? "text" : "password",
            "new-password",
          )}
        <button
          className="button primary auth-submit"
          type="submit"
          disabled={loading}
        >
          {loading
            ? registration
              ? "Sending verification code…"
              : "Signing you in…"
            : registration
              ? "Create organization account"
              : "Log in to your workspace"}
          {!loading && <Icon name="arrow" />}
        </button>
      </fieldset>
      {!registration && (
        <p className="auth-switch">
          <Link href="/forgot-password">Forgot your password?</Link>
        </p>
      )}
      <p className="auth-switch">
        {registration ? "Already have an account?" : "New to HRMS?"}{" "}
        <Link href={(registration ? "/login" : "/register") + continuation}>
          {registration ? "Log in" : "Create an organization"}
        </Link>
      </p>
    </form>
  );
}

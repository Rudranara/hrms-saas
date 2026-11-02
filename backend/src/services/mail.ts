import nodemailer from "nodemailer";
import type { SendMailOptions } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { ServiceError } from "./errors";

export type MailMessage = { to: string; subject: string; text: string };
export interface Mailer {
  available: boolean;
  configurationError?: { code: string; message: string };
  checkConnection?(): Promise<void>;
  send(message: MailMessage): Promise<void>;
}
type Transport = {
  sendMail(message: SendMailOptions): Promise<{ accepted?: unknown[]; rejected?: unknown[] }>;
  verify(): Promise<unknown>;
};
type TransportFactory = (options: SMTPTransport.Options) => Transport;
function unavailable(code: string, message: string): Mailer {
  const fail = async () => { throw new ServiceError(code, 503, message); };
  return {
    available: false,
    configurationError: { code, message },
    send: fail,
    checkConnection: fail,
  };
}
function deliveryError(error: unknown): ServiceError {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  // Classify provider policy failures without exposing its raw response (which
  // may contain account email addresses or credentials) to the browser.
  const response = error && typeof error === "object" && "response" in error ? String(error.response) : "";
  if (/only send (?:testing|test) emails|testing emails.*own email/i.test(response))
    return new ServiceError("EMAIL_TEST_RECIPIENT_RESTRICTED", 503, "The email service is using a test sender that cannot send to this address. Contact your administrator to configure a verified sending domain.");
  if (/domain.*not verified|verify (?:a|your) domain|sender.*not (?:verified|authorized)/i.test(response))
    return new ServiceError("EMAIL_SENDER_UNVERIFIED", 503, "The email sender is not verified. Contact your administrator to configure a verified sending domain.");
  if (code === "EAUTH") return new ServiceError("EMAIL_AUTH_FAILED", 503, "The email provider rejected authentication. Contact your administrator to check the provider credentials, then resend verification.");
  if (["ECONNECTION", "ECONNREFUSED", "ETIMEDOUT", "ESOCKET", "EDNS"].includes(String(code)))
    return new ServiceError("EMAIL_CONNECTION_FAILED", 503, "The email provider could not be reached securely. Please try again or contact your administrator.");
  return new ServiceError("EMAIL_DELIVERY_FAILED", 503, "The email provider did not confirm acceptance. Check the authorized sender and recipient settings, then try again.");
}
export function smtpMailer(env: NodeJS.ProcessEnv = process.env, createTransport: TransportFactory = nodemailer.createTransport): Mailer {
  const provider = env.MAIL_PROVIDER?.trim() || "smtp";
  if (!["smtp", "resend", "gmail"].includes(provider)) return unavailable("EMAIL_PROVIDER_INVALID", "MAIL_PROVIDER must be smtp, gmail or resend. No email has been sent.");
  const resend = provider === "resend";
  const gmail = provider === "gmail";
  const host = gmail ? "smtp.gmail.com" : resend ? "smtp.resend.com" : env.SMTP_HOST?.trim();
  const user = gmail ? env.SMTP_USER?.trim() : resend ? "resend" : env.SMTP_USER;
  // Google displays app passwords grouped with spaces. Authenticate using the
  // actual password, and send from the same Google account that authenticated.
  const password = gmail ? env.SMTP_PASSWORD?.replace(/\s/g, "") : resend ? env.RESEND_API_KEY : env.SMTP_PASSWORD;
  const from = gmail ? user : env.SMTP_FROM?.trim();
  const port = Number(gmail || resend ? 465 : env.SMTP_PORT || 587);
  const local =
    !resend && !gmail &&
    env.NODE_ENV !== "production" &&
    env.SMTP_ALLOW_INSECURE_LOCAL === "true" &&
    ["localhost", "127.0.0.1", "::1"].includes(host || "");
  const missing = [
    ...(!host ? ["SMTP_HOST"] : []),
    ...(!from && !gmail ? ["SMTP_FROM"] : []),
    ...(!local && !user?.trim() ? ["SMTP_USER"] : []),
    ...(!local && !password?.trim() ? [resend ? "RESEND_API_KEY" : "SMTP_PASSWORD"] : []),
  ];
  if (missing.length) return unavailable("EMAIL_NOT_CONFIGURED", `Email delivery is not configured. Missing backend settings: ${missing.join(", ")}. Your account remains saved; configure delivery and request a new link.`);
  if (gmail && (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(user || "") || !/^[a-zA-Z0-9]{16}$/.test(password || "")))
    return unavailable("EMAIL_GMAIL_CONFIG_INVALID", "Set SMTP_USER to your full Google email address and SMTP_PASSWORD to its 16-character Google App Password.");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return unavailable("EMAIL_PORT_INVALID", "SMTP_PORT must be an integer between 1 and 65535.");
  if (!resend && !gmail && env.SMTP_SECURE && !["true", "false"].includes(env.SMTP_SECURE))
    return unavailable("EMAIL_TLS_INVALID", "SMTP_SECURE must be true or false. Use true for implicit TLS, or false for STARTTLS.");
  const secure = gmail || resend || env.SMTP_SECURE === "true";
  const transport = createTransport({
    host,
    port,
    secure,
    requireTLS: !local && !secure,
    ignoreTLS: local,
    auth:
      !local && user && password
        ? { user, pass: password }
        : undefined,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 8000,
    logger: false,
    debug: false,
  });
  return {
    available: true,
    async checkConnection() {
      try { await transport.verify(); }
      catch (error) { throw deliveryError(error); }
    },
    async send(message) {
      try {
        const result = await transport.sendMail({
          from,
          ...message,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        if (
          !result.accepted?.some(
            (address: unknown) =>
              typeof address === "string" &&
              address.toLowerCase() === message.to.toLowerCase(),
          ) ||
          result.rejected?.length
        )
          throw new Error("SMTP rejection");
      } catch (error) {
        throw deliveryError(error);
      }
    },
  };
}

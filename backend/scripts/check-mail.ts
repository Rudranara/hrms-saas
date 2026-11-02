import "dotenv/config";
import { smtpMailer } from "../src/services/mail";
import { ServiceError } from "../src/services/errors";

// Checks configuration, TLS and authentication; never sends an email or prints credentials.
async function main() {
  const mailer = smtpMailer();
  if (mailer.configurationError) {
    console.error(JSON.stringify({ success: false, ...mailer.configurationError }));
    process.exitCode = 1;
    return;
  }
  try {
    await mailer.checkConnection!();
    const testSender = (process.env.MAIL_PROVIDER === "resend" || process.env.SMTP_HOST === "smtp.resend.com") && /@resend\.dev\b/i.test(process.env.SMTP_FROM || "");
    console.log(JSON.stringify({ success: true, message: "SMTP connection and authentication succeeded. No email was sent; sender authorization and inbox delivery still require an actual send.", ...(testSender ? { warning: "Resend test sender detected. Sending is restricted to the email associated with your Resend account. Use a verified sending domain for other recipients." } : {}) }));
  } catch (error) {
    console.error(JSON.stringify({ success: false, code: error instanceof ServiceError ? error.code : "EMAIL_UNAVAILABLE", message: error instanceof ServiceError ? error.message : "Email connection check failed." }));
    process.exitCode = 1;
  }
}
void main();

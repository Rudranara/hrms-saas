# Platform password recovery

The login page links to `/super-admin/forgot-password`. The flow requests an
eight-digit code, verifies it, then accepts matching new passwords of 8-128
characters. An active SuperAdmin record must match the submitted email.
An unknown or inactive address returns `PLATFORM_ACCOUNT_NOT_FOUND`.

Codes are hashed in SuperAdminPasswordReset, expire after 30 minutes, and are
consumed once. Successful reset verifies the registered inbox, increments
authVersion, revokes platform sessions, cancels pending email changes, and records
a platform audit event. Organisation users, passwords and sessions are independent.

Both organisation recovery and platform recovery use the same SMTP service.
Organisation recovery suppresses asynchronous delivery errors to preserve a generic
response; reaching its OTP screen alone does not prove that a code was sent.
Platform recovery reports delivery errors and invalidates the failed code. Resends
within 60 seconds return RATE_LIMITED; failed delivery allows a fresh request.

## Resend sender configuration

SMTP authentication success does not prove that the provider authorises a send.
Resend's `resend.dev` test sender is restricted to the email associated with the
Resend account. To send to other recipients, verify a domain in the Resend dashboard
and set backend SMTP_FROM to an address on that verified domain. Do not change the
recipient account to bypass the provider restriction. Restart the API after changing
backend environment settings.

`npm.cmd run mail:check` checks connectivity and warns about the test sender.
For an actual platform reset request, run:

```powershell
node --import tsx scripts/request-platform-reset.ts REGISTERED_PLATFORM_EMAIL
```

This sends a real reset code through the same service used by the HTTP flow and
prints only status/error information. It never prints the OTP or SMTP credentials.

Tests: `node --import tsx --test test/platform-recovery.test.ts test/smtp.test.ts`.
The recovery test uses temporary accounts and loopback SMTP; it checks request,
delivery, verification, reset, sign-in, reuse/expiry rejection, delivery failures,
retry cooldown, session revocation, and organisation identity isolation.

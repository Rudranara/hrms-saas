# Registration email OTP

POST /api/auth/register validates signup fields, hashes the password, sends a
six-digit email code and returns 202 with verificationRequired=true. It sets an
HttpOnly hrms_registration cookie, not an authenticated session. No organization,
user or trial exists at this point. Email delivery must be configured and succeed.

Signup requires an organization contact phone with 10–15 digits, optionally
starting with +. Spaces, parentheses, dots and hyphens are accepted and removed
before storage. The pending registration retains it until confirmation, then it
is saved on Organization and shown in super-admin organization details. Existing
organizations have a nullable phone field. Email OTP verifies the email address;
the contact phone is not phone-verified.

Signup also requires employeeSize: one of 1-10, 11-50, 51-200, 201-500,
501-1000, or 1001+. This self-reported range is saved with the organization
after verification and shown in super-admin details. It does not change billing,
trial duration, or employee permissions. Existing organizations keep a null value.

POST /api/auth/register/verify accepts only {code} and requires the pending cookie.
Codes expire in ten minutes and lock after five incorrect attempts. Verification
atomically creates the verified administrator, organization, seven-day trial and
session, consumes the pending signup, and returns 201. Concurrent or repeated
verification cannot create another organization. Existing email uniqueness is
enforced again at creation. Passwords and OTPs are never returned in API responses.

POST /api/auth/register/resend accepts {} and requires the same pending cookie.
Resending rotates the code after a sixty-second cooldown. Requests are rate limited;
resends cannot extend a pending registration past one hour. Delivery failure
invalidates that pending code. Expired pending records are removed on new signup.

The frontend presents the OTP form inline on /register, with resend countdown and
Change email. Existing accounts and recovery flows remain supported. Paid-plan
continuation is retained after confirmation; registration opens the dashboard.

Apply migrations and regenerate Prisma before deploying both applications.
The backend registration and SMTP tests use captured test mail; no production
email bypass or test-only verification endpoint exists.

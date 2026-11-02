# Verification, recovery, trial access, and Razorpay subscriptions

## Independent audit corrections — 2 November 2026

See [BILLING_AUDIT_FIXES.md](BILLING_AUDIT_FIXES.md) for the finding-by-finding
implementation, regression evidence, deployment order and remaining provider limitations.
That document supersedes the creation-time `paidAt`, immediate unpaid replacement,
and scheduler shutdown details in older notes below.

## Current implementation: quoted recurring purchases

### Repurchasing after a super-admin trial reset

Backend checkout eligibility now distinguishes older provider subscriptions from
the current access-policy revision. Plans remain selectable after an explicit
subscription-to-trial reset. The summary discloses replacement and sends the
confirmed local `replaceSubscriptionId` alongside `quoteId`; the backend requires
that ID to match the organization's superseded subscription. No provider operation
occurs during plan selection or quote creation.

Paid replacements use the existing durable BillingReplacement flow with a nullable
context baseline (migration `20261102010000_trial_repurchase`). Known historical
payments are retained; any financial change after that baseline blocks replacement
for review. Provider cancellation must be confirmed and the settlement wait must
finish before a new mandate is created. Normal active subscriptions, uncertain
creations, suspensions and admin-managed subscription windows retain their guards.
Test coverage uses mocked provider responses; real Test Mode acceptance remains
manual. No prices, credentials or existing trial dates are changed.

This section describes the current code. Older implementation notes below are
retained as history and are not the current registration or checkout contract.

### Registration and trial

Registration requires email OTP confirmation. Until the code is consumed, only a
PendingRegistration exists. Confirmation creates the organization, verified admin,
session and exact seven-day trial atomically. See REGISTRATION.md. Existing legacy
unverified users still retain their supported login/recovery behavior.

Trial-only admin extensions allow plan purchases. Manual subscription periods and
suspension continue to constrain access independently of provider charges; see
ORGANIZATION_ACCESS.md. Purchase, failure and reconciliation do not edit trial dates.

### Catalog and schedules

The six existing organization prices remain unchanged: Essentials INR 999/month or
9990/year; Growth 1999/month or 19990/year; Organization 3999/month or 39990/year.
Amounts are integer paise. BILLING_PLANS_FILE selects the central plan-sync file;
the stored BillingPlan catalog is authoritative for quotes and checkout.

All existing catalog entries retain totalCount=12. That means up to twelve monthly
charges or twelve ANNUAL charges, not a one-year term for a yearly plan. Configuration
and summary disclose that schedule. No existing provider subscription is modified.
Changing future cycle-count policy requires explicit commercial approval and a
versioned rollout, not rewriting existing subscription snapshots.

Organization.employeeSize is self-reported profile information. No approved paid
capacity limits exist. No capacity selector, price multiplier or enforcement is
invented. Add approved capacity terms to the quote/snapshot boundary in a future
migration when the commercial rules and employee module exist.

### Purchase journey and API

Billing -> select plan -> configure monthly/yearly frequency -> backend-generated
payment summary -> explicit recurring-consent checkbox and Proceed to payment ->
existing Razorpay Subscription Checkout -> backend confirmation -> payment-status
screen -> verified success and dashboard notification. Quote and purchase IDs are
retained in the URL for refresh. Checkout dismissal returns to summary. Plan
selection, configuration and quote creation never initiate payment.

Configuration, summary and verification now live on `/billing/checkout`. Selecting
a billing plan opens this dedicated page; `/billing` retains subscription management,
plan selection and history. Old `/billing?plan=...` bookmarks redirect after login,
preserving quote and purchase parameters. Checkout includes a back link to billing.

Unpaid CREATED/AUTHENTICATED authorizations no longer lock the customer to one plan.
All plan choices stay available before the billing period starts. Explicit Proceed
for another plan reconciles the old authorization, refuses replacement if billing
or payment has started, confirms immediate provider cancellation, reconciles again,
and only then reserves a new checkout. Unknown or unconfirmed operations remain
blocked for safe recovery. Existing records and trial dates are retained.

- POST /api/billing/quote: strict {planId, period}; authenticated organization admin.
- GET /api/billing/quote?quoteId=...: restore own quote.
- POST /api/billing/checkout: strict {quoteId}; direct browser plan/price payloads
  are no longer accepted. Existing pending provider subscriptions remain resumable
  through a fresh matching quote; no existing records need rewriting.
- GET /api/billing/purchase?subscriptionId=...: own verified payment/activation
  status, transaction reference, paid amount and renewal date. No invoice URL is
  fabricated. Restricted admin access is reported separately from successful activation.
- Existing plans, status, history, confirm, refresh, cancel and signed webhook APIs remain.

BillingQuote version 1 expires after 15 minutes. It freezes organization name,
plan/name/mapping, currency, per-cycle price, interval, cycle count and tax note.
The additional discount is zero; existing yearly savings are already reflected
in catalog prices. Tax remains inclusive/not_applicable as configured, without an
invented additive tax or tax breakdown. Summary distinguishes the first-period
amount from future recurring charges. No one-time Orders system was added.

Checkout rechecks expiry, tenant, current commercial terms and admin policy under
the organization/plan locks before reserving a provider operation. A quote links
to the resulting subscription; commercialTerms snapshots are nullable for legacy
subscriptions. Matching pending operations are reused; uncertain creation is
reconciled and never blindly recreated. New plan terms require a fresh quote.

### Reconciliation and operations

Captured transitions now populate paidAt from the authoritative provider payment
timestamp, including records first stored as authorized. Invoice fetches paginate
in batches of 100 and fail closed beyond 100 pages. Payment ownership, raw webhook
HMACs, event id/body hashes, unique payment IDs and synchronization leases remain.
Secondary history/status read failures cannot prevent opening a valid Checkout.

Production starts a non-overlapping recovery batch every five minutes. It fetches
provider state for up to 25 due subscriptions per batch and never initiates a charge
or subscription. Failed attempts rotate fairly by updatedAt. Existing leases make
multiple processes safe. Tune throughput/monitor failures for deployment scale.
In development it is off unless BILLING_RECONCILE_INTERVAL_MS (minimum 60000) is
explicitly set. Operators can schedule `npm run billing:reconcile` for one batch.
This command may update reconciled billing state; it is not a read-only audit command.

Apply additive migrations, regenerate Prisma, and deploy backend before the new
frontend. Existing subscriptions, users, payments and trial dates are preserved.
No credentials or payment mode change is required by the code migration.

### Validation and manual Test Mode acceptance

Run backend tests/build and Prisma validation/migration checks, plus frontend
lint/build. `npm run test:billing-purchase` uses an isolated Chrome debug session
on 9223, real local quote APIs, uniquely scoped DB fixtures and intercepted
Razorpay responses. It never creates a real provider subscription or payment.
The older subscription browser script below predates required OTP registration
and quoted checkout; use the new purchase runner for the current journey.

Before production, explicitly test real Razorpay TEST MODE authorization, captured
payment, delayed/duplicate webhook delivery, renewal failure and cancellation with
matching keys and a public HTTPS webhook. Verify first-period versus renewal
amounts, paid access, transaction reference and dashboard notice. No live payment,
mandate, deployment, provider API permission or external webhook delivery is claimed
by the fixture-based checks. Invoice download, arbitrary prepaid durations,
immediate upgrades/proration and paid employee capacity remain unsupported.

## Historical implementation notes

The read-only SaaS owner dashboard at `/super-admin` is documented in
[SUPER_ADMIN.md](SUPER_ADMIN.md), including dedicated platform-account provisioning,
isolated sessions, metric definitions, captured-payment revenue limits, the additive
migration and local tests. It reuses
the verified billing records without modifying provider verification or access rules.

## Immediate signup; optional email verification (27 October 2026)

Pricing actions now carry an encoded internal `/billing?plan=...&period=monthly`
or `period=yearly` continuation. Selection remains available when payment setup
is incomplete; actual checkout still requires all existing readiness checks.
Prices continue to come from the backend plan catalog. The billing page resolves
the selected ID and period against that catalog, rejects duplicate/unknown query
parameters and mismatched periods, and never accepts a browser price.

Registration now grants an authenticated session immediately after the organization,
administrator and exact seven-day trial transaction commits. SMTP is not called
during registration, and emailVerifiedAt stays null. Email verification is optional
for dashboard/business access and billing, but required to trust an address for
password recovery. Payment authorization remains an explicit Billing action.

- **Free trial:** `/register` creates the organization, administrator and existing
  exact seven-day trial and full session atomically, without payment details.
  After commit it sets the HttpOnly `hrms_session` cookie and opens `/dashboard`.
  No verification email or token is generated during signup, so no mail provider
  is required. Email settings remain available later at `/verification-pending`.
- **New paid customer:** login's registration link preserves the continuation.
  Registration retains it with `review=1`, but opens the dashboard immediately.
  A dashboard link can resume the selected plan in the same
  tab. Alternatively choose any plan through Billing. Browser storage holds only
  validated navigation intent, never authentication or payment authorization.
- **Dashboard:** shows backend trial status, remaining days (rounded up), end
  date and Billing / Choose a plan. Registration and verification never open
  payment checkout. Expired trials redirect to subscription-required; they are
  never restarted by login or plan selection.
- **Existing customer:** password login opens `/dashboard`, or a validated billing
  continuation when explicitly supplied, whether or not email is verified. Legacy
  limited verification cookies are replaced through normal login without changing
  trial dates. In Billing,
  choose a plan and cycle, review its backend price and renewal/tax terms, then
  explicitly Continue to payment authorization. Refresh and plan selection never
  automatically open checkout. Missing provider configuration remains blocking.
- **Existing subscription:** pending authorization can reuse the same subscription.
  Other active/pending/paid-through subscriptions block new checkout. Plan changes
  require resolving the existing subscription and waiting for paid access to end;
  immediate switching and proration are unsupported.

The checkout endpoint accepts an optional `period` (`monthly`/`yearly`) for
compatibility with existing callers. It checks this against the stored plan
before contacting Razorpay. Tenant authorization, organization-row locking,
ambiguous-request handling, server payment verification, and signed/idempotent
webhooks remain enforced. Checkout load failure, dismissal, provider failure,
and unconfirmed authorization do not activate paid access or alter trial dates.

Changed files for the optional-verification revision:
backend `src/auth/{routes,recovery,security}.ts`, `src/billing/{routes,access}.ts`,
`src/server.ts`, `test/{auth,lifecycle,smtp}.test.ts`,
`AUTH.md`, and this guide; frontend
`app/{dashboard,verification-pending,pricing}/page.tsx`,
`app/components/{auth-form,auth-shell,billing-panel,recovery-form,verification-panel}.tsx`,
and `scripts/{check-account-ui,check-subscription-ui,check-pricing-ui}.mjs`.
No schema, migration, environment, price, or existing account records are changed.

Current optional-verification validation: **90/90 backend tests passed**, backend
TypeScript build, Prisma validation, four-migration status and no-drift comparison
passed. Frontend lint/production build passed. Subscription browser checks passed
all six plan/cycle choices by an unverified administrator without SMTP, plus eight
responsive views. Account browser checks passed immediate registration, voluntary
loopback SMTP verification, OTP-based password recovery, trial expiry and 20 responsive
views. Provider interactions were mocked; no real Razorpay payment, external email,
deployment or Live Mode change was performed. Test fixtures were scoped to unique
names/IDs; no existing organization or trial dates were modified.

Run `npm.cmd test` and `npm.cmd run build` in backend, then `npm.cmd run lint`,
`npm.cmd run build`, and `npm.cmd run test:subscription` in frontend.
The subscription browser runner uses the dedicated Chrome debug session on 9223,
real local registration/login and isolated database fixtures, plus intercepted
checkout/confirmation requests and a fake Checkout object. It works with configured
Test Mode keys and **never creates a real provider subscription**. It checks all
six plan continuations, explicit Billing plan review, immediate free trial,
unverified administrator checkout, unsafe returns, tampered selections, missing setup, refresh,
dismissal, failure, confirmation rejection, and responsive pricing/billing.
The subscription runner needs no SMTP. The older `test:pricing` runner requires
missing Razorpay configuration but no SMTP. `test:browser` covers immediate signup,
voluntary verification/resend using loopback SMTP, OTP-based password reset,
expired-trial enforcement and responsive account screens.
Set `UI_TEST_ORIGIN` for an alternate frontend origin (for example localhost:3001)
and `UI_TEST_API_URL` for the account runner's direct business-API check;
set the test API's FRONTEND_URL/APP_ORIGIN to match and build that frontend with
NEXT_PUBLIC_API_URL pointing to the isolated API. Use only process-local settings;
never overwrite environment files. Restore a normal frontend build afterward.

For an actual Test Mode subscription, check `/api/billing/plans` readiness and
all six configured plans, sign in with an authenticated organization administrator,
choose a plan/period, and authorize using Razorpay's Test Mode Checkout options.
For a new account, registration opens the dashboard; then choose Billing and
explicitly Continue from the selected-plan review. Refresh provider status after authorization and
verify paid access only appears after a server-confirmed captured payment.
Check dismissal, a failed payment, renewal, and cancellation separately. Configure
the matching private webhook secret and public HTTPS webhook delivery for signed
renewal/failure events; do not rely on the browser callback for activation.
No real payment, mandate, or external webhook delivery was tested by this change.

Validation for the preceding continuation implementation: **81/81 backend tests passed**, backend TypeScript build,
Prisma validation, four-migration status, and no-drift database comparison passed.
Frontend lint and production build passed. The subscription browser runner passed
all six plan selections plus eight responsive pricing/billing views. Local API
readiness reported `CONFIGURED` and all six plans available; no missing Razorpay
setting was reported at validation time. Actual authorization, captured payment,
and external webhook delivery still require the manual Test Mode checks above.

This extends the existing authentication; it does not replace it. No production
SMTP/Razorpay credentials are included. No payment or externally delivered email
is simulated in the application. The defaults deliberately leave checkout and
external email delivery unavailable. Introductory prices are configured and visible
independently of Razorpay checkout availability.

## Windows / XAMPP setup

Earlier mandatory-verification revision validation (historical): **82/82 backend tests passed**, backend build,
Prisma validation, four-migration status, and no-drift database comparison passed.
Frontend lint/build passed. Actual loopback SMTP browser checks passed the six
account workflow groups at 20 responsive views, and subscription checks passed
all six plan/cycle combinations plus eight responsive views. Checkout requests
were intercepted; backend provider fixtures verify success, signature failures,
renewal, cancellation, duplicates and tenant isolation. No real payment or external
email was sent. Local API readiness reports `CONFIGURED` and all six plans ready;
actual Test Mode payment/mandate and public HTTPS webhook delivery remain unverified.

Start MySQL in XAMPP. Keep the existing `backend/.env` and `frontend/.env.local`.
Use the example files to add settings manually; do not overwrite working files.
Run these commands in PowerShell from the project directory:

```powershell
Set-Location C:\xampp\htdocs\hrms-saas\backend
npm.cmd ci
# Stop the backend first if the Windows Prisma engine DLL is locked.
npx.cmd prisma validate
npx.cmd prisma generate
npx.cmd prisma migrate deploy
npx.cmd prisma migrate status
npm.cmd run billing:sync-plans
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

In a second terminal:

```powershell
Set-Location C:\xampp\htdocs\hrms-saas\frontend
npm.cmd ci
npm.cmd run lint
npm.cmd run build
npm.cmd run dev
```

Use `http://localhost:3000`, consistently, rather than mixing localhost and
127.0.0.1 origins. Backend starts on port 4000. Never use migrate reset, db push
with data-loss flags, or delete existing tables.

## Configuration

### Optional verification delivery and provider setup

Registration does not call the mail provider or require SMTP/API settings.
`AccountRecovery.requestVerification` is called only when a signed-in user
requests optional verification from email settings. The earlier not-configured
message reflected missing SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM.
Mail settings now affect optional verification and password recovery only.
Actual environment files and secrets remain unchanged.

Nodemailer remains the only delivery dependency. `MAIL_PROVIDER=smtp` (default)
supports an existing SMTP provider; `MAIL_PROVIDER=resend` selects Resend's real
SMTP service using TLS on smtp.resend.com:465, username `resend`, and a private
RESEND_API_KEY. No separate SDK is needed. Configure one option in the backend
process environment or your private backend environment file yourself, using
the placeholders in `.env.example`:

```dotenv
# Option A: Resend SMTP preset. Replace placeholders privately.
MAIL_PROVIDER=resend
RESEND_API_KEY=re_REPLACE_WITH_PRIVATE_API_KEY
SMTP_FROM="HRMS <accounts@your-verified-domain.com>"
FRONTEND_URL=http://localhost:3000
APP_ORIGIN=http://localhost:3000
EMAIL_VERIFY_TTL_MINUTES=1440
```

Create a Resend account, add a domain you own, publish the DNS records requested
by Resend and wait until its status is verified. Create a sending API key with
access to that domain. Use a sender address at the verified domain. For sensitive
transactional links, leave click/open tracking disabled. The app can run entirely
on localhost while sending real email through the remote SMTP service; you do
not need to deploy it. The email link opens the configured local frontend, so
open it on the machine running this app. See the official
[Resend SMTP settings](https://resend.com/docs/send-with-smtp) and
[domain setup](https://resend.com/docs/dashboard/domains/introduction).

```dotenv
# Option B: an existing authenticated SMTP provider.
MAIL_PROVIDER=smtp
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=REPLACE_WITH_SMTP_USERNAME
SMTP_PASSWORD=REPLACE_WITH_SMTP_PASSWORD_OR_APP_PASSWORD
SMTP_FROM="HRMS <accounts@your-authorized-domain.com>"
SMTP_ALLOW_INSECURE_LOCAL=false
FRONTEND_URL=http://localhost:3000
APP_ORIGIN=http://localhost:3000
```

For port 465 set SMTP_SECURE=true; port 587 requires STARTTLS. External TLS
certificate validation remains enabled. Keep every mail setting on the backend;
never use NEXT_PUBLIC names. `SMTP_FROM` must be authorized by the provider.
MAIL_PROVIDER=resend ignores the generic SMTP host/port/auth fields; it still
requires SMTP_FROM. MAIL_PROVIDER=smtp ignores RESEND_API_KEY.

After configuration, restart the API (environment values are read at startup)
and run from `backend`:

```powershell
npm.cmd run mail:check
npm.cmd run dev
```

`mail:check` sends no message. It reports missing setting **names**, validates
configuration and, when configured, checks SMTP connection/TLS/authentication.
It never prints credential values, provider response bodies or verification
tokens. A passing connection check cannot establish sender authorization or inbox
delivery. Register a test organization and confirm immediate dashboard access.
Open Email and recovery settings and explicitly request verification. Check spam
and the provider's email activity, follow the link and press Verify my email.
The email is marked verified only after confirmation. Reopening the used link must
fail. Resend preserves the account and trial dates, enforces the cooldown and
supersedes the older token. Existing saved accounts can log in and resend after
configuration; they do not need to register a new organization.

Registration claims no email delivery and never requires an email token.
Optional verification reports acceptance only after SMTP accepts the recipient;
configuration/provider failures show safe errors. The settings page keeps Send
or resend available. SMTP acceptance is not an inbox-delivery guarantee. Failed
transport attempts invalidate their issued token and never mark an address verified.
No provider credentials are currently configured; external inbox delivery cannot
be verified until the operator supplies them. Local SMTP tests exercise actual
transport and voluntary verification delivery; they do not deliver externally.

Earlier automatic-mail revision validation (historical): **87/87 backend tests passed**, backend TypeScript build
passed, and frontend lint/production build passed. Coverage includes automatic
registration delivery through an actual loopback SMTP server, missing settings,
the Resend TLS preset with an injected transport, authentication/connection errors,
actual SMTP recipient rejection, hashed/expired/used tokens, resend supersession,
trial preservation and verification sign-in. `npm.cmd run mail:check` against the
unchanged local configuration correctly exits 1 with EMAIL_NOT_CONFIGURED and
lists the four missing setting names. No external inbox delivery was claimed.

Changed files for this mail revision: `src/services/mail.ts`,
`src/auth/{routes,recovery}.ts`, `scripts/check-mail.ts`, `test/{smtp,lifecycle}.test.ts`,
`package.json`, `.env.example`, this guide; frontend
`app/lib/{auth-types,auth-server}.ts`,
`app/components/{auth-form,verification-panel,recovery-form}.tsx`, and
`app/verification-pending/page.tsx`. No migration or existing trial/date changes.

Backend `.env`:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Existing MySQL connection string; private |
| `FRONTEND_URL` | Exact trusted public frontend origin; localhost:3000 in development |
| `APP_ORIGIN` | If supplied to the backend, must match FRONTEND_URL |
| `NODE_ENV` | `production` on both deployed applications; production requires HTTPS |
| `SMTP_HOST`, `SMTP_PORT` | SMTP endpoint, normally port 587 or 465 |
| `MAIL_PROVIDER` | `smtp` (default) or `resend` SMTP preset |
| `RESEND_API_KEY` | Private Resend sending API key, used only by MAIL_PROVIDER=resend |
| `SMTP_SECURE` | `true` for implicit TLS (normally 465); otherwise STARTTLS is required |
| `SMTP_USER`, `SMTP_PASSWORD` | Backend-only SMTP credentials |
| `SMTP_FROM` | Sender address authorized by the SMTP service |
| `SMTP_ALLOW_INSECURE_LOCAL` | Development-only `true` permits plaintext only to loopback SMTP |
| `EMAIL_VERIFY_TTL_MINUTES` | 5–1440 minutes; default 1440 |
| `PASSWORD_RESET_TTL_MINUTES` | 5–1440 minutes; default 30 |
| `RAZORPAY_MODE` | `test` by default; `live` also requires NODE_ENV=production |
| `RAZORPAY_KEY_ID` | Matching rzp_test_ or rzp_live_ key; the public key returned only for checkout |
| `RAZORPAY_KEY_SECRET` | Private Razorpay API secret |
| `RAZORPAY_WEBHOOK_SECRET` | Separate private secret configured for this webhook |
| `BILLING_PLANS_FILE` | Defaults to config/billing-plans.json |
| `BILLING_GRACE_HOURS` | 0–168; default 0, no grace after the verified paid-through date |
| `BILLING_TAX_TREATMENT` | `inclusive` (default) or `not_applicable`; never adds a surcharge |

Frontend keeps `NEXT_PUBLIC_API_URL`. Its server-side `APP_ORIGIN` should be set to
the same exact public HTTPS origin as FRONTEND_URL in production. SMTP and private
payment secrets must never use NEXT_PUBLIC names. No Razorpay secret is sent to
the browser. Razorpay Checkout needs only its public key, returned by an
authenticated, authorized checkout request. Preserve public Host/protocol at the
reverse proxy; configure trusted ingress rate limits before public deployment.

## Safe local email testing without external delivery

Open a third terminal:

```powershell
Set-Location C:\xampp\htdocs\hrms-saas\backend
npm.cmd run mail:local
```

It listens only at SMTP `127.0.0.1:1025` and inbox
`http://127.0.0.1:8025`. Messages are kept in RAM, limited to 20, hidden after an
hour, and lost on restart. No messages are delivered outside the machine. It is
disabled in production, rejects other HTTP hosts, and does not log message bodies
or tokens. Do not expose this inbox or SMTP listener through a tunnel.

Restart the API in its terminal with process-local test settings:

```powershell
$env:SMTP_HOST = "127.0.0.1"
$env:MAIL_PROVIDER = "smtp"
$env:SMTP_PORT = "1025"
$env:SMTP_SECURE = "false"
$env:SMTP_FROM = "HRMS <noreply@example.test>"
$env:SMTP_ALLOW_INSECURE_LOCAL = "true"
npm.cmd run mail:check
npm.cmd run dev
```

Register an account, open the inbox, and follow its verification link. Request
another link at `/verification-pending`; only the newest link is valid and a
60-second cooldown applies. Use `/forgot-password`, follow the reset email, and
set an 8–128-character password. Existing sessions are revoked; log in again.
For failed-send testing, stop the local SMTP server and request another email.
SMTP failures do not claim delivery and invalidate the newly issued token.
Clear the temporary SMTP environment variables or open a fresh terminal before
restarting the API with its normal settings.

For real delivery, supply provider credentials and an authorized sender domain;
complete the provider's domain/SPF/DKIM setup as appropriate. SMTP acceptance is
reported as “accepted for delivery,” not a guarantee of inbox delivery.

## Token and recovery design

- Verification status is derived from nullable `User.emailVerifiedAt`. Existing
  accounts are not automatically verified. Signup/login create full sessions with
  the current auth version even for unverified users. Legacy negative-version
  challenges are accepted only for verification settings; password login replaces
  them without a migration or trial restart. Optional confirmation consumes the
  token and marks only its owner verified. SMTP is not used by signup/login.
- Recovery sends an eight-digit, single-use OTP to any registered address,
  including an address that was not previously verified. Unknown addresses receive
  the same generic forgot-password response. Consuming the valid OTP resets the
  password and marks that address verified, because the code proves mailbox
  control. No email-change flow is introduced.
- Verification links use 32 cryptographically random bytes; reset OTPs use eight
  random digits. Only SHA-256 hashes, purpose, auth version, expiry, and
  consumption time are stored. One user/purpose slot means reissue replaces the
  previous code or link; failed delivery invalidates only the matching newly
  issued record, not a later request's record.
- User-row locking and conditional token updates make consumption single-use,
  including simultaneous requests. Purpose, expiry, and auth version are checked.
- Verification links use URL fragments, not query strings. The frontend removes
  the fragment, retains the token only in component memory, and submits it in a
  JSON POST body. Reset OTPs are entered in the forgot-password flow. Token pages
  have no-referrer/noindex metadata. Do not add analytics that capture URL
  fragments, form bodies, or credentials to these pages.
- Verification requires an explicit button click; an email scanner opening the
  page does not consume the token. Reset validation does not consume a token.
- Reset updates password/hash and auth version, consumes tokens, and revokes all
  sessions atomically. Login checks the credential/version under a write lock so
  an in-flight old-password login cannot survive a completed reset. Reset does
  not sign the user in and does not implicitly verify their email.
- Reset requests use one generic response for existing and nonexistent accounts.
  SMTP delivery runs asynchronously, with a padded response floor independent of
  SMTP latency. If SMTP is globally unconfigured both cases return the same 503.
  A configured SMTP rejection still produces the generic conditional response;
  it never claims the email was sent. A safe diagnostic is logged instead.
- The reset-delivery queue is in-process, not durable. If the API restarts before
  delivery, request another link. No plaintext-token outbox is persisted.

## Trial / migration strategy and route audit

Migration `20261026100000_account_recovery_billing` adds nullable verification,
default-zero auth versions, AccountToken, BillingPlan, Subscription, BillingPayment,
and BillingEvent. It does not modify trial timestamps, verify existing emails,
grant paid access, delete records, or reset the database. Existing null trial
dates remain null: these organizations require a subscription or an explicit,
reviewed operator decision, not an automatic new trial. Existing session/user
auth versions both default to zero, preserving compatible sessions.

The normal seven-day expiry is registration start + exactly 604800000 ms in UTC.
Access caps a stored expiry at start + seven days and never extends an earlier
stored cutoff. Login, resend, verification, reset, and checkout do not rewrite
trial dates. Public registration cannot attach another administrator to an
existing organization or accept client role/tenant fields.

Current protected business routes are `/api/organization` and
`/api/organizations/:organizationId`. Both require authentication, administrator
role and trial/paid eligibility. The latter also requires an
exact tenant match before querying the authenticated tenant. Reuse the central
`AccessPolicy.requireSubscription` middleware on every future
business route. It returns TRIAL_EXPIRED (402) or
SUBSCRIPTION_REQUIRED (402). Never trust frontend state or IDs for these decisions.

Authentication, `/api/auth/me`, verification, password recovery, logout, public
plans, subscription status, and restoration/billing endpoints stay outside trial
gating. Checkout, cancellation, and financial history still require an authenticated
administrator. Dashboard routes send expired accounts to `/subscription-required`;
backend middleware remains authoritative if frontend navigation is bypassed.

## Configuring Razorpay test subscriptions

1. Enable Subscriptions for the Razorpay account if necessary. Generate Test-mode
   API keys and configure the backend variables above. Do not use live keys for
   development. If the account lacks Subscriptions access, the real provider
   rejection is surfaced; the application does not simulate a payment.
2. Generate Test-mode keys in the Razorpay Dashboard's API Keys settings. Put
   RAZORPAY_KEY_ID (`rzp_test_...`) and RAZORPAY_KEY_SECRET only in backend settings.
   Add a separate RAZORPAY_WEBHOOK_SECRET matching the webhook configured below.
3. Review `config/billing-plans.json`, the authoritative price source. Amounts are
   integer paise. Keep providerPlanId null to provision a plan automatically, or
   supply an existing real matching Razorpay plan ID to reuse it. No plan-ID
   environment variables are required. Set intended totalCount (currently 12)
   payment cycles; this retains the existing configurable finite-cycle behavior.
4. Run `npm.cmd run billing:sync-plans`. It publishes local prices transactionally
   even without credentials, and disables removed definitions. With valid API
   keys it creates/discovers/reuses the six provider plans and persists their IDs
   in MySQL; it does not rewrite the JSON file. It validates amount, currency,
   frequency and interval before enabling a mapping. Plan creation itself does
   not need the webhook secret; checkout additionally requires that secret.
   Existing subscriptions retain their amount, currency, interval, provider plan
   ID and cycle-count snapshots. Nothing is created automatically on API startup.
5. Configure a Razorpay **test-mode** webhook on a public HTTPS **backend** URL:
   `https://YOUR-API-HOST/api/billing/webhook`. localhost is not reachable from
   Razorpay. Use owned staging infrastructure or a tunnel hostname permitted by
   Razorpay, and set the same webhook secret on both sides. No deployment or
   tunnel is created by this implementation.
6. Subscribe to subscription lifecycle events and invoice.paid. Checkout callback
   verification and Refresh provider status also reconcile authoritative state.
   Raw-body webhook signatures must reach Express unchanged; do not send this
   webhook to the frontend JSON proxy or put a JSON parser in front of it.
7. Register and verify an administrator. Open `/billing`, select Monthly/Yearly,
   choose a configured plan, and use Razorpay's current official test payment
   instructions. Only the Razorpay-hosted checkout collects payment details.
8. Check pending, captured payment, repeated webhook, failed renewal, cancellation,
   and expired-period behavior. A checkout opened/closed or a browser success flag
   must not unlock paid access. Confirm the provider sandbox dashboard agrees with
   the application's state. These real-provider steps require your credentials;
   the automated fixture tests do not substitute for them.

For process-local Test Mode configuration in PowerShell (replace placeholders):

```powershell
Set-Location C:\xampp\htdocs\hrms-saas\backend
$env:RAZORPAY_MODE = "test"
$env:RAZORPAY_KEY_ID = "rzp_test_YOUR_KEY_ID"
$env:RAZORPAY_KEY_SECRET = "YOUR_PRIVATE_TEST_SECRET"
$env:RAZORPAY_WEBHOOK_SECRET = "YOUR_PRIVATE_WEBHOOK_SECRET"
npm.cmd run billing:sync-plans
npm.cmd run dev
```

Restart an already-running API after changing its credentials. Configure the
same webhook secret in the Razorpay dashboard and retain Test Mode for both API
keys and webhook. Prefer backend environment configuration/secret storage over
putting real credentials in shell commands that persist in command history.

The public pricing cards and billing page both load the same server plan catalog.
Plan IDs are accepted; amounts/provider plan IDs supplied by a client are rejected.
The provider plan's amount, currency, and interval are cross-checked before checkout
and reconciliation. No card data or raw payment/webhook payload is stored.

### Introductory organization-level prices and tax policy

| Plan | Monthly | Yearly | Monthly paise | Yearly paise |
| --- | ---: | ---: | ---: | ---: |
| Essentials | ₹999 | ₹9,990 | 99900 | 999000 |
| Growth | ₹1,999 | ₹19,990 | 199900 | 1999000 |
| Organization | ₹3,999 | ₹39,990 | 399900 | 3999000 |

Yearly prices are charged once per year, not monthly installments. UI savings are
calculated from `12 × current monthly amount − current yearly amount`, not a
hardcoded discount. These prices apply to one organization. Existing proposed
feature lists and the seven-day trial are unchanged.

The default merchant policy treats the listed amount as **inclusive of GST where
applicable**. HRMS adds no GST percentage, fee, addon, or other charge. The exact
configured amount is used in the Razorpay plan; invoices/payments are reconciled
against that amount. `BILLING_TAX_TREATMENT=not_applicable` changes disclosure only
and must be used only if appropriate to the merchant. Other settings are rejected.
This is a pricing/disclosure policy, not a tax calculation or statutory invoicing
implementation. Before live collection, confirm merchant GST obligations and
configure any required tax breakdown/authorized invoices with the provider or
accounting workflow. Exclusive-tax collection requires a separately reviewed
implementation; changing an environment setting cannot silently add a charge.

### Safe provider-plan synchronization

Migration `20261026150000_provider_plan_provisioning` adds only a provisioning
checkpoint table. It does not alter existing account, trial or subscription data.
The checkpoint is necessary because provider plan creation is an external side
effect that cannot be rolled back by a MySQL transaction.

A deterministic reference includes local plan ID, amount, currency, interval,
mode and public API key ID. It is stored in provider notes. A durable PENDING
checkpoint is committed **before** the create request; its unique reference
prevents concurrent syncs from issuing duplicate create requests. Subsequent
runs reuse persisted IDs or discover a plan by reference across paginated provider
history. Existing IDs are checked before reuse, including after API key rotation.
A definitive API rejection permits retry; timeouts, 5xx, malformed responses and
crashes leave an unresolved checkpoint. Rerun sync to discover the created plan.
If it cannot be discovered, sync stops with PLAN_RECONCILIATION_REQUIRED instead
of creating another plan. An operator must inspect the provider account and
supply a verified matching providerPlanId before proceeding; never delete a
checkpoint just to bypass this protection. Concurrent runs may report a pending
sync; rerun after the first finishes.

Changing price/currency/interval clears the old catalog mapping and provisions a
new immutable provider plan; existing subscription snapshots are retained. If
switching Razorpay accounts or Test/Live mode, supply matching IDs from the target
account after reviewing existing mappings; provider validation fails closed when
an old ID is unavailable. Do not copy test IDs into live settings. Do not run
different configuration files concurrently against the same catalog.

When keys or provider IDs are absent, pricing remains visible and checkout is
disabled with a setup-pending message. Plan links retain plan/interval through
sign-in/registration; they never auto-start checkout or trust a client amount.

### Diagnosing plan-sync readiness and API failures

Both `src/app.ts` and `scripts/sync-plans.ts` load `dotenv/config`. When run from
the backend directory (including its npm scripts), they read `backend/.env` and
use the same RAZORPAY_MODE, RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET names. Existing
process environment values take precedence over dotenv; restart stale terminals
or remove an obsolete process-level setting if it conflicts with the file.
The provider itself reads the supplied environment; it does not load a second
file. `.env.example` is documentation, not runtime configuration.

Presence alone does not mean readiness. Test Mode requires a Test Mode key ID
and its matching secret. The observed pending message was caused by a Live Mode
key ID with RAZORPAY_MODE=test. Previously this failed the prefix check but was
indistinguishable from missing credentials. It now fails with an actionable
RAZORPAY_MODE_KEY_MISMATCH and a nonzero sync exit status. Obtain a Test Mode key
pair from the Razorpay dashboard; never edit a key's prefix or switch to Live
Mode to work around validation. Actual environment files are left unchanged by
this correction. No webhook secret is needed for plan provisioning; checkout
still requires it. Plan configuration does not control API credential readiness.

| Code | Meaning / action |
| --- | --- |
| RAZORPAY_CREDENTIALS_MISSING | Local prices sync; supply both API credentials before provider sync |
| RAZORPAY_MODE_KEY_MISMATCH | Key mode differs from configured mode; supply the matching key pair |
| RAZORPAY_MODE_INVALID / RAZORPAY_KEY_FORMAT_INVALID / RAZORPAY_CREDENTIAL_FORMAT_INVALID | Correct mode/key formatting or surrounding whitespace |
| RAZORPAY_LIVE_MODE_BLOCKED | Live Mode is blocked outside production; use test keys locally |
| PROVIDER_AUTHENTICATION_FAILED | Provider returned HTTP 401; verify active matching credentials |
| PROVIDER_PERMISSION_DENIED | Provider returned HTTP 403; check account/Subscriptions access |
| PROVIDER_NOT_FOUND | Provider returned HTTP 404; check stored plan's account/mode; no blind replacement |
| PROVIDER_REJECTED | Other provider 4xx; check plan values and enabled capabilities |
| PROVIDER_RATE_LIMITED | HTTP 429; wait and retry reconciliation |
| PROVIDER_UNAVAILABLE | Provider 5xx; retry later, preserving uncertain creation checkpoints |
| PROVIDER_NETWORK_ERROR / PROVIDER_TIMEOUT | Connection/DNS/proxy/TLS issue or timeout; no confirmed outcome |
| PROVIDER_INVALID_RESPONSE | Unreadable JSON; no provider confirmation |
| PLAN_CONFIGURATION_INVALID | Invalid local plan definitions; review server configuration |

Readiness means the configuration can be submitted, not that credentials have
been authenticated. Only a successful provider response confirms reconciliation.
HTTP errors include their status and safe guidance, never response bodies,
Authorization headers, credential values or raw network exceptions. Definitive
creation rejections permit retry; network errors, rate limits, timeouts and 5xx
retain the checkpoint to avoid duplicate creation.

Checkout creation uses an organization row lock with READ COMMITTED isolation to
prevent parallel provider subscriptions. A timed-out creation becomes CREATE_UNKNOWN,
blocks duplicate creation, and can be reconciled using the server-created reference
stored in provider notes. If the provider cannot confirm it, an operator must
review the Razorpay account before clearing the pending record. Do not blindly
retry unknown creation or delete subscription records to bypass this check.

Callback signatures use the stored provider subscription ID. Webhooks use the raw
request bytes and their own secret. Events are deduplicated by provider event ID
and body hash. A MySQL lease serializes synchronization across app processes;
out-of-order event payload states are not applied directly. Each event fetches
the current provider subscription/plan/invoices/payments and validates tenant
reference, currency, amount, period, paid invoice, and captured payment before
granting paid time. Terminal subscriptions cannot be resurrected by stale state.
Provider errors/invalid signatures cannot grant new paid access. Previously
verified paid access remains valid until its recorded cutoff.

Renewals are automatic for the configured number of cycles unless cancelled.
Starting paid checkout during a trial is an explicit opt-in to billing immediately;
it does not extend/reset the trial or wait until the trial ends. Cancellation can
be scheduled at cycle end; verified paid time is retained. Plan changes require
cancelling and waiting for the paid period to end; no automatic proration. Failed
renewals restrict access after the paid cutoff, plus optional configured grace.
Pending/authentication-only payments never grant paid access. A completed finite
subscription needs a new subscription for subsequent periods. Full refunds found
during reconciliation remove paid eligibility for the refunded period; refunds
are not initiated by this application.

## API endpoints

### Recurring lifecycle completion

The application uses **Razorpay Subscriptions**, not Orders or a local card-charging
job. Monthly/yearly provider plans use interval 1, quantity 1 and server-configured
amounts. Checkout opens the provider subscription authorization flow using only
the public key and subscription ID. The customer must complete the payment-method
authorization/mandate steps presented by Razorpay. A browser callback or first
authorization payment is not proof of recurring access: the backend verifies the
signature, fetches subscription/invoices/payments, and requires the paid invoice
and captured plan amount. Provider states such as authenticated/pending do not
by themselves extend paid access. No card details or mandate credentials are stored.

| Situation | Server behavior |
| --- | --- |
| Registration | One seven-day trial after the account transaction commits; no card required |
| Pending/abandoned Checkout | Same plan reuses CREATED/AUTHENTICATED subscription; complete authorization from billing |
| Unknown creation | Refresh/reconcile; never blindly create another subscription |
| Initial capture | Paid invoice, captured amount/currency and provider subscription state must match |
| Renewal | Razorpay owns the schedule/mandate and attempts the recurring charge; verified events extend paid-through time |
| Failed renewal | Payment history records the verified failed attempt; no new paid time; existing cutoff plus optional grace controls access |
| Provider still says active after paid cutoff | Derived access state is EXPIRED; business APIs remain blocked until verified renewal |
| Cancel before first billing cycle | Provider immediate cancellation, including while HRMS trial runs; original trial dates stay intact |
| Cancel an active cycle | Schedule cycle-end cancellation; retain verified paid time, suppress next-renewal display |
| Completion/expiry | No next renewal; paid time remains only through its verified cutoff |
| Upgrade/downgrade/interval change | Cancel and wait for paid period to end, then choose a plan; no immediate switch or proration |

`/api/billing/status` now includes trial start/end, server-derived remaining seconds,
current provider period dates, latest payment status/amount, cancellation date,
next billing date and last synchronization time. `/billing` displays these fields
and a resumable pending-authorization action. Access status and raw provider
subscription status are shown separately so an old provider status cannot imply
current paid eligibility. Remaining days are explicitly rounded up from server
seconds; the browser clock does not authorize access.

The public plan catalog includes a safe `unavailableReason` per plan and
`checkoutReadiness` metadata. Reasons distinguish API configuration problems,
missing webhook secret, missing synchronized plan ID and missing price. No
credential values/provider private data are returned. Readiness means configured,
not proof that a payment succeeded. Pricing continues working when checkout is
disabled. API/billing/verification/recovery/logout stay available after expiry;
the two current business routes retain the central trial/subscription gate.

### Webhook events and local signed tests

The existing backend `/api/billing/webhook` route still receives **raw bytes before
the JSON parser**. It validates HMAC-SHA256 using the private webhook secret and
requires `x-razorpay-event-id`. Supported triggers are:

- subscription.authenticated, activated, charged, completed, updated, pending,
  halted, cancelled, paused, resumed;
- invoice.paid;
- payment.authorized, payment.captured, payment.failed.

These names trigger reconciliation; their payload statuses never directly activate
access. Payment-only events fetch the provider invoice to find its subscription,
then verify the payment/invoice association and persisted subscription/tenant
mapping. A failed attempt can appear in billing history even if it is no longer
the invoice's current payment ID. Authorization amounts without an invoice are
not attributed to an organization or recorded as paid cycles; the independently
fetched subscription state is still reconciled and the event acknowledged.
Unknown/unrelated events are acknowledged as
ignored. Processed event IDs with identical body hashes are acknowledged as
duplicates before another provider request; conflicting payloads return 409.
Unprocessed reconciliation failures return an error for provider retry. MySQL
leases and transactions retain idempotency across delayed/out-of-order events.

To exercise local handlers without a public URL or real payment, run isolated
fixtures that generate valid raw-body signatures using an in-memory test secret:

```powershell
Set-Location C:\xampp\htdocs\hrms-saas\backend
node --import tsx --test --test-name-pattern='payment-only|signed event|invalid callback|deduplicates webhooks|renewal|renews yearly|cancels an unstarted' test/lifecycle.test.ts
```

These tests start an isolated API on an ephemeral port, create unique MySQL
fixtures, inject a test provider, sign exact request bytes, reject invalid
signatures, and clean up only their records. They do not fabricate a successful
payment in the normal application, bypass signature verification, or substitute
for real Razorpay webhook delivery. No secrets appear in test output.

For real Test Mode checkout locally, configure a backend-only
RAZORPAY_WEBHOOK_SECRET and restart the API; a public endpoint is not required by
the local readiness check, but **this existing integration requires the secret**.
Register/verify an administrator using the local SMTP workflow above, select a
plan in `/billing`, and complete Razorpay's current Test Mode authorization steps.
Cancel/dismiss Checkout to test the pending state; resume the same subscription
instead of creating another. Callback confirmation and Refresh provider status
can reconcile local test payments without externally delivered webhooks.

Renewals/retries remain provider-controlled; Test Mode simulation/dashboard steps
may be needed to advance provider lifecycle events. Do not wait for or invent a
local cron charge. Before relying on unattended renewal updates, configure the
future public HTTPS backend webhook with the matching secret and the event list
above, then validate delivery/retries in Razorpay's dashboard. Do not deploy or
switch to Live Mode as part of local testing. Confirm supported payment methods
and mandate behavior using the provider's current Test Subscriptions guide.

Existing auth and health endpoints are preserved.

| Method | Path | Access |
| --- | --- | --- |
| GET | /api/auth/verification-status | Own authenticated account |
| POST | /api/auth/verification/request | Own authenticated account; resend limits |
| POST | /api/auth/verification/confirm | Valid single-use verification token |
| POST | /api/auth/forgot-password | Public, generic and rate-limited |
| POST | /api/auth/reset/validate | Public token validation; does not consume |
| POST | /api/auth/reset-password | Valid reset token + password policy |
| GET | /api/billing/plans | Public; no private credentials/provider plan IDs |
| GET | /api/billing/status | Own authenticated organization |
| GET | /api/billing/history | Own authenticated administrator |
| POST | /api/billing/checkout | Own authenticated administrator, server plan ID |
| POST | /api/billing/confirm | Own authenticated administrator; provider signature |
| POST | /api/billing/refresh | Own administrator; provider reconciliation |
| POST | /api/billing/cancel | Own authenticated administrator |
| POST | /api/billing/webhook | Raw signed provider request; no session/CSRF |

All other mutations retain exact-Origin, custom-header and JSON CSRF checks on
both frontend and backend. Billing and token responses use no-store. Histories,
subscriptions, cancellation, confirmation, and refresh always derive tenant scope
from the session; webhook scope is derived from the persisted provider mapping.

## Test commands and scope

```powershell
Set-Location C:\xampp\htdocs\hrms-saas\backend
npm.cmd test
npm.cmd run build
npx.cmd prisma validate
npx.cmd prisma migrate status
npx.cmd prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code
```

Tests use the configured MySQL database, create unique fixtures, and delete only
their recorded IDs. Prefer an isolated development test database supplied through
process-level DATABASE_URL; migrate it first. Never run fixtures against production.
Payment fixtures are isolated adapters, not real payments. SMTP transport tests
use an actual loopback SMTP server without external delivery. Dates are controlled
for expiry/renewal tests; tests do not wait seven days.

For browser regression tests, start both applications and local SMTP as above,
then launch a **dedicated** headless test Chrome (not a normal browsing profile):

```powershell
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = Join-Path $env:TEMP "hrms-account-test-chrome"
Start-Process -FilePath $chrome -WindowStyle Hidden -ArgumentList '--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9223',"--user-data-dir=$profile",'about:blank'
Set-Location C:\xampp\htdocs\hrms-saas\frontend
npm.cmd run test:browser
```

The runner uses Node's built-in WebSocket/CDP, requires no browser dependency,
creates/deletes only its own organization, exercises actual local SMTP links,
verification/resend/reset/login/logout, direct expired-trial API denial, billing
availability and billing-period selection, and checks widths 320/390/768/1440.
It does not perform a real Razorpay payment or send external email. Chrome's debug
port and the SMTP inbox must remain local-only. Optional UI_SCREENSHOT_DIR saves
screenshots; no tokens/passwords are printed. Close the dedicated Chrome afterward.

## Remaining external / production work

Supply SMTP credentials and sender/domain verification, enable Razorpay Subscriptions,
configure test keys/webhook, synchronize the configured provider plans, and execute the
real-provider sandbox scenarios above. Then review HTTPS deployment, ingress rate
limits, monitoring and provider reconciliation operations before live mode.
In-process rate limits aggregate traffic behind the Next proxy and are not shared
between instances. The SMTP reset-delivery queue is not durable across restarts.
MFA and HR modules are still not implemented. Existing Prisma toolchain dependency
advisories require a separately reviewed upgrade; no blind major upgrade was made.

## Validation performed (26 October 2026)

- Backend TypeScript build and all 48 automated tests passed.
- Frontend lint and production build passed, including all new routes.
- Prisma validation, client generation, migration deployment/status, and schema
  drift comparison passed against the configured XAMPP MySQL database.
- The original organization/user/session audit matched before and after migration
  and fixture cleanup. This development database contained zero records in those
  tables at baseline; preservation of populated production data was not tested.
- The checked-in browser runner passed all six workflow groups and 20 responsive
  checks at 320/390/768/1440 px. Registration, verification and password reset used
  actual local SMTP, with no external delivery. Expired direct business requests
  returned 402 while billing remained accessible. No browser runtime exceptions
  were detected.
- Real external SMTP delivery and Razorpay sandbox transactions were not executed:
  credentials, configured prices/provider plans, and a public HTTPS webhook remain
  external setup. The application honestly disables unconfigured checkout.
- Temporary SMTP/browser services were stopped after testing; the normal API
  configuration was restored. Actual environment files were not changed.

The above 48-test/local-SMTP run describes the initial account implementation.
For the pricing follow-up, run `npm.cmd test` for the expanded suite (including
plan provisioning), and `npm.cmd run test:pricing` in frontend for the new browser
checks. The pricing runner needs both apps, XAMPP MySQL, and the dedicated Chrome
debug profile above; **no SMTP or Razorpay credentials**. It checks all six prices,
derived savings, loading/error states, authenticated plan continuation, disabled
checkout/direct API rejection and eight responsive views. It creates/deletes only
its own uniquely named organization. It deliberately stops if payment credentials
are configured, keeping its missing-configuration assertions honest.

Pricing follow-up results: all **61 backend tests passed**, backend TypeScript
build passed, frontend lint/production build passed, and Prisma validation,
generation, additive migration deployment/status and no-drift comparison passed.
Plan sync was executed twice successfully without credentials, publishing all six
prices each time. The pricing browser runner passed its three workflow groups
and eight responsive views. Real Razorpay sandbox/live transactions were not run
because credentials are unavailable. Only isolated adapters/mock HTTPS responses
exercise provider success/failure; no production account was marked paid.

Readiness-diagnostic correction: backend build and **66/66 tests passed**,
including missing/incorrect-mode credentials, valid configuration, simulated
HTTP 401/403/404/429/400/503, network failure, timeout and repeated synchronization.
The actual local sync command was executed and returned
RAZORPAY_MODE_KEY_MISMATCH with exit code 1 because Test Mode is configured with
a Live Mode key ID. No real provider synchronization was attempted or confirmed.
Environment files and schema/migrations were not modified. Before/after record
count/digest audits of the actual sync attempt matched, including the six local
plan definitions; the account/subscription tables were empty at this audit.

References: [Razorpay integration/signatures](https://razorpay.com/docs/payments/subscriptions/integration-guide/),
[Razorpay webhook validation](https://razorpay.com/docs/webhooks/validate-test/),
[Nodemailer SMTP/TLS](https://nodemailer.com/smtp), and
[OWASP password recovery](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

## File inventory for this change

Recurring-lifecycle completion modified:
`src/billing/{access,provider,routes,service}.ts`,
`test/{lifecycle,plan-sync}.test.ts`, this guide,
frontend `app/lib/{billing-types,auth-server}.ts`,
`app/components/{billing-panel,home-interactions}.tsx`, and
`scripts/check-pricing-ui.mjs`. No new dependencies, environment edits or schema
migrations were required. Existing trial/session/organization records are retained;
automated fixtures are scoped to their own unique IDs.

Completion validation: **73/73 backend tests passed**, backend build passed,
frontend lint and production build passed, and the pricing/billing browser runner
passed eight mobile/tablet/desktop responsive views plus loading/error states,
plan continuation, detailed billing labels and the exact checkout-readiness
reason. Prisma validation, migration status and schema-drift comparison passed.
Both local applications respond successfully on ports 3000/4000.

Two real Test Mode `billing:sync-plans` runs were confirmed by Razorpay and all
six configured plan IDs/prices are persisted. This confirms plan API integration,
**not** a customer payment, mandate or webhook delivery. No live mode, deployment
or real checkout transaction was performed. The current local blocker is the
missing RAZORPAY_WEBHOOK_SECRET; API Test Mode keys are now configured. Supply
that private secret locally to enable checkout, then execute the manual provider
authorization/payment checks above. Configure actual public webhook delivery
later on the intended server before relying on unattended renewal updates.

- Backend schema and `prisma/migrations/20261026100000_account_recovery_billing/migration.sql`.
- `src/auth/recovery.ts`, `src/auth/routes.ts`, `src/auth/security.ts`, `src/app.ts`, `src/server.ts`.
- `src/services/{errors,index,mail}.ts`, `src/billing/{access,provider,routes,service}.ts`.
- Pricing follow-up: `src/billing/{plan-sync,tax}.ts`, provider provisioning migration,
  `test/plan-sync.test.ts`, updated provider tests and price configuration.
- `config/billing-plans.json`, `scripts/{local-mail,sync-plans}.ts`.
- `test/{auth,lifecycle,provider,smtp}.test.ts`, package manifests/lockfile, `.env.example`, `AUTH.md`, this guide.
- Frontend auth catch-all/API billing proxy routes and `app/lib/{api-proxy,auth-server,auth-types,billing-types}.ts`.
- Pages: `/forgot-password`, `/reset-password`, `/verify-email`, `/verification-pending`, `/billing`, `/subscription-required`; dashboard notices/access redirects.
- Components: account-card, recovery-form, verification-panel, billing-panel, billing-page; auth/pricing integration and `app/account.css`.
- Frontend marketing copy updates, `.env.example`, package test script, and `scripts/check-account-ui.mjs`.
- Pricing follow-up: shared pricing/billing types, plan continuation in billing/auth
  components/pages, pricing copy, disabled/selected plan styles in globals/account
  CSS, package test scripts, and `scripts/check-pricing-ui.mjs`.

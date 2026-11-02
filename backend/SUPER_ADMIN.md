# Super Admin authentication, reporting and account settings

Platform accounts and organization users are independent identities. The old
implementation separated the login screens but resolved both through User and
Session. Platform authentication now resolves exclusively through SuperAdmin and
SuperAdminSession. It never queries User as a fallback or promotes an organization
account. No real owner credentials are created by migration or application startup.

## Models and identity boundaries

| Purpose | Organization | Platform |
| --- | --- | --- |
| Account and password hash | User | SuperAdmin |
| Sessions | Session | SuperAdminSession |
| Browser cookie | hrms_session | hrms_platform_session |
| Login | /login | /super-admin/login |
| Backend login | POST /api/auth/login | POST /api/super-admin/auth/login |
| Session lookup | GET /api/auth/me | GET /api/super-admin/auth/me |
| Logout | POST /api/auth/logout | POST /api/super-admin/auth/logout |
| Email-change verification | Existing organization recovery services | SuperAdminEmailChange |
| Current platform audit history | Not applicable | SuperAdminAuditEvent |

SuperAdmin has a cuid id, fullName, unique email, passwordHash, isActive,
authVersion, emailVerifiedAt and creation/update timestamps. It has no organization
ID or organization role. Multiple platform administrators are supported. Email
uniqueness is independent in each account table: the same email may legitimately
have different credentials in User and SuperAdmin.

The legacy UserRole.SUPER_ADMIN enum value is retained to preserve existing records;
it grants no platform access. Existing User rows, roles, password hashes, Session
rows, organization memberships, trial dates and all billing records stay unchanged.
Legacy role values are not converted to organization-administrator privileges.
A legacy organization account cannot unlock platform APIs with its existing cookie.

## Migration and preservation

The additive migration `20261028010000_separate_super_admin_auth` creates only:

- SuperAdmin
- SuperAdminSession (foreign key to SuperAdmin, cascade on account deletion)
- SuperAdminEmailChange (one supersedable request per SuperAdmin, cascade)
- SuperAdminAuditEvent (immutable actor ID namespace; survives account deletion)

The schema/data state was checked before applying the normal development migration.
No INSERT/UPDATE/DELETE against old tables and no automatic identity copying are part
of the migration. The new tables start empty. Apply locally from the backend:

```powershell
# Stop the local API watcher first on Windows if Prisma's native DLL is held open.
npx.cmd prisma migrate status
npx.cmd prisma validate
npx.cmd prisma migrate deploy
npx.cmd prisma generate
npm.cmd run build
npm.cmd run dev
```

Legacy AdminAuditEvent and AdminEmailChange tables and foreign keys remain intact.
AdminAuditEvent.actorUserId still refers logically to the old User namespace.
No old audit is silently deleted, reassigned to a new owner, or exposed as another
identity's history. New settings show only SuperAdminAuditEvent for their own ID.
Legacy audits remain available through trusted database administration/export;
manual ownership reconciliation would require a separately reviewed mapping.
Old User-based email links cannot mutate SuperAdmin records.

Rollback: keep a trusted database backup and stop the platform API if rollback is
needed. Do not deploy an old API that treats User.role as platform authorization.
There is no automatic destructive down migration: leave the new tables and their
audit records intact, and prefer a forward fix. Do not reset the database or edit
previously applied migrations. No Razorpay keys, prices or configuration change.

## Explicit owner provisioning

No public signup, email allowlist, startup seed, default password or role-promotion
endpoint exists. The old --user-id command is deliberately rejected. Provisioning
requires a trusted local terminal with the existing backend DATABASE_URL access.
No new secret environment variables are needed. Never put passwords on a command
line, in a URL, or in frontend environment variables.

Replace the uppercase email/name placeholders with values you control. Run from
`C:\xampp\htdocs\hrms-saas\backend` in an interactive PowerShell terminal:

```powershell
# First dedicated owner; refuses if ANY platform account already exists
npm.cmd run admin:provision -- --email YOUR_OWNER_EMAIL --name "YOUR_OWNER_NAME" --initial-owner --confirm-platform-access

# A further authorized administrator; requires an existing platform account
npm.cmd run admin:provision -- --email YOUR_ADDITIONAL_ADMIN_EMAIL --name "YOUR_ADDITIONAL_ADMIN_NAME" --additional-admin --confirm-platform-access
```

The command prompts twice for a hidden 8–128 character password. It refuses
noninteractive input, password arguments, old user IDs, missing confirmation,
ambiguous modes and duplicate emails. Creation uses existing scrypt hashing and a
serializable transaction; concurrent initial-owner attempts cannot both commit.
It creates a new account and an ACCOUNT_PROVISIONED audit event, never a User row.
The returned ID identifies the platform account, not an organization user.

Provisioning does not assert ownership of the entered email: emailVerifiedAt starts
null. Sign in using the new platform credentials; settings show the true verification
status. Verify an address using the email form and your current password. An
unverified address is never accepted as proof for platform password recovery.

### Recovery when the platform password is lost

Use the same trusted terminal and the actual SuperAdmin.id:

```powershell
npm.cmd run admin:provision -- --admin-id YOUR_SUPER_ADMIN_ID --reset-password --confirm-platform-access
```

This prompts for a new hidden password, requires an existing active account,
increments authVersion, revokes its platform sessions, cancels pending platform
email changes and records TRUSTED_CLI_RECOVERY. It never changes its email or
verification status, and never touches User credentials/sessions. Public organization
forgot-password/reset endpoints operate only on User and cannot reset SuperAdmin.
Platform self-service email-based password recovery is intentionally not introduced;
trusted terminal/database access is the recovery authority. Protect that access.

## Login, sessions and route protection

The dedicated frontend page is `http://localhost:3000/super-admin/login`. It posts
email/password to the dedicated platform auth endpoint. Organization login retains
its existing request body; the obsolete scope=platform request is rejected there.

Passwords use the shared existing scrypt implementation; tokens use the shared
cryptographically random 32-byte generator and SHA-256 hashing. Raw session tokens
exist only in HttpOnly cookies and memory, never as stored database values.
Cookies are SameSite=Lax, path=/, and Secure in production. Sessions last twelve
hours. CSRF/origin/custom-header checks, no-store responses and mutation body limits
remain in force. Login failures have an IP-based twenty-attempt/15-minute limiter
and generic messages for unknown, inactive and invalid-credential accounts.

Every platform API independently validates SuperAdminSession, expiry, authVersion,
account existence and isActive. Login rechecks the account under its row lock before
issuing/rotating a session. Inactive/deleted/revoked/expired sessions return 401.
Even a valid organization session, a legacy SUPER_ADMIN User role or a renamed
organization cookie cannot authorize a platform request. The inverse holds for
organization APIs. The Next.js proxy forwards only the matching cookie namespace.
Both account types can remain signed in independently in the same browser.

Overview, detail and settings pages use SuperAdminShell and getPlatformAdmin, not
getCurrentUser. Missing platform authentication redirects to the dedicated login
with a safe continuation and a session-ended message. Only /super-admin,
/super-admin/settings and /super-admin/organizations/<id> are allowed continuations.
External URLs, malformed paths, duplicate values, queries/fragments and login routes
are rejected. A new login follows a validated destination; a SuperAdmin already
signed in visiting the login page opens the overview. Session errors during an open
page provide an explicit dedicated sign-in action. Service outages do not fabricate
an authenticated or anonymous session. Organization login/dashboard never infer a
platform identity from a User role or from the platform cookie.

Platform logout revokes only its platform session and clears only its platform
cookie, then returns to the dedicated login. Organization logout leaves platform
sessions intact. Use localhost consistently: host-only cookies are not shared with
127.0.0.1. To disable an account, trusted database administration sets isActive=false;
all platform requests immediately fail. For permanent revocation before reactivation,
also increment authVersion and revoke that account's platform sessions.

## Account settings and audit history

At /super-admin/settings, all operations derive the identity from platformAuth;
submitted target IDs, organization IDs and roles are rejected.

- Email: confirm the current password, send to the requested address, store only a
  token hash, and keep the current email active until valid confirmation. Links
  expire in thirty minutes and are single-use. The token is in a frontend fragment,
  scrubbed into memory, never a query or browser storage. Confirmation requires the
  same signed-in platform owner and current password. If asked to sign in, use the
  current email then reopen the original link. An unverified initial owner can enter
  its existing email to verify it; an already-verified unchanged email is rejected.
- Resend: the same form supersedes the old token after sixty seconds. Missing mail,
  rejection, expiry, replay, wrong owner/password or duplicate email leaves the
  existing email usable. Duplicates are checked only within SuperAdmin, both at
  request and confirmation. Delivery acceptance is not guaranteed inbox delivery.
- Password: current password plus matching new 8–128 character passwords; use the
  established hash implementation and atomically revoke all platform sessions,
  increment authVersion and cancel active platform email requests.
- Successful email verification/replacement also revokes all platform sessions and
  increments authVersion. The current session is revoked; select Sign in again.
  Organization accounts, sessions and recovery tokens remain independent.

Account mutations have ten attempts per IP/15 minutes plus the resend cooldown.
New audit events store only actorSuperAdminId, action, outcome, fixed reason code
and time. They contain no passwords, hashes, session/verification tokens, email
bodies or provider responses. Settings show the latest ten own events. Audits
survive account deletion; establish a retention policy before production use.

## API endpoints

| Endpoint | Access / body |
| --- | --- |
| POST /api/super-admin/auth/login | Strict email/password; no User fallback |
| GET /api/super-admin/auth/me | Active platform session; public account fields |
| POST /api/super-admin/auth/logout | CSRF-protected, idempotent session revocation |
| GET /api/super-admin/account | Own public account, pending state, mail readiness, ten own audit events |
| POST /api/super-admin/account/email | currentPassword, newEmail |
| POST /api/super-admin/account/email/confirm | currentPassword, token |
| POST /api/super-admin/account/password | currentPassword, newPassword, confirmPassword |
| GET /api/super-admin/metrics | from/to; aggregate counts and captured-payment summary |
| GET /api/super-admin/revenue | from/to; payment summary |
| GET /api/super-admin/organizations | q/status/page/pageSize; bounded directory |
| GET /api/super-admin/organizations/:id | Organization and trial/subscription detail |
| GET /api/super-admin/organizations/:id/subscriptions | page/pageSize; subscription history |
| GET /api/super-admin/organizations/:id/payments | page/pageSize; payment history |

Reports remain read-only and use the existing billing classifications, tenant
relations and provider-reconciled history. No checkout/payment/webhook code changes.
Page size is at most fifty, with stable ordering and literal parameterized search.
Reports have their existing 120-request/minute limiter; all APIs are no-store.

## Email configuration

Reuse backend .env.example/AUTH.md/BILLING.md. Never expose or display .env secrets.
Generic SMTP requires MAIL_PROVIDER=smtp, SMTP_HOST, SMTP_PORT, SMTP_SECURE,
SMTP_USER, SMTP_PASSWORD and SMTP_FROM. Resend uses MAIL_PROVIDER=resend,
RESEND_API_KEY and an authorized SMTP_FROM. Use implicit TLS on 465 or STARTTLS on
587. FRONTEND_URL and frontend APP_ORIGIN must match the local frontend origin.
Run npm.cmd run mail:check after configuring your provider. No credentials or
frontend environment secrets were added by this refactor. Missing email delivery
does not prevent platform login/password changes; it disables email requests.

## Validation and local browser checks

From backend:

```powershell
npm.cmd test
npm.cmd run build
npx.cmd prisma validate
npx.cmd prisma migrate status
npx.cmd prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code
```

From frontend: npm.cmd run lint, npm.cmd run build, npm.cmd run test:super-admin,
npm.cmd run test:super-admin-settings, npm.cmd run test:browser and
npm.cmd run test:subscription. Browser fixtures are uniquely named, then cleaned up
by their exact IDs. They never create a real owner, send external email or perform
a real Razorpay charge; checkout browser states are intercepted fixtures.

For settings/email browser checks, use a dedicated headless Chrome on debug port
9223 (profile outside frontend source), loopback SMTP and isolated API/frontend:

```powershell
# backend terminal 1
npm.cmd run mail:local
# backend terminal 2 (process-local variables only; do not edit .env secrets)
$env:PORT='4001'
$env:FRONTEND_URL='http://localhost:3001'
$env:APP_ORIGIN='http://localhost:3001'
$env:MAIL_PROVIDER='smtp'
$env:SMTP_HOST='127.0.0.1'
$env:SMTP_PORT='1025'
$env:SMTP_SECURE='false'
$env:SMTP_ALLOW_INSECURE_LOCAL='true'
$env:SMTP_FROM='HRMS Test <test@example.test>'
$env:SMTP_USER=''
$env:SMTP_PASSWORD=''
node dist/app.js
# frontend terminal 3
$env:NEXT_PUBLIC_API_URL='http://localhost:4001'
$env:APP_ORIGIN='http://localhost:3001'
npm.cmd run build
npx.cmd next start -p 3001
# frontend terminal 4
$env:UI_TEST_ORIGIN='http://localhost:3001'
$env:UI_TEST_API_URL='http://localhost:4001'
npm.cmd run test:super-admin
npm.cmd run test:super-admin-settings
npm.cmd run test:browser
npm.cmd run test:subscription
```

Stop isolated services afterward and rebuild from a fresh terminal with normal
local configuration. The local inbox is http://127.0.0.1:8025 and sends no email
externally. To verify real delivery, configure a real backend sender, request an
address you control in platform settings, and open the received link.

Known limitations: rate limits are process-local (a distributed deployment needs
shared storage); platform recovery is trusted-terminal only; legacy audit identities
are retained separately rather than guessed; no real owner is provisioned by tests.
Do not deploy, reset data, change Razorpay mode or promote organization users.
## Classification and metric definitions

Trial end is capped at the earlier stored cutoff or trial start plus exactly seven
days, matching AccessPolicy; no dates are changed or legacy trials invented.
Subscription access/status reporting reuses the existing status values and
paid-through model, and additionally requires reconciled captured-payment evidence.
This stricter reporting does not change the business access policy or provider code.

Each organization has a single representative subscription: prefer an eligible
subscription with verified paid time remaining, then an unresolved/live subscription,
then the most recently created terminal record. A newer pending checkout does not
hide an older subscription that still has verified paid time. Each primary status
metric counts an organization once even with multiple subscriptions.

| Metric / filter | Definition |
| --- | --- |
| Total registered | All Organization rows, including any owner workspace |
| Active free trial | Trial start <= now, capped end > now, no current verified paid access |
| Verified active paid | Representative status ACTIVE, paidUntil > now, provider reconciliation timestamp and an invoice-linked captured payment dated no later than now, matching the subscription currency and at least its cycle amount |
| Expired trial | Capped trial end <= now and no current verified paid access |
| Pending | CREATING, CREATE_UNKNOWN, CREATED or AUTHENTICATED; also an ACTIVE record without confirmed paid evidence |
| Payment failed / past due | PENDING or HALTED, or the latest reconciled failed payment; never sufficient alone to grant paid access |
| Checkout creation failed | FAILED local creation record; not evidence that a payment was attempted or declined |
| Paused | Provider PAUSED state; not treated as a failed payment |
| Cancelled | Representative provider state CANCELLED; paid access may remain until the verified paid cutoff |
| Expired subscription | EXPIRED/COMPLETED, or ACTIVE with lapsed paidUntil; this does not imply that an unpaid checkout ever converted |
| No subscription | No paid/pending/terminal subscription and no active/expired recorded trial |
| Converted trials | A trial organization with any historically captured/refunded invoice-linked payment dated between trial start and now, matching the subscription currency and at least its cycle amount, with a provider reconciliation timestamp |

Trial and subscription metrics **can overlap**: a pending checkout may still have
trial access; an expired trial can coexist with a cancelled subscription. Conversion
is historical, separate from current status. Captured-paid evidence, current paid
access, raw provider status, and historical conversion are shown separately.
The payment/checkout issues card includes past-due/payment failures and failed
checkout creation. The paused state is a separate filter and is not counted there.
Registration, plan selection, checkout creation and authorization-only payments
never classify an organization as active paid. Subscription period/renewal dates
come only from stored provider reconciliation; registration dates are separate.
Detailed failure reasons are unavailable because the existing schema does not
persist them. The most recent payment is the latest reconciled locally recorded
payment; failed-payment provider timestamps are not stored. No provider network
calls are made by these reports, so lastSyncedAt shows how current the data is.

## Captured payments, refunds and dates

Revenue queries include only INR BillingPayment rows with status captured, a
non-null paidAt, a provider invoice ID, a positive amount and a reconciled owning
subscription. The existing reconciler is the source of these provider-confirmed
records. providerPaymentId is unique in the database, preventing double counting;
several legitimate captures for one organization are counted individually.
Authorized, pending, failed, fully refunded and unconfirmed rows are excluded.
No currency conversion is attempted.

`from` and `to` are calendar dates in Asia/Kolkata, inclusive through the end of
`to`, implemented with an exclusive next-day boundary on paidAt. Default is the
last 30 calendar days; ranges must be ordered and at most 366 days. The date filter
applies to captured payments, not the current organization-status counts.

The schema does not store refund amounts or immutable historical capture totals;
partial refunds can leave the original captured amount on a captured row, and full
refunds change its status. Therefore the figure is explicitly **captured payments**,
not reliable lifetime gross collections or net revenue. Refund totals and net
revenue return null and are shown as unavailable. No zero refund/net placeholders
are invented. Zero captured payments means the aggregate found no qualifying rows;
database/service failures produce an error, not a fabricated zero.



## Files changed for identity separation

- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20261028010000_separate_super_admin_auth/migration.sql`
- `backend/src/auth/routes.ts`
- `backend/src/server.ts`
- `backend/src/super-admin/auth.ts`
- `backend/src/super-admin/security.ts`
- `backend/src/super-admin/routes.ts`
- `backend/src/super-admin/account-service.ts`
- `backend/src/super-admin/account-routes.ts`
- `backend/src/super-admin/provision.ts`
- `backend/scripts/provision-super-admin.ts`
- `backend/test/platform-auth.test.ts`
- `backend/test/super-admin.test.ts`
- `backend/test/super-admin-account.test.ts`
- `backend/test/auth-redirects.test.ts`
- `backend/package.json`
- `backend/SUPER_ADMIN.md`
- `backend/AUTH.md`
- `backend/BILLING.md`
- `frontend/app/lib/auth-types.ts`
- `frontend/app/lib/auth-server.ts`
- `frontend/app/lib/api-proxy.ts`
- `frontend/app/lib/auth-redirects.ts`
- `frontend/app/login/page.tsx`
- `frontend/app/dashboard/page.tsx`
- `frontend/app/super-admin/login/page.tsx`
- `frontend/app/api/super-admin/[...path]/route.ts`
- `frontend/app/components/platform-login-form.tsx`
- `frontend/app/components/logout-button.tsx`
- `frontend/app/components/super-admin-shell.tsx`
- `frontend/app/components/super-admin-settings.tsx`
- `frontend/scripts/check-super-admin-ui.mjs`
- `frontend/scripts/check-super-admin-settings-ui.mjs`

No billing service, payment provider, webhook, organization-recovery service,
password-hashing implementation or environment secret was modified. Generated
Prisma client artifacts were regenerated in backend/node_modules.
## Completed local validation — 28 October 2026

- `npm.cmd test`: **123 passed, 0 failed, 0 skipped**. This includes nine isolated
  platform-auth/provisioning/legacy-preservation groups and fourteen account-settings
  groups, alongside existing organization, trial, billing, provider and SMTP tests.
- The nine platform-auth tests were additionally rerun after strengthening the
  matching-organization-email provisioning assertion: all nine passed.
- `npm.cmd run build` in backend: passed. The provisioning script also passed a
  strict standalone TypeScript check with Node types (the backend build normally
  includes src only).
- Prisma validate: passed; migrate deploy applied the additive migration; all seven
  migrations are current; database/schema drift comparison returned no differences;
  Prisma client generation passed.
- Frontend lint and production build: passed, with normal local configuration
  restored after isolated browser testing.
- Platform browser suite: passed, including session isolation, inactive-account
  denial, safe continuations, reports/histories, four login and eight report layouts.
- Platform settings browser suite: passed, including actual loopback SMTP delivery,
  email/password changes, platform session revocation, independent organization
  session preservation and four responsive widths.
- Existing organization-account browser suite: passed (signup, verification,
  recovery, trial expiry, billing access; twenty responsive layouts).
- Existing subscription browser suite: passed (six plan/cycle choices,
  failure/dismissal, explicit mocked checkout; eight responsive layouts).

A pre/post SHA-256 fingerprint over all original organization, User (including
password hashes and timestamps), Session, AccountToken, subscription, payment,
plan and legacy email-change/audit records matched exactly. The original counts
remain one organization, one User, one subscription, one payment and six plans.
All temporary fixtures were removed. There are zero real SuperAdmin accounts,
platform sessions, pending platform changes and platform audit events after cleanup.

Manual next step: run the initial-owner command above using your chosen credentials
in a trusted interactive terminal. Existing organization credentials do not become
platform credentials. Additional-account and trusted recovery commands are also
listed above. No .env secret, Razorpay configuration, trial date or real organization
account was changed; no deployment or database reset occurred. Isolated test
services and dedicated Chrome were stopped; the normal local applications remain
available. Generated build artifacts were refreshed under backend/dist and
frontend/.next, and the Prisma client under backend/node_modules.
## Session-proxy incident audit — 28 October 2026

An owner reported a platform dashboard header recognizing the account while its
reports showed an expired/revoked-session message immediately after login.
The audit found an active account and an unexpired, version-matching platform
session. No password, account-role, token or database reset was required.

Reproduction with an isolated disposable account on the actual localhost:3000
**development** server established:

- Login succeeded and issued the platform cookie.
- Direct backend session lookup, metrics, organizations and settings returned 200.
- The same requests through the frontend proxy returned 401, while the server-rendered
  dashboard recognized the same session.
- Temporary development-only diagnostics showed the platform cookie constant was
  undefined in the running app-route module, although the source/compiled file
  defined it and the server-rendered auth context used the correct value.
- A controlled frontend restart restored cookie forwarding. The old generated dev
  cache was subsequently preserved under frontend/.next/dev-before-session-proxy-fix-*
  and regenerated to clear remaining stale client/server development artifacts.
  No project source, database record or browser cookie was deleted by this operation.

A further dev-browser check exposed a platform prerender diagnostic for Date.now().
getPlatformAdmin now explicitly waits for a real request with connection(), so
platform identity lookup and its timeout are not prerendered. Fresh-cache platform
browser checks passed, with no platform prerender diagnostics in that dev run.
Independent pre-existing dev diagnostics on organization dashboard/billing routes
remain outside this platform fix; their tested registration/billing flows passed.

The proxy now fails closed with a generic 503 availability response if its cookie-name
configuration is missing, instead of forwarding an anonymous request and falsely
reporting an expired session. Real absent/expired/inactive/revoked platform sessions
still return 401. Organization cookies are never used as a platform fallback.
The obsolete assertion that provisioning necessarily revokes earlier sessions was
removed from report errors. Platform login uses an explicit POST form fallback;
missing hydration cannot turn credential entry into a GET query. JSON/CSRF checks
still reject unsupported native form submissions rather than bypassing security.
All temporary diagnostic headers were removed.

The new `npm.cmd run test:platform-proxy` command runs against the **actual local
server**, defaulting to frontend 3000/API 4000 (UI_TEST_ORIGIN/UI_TEST_API_URL can
select another local server). It creates/deletes only exact owned fixtures, compares
nine backend/proxy endpoint results, verifies SSR recognizes the same session,
checks platform and organization cookie isolation, reaches password confirmation,
and verifies real expiry is still denied. Credentials/tokens stay in memory.
Unlike the prior production-only coverage, this catches the development proxy fault.

Files changed for this incident:

- frontend/app/lib/api-proxy.ts
- frontend/app/lib/auth-server.ts
- frontend/app/components/platform-login-form.tsx
- frontend/app/components/super-admin-panel.tsx
- frontend/scripts/check-platform-session-proxy.mjs
- frontend/scripts/check-super-admin-ui.mjs
- frontend/package.json
- backend/SUPER_ADMIN.md

Do not edit credential/session tables or clear all browser cookies to resolve this
case. After a controlled dev-server restart, refresh /super-admin. Stop the dev
server before a production build, then restart and verify the actual dev proxy
again afterward. Keep the regenerated cache separate from any preserved diagnostic
cache; none of this requires deployment or database migration.

Incident validation completed:

- Full backend suite: 123 passed, zero failures; backend TypeScript build passed.
- Frontend lint and production build passed. The dev server was stopped for that
  build, restarted afterward, and the actual port-3000 proxy regression passed again.
- New live proxy regression: nine endpoints agree with the backend; SSR uses the
  same valid platform session; organization-cookie isolation, authenticated mutation
  authorization and real platform-session expiry all passed.
- Full platform browser suite passed against the development server: dashboard
  metrics and histories, refresh, login/logout, safe continuations, inactive/expired
  session denial, and twelve responsive login/report checks.
- Customer subscription browser suite passed against the same dev server: immediate
  signup, six plan/cycle choices, eight responsive checks and mocked checkout failure/
  dismissal. No real Razorpay transaction or external email was performed.
- The login form's POST method and absence of a password query were separately
  verified in the browser.
- A pre/post SHA-256 fingerprint of all thirteen relevant organization/platform
  account, session, token, audit, trial, subscription, payment and plan tables matched.
  The existing owner account and original platform session remained unchanged and
  valid. All disposable fixtures were removed.

The normal frontend (3000) and backend (4000) are running. The separate headless
browser was closed. No passwords, account activation/roles, authVersion values,
original session records, environment secrets or billing configuration were changed.
Refresh the platform dashboard to replace the old client error state with the
updated runtime; do not provision another owner or reset credentials for this fault.

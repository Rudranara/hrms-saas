# Organization authentication

Platform authentication uses dedicated SuperAdmin/SuperAdminSession tables and a
distinct cookie. See [SUPER_ADMIN.md](SUPER_ADMIN.md) for protected routes and the
explicit owner-creation command. Public organization signup cannot create platform
accounts; legacy User roles grant no platform privileges.

The existing health endpoints remain public. Authentication uses MySQL-backed,
12-hour opaque sessions. Node's built-in scrypt hashes passwords with independent
16-byte salts (`N=65536, r=8, p=2`). Only a SHA-256 digest of each random 256-bit
session token is stored. Passwords and session tokens are never returned in JSON.

## Setup

Keep the existing `.env` and `.env.local` files. Examples contain no real secrets.

Backend requires `DATABASE_URL`. `FRONTEND_URL` defaults to
`http://localhost:3000` in development; production requires an exact HTTPS origin.
Frontend requires the existing `NEXT_PUBLIC_API_URL`. For production set frontend
server variable `APP_ORIGIN` to the same public origin as backend `FRONTEND_URL`.
Keep the API URL reachable from the Next.js server. Behind a reverse proxy,
preserve the public host and protocol and do not expose untrusted proxy headers.

From `backend/`:

```sh
npm install
npx prisma generate
npx prisma migrate deploy
npx prisma migrate status
npm run build
npm test
```

On Windows use `npm.cmd` / `npx.cmd` if PowerShell blocks the `.ps1` launchers.
Stop the backend before generating Prisma Client if its Windows engine DLL is
locked. Never reset the database. The migration only adds nullable Organization
trial fields and new User/Session tables, indexes, and foreign keys.

## Requests and authorization

- `POST /api/auth/register`: `organizationName`, `fullName`, `email`, `password`,
  `confirmPassword`. Passwords must contain 8–128 characters. Extra keys,
  including role or organization IDs, are rejected. Email is normalized and
  globally unique. Organization, administrator, and authenticated session are written
  in one transaction. Duplicate-email failure rolls back the new organization.
  Only after commit is the HttpOnly `hrms_session` cookie issued. Registration
  opens the dashboard immediately, does not call SMTP, and leaves emailVerifiedAt
  null. Verification is optional and available later in email settings.
- `POST /api/auth/login`: email and password. Invalid credentials use one message;
  missing accounts still perform password hashing work. Successful login rotates
  the current session. Other device sessions are retained.
  Unverified accounts also receive a full session. Legacy limited verification
  cookies are replaced through normal password login without restarting trials.
  Passwords continue to use the requested 8–128-character policy.
- `GET /api/auth/me`: current safe user and organization fields, or 401.
- `POST /api/auth/logout`: deletes the session and clears the cookie.
- `GET /api/organization`: session-scoped organization, administrator only.
- `GET /api/organizations/:organizationId`: requires an exact match to the
  authenticated organization. Even then the query uses the session's ID.

Reuse `requireAuthentication`, `requireRole`, and `organizationScope(req.auth!)`
for future organization-owned routes. Never construct tenant scope from request
body, query, or path values. Roles are read from MySQL on each authenticated call.

The browser calls same-origin Next `/api/auth/*` handlers, which forward only the
session cookie to the API and forward Set-Cookie back to the frontend host. This
supports separate frontend/API origins without exposing tokens to JavaScript or
relying on third-party cookies. Cookies are host-only, HttpOnly, SameSite=Lax,
and Secure in production. Use HTTPS in production; no cookie Domain is set.

All mutations require an exact trusted Origin, JSON content type, and the custom
`X-HRMS-Request: 1` header on both Next and Express. CORS allows only FRONTEND_URL
with credentials. GET endpoints do not mutate state. Authentication responses are
not cached. No authentication data is written to browser storage.

## Tests

`npm test` starts an isolated HTTP listener against the configured MySQL database,
creates uniquely named test organizations, and deletes only their recorded IDs
afterward. It never deletes existing organizations. Use a dedicated database via
the process-level `DATABASE_URL` when available; apply migrations there first.
Tests cover transactions, normalized duplicates, validation, login, session
rotation/expiry/revocation, CSRF, role checks, cross-organization isolation,
cookie settings, malformed input, rate limiting, and password hashing.

## Verification, recovery, trial enforcement, and billing

These workflows are now implemented. See [BILLING.md](BILLING.md) for the complete
route audit, policy, migration/backfill strategy, external service setup, Windows
commands, test commands, remaining external dependencies, and changed-file list.

## Original authentication boundaries (updated)

New organizations receive exact seven-day trial timestamps. Authentication does
not depend on trial expiry. Business API access requires authentication and
trial or verified paid eligibility. Billing/recovery/account routes remain
accessible after expiry. HR modules are still in development. Legacy null trial
timestamps are not backfilled with new trials. No legal acceptance box is shown
because this repository contains no Terms page.

Password recovery is restricted to verified email addresses. Unverified addresses
receive the same generic forgot-password response as unknown accounts, but no reset
email or token. Reset validation and consumption also reject unverified accounts,
including older reset tokens. Users should verify their address voluntarily before
relying on email recovery; signup and login do not prove mailbox ownership. There
is no email-change flow in this application; this change adds no recovery bypass.

Rate limiting uses express-rate-limit's in-process store. With the Next proxy,
the API observes the proxy address: limits are conservative aggregate limits,
not a reliable per-browser identity. Before a multi-instance public launch,
configure trusted ingress rate limiting/shared counters for the deployment.
No Redis or Docker is required by this implementation. Expired sessions are
always rejected; periodically prune them with the indexed `expiresAt` field.
Email verification and password recovery are implemented; MFA and a general-purpose
audit logging system are not. Provider event deduplication/history is persisted.

An audit found three pre-existing Prisma 6 toolchain advisories via deepmerge-ts
(also reported by `npm audit --omit=dev`). Their advertised fix requires a Prisma
major upgrade, which is not part of this authentication change. The compatible
body-parser runtime fix was applied. These remaining advisories need separate
dependency-upgrade review before a public production launch.

## Changed files

- Backend: `src/app.ts`, `src/server.ts`, `src/auth/password.ts`,
  `src/auth/security.ts`, `src/auth/routes.ts`, `prisma/schema.prisma`,
  `prisma/migrations/20261026090000_organization_auth/migration.sql`,
  `test/auth.test.ts`, `package.json`, `package-lock.json`, `.env.example`,
  and this document.
- Frontend: `app/register/page.tsx`, `app/login/page.tsx`,
  `app/dashboard/page.tsx`, `app/dashboard/error.tsx`,
  `app/api/auth/[action]/route.ts`, `app/lib/auth-types.ts`,
  `app/lib/auth-server.ts`, `app/components/auth-form.tsx`,
  `app/components/auth-shell.tsx`, `app/components/logout-button.tsx`,
  `app/components/home-interactions.tsx`, `app/auth.css`, `app/page.tsx`,
  `app/pricing/page.tsx`, `.env.example`, and `.gitignore`.
- Added dependency: `express-rate-limit` for authentication attempt throttling.
  Updated compatible transitive `body-parser` in the lockfile for its security fix.

Security references: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
[session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
and [CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

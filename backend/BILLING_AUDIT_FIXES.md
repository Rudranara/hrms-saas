# Billing audit corrections — 2 November 2026

## Scope and preservation

The existing Razorpay recurring Subscription integration, six prices, intervals,
12-cycle schedules, tenant authorization, trial dates and customer terms remain.
The additive migration is `20261102000000_billing_audit_safety`; it creates no
provider operation and contains no customer-record updates or timestamp backfill.
Existing `paidAt` values are preserved, even where their historical provenance is
payment creation. Credentials, payment mode and environment files are unchanged.

## Findings and implementation

| Finding / original root cause | Implemented correction | Source files | Regression evidence |
| --- | --- | --- | --- |
| Unpaid check and immediate cancellation were separate provider operations, allowing a payment race. | An organization-serialized durable BillingReplacement records CHECKING, CANCELLING, SETTLING, READY, COMPLETED or CONFLICT. Cancellation is sent once, followed by authoritative subscription/invoice/payment reads. A minimum 60-second settlement interval and a second observation precede any replacement. Uncertain cancellations are never blindly repeated. Money observed after cancellation or after replacement creates durable review, preserves financial records/verified time and blocks checkout. | `src/billing/service.ts`, `routes.ts`, `access.ts`, Prisma schema/migration, billing panel/status/types | Payment during cancellation; concurrent switches and same-plan resume; late money after replacement; only one provider cancellation/new subscription. |
| Late provider creation responses unconditionally wrote CREATED/FAILED/CREATE_UNKNOWN. | Creation updates require the original CREATING state, persisted creationOperationId and no active synchronization owner. Success checks affected rows and reads the resulting record; error updates cannot overwrite an advanced state. | `src/billing/service.ts`, Prisma schema/migration | ACTIVE survives a late success, definite rejection and timeout. |
| Lease validation was a read followed by an unfenced update. | The final SQL update checks owner and unexpired lease and requires one affected row. Subscription/payment/event writes share one transaction. Cleanup is conditional on owner. Organization locking also coordinates replacement conflict writes with checkout reservation. | `src/billing/service.ts` | Expired worker; replacement worker while old work is delayed; ownership change specifically after the successful lease read and before final SQL. |
| Payment creation time was presented as capture time. | `paymentCreatedAt` stores provider creation; `captureVerifiedAt` stores first authoritative observation. New `paidAt` remains unknown unless a signed `payment.captured` event supplies a valid event timestamp for that verified payment. `paidAtSource` records SIGNED_CAPTURE_EVENT. Existing non-null historical dates are never rewritten. Access uses verified capture evidence without inventing capture time. Revenue fallback to first verification is explicitly disclosed. | `src/billing/service.ts`, `routes.ts`, `access-rules.ts`, `src/super-admin/service.ts`, schema/migration, billing display/types | Delayed authorization-to-capture; API-only unknown capture time; later signed capture event; repeated sync; legacy timestamp preservation and revenue inclusion. |
| Refund events and old terminal records could escape financial recovery. | Signed refund.created/processed/failed/speed_changed events resolve the provider payment and invoice before tenant attribution. Amount refunded comes from authenticated provider GETs, never event amounts. Unique payment IDs store cumulative totals; event ID/hash deduplication prevents duplicate processing. Scheduler includes terminal subscriptions/recent financial changes within 30 days. Unchanged reads preserve payment updatedAt, preventing an endless lookback. Access is separately checked against verified paid periods and status. | `src/billing/routes.ts`, `service.ts`, `reconciler.ts`, schema/migration, billing history | Invalid refund signature, duplicate refund event, partial/full refunds, terminal history recovery, expired access remains off. |
| Oversized/fractional intervals passed validation and could overflow Node timers. | Shared parser requires a safe integer from 60,000 to 3,600,000 ms; default is 300,000 ms. Both startup and scheduler validate. | `src/billing/reconciler.ts`, `src/app.ts` | Empty, malformed, fractional, tiny, infinite and overflowing values rejected; both boundaries accepted. |
| Signal handlers stopped the timer but left HTTP/Prisma running. | Idempotent signal handler stops new batches, stops HTTP acceptance, drains the running request/recovery, closes newly idle connections and disconnects Prisma. Normal completion exits zero; a 30-second deadline closes connections and exits nonzero if draining cannot finish. | `src/shutdown.ts`, `src/app.ts`, `src/billing/reconciler.ts` | Child-process tests cover in-flight request + recovery, repeated signals, disconnect once, bounded forced exit, and no next subscription after stop. |
| Historical names used the live catalog. | Tenant status/history/purchase and platform subscription/payment reporting prefer the commercial snapshot, falling back only for legacy records. | `src/billing/terms.ts`, `access.ts`, `routes.ts`, `src/super-admin/service.ts`, billing panel | Catalog rename leaves existing agreed names intact. |
| Polling ran while Razorpay was open and expired before a slow checkout completed. | Polling is paused while Checkout is open, restarts after dismissal or callback completion, is bounded to twelve attempts at five-second spacing, and stops for verified terminal results including review. Manual status checking remains. HTTP/network failures preserve pending/previous verified state. | frontend `billing-panel.tsx`, `payment-status.tsx`, billing types | Browser keeps Checkout open 25 seconds with zero refresh attempts, closes it to begin verification, handles an outage without false failure, retries, verifies success and checks polling stops. |

## Recovery and provider limitations

No application lock can freeze an external payment. The settlement interval is a
conservative observation window, not proof that a payment can never arrive later.
The durable operation remains linked to the old subscription after replacement;
later verified money raises CONFLICT. A cancelled paid mandate cannot be restored
automatically by this integration. Do not create a substitute, refund, charge or
clear a conflict automatically. The platform operator must inspect both provider
subscriptions, invoices/payments and BillingReplacement before deciding an explicit
resolution. There is no new public endpoint that silently clears financial review.
Refresh errors and ambiguous cancellations retain a blocking operation. Interrupted
operations move to review once observed stale. Financial records are preserved.

Refund handling stores authoritative cumulative refunded totals per payment;
known refund evidence cannot be reduced by a later stale provider read or used
to reactivate a fully refunded cycle.
it does not claim a complete historical refund ledger or infer individual refund
amounts from untrusted event payloads. Historical refund amounts unknown before
this migration remain unknown until normal reconciliation. Thirty-day terminal
recovery is bounded; older missing history needs explicit operator reconciliation.
Signed webhook delivery still processes supported events for older subscriptions.

Capture-event time has provider-event precision. First verification time is an
observation, not an exact capture timestamp. Legacy dates retain their original
meaning; they are not retroactively certified as capture times. Invoice downloads,
new capacity entitlements, proration and immediate paid-plan upgrades remain outside
this change.

## Automated verification

`npm run test:billing-audit` creates a separately named localhost fixture database,
applies migrations there, validates schema/status/drift and runs the complete
existing backend suite plus `test/billing-audit.test.ts` and `test/shutdown.test.ts`.
It refuses production/non-localhost database targets and preloads a network guard
that rejects real Razorpay API calls. Logs are written to
`artifacts/billing-audit-backend-tests.log`. The application database is not used
for test fixtures. `--reuse` only accepts the previously generated isolated name.
Loopback SMTP fixtures are used by existing mail tests.

Browser verification uses `scripts/audit-browser-server.ts`, the isolated database,
an isolated headless browser profile and intercepted Razorpay checkout responses.
The fixture API must run with `--require ./test/block-provider-network.cjs`.
The browser runner accepts UI_TEST_ISOLATED=1, UI_TEST_ORIGIN and UI_TEST_DEBUG_PORT.
Never run the fixture backend against an application/production database.

## Verification results

- Complete backend suite plus audit/shutdown regressions: **187/187 passed**.
- Dedicated final-write lease, replacement, timestamp, refund, historical-label and
  shutdown regression run: **17/17 passed**. The complete suite includes these
  tests; these counts are not additive unique-test totals.
- Backend TypeScript production build: passed.
- Frontend TypeScript, full ESLint and Next.js production build: passed.
- Browser purchase regression: passed, including monthly/yearly flow, quote expiry,
  edit/reload, closure/retry, verification outage, 25-second open Checkout, terminal
  polling stop, dashboard confirmation and widths 320/390/768/1440.
- Prisma generation, validation, migration status and schema drift checks: passed.
  All 16 migrations apply from an empty isolated fixture database.
- The additive migration was also applied to the existing **local development**
  database. An in-memory before/after hash comparison of every pre-existing scalar
  field in Organization, User, Subscription, BillingPayment and BillingPlan matched.
  The comparison included existing payment timestamps, subscription prices/cycles,
  customer terms and trial dates. No fixture was inserted into that database.
  Only non-sensitive counts/preservation outcome were saved in
  `artifacts/billing-audit-preservation.json`.
- The original development backend was restored on port 4000; catalog verification
  reports Test Mode and all six original prices and twelve-cycle schedules.
- Actual Razorpay Test Mode acceptance: **not performed**. No provider subscription,
  payment, refund or mandate was created; no credentials/environment file was changed.

Each finding in the implementation table has passing regression coverage; the
source logs are `artifacts/billing-audit-backend-tests.log` and
`artifacts/billing-audit-targeted-tests.log`. Existing lifecycle expectations were
updated for settlement waiting and honest unknown capture time. One existing
directory test now creates its own second fixture instead of depending on a real
owner, allowing the complete suite to run against an empty isolated database.

Modified/added implementation files:
- `prisma/schema.prisma`, `prisma/migrations/20261102000000_billing_audit_safety/migration.sql`
- `src/billing/service.ts`, `routes.ts`, `access.ts`, `access-rules.ts`, `reconciler.ts`, `terms.ts`
- `src/app.ts`, `src/shutdown.ts`, `src/super-admin/service.ts`
- frontend `app/components/billing-panel.tsx`, `payment-status.tsx`,
  `app/lib/billing-types.ts`, `app/lib/super-admin-types.ts`

Verification/support files:
- `test/billing-audit.test.ts`, `test/shutdown.test.ts`, `test/block-provider-network.cjs`
- `test/lifecycle.test.ts`, `test/super-admin-management.test.ts`
- `scripts/verify-billing-audit.ts`, `scripts/audit-browser-server.ts`, `package.json`
- frontend `scripts/check-billing-purchase-ui.mjs`
- `BILLING.md`, this report and the named verification artifacts

## Deployment and manual acceptance

Apply the additive migration before starting this backend, regenerate Prisma,
then deploy backend and frontend. Never use migrate reset or db push on customer
data. Scheduler interval must remain within the documented bounds; monitor failed
batches and durable review operations. Recovery performs provider GETs only.

Mocked automation does not establish real Razorpay acceptance. Before production,
manually test Test Mode monthly/yearly authorization/capture, slow Checkout,
callback loss, duplicated/delayed/out-of-order webhooks, refunds, terminal financial
recovery, payment/cancellation overlap, settlement/retry and shutdown of the actual
deployment. Match invoice amount, references, timestamp provenance and paid period.
No actual Razorpay Test Mode or Live Mode transaction is performed by this work.

Provider contracts checked against official documentation:
- https://razorpay.com/docs/webhooks/refunds
- https://razorpay.com/docs/webhooks/payments
- https://razorpay.com/docs/api/payments/entity

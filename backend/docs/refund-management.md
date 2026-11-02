# Refund management: implementation and acceptance

## Initial implementation audit

The audit preceded implementation. `BillingPayment` already stored one unique
Razorpay payment ID per original payment, invoice ownership, captured-payment
proof, original amount/currency, cumulative refunded amount, and preserved payment
timestamps. Payment IDs belonged to subscriptions, which belonged to organizations.
`BillingService.reconcile` fetched provider subscription, invoice and payment
evidence. Full refunds removed payment eligibility; partial refunds retained the
paid period. Signed refund webhooks resolved payment/invoice/subscription ownership
and reused `BillingEvent` deduplication. History already displayed cumulative
refunds. There was no customer request, decision, provider-refund issuance, refund-ID
ledger, or financial-decision audit workflow. Dedicated `SuperAdminSession` cookies
were already separate from organization sessions. Those mechanisms were preserved.

## Policy and workflow

- Requests are case-by-case and request the full *remaining* captured balance.
- No automatic eligibility deadline, unused-day credit, automatic approval, or
  cancellation-triggered refund is introduced.
- Organizations cannot submit an amount. Reviewers may approve the full remaining
  request or a smaller positive amount, or reject with a mandatory explanation.
- Approval requires explicit confirmation. A persisted approval is not a claim
  that money has been refunded. Only provider refund and payment evidence produces
  a completed status; bank credit timing is outside HRMS.
- Refunds never cancel subscription renewals, extend access, restart trials, or
  change plan pricing or the existing 12-cycle schedule.
- Partial refunds preserve access. A fully refunded payment ceases to prove paid
  access; other valid payments, trials and admin grants remain independent.

`RefundRequest` preserves the full-balance intent, reason, organization/payment,
decision, reviewer identity/name, approved amount, rejection explanation and
timestamps. `RefundTransaction` preserves each provider refund and its status,
original payment, amount, currency, stable receipt/idempotency key and verification
timestamps. External refunds can have no local request. `RefundAuditEvent` is an
append-only timeline of submission, decision, processing and verified outcomes.
Foreign keys restrict deletion of refund financial evidence. The additive migration
is `20261102030000_refund_management`. It creates three tables and foreign keys;
it does not update customer, subscription or payment rows.

## API and authorization

All mutation endpoints also require the existing trusted-origin/custom-header CSRF
checks. Inputs reject extra fields, and mutation routes are rate limited.

| Endpoint | Identity and operation |
| --- | --- |
| GET `/api/billing/refunds` | Organization admin; own requests only; paginated |
| POST `/api/billing/refunds` | Organization admin; `{paymentId, reason, requestId}`; session supplies organization/user |
| POST `/api/billing/refunds/:id/refresh` | Organization admin; own request only; GET-only provider verification |
| GET `/api/super-admin/refunds` | Dedicated platform session; search organization/payment ID and filter status |
| POST `/api/super-admin/refunds/:id/decision` | Dedicated platform session; APPROVE or REJECT, stable UUID and expected version |
| POST `/api/super-admin/refunds/:id/process` | Dedicated platform session; continue an existing approved operation, confirmed saved amount |
| POST `/api/super-admin/refunds/:id/refresh` | Dedicated platform session; GET-only verification |

Approval payload: `{action:"APPROVE", requestId:<UUID>, expectedVersion:<integer>,
amountMinor:<positive integer>, confirmed:true}`. Rejection instead requires
`action:"REJECT"` and `reason`; no amount or confirmation field is accepted.
List query parameters: `page` (20 rows/page), `q`, optional `status`.
Request statuses: PENDING, APPROVED, REJECTED, PROCESSING, PARTIALLY_REFUNDED,
REFUNDED and FAILED. Partial/full completion describes the decision against that
request's remaining-balance intent; payment history separately shows cumulative
refunds across all requests.

## Financial safety

- The original payment is scoped through its subscription to the authenticated
  organization. Before issuance, provider payment and invoice evidence must match
  the persisted payment, original amount/currency and provider subscription.
- Available balance accounts for confirmed refunded totals and externally pending
  refund amounts. Razorpay independently enforces its balance if external activity
  races between the last read and the POST.
- A payment-row lock, unique active-payment request, unique submission/decision
  keys, version check, and one transaction per request serialize decisions.
- Reviewer activity/session versions are rechecked under an actor lock after
  provider preflight reads. Approval and its audit commit together.
- PREPARED is claimed once as INITIATING, atomically with its processing audit,
  before any provider POST. The same request cannot cause a second POST.
- The adapter sends `X-Refund-Idempotency`, a permanent `receipt`, exact approved
  amount and `speed:normal` to the original payment's refund endpoint.
- A timeout/network/ambiguous rejection leaves RECONCILING with the balance
  reserved. Recovery only GETs the saved refund ID or searches the original
  payment's refund list by receipt. It never silently retries issuance.
- Confirmed provider authentication/permission/not-found denial is FAILED, not
  successful. A provider-verified failed refund can release its reservation.
- PROCESSED cannot regress from stale pending/failed evidence. Failed cannot
  regress to pending. Original amounts and historical paidAt values are retained.
- Webhooks validate the existing raw-body signature and event ID. Refund evidence
  is fetched from Razorpay. An early webhook reconciles its original payment and
  commits its refund ledger before the event is acknowledged/deduplicated.
- The existing production recovery scheduler also checks pending refunds and
  imports observed external refunds. Recovery is bounded, rotates unresolved work,
  observes shutdown, and performs no new refund POSTs.

## Notifications and UI

Organizations use the Refund requests section on `/billing`. The screen shows
captured payments, original/refunded/remaining amounts, reasons, request status,
rejection explanation, provider reference and verification date. Active requests
refresh periodically and can be checked explicitly. Notifications are persistent
**in-app status messages**, not email delivery.
Payment history has bounded 50-row pages and a Load older payments action. Older
eligible captures can therefore be selected without an arbitrary refund deadline.

Platform reviewers use `/super-admin/refunds`, linked in platform navigation. It
provides search, filters, original payment/subscription details, full/partial amount
validation, explicit confirmation, rejection reasons and the audit trail.

## Automated verification

`npm test` includes `test/refunds.test.ts`. Use the existing isolated local runner:
`node --import tsx scripts/verify-billing-audit.ts --reuse` from `backend`.
It validates/migrates only its named fixture database and blocks real provider
network access. The full suite also covers registration, OTP, login/recovery,
trial/monthly/yearly checkout, cancellation, platform sessions and tenant access.
`test/provider.test.ts` mocks transport and checks the refund endpoint, minor-unit
amount, stable header/receipt, invalid amount rejection and no secret exposure.

Frontend browser check: `node scripts/check-refunds-ui.mjs`, with an isolated
headless Chrome debug port selected via `UI_TEST_DEBUG_PORT`. It creates uniquely
named temporary local fixtures, uses real authentication/proxies/screens, intercepts
financial provider actions with an in-memory mock, and cleans its own fixtures.
It checks submission, status notifications, partial/full approvals, explicit
confirmation, rejection validation, original-history preservation and four widths.
It does **not** test actual Razorpay refunds. The local browser origin defaults to
`http://localhost:3000` and requires the local API and Test Mode catalog.

Backend lint reuses the TypeScript ESLint tooling installed in the frontend
workspace; install both workspaces' existing dependencies before `npm run lint`.
No runtime backend dependency on the frontend is introduced.

## Manual Razorpay Test Mode acceptance — still required

Do not run these against Live Mode or real customer records. Use dedicated staging
organizations and dedicated platform reviewers. Keep the Test Mode key pair and
webhook secret server-side; do not replace production credentials. Configure the
staging webhook's public HTTPS URL and refund/payment/subscription events. Configure
the existing recovery worker for staging, or run its one-shot command. Do not
disable TLS verification or signature checks.

Use only payment methods published in the current official testing documentation:
https://razorpay.com/docs/payments/subscriptions/test/ . Refund operations:
https://razorpay.com/docs/api/refunds/create-normal/ and
https://razorpay.com/docs/api/refunds/fetch-with-id/ . Do not invent test credentials
or treat locally simulated events as provider-backed acceptance.

| Scenario | Steps and expected evidence; failure indication |
| --- | --- |
| Captured monthly payment | Register/verify a staging organization, purchase an existing monthly plan using official Test Mode methods, and verify captured payment plus paid invoice in Razorpay. HRMS history must show the same original amount and reference. Do not change plan prices. |
| Captured yearly payment | Repeat with a separate organization and existing yearly plan. Verify annual amount/period and unchanged 12-cycle disclosure. |
| Request submission | Select the captured payment on Billing, enter a reason and submit. Expect PENDING and no provider refund. Original payment and renewals must not change. |
| Authorization isolation | With organization B, try organization A's payment/request ID; expect 404. Anonymous/employee sessions must fail; organization cookies cannot approve. Extra organization/amount fields on submission must be rejected. |
| Duplicate request | Double-click or replay the same submission UUID. One request only; a different UUID while unresolved must receive conflict. |
| Rejection | Select Reject as a platform reviewer. Empty reason must fail; a valid explanation must persist and appear in the organization's rejected notification. No provider refund. |
| Partial approval | Approve a smaller positive amount within the remaining balance and explicitly confirm. Observe one provider refund ID and matching amount/receipt; initial APPROVED/PROCESSING is not success. Verify partial completion and unchanged paid-through access. |
| Invalid partial amount | Try zero, negative, extra decimal places and an amount above the remaining/requested amount. UI/API must reject without a provider POST. |
| Full remaining approval | Request the remaining balance and approve it. Verify one new refund ID, cumulative refunds no greater than original capture, full-refund eligibility removed, and other trial/admin grants unchanged. Original payment row must remain. |
| Approval confirmation | Cancel the confirmation dialog. No decision/refund should be submitted. Direct approval without confirmed:true must fail. |
| Concurrent reviewers | In two reviewer sessions submit decisions for the same pending request. One decision wins; one conflict or identical replay is returned; exactly one provider refund. |
| API denial | Use an isolated mock/fault harness (not altered production credentials) to simulate a definitive 401/403 denial. Expect FAILED, no claimed completion and no resend of the operation. |
| Lost response | In an isolated fault harness, drop the POST response after the provider accepts it. Expect RECONCILING/PROCESSING, a reserved balance, and recovery by the existing refund ID/receipt. There must be no second refund POST. This fault injection is simulated, not a natural Razorpay event. |
| Pre-POST outage | Interrupt processing after approval but before the once-only claim. Expect APPROVED/PREPARED. Continue the saved approval after recovery; it must retain its original reference. |
| Delayed/missed webhook | Delay delivery in the staging delivery/fault setup. Request status must remain unconfirmed until provider verification. Run recovery/Check status and verify the original refund becomes complete without another issuance. |
| Duplicate/out-of-order events | Use Razorpay's supported Test Mode webhook replay/delivery tools where available. Identical events must be idempotent. Test stale reads/order with the isolated mock harness; confirmed success must not regress. Do not label handcrafted payloads as actual provider delivery. |
| Early external refund | Issue a separate Test Mode refund in the Razorpay Dashboard without an HRMS request. Its verified webhook/recovery must import exactly one ledger record with original payment ownership. |
| External pending refund | With a pending provider refund, attempt approval above the truly available balance. It must not issue an excess refund. Use a mock harness if the provider processes too quickly to observe this state. |
| Payment history | Verify original amount, original paid/capture timestamp, total refunded, remaining amount, each provider refund ID and verification date. Multiple partial refunds must not duplicate the payment. |
| Cancellation independence | Cancel a dedicated staging subscription and verify no refund was issued. Separately refund a different active subscription and verify renewals are not automatically cancelled. |
| Access after refund | Partial: paid access remains. Fully refunded current payment: that payment cannot prove paid access. A distinct valid trial/admin grant/paid entitlement may still permit access. |
| Worker and shutdown | Run recovery with unresolved refunds, then stop the worker/backend gracefully. The current GET/transaction may finish; no new refund issuance or duplicate POST may occur after restart. |

For every provider-backed case, compare the Test Mode Dashboard and API evidence
with `RefundRequest`, `RefundTransaction`, `RefundAuditEvent`, original
`BillingPayment`, subscription state and organization access response. A UI-only
success or approval is not acceptance. No production-readiness claim is made until
required provider-backed cases pass.

## Initial implementation verification results — 2 November 2026

- Full isolated backend run: **222 tests passed**, zero failed, including the
  existing authentication, registration/OTP, recovery, trial/subscription,
  cancellation, refund, platform-session and access-isolation cases.
- Backend TypeScript build and backend ESLint: passed.
- Frontend ESLint: passed without warnings; production build: passed.
- Organization/platform refund browser workflow: passed with in-memory provider
  responses, actual local sessions/proxies/database fixture storage and four
  widths (320, 390, 768, 1440 pixels).
- Prisma validation: passed. Both local application and isolated fixture schemas
  have 19 applied migrations and no schema drift.
- The additive application migration compared hashes of **all pre-existing model
  rows** before and after; they were unchanged. Only new tables were introduced.
- No real provider payments/refunds, credentials/environment edits, plan-price or
  12-cycle changes, customer financial backfills, or deployments were performed.
- Actual provider-backed Razorpay Test Mode acceptance remains **not performed**.
  The checklist above is still required before any production-readiness decision.

Later independent-audit remediation and follow-up verification are recorded in
`refund-audit-remediation.md`. The latest isolated run passed 237 backend tests
and the separate refund/helper/redirect subset passed 41 tests, with no failures.
Those supersede the initial implementation count above. Real provider-backed
acceptance is still pending.

## Deliberate limitations

- An uncertain initiation with no discoverable provider refund remains reserved
  for operator review. Absence from a list is not permission to issue another.
- PREPARED approvals require an authorized reviewer to explicitly continue after
  a pre-POST interruption; the recovery worker never starts a new financial action.
- Refunds do not stop renewals. Cancel separately if the business decision requires it.
- Refund approval is case-by-case, not a legal refund-policy determination.
- Notifications are in-app. No email provider/delivery workflow was added.
- `processedAt` is HRMS's observed provider-completion time, not a fabricated bank
  credit timestamp. Acquirer credit timing remains outside HRMS.
- Exact refund-ID history for old refunds depends on webhook/API availability;
  legacy fully-refunded balances are displayed safely without backfilling old rows.
- Full financial records are retained; deletion is restricted by foreign keys.
- Provider refund-list scans are bounded; exceptionally large histories require
  operator reconciliation rather than silently approving with incomplete data.
- Revenue/net-revenue aggregation remains the existing explicitly limited report;
  the refund ledger does not silently rewrite historical revenue calculations.

## Independent audit remediation and operator recovery

The independent audit found a stale captured-payment commit race, loss of
provider-completion evidence during aggregate lag, unchangeable PREPARED
approvals, unfair external-refund scans, locked forms after definitive errors,
and a missing refund-management reauthentication destination.

Reconciliation now locks payment rows in deterministic order, re-reads refund
evidence under READ COMMITTED, and recalculates entitlement before committing.
Paid-proof SQL also excludes fully refunded amounts. Individual provider
`processed` evidence is latched independently while aggregate totals catch up;
stale pending/failed reads cannot erase it or release its reservation.

External refund discovery uses a durable `RefundDiscoveryScan` checkpoint and
lease, with deterministic primary-key pagination and a fixed upper bound per
cycle. It scans at most 25 payment rows per tick, including captured payments
with zero local refund totals and refunded/previously-refunded payments.
Ineligible rows still consume the query budget. New IDs on either side of the
cursor and payments becoming eligible after inspection are revisited next cycle.

Failed inspections enter `RefundDiscoveryRetry`. Queue insertion, cursor advance,
and any global cooldown commit atomically. Deferred rows do not block the main
scan and are skipped there until the independent retry queue handles them. Each
tick permits five due retries after the main batch, ordered by next retry time
and payment ID. Backoff starts at one minute, doubles to a one-hour maximum,
and has no terminal attempt limit. Successful inspection removes the retry row.
Provider `Retry-After` may extend the delay beyond that maximum when required.

Inspections are serial GET-only calls spaced by 250 ms. A payment-specific 429
defers only that payment; an account-wide or unclassified 429 ends the batch and
persists a shared cooldown. Razorpay responses currently provide no trusted
payment-specific classification, so its 429s are treated conservatively as
global. Subscription and uncertain-refund recovery check the same cooldown
before each operation. Already-running requests may finish. Refund-list API
pagination retains its existing hard limit. No recovery path submits a refund.

The shared lease lasts 30 minutes and renews before each payment inspection.
Graceful shutdown releases it; after a crash, another worker resumes when it
expires. Owner-token checks fence stale workers from checkpoint writes. A crash
before checkpoint commit repeats an idempotent GET, including when financial
evidence already committed. Existing financial observations serialize on the
payment row. Do not delete checkpoints or retry rows to recover an outage.

Release prerequisites: `20261102030000_refund_management` and the additive
`20261102040000_durable_refund_discovery` must be applied before
enabling refund routes/workers. Verify `prisma migrate status` and database-to-schema
drift with `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code`.
Require up-to-date migrations and no schema difference. The durable worker
migration adds two tables and does not rewrite customer financial records.

### Definitely unsubmitted approvals

1. In `/super-admin/refunds`, refresh the request and inspect its audit trail.
2. Only an APPROVED request whose transaction is still PREPARED, with no provider
   refund ID or provider status, offers **Amend or void approval**.
3. If an external refund reduced the balance, choose Amend, enter the revised
   positive amount and an explanation, and explicitly confirm. The backend
   validates fresh payment/invoice/refund-list evidence and locks the payment.
4. Amendment records the old amount and reason in the append-only audit, rotates
   the unsubmitted reference, and fences any initiator holding the old snapshot.
   It does not submit a refund. Explicitly choose Continue approved refund only
   after reviewing the saved amendment.
5. Alternatively choose Void, explain and confirm. This marks the unsubmitted
   transaction VOIDED, rejects the request and releases its reservation. Original
   approval and financial history are retained.

The dedicated authenticated endpoint is POST
`/api/super-admin/refunds/:id/prepared`: action AMEND (with amountMinor) or VOID,
UUID requestId, expectedVersion, reason, and confirmed:true. It rejects extra
fields, revoked sessions, stale versions and any already-claimed operation.

### Uncertain initiation, including a crash immediately before POST

INITIATING/RECONCILING is **uncertain**, even if an operator believes the process
crashed before sending the POST. PREPARED is the only application's conclusive
unsubmitted state. Do not reset uncertain rows, release reservations, alter
references, amend amounts or press a new-refund action to work around this state.

1. An authorized platform operator selects Check provider status. Recovery GETs
   the saved refund ID, or paginates the original payment's refunds and matches
   the permanent receipt. It never retries the POST.
2. If found, verify original payment/invoice/subscription ownership, amount,
   currency and receipt. Provider processed evidence is preserved; disagreement
   with payment totals remains reserved until those totals are reconciled.
3. If not found, leave the operation reserved and retain its audit trail. Repeat
   GET/status checks after provider delivery delays have settled. Absence from a
   refund list, or a 404 alone, does not establish that no money was sent.
4. Escalate using the saved payment ID, receipt, idempotency key, claim time and
   existing audit evidence through the provider's authorized support process.
   Keep that evidence in the restricted incident record; do not expose keys or
   customer details in public logs. This application adds no override that
   blindly reissues an uncertain refund.
5. Any eventual manual financial correction requires explicit authorized
   operator review of conclusive provider evidence and a separately reviewed,
   audited procedure. Until sufficient evidence exists, keep the reservation.

Cancelling a subscription remains separate from issuing or voiding a refund.
These code changes and mocked regressions do not establish real Razorpay Test
Mode acceptance or production readiness.

## Changed implementation files

Backend: `prisma/schema.prisma`, the additive migration above, `package.json`,
`eslint.config.mjs`, `src/billing/refunds.ts`, `refund-routes.ts`, `provider.ts`,
`routes.ts`, `reconciler.ts`, `src/services/index.ts`, `src/server.ts`,
`test/refunds.test.ts`, and `test/provider.test.ts`.

Frontend: `app/components/organization-refunds.tsx`, `super-admin-refunds.tsx`,
`billing-panel.tsx`, `super-admin-shell.tsx`, `super-admin-panel.tsx`, `app/lib/refund-types.ts`,
`app/refunds.css`, `app/super-admin/refunds/page.tsx`, the new billing-refund proxy,
the existing super-admin proxy allowlist, and `scripts/check-refunds-ui.mjs`.

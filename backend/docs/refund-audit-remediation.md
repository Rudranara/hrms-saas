# Refund independent-audit remediation — 2 November 2026

All six reported findings are addressed in the implementation and covered by
regression checks. This is code/mock verification, not provider acceptance or a
production-readiness declaration. No real payments, refunds, cancellations,
credential changes, environment-file edits or deployment were performed.

## Findings and fixes

| Finding | Resolution | Regression evidence |
| --- | --- | --- |
| H1: stale captured snapshot restores access | The final reconciliation transaction uses READ COMMITTED, locks payments in deterministic order, merges the latest irreversible refund evidence, and recalculates paid-through entitlement. Paid-proof SQL and purchase status exclude fully refunded totals. | A full refund commits after the provider/captured snapshot; the stale reconciliation cannot restore captured status, paid-through time or access. An inconsistent legacy captured/full-refund row is denied, while an independent trial remains valid. |
| M1: processed evidence regresses during aggregate lag | Provider `processed` is latched independently in providerStatus. Local completion waits for matching aggregate evidence; stale failure/pending cannot erase success evidence or release the active reservation. | Processed refund + zero aggregate, then stale failed response, then matching aggregate: reservation remains until verified completion. |
| M2: PREPARED approval becomes unprocessable | Dedicated confirmed amendment/void endpoint for APPROVED/PREPARED only, fresh balance verification, reviewer-session recheck, payment locking, versioning and audited old/new amounts. Amendment rotates unsubmitted references; initiation CAS includes the original amount/reference to fence stale initiators. | External refund reduces balance; excessive amendment rejected; valid amendment processes; void releases reservation; organization cookies/missing confirmation rejected; uncertain submissions cannot change; concurrent amendment fences old initiation. |
| M3: first-25 starvation and missed external refunds | Independent per-worker primary-key pagination, 25 rows per query, inspecting captured payments including zero local refund totals, plus refunded/previously-refunded rows. Serial GET-only inspections are spaced by 250 ms. HTTP 429 stops the batch without checkpointing the failed row; other failures retry on wrap. No shared mutable checkpoint. | Mixed zero/positive local totals across 60+ payments; missed-webhook full/partial refunds; temporary failure, rate-limit retry, new earlier ID, overlapping calls and independent workers. |
| L1: definitive error locks form | HTTP status/code retained. Definitive 4xx responses refresh data and clear draft locks; network/parse/5xx uncertainty retains the same idempotency payload. No automatic financial replay. | Helper tests plus real browser validation rejection, balance conflict, timeout and explicit same-key retry. |
| L2: refund return path missing | Add only the exact refund-management path to the strict platform continuation allowlist. | Expired-session login continuation preserved; external origins, queries, fragments and extra path segments rejected. |

## Operational recovery

The detailed operator runbook is in `refund-management.md`, under
"Independent audit remediation and operator recovery". PREPARED can be amended
or voided after authorization and confirmation. INITIATING/RECONCILING remains
GET-only: search by refund ID/receipt, validate payment and refund evidence, retain
the reservation if inconclusive, and escalate with preserved evidence. Absence
from provider lists never authorizes a second issuance. No blind-reset override
was introduced.

## Files changed for this remediation

Backend:

- `package.json`
- `src/billing/service.ts`
- `src/billing/access-rules.ts`
- `src/billing/routes.ts`
- `src/billing/refunds.ts`
- `src/billing/refund-routes.ts`
- `src/billing/reconciler.ts`
- `test/refunds.test.ts`
- `test/refund-ui-errors.test.ts` (new)
- `test/auth-redirects.test.ts`
- `scripts/verify-refund-browser.mjs` (new isolated browser runner)
- `docs/refund-management.md`
- `docs/refund-audit-remediation.md` (this report)

Frontend:

- `app/api/super-admin/[...path]/route.ts`
- `app/components/super-admin-refunds.tsx`
- `app/components/organization-refunds.tsx`
- `app/lib/refund-types.ts`
- `app/lib/auth-redirects.ts`
- `scripts/check-refunds-ui.mjs`

Earlier working-tree changes were preserved. The refund feature requires the
existing additive migration `20261102030000_refund_management`, which creates
`RefundRequest`, `RefundTransaction`, and `RefundAuditEvent` with their indexes
and foreign keys. The follow-up remediation requires no additional migration;
this does not mean the refund feature can run without the existing migration.

## Release prerequisite

Before enabling refund routes or workers in a release, verify that
`20261102030000_refund_management` and
`20261102040000_durable_refund_discovery` are applied in the target environment, run
`prisma migrate status`, and verify database-to-schema drift with
`prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code`.
Require an up-to-date migration history and no schema difference. Apply the
existing additive migration through the approved release process if missing;
do not create a replacement migration or rewrite customer financial records.
This remediation applies/verifies migrations only in the isolated local fixture
database; it does not apply production or application-database migrations.

## Earlier remediation verification (before the follow-up below)

- Final full isolated backend suite: **232 passed, 0 failed**, four suites. This
  includes existing lifecycle, provider, webhook, access-control, recovery and
  platform authorization tests. Real provider network access was blocked.
- Targeted refund/helper/redirect run: **36 passed, 0 failed**.
- Backend TypeScript build and source lint: passed.
- Frontend no-emit TypeScript, lint and production build: passed.
- Actual browser workflow against separate local frontend/backend servers and
  the isolated fixture database: passed. Provider methods were in-memory mocks.
  Includes request/decision error recovery, same-payload retries, PREPARED
  amendment/void, confirmation, rejection, partial/full status, original history,
  cancellation independence and widths 320/390/768/1440.
- Application Prisma validation/status/drift: passed; 19 migrations applied and
  no schema difference. A fresh isolated database also applied the existing 19
  migrations and passed validation/status/drift. No application migration ran.
- Hashes of every application model's rows matched before and after verification.
  Customer/financial rows were unchanged; all mutating fixtures used isolated DBs.

Initial browser-runner setup attempts failed before completing the checks
(development-server isolation and restricted Windows GPU startup). The final
runner passed using an isolated copied frontend and a dedicated headless browser.
The browser uses test-only sandbox flags, never a customer browsing profile.
Windows may retain temporary browser cache files; fixture financial rows are
cleaned and owned test servers are stopped.

## Follow-up verification - 2 November 2026

The independent follow-up found that scanning only positive local refund totals
missed external refunds with absent webhooks, and that the migration wording
above was incorrect. Both are corrected in `src/billing/reconciler.ts`,
`test/refunds.test.ts`, and these two refund documentation files. Existing
reservation, locking, evidence, idempotency and initiation code is unchanged.

- Full isolated backend runner: **237 passed, 0 failed**, four suites, no skips.
  Command: `node --import tsx scripts/verify-billing-audit.ts --reuse`.
- Separate refund/helper/redirect subset: **41 passed, 0 failed**, no skips.
  The previous six findings' regression checks remain passing.
- New full and partial missed-webhook regressions begin with zero local refund
  evidence and scan **61 captured payments** (mixed zero/positive local totals)
  across three recovery ticks using the actual RefundService and MySQL fixture.
  The ledger/balance is imported; partial access remains; full access is revoked
  and cannot be restored by a later stale provider capture. No refund POST runs.
- A separate **62-payment** scan covers pagination, transient failure retry on
  wrap, new earlier IDs, pacing and overlapping same-client calls. Additional
  tests cover HTTP 429 without cursor advancement, independent concurrent MySQL
  workers with unique ledger evidence, and shutdown during pacing.
- Backend TypeScript build and source lint: passed. Frontend production build,
  lint and no-emit TypeScript (`--incremental false`): passed.
- Isolated Prisma validation: passed; all **19 existing migrations** applied,
  no pending migrations and **no schema difference**. No new migration created.
- Real Razorpay requests were blocked by `test/block-provider-network.cjs` in
  both test runs. Provider activity used in-memory fixtures. No application or
  production database migration/data changes, credentials, environment files,
  prices, billing terms or subscription cycles were changed. No deployment,
  commit or push occurred. Verification refreshed ignored local test artifacts.

Browser checks described in the earlier section were not rerun for this backend
and documentation follow-up. Actual provider-backed acceptance remains pending.

## Remaining acceptance and limitations

Real Razorpay Test Mode acceptance is still required: captured monthly/yearly
payments; full and repeated partial refunds; provider idempotency and receipt
matching; real webhook signatures/delivery/replays; delayed/missed events;
aggregate lag; provider failure/lost response; cancellation independence;
timestamps/access after refunds; recovery worker restart and shutdown.

Use dedicated Test Mode organizations and official supported testing methods.
Compare provider IDs/amounts/status with the original payment, refund ledger,
request/audit and access response. Handcrafted events and fault injection are
simulations, not evidence of real provider timing or bank-credit behavior.

Uncertain operations can deliberately remain reserved indefinitely when provider
evidence is insufficient. Operator escalation is required. Mocked passing tests
do not prove production readiness.

## Durable worker follow-up

The final audit identified persistent-429 starvation and loss of process-local
scan progress. These supersede the earlier M3 implementation described above.
The worker now uses a durable checkpoint/lease plus a separate persisted retry
queue. Failed inspections advance the main cursor atomically with retry metadata;
global 429s also persist a cooldown in that transaction. The main scan has a
25-row budget and due retries have a separate five-row budget. Backoff starts at
one minute and caps at one hour, unless provider Retry-After requires longer.
Retries never expire merely because the attempt count is high.

Apply both `20261102030000_refund_management` and the new additive migration
`20261102040000_durable_refund_discovery` before enabling routes/workers; verify
migration status and schema drift as above. Previous migrations are unchanged.
See `refund-management.md` for the lease, restart, cooldown and retry runbook.

Verification for the durable worker:

- Full isolated backend runner: **245 passed, 0 failed**, four suites, no skips.
- Focused refund/provider/helper/redirect run: **60 passed, 0 failed**, no skips,
  using `node --import tsx scripts/verify-billing-audit.ts --reuse --refunds`.
- Persistent global and payment-specific 429 cases use 66 captured payments,
  including a later missed full refund, through actual reconciliation cycles.
  Each batch uses a fresh Prisma client. Later captures are inspected, full
  refund evidence revokes access, failed rows stay queued with backoff, and
  subsequent successful retries clear the queue and import financial evidence.
- Lease expiry fences a stale worker; failed checkpoint transactions repeat
  already-committed financial GETs without duplicate ledger records. New IDs
  above/below the cursor and changed eligibility are covered across cycle wraps.
- Shared cooldown suppresses subscription and uncertain-refund recovery reads.
  Retry-After transport metadata and bounded exponential delay are tested.
- Backend TypeScript build and source lint passed. Prisma validation, migration
  status and drift checks passed in the isolated fixture: 20 applied migrations,
  none pending, no schema difference. Application migrations were not applied.
- Initial full verification timed out because the shutdown test's database mock
  lacked the new checkpoint delegate. The mock was updated; the repeated full
  run and standalone shutdown tests passed. Its orphaned test process was stopped.
- Prisma generation emitted updated client code/types but its final Windows
  query-engine replacement failed with EPERM while the DLL was in use. The
  installed and bundled engine SHA-256 hashes match. Regenerate the client after
  releasing the DLL lock as part of release preparation.
- Real Razorpay access was blocked during tests; no provider-backed acceptance
  or browser checks were performed for this backend-only change.

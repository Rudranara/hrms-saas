# Organization trial and subscription access controls

Super admins manage an organization's workspace eligibility from its existing
`/super-admin/organizations/<id>` detail page. Organization users cannot call these
management endpoints. Existing super-admin account creation remains add-only.

## Policies

- `CONTROLLED`: separate trial and subscription switches. An enabled, unexpired
  trial or an enabled subscription date window grants access; subscription wins
  when both apply. Both off denies access. Disabled dates are retained for reuse.
  With only trial enabled, organizations may purchase a plan before or after trial
  expiry. A fresh purchase records the current access-policy revision and can
  activate verified paid access without changing trial dates. Saving the switches
  again overrides subscriptions from older policy revisions: switching paid access
  off and trial on uses only the chosen trial, even if an older provider subscription
  remains paid or later renews. The form retains the saved switches, including
  enabled options whose dates have expired, instead of deriving them from the
  effective access source. With
  subscription dates enabled, provider renewals cannot bypass admin dates; both
  off still blocks access and checkout. Existing accounts remain unchanged
  until their first save.
- `AUTO`: evaluate verified provider-paid time, trial expiry, then configured grace.
  New registrations still receive seven days by default. Explicit trial expiry is
  authoritative, allowing audited extensions beyond seven days.
- `MANUAL`: only the specified start-inclusive/end-exclusive period grants access.
  It overrides automatic eligibility, so shortening it also limits an otherwise
  provider-paid organization. Its expiry does not fall back to an active trial or
  provider subscription. Restore automatic access explicitly to remove this policy.
- `SUSPENDED`: deny business access regardless of trial, provider-paid, grace or
  manual time. Sign-in, recovery, settings, billing status/history and existing
  cancellation remain available. Starting a new checkout is blocked for suspended
  or manually managed organizations.

These policies do not pause charges, cancel mandates, issue refunds, change provider
billing dates or create payment records. Existing provider subscriptions continue
their billing lifecycle. Payment-provider management is a separate workflow.

After a subscription-to-trial reset, Billing keeps plan selection available even
when the earlier provider subscription still has paid time. The quote identifies
that earlier subscription and requires explicit replacement consent on Proceed.
The backend confirms cancellation of its renewals, retains its financial history,
waits at least one minute and checks again before reserving one new subscription.
Proceed retries perform due confirmation reads automatically. New payments or
refund changes during replacement enter durable review instead of starting another
charge. Saving access switches or selecting/reviewing a plan never cancels billing.

## Controls and dates

The UI uses one `SET_CONTROLS` action, two independent switches, conditional dates,
and one Save changes button. No reason field is required for this action; the server
records a default audit description when omitted. The strict payload requires booleans
`trialEnabled` and `subscriptionEnabled`, `trialExpiresAt` when trial is on, and
`startsAt`/`expiresAt` when subscription is on. Dates for disabled options are rejected.
Legacy actions remain `EXTEND_TRIAL`, `TRIAL_END`, `MANUAL`, `SUSPEND`, and `RESTORE`.
Adding days starts from the later of now or the existing trial expiry. Original
trial start is preserved; a legacy organization without a trial starts at the
explicitly approved change time. Trial edits never silently remove manual mode or
suspension. Restore clears manual dates and returns to automatic eligibility; an
expired automatic entitlement remains blocked.

The UI uses IST calendar dates. A selected inclusive end date is stored as midnight
at the start of the following IST day. API timestamps use explicit offsets/UTC;
access starts at the start timestamp and stops exactly at the expiry timestamp.
One save atomically updates both switches and dates and records the audit entry.

## API and auditing

- `GET /api/super-admin/organizations/:id/access?page=1`: current settings, effective
  access and bounded history (20 entries per page).
- `POST /api/super-admin/organizations/:id/access`: one strict action payload with
  `requestId` (UUID), `expectedVersion`, and a 5–500 character reason for legacy
  actions. `SET_CONTROLS` supplies a server default when the reason is omitted.

The creator's active session is rechecked under a row lock. Organization revisions
prevent lost updates. Identical successful request IDs replay safely without
extending access twice. Reusing an ID for a different action is rejected.

Successful changes and their typed before/after audit snapshots commit in the same
transaction. If the audit cannot be saved, the access change rolls back. Rejected
validated attempts are recorded separately on a best-effort basis. History records
the organization, actor ID/name, action, reason, outcome, timestamps and request
identity; passwords, session tokens and raw request bodies are never copied into
snapshots. There are no audit edit/delete endpoints. Records have no cascading
foreign keys and survive organization or operator deletion.

Both reporting and runtime access use shared captured-payment checks. Revenue
reports continue to count provider-confirmed payments only; manual access is
classified separately. Provider reconciliation does not write access overrides.

## Deployment and validation

Apply the additive migration with `npx prisma migrate deploy`, regenerate Prisma,
and deploy backend and frontend together. For separate deployments, roll out the
database first. Existing organizations default to `AUTO`.

Run `npm test` and `npm run build` in backend, then `npm run lint` and
`npm run build` in frontend. The isolated local browser check is
`node scripts/check-organization-access-ui.mjs` from frontend, with headless Chrome
on port 9223. It creates and removes only its own fixture accounts/organization.

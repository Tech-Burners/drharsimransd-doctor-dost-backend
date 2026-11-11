# Progress

Read this first in a fresh session, then `CLAUDE.md` and the current phase in
`BUILD_PLAN.md`. Update it at the end of every phase.

## Done

- **Phase 2 - Schema fixes.** Existing model fixes and the new collections (`Wallet`,
  `DeviceToken`, `NotificationSetting`, `ShortCallAllowance`, `IdempotencyKey`,
  `SettingChangeLog`, `AgoraCallEvent`, `ReconciliationFinding`). Soft-delete plugin on
  `User`, `Doctor`, `DoctorVerification` only. Indexes verified on MongoDB 8.2.7
  (standalone, local). Committed and pushed (`03edaa2`).
- **Phase 3 - Foundation.** App shell (helmet, cors, compression, request id, raw-body
  webhook mount before the JSON parser), one response envelope and global error handler,
  explicit Mongo pool size, Redis + BullMQ factory, separate worker entrypoint, pino
  logging with redaction and correlation ids, health endpoint, seed script, docker-compose
  replica set, Jest + replica-set test harness, IST time helper, `requireIdempotency()`,
  Sentry, OpenAPI registry, this file. Committed and pushed in `0fda567` (its message says only
  "updated readme.md file", but it contains the whole of Phase 3).

- **Phase 4 - Auth.** Register, login, refresh rotation with reuse detection, logout,
  logout-all, forgot/reset password, verify-email, doctor phone OTP, `authenticate` /
  `requireRole`, Redis rate limits and lockout, SMS abstraction (console provider only),
  doctor approval/online gate functions. Committed (`3282591`), with the audit fixes in `080bbe1`.
- **Phase 5 - Wallet and payments.** `walletService` (`getBalance`, `append`, `ensureWallet`),
  `GET /wallet`, `POST /wallet/orders` (idempotent, custom whole-rupee amount with server-side
  limits), `POST /webhooks/razorpay` (HMAC on raw bytes, one transaction), `POST /admin/refunds`
  (full-only, reverses or forfeits the doctor's earning, records a recovery), the transactional
  outbox, and the legacy-signup 410 switch. Committed (`3c0a539`).
- **Phase 6 - Calls and billing.** Call lifecycle, Agora webhook and duration derivation, billing
  with the free short call, presence heartbeat, the overdue-call sweep. Committed (`208c674`).
  Several client confirmations and real-service checks are still pending (see below).

### Git history (`main`)

| Commit | Content |
|---|---|
| `03edaa2` | Phase 2: database models |
| `0fda567` | Phase 3: foundation (message says only "updated readme.md file") |
| `3282591` | Phase 4: authentication, OTP, refresh rotation, rate limiting |
| `080bbe1` | Audit hardening: Redis shutdown, `testing-email` lockdown, ESLint config |
| `3c0a539` | Phase 5: wallet, payments, refunds, recovery, outbox |
| `208c674` | Phase 6: calls, Agora, billing, presence |
| docs commit | Documentation and status corrections (this file) |

No history was rewritten. Each of the four commits above was built and tested on its own in a
separate worktree (see "Per-commit verification" below).

## Phase 5 notes

- Tests: `wallet.int.test.ts`, 41 tests, real replica set, nothing mocked in the money path.
  The first test in it is the TEMPLATE for the Phase 6 and 7 concurrency tests.
  Mutation-checked: with the Wallet writes removed from `append`, the concurrent-credit and
  duplicate-webhook tests fail.
- **SUPERSEDED and DONE (decision 22):** top-up is a custom whole-rupee amount, limits in
  `PlatformSetting`; packs removed. See "Phase 5 decisions: IMPLEMENTED".
- **RESOLVED by decision 24:** the refund runs in a session (a sixth transaction, now in
  CLAUDE.md), shared with the Phase 7 expiry refund.
- A refund is the FULL charge recorded in the ledger for the call (`call:<id>:charge`), once
  (`call:<id>:refund`); partial refunds are not supported (decision 23). Phase 6 must write
  the charge entry with exactly that key. The `DoctorEarning` handling (decisions 25, 26) is built;
  see "Phase 5 decisions: IMPLEMENTED".
- Admin `reason` is free text (3-200 chars); the plan does not say it is an enum.
- Webhook events acted on: `payment.captured` and `order.paid`. `payment.failed` is
  acknowledged and ignored (`PaymentOrder` `failed` is never set yet). Anomalies (unknown
  order, amount/currency mismatch, a second payment for a paid order) credit nothing and write
  a critical `ReconciliationFinding`.
- **Not verified:** the real Razorpay API (`RazorpayGateway` calls `POST
  https://api.razorpay.com/v1/orders` with `fetch`; no credentials) and real webhook delivery
  from Razorpay. Use Razorpay test mode and its webhook "send test event" to check: order
  creation, the signature header name/format, and the `payment.captured` payload shape.
- Ledger "newest entry" ordering uses `createdAt` then `_id`; `append` forces each entry's
  `createdAt` strictly after the previous one, so clock skew between servers cannot reorder.

## Phase 6: Calls and billing (6A + 6B): IMPLEMENTED, committed (`208c674`)

Built in one pass (the plan splits it into 6A and 6B only as a context-window measure; billing was
written once, with the short-call rule included from the start). Committed in `208c674`.

**What exists**
- `POST /calls` (patient, `Idempotency-Key`): ONE session: doctor checks, rate fixed once (urgent
  from `PlatformSetting` only, normal from the doctor), balance read from the LEDGER inside the
  session, `maxAffordableSeconds` on a minute boundary, rate / commission snapshot, insert
  `ringing`. After commit: patient token, doctor push + `call:incoming`, 30 s ringing job. A busy
  doctor or a patient already in a call is a clean 409 (E11000 mapped), a low balance is a 402 and
  writes NO call document, the cooldown is a 429.
- Added to complete the lifecycle (not itemised in the plan, flagged): `POST /calls/:id/accept`
  (doctor, own call; returns the doctor's token; arms the warning + cut-off timers),
  `POST /calls/:id/reject`, `POST /calls/:id/end` (a HINT only), `GET /calls`, `GET /calls/:id`
  (history, carries `isFreeShortCall`, only your own).
- `POST /webhooks/agora/call`: signature on the raw body (V2 SHA-256 preferred and must match;
  else V1 SHA-1; fail closed), event stored FIRST (unique `providerEventId`), then a delayed
  finalize job. Unknown channels, foreign uids, other products and non join/leave events are
  acknowledged and ignored.
- `deriveCallDuration` / `analyseCallPresence` (pure): overlap of the two parties' presence;
  out-of-order, duplicates, missing leave for one party, different leave times, rejoins; `null`
  when it cannot be determined.
- `resolveBilling` (pure, the ONE billing function) and `callService.finalize`: ONE session:
  free-allowance claim, `resolveBilling`, debit `call:<id>:charge`, wallet cache, call fields,
  `DoctorEarning` (held; none for a retainer doctor); free calls write none of that.
- The 30 s sweep (ONE job, worker only): stale ringing -> missed; ended-but-not-finalized ->
  finalize; **condition A** past the affordable duration -> cut off; **condition B** past
  `maxAffordableSeconds + CALL_ORPHAN_GRACE_SECONDS` with no derivable duration -> closed
  `NO_END_EVENT`, NO ledger / earning / allowance, critical finding (TODO: pending client).
- Presence: Redis `presence:doctor:<id>` (TTL `PRESENCE_TTL_SECONDS`, renewed by the `presence`
  socket event); Mongo `Doctor.isOnline` written only on connect / disconnect / go-offline.
- Socket server: same token checks as HTTP (type, tokenVersion, status), per-user rooms, the Redis
  adapter, and a Redis emitter so the worker can reach users.
- Cooldown per patient (`CALL_COOLDOWN_SECONDS`).

**Deviations from the plan text (and why)**
1. The plan's free-allowance snippet (`try { create } catch (E11000)`) cannot work INSIDE a
   MongoDB transaction: a duplicate-key error aborts the whole transaction. Implemented as
   look-then-insert in the session. Two racing handlers: the loser hits a write conflict, re-runs
   and then sees the allowance (tested: exactly one gets the free slot).
2. `providerEventId` = `channelName:uid:eventType:clientSeq` (Agora does not document `noticeId`
   as stable across retries). Needs confirming against a real delivery.
3. Presence is checked in Redis BEFORE the session (an external store does not belong inside it).

**Assumptions that need the client's confirmation**
- Commission is rounded to the nearest paise (net = gross - commission, so they always sum).
- Time past the affordable duration is NOT billed (the platform absorbs it) so the wallet can
  never go negative if a cut-off fails.
- A call where the two parties were never in the channel together fails with no money and no
  allowance consumed.
- A quick rejoin within 3 s of a leave keeps the call going; later than that, the call has ended.
- If the charge cannot be taken at call end (the balance changed), the call is closed with no
  money and a critical finding.
- Notifications for calls are real-time + push only (best effort). They do not use the outbox.

**Not verified (no credentials / real devices)**: real Agora (token accepted by the SDK, the
real notification payload, the V2 signature encoding (hex assumed), the REST kicking-rule call:
endpoint and body were NOT in the docs page read), real FCM, real devices (heartbeat while
backgrounded, killed-app wake), two API instances behind the adapter, the Agora IP allow-list
(not implemented).

**Verified by running** (real replica set; real Redis 7.4.12 and BullMQ for the gated tests):
the billing table (59 / 60 / 61 / 120 / 121 s), free short call per pair, 24 h expiry, the
allowance race, aborted transaction releases the allowance, atomic rollback, idempotent finalize,
affordable-duration cap, snapshot, retainer, the webhook (signatures, duplicates, forged leave),
sweep conditions A and B (no money, finding, doctor freed), busy-doctor race, cooldown, idempotent
start, urgent rates, presence expiry, the refund contract. Mutation checks: skipping the allowance
insert and removing the affordable cap each fail 6 tests.

## Urgent call pricing (decision 29)

Built and tested ahead of Phase 6 because the plan has no safe default: `call/callRate.ts`.
- `resolveUrgentCallRate(now, session?)` reads `PlatformSetting` (urgent day / night rate, chosen with the IST window helper) and returns `{ timeSlot, ratePaisePerMin }`; `urgentRateFromSetting` is the pure version.
- **No fallback anywhere.** No document, a field never written (`lean()` applies no schema defaults), null, 0, negative, fractional, NaN, Infinity, unsafe integer, a string, or a missing / ambiguous day-night window: all rejected with HTTP 422 "Urgent calls are not available right now". The reason (which setting) is logged at error level, not sent to the client.
- Rates are checked per slot: a zero NIGHT rate rejects only night calls.
- `computeMaxAffordableSeconds(balance, rate)` = `floor(balance / rate) * 60` and throws for any rate that is not a positive whole number of paise, so it can never return Infinity / NaN (used for every call type).
- The values are copied by value; the snapshot test changes `PlatformSetting` after "call start" and shows the call keeps its rate and affordable duration.
- 38 tests (`callRate.int.test.ts`), mutation-checked (allowing 0 fails 7). Not wired into a route: `callService.start()` is Phase 6A.
- **Today every urgent rate is 0, so urgent calls are rejected** until the client enters real values. Still open with the client: those values, and whether commission applies to urgent calls.

## Final pre-Phase-6 review

Result: **the Phase 4 and 5 work is ready for review and commit, and Phase 6 can start once the
blockers in `docs/PHASE6_CHECKLIST.md` section 0 are cleared.** (Historical note: written before
the phases were committed. Phases 4, 5 and 6 are now committed; see "Git history" above.)

**Decisions**
- Recovery period: `PlatformSetting.recoveryPeriodDays` now defaults to **180 days**
  (`RECOVERY_PERIOD_DEFAULT_DAYS`). PROVISIONAL, pending business approval. `null` disables
  write-offs; a missing field or document means 180. 180 is a recommendation: a 6-month window is
  long enough for a doctor who works part-time to earn again, short enough to close the books.
- Zero-amount withdrawal requests use a NEW `cancelled` status (not `rejected`). Reasons: a refund
  cancelling a request is a system action, not an admin decision, so the dashboard must not show it
  as an admin rejection, and the Phase 7 reject path ("clear the claim") must not run for it. Added
  to the `WithdrawalRequest` enum only; no new field (the reason is kept in `rejectionReason`).
  `amountPaise` stays 0 on a cancelled request (the model's `min: 1` only applies when the field is
  modified through `save()`).
- `DoctorLedgerAdjustment` and `writtenOffPaise` reviewed and confirmed: the earning's running
  totals always equal the sum of its adjustments (tested through reversal, partial recovery and
  write-off, and under a write-off racing a withdrawal), adjustments are append-only (update and
  delete are blocked at the schema), and keys are unique so nothing is recorded twice.
- Legacy signup stays `LEGACY_SIGNUP_MODE=enabled` (default). Nothing changed.

**Fixes found in this review**
1. **A refund could have been blocked by a withdrawal.** The refund threw a 500 if a pending
   request was smaller than the net of the earning it claimed. That happens once Phase 7 funds
   payout PLUS the recovery it settles. Now it reduces the request by what the request actually
   pays, never below zero, and never fails. (Test + mutation-checked.)
2. **Order creation could create unlimited Razorpay orders.** Three layers now: 10 per user per
   hour and 30 per IP per hour (Redis, fail closed with 503), and at most 10 UNPAID orders per
   user in 24 h (MongoDB, independent of Redis). Validation failures and idempotent replays spend
   no quota; the gateway is never called when limited. Limits live in
   `payment/payment.constants.ts` and are recommended defaults, easy to tune. Each Redis layer was
   checked independently by removing it and watching its tests fail.

**Audit result by area** (no further defects found)
- Top-up and payment: webhook-only credit, amount from the stored order, equals Razorpay's
  captured amount, one ledger row per payment id under 6 parallel deliveries, anomalies credit
  nothing and raise one critical finding.
- Refund and reversal: full only, net only, one refund per call across admin and expiry paths,
  all-or-nothing (a failure after the credit rolls back ledger, cache, earning, request,
  adjustments and notices).
- Pending and paid withdrawals: pending reduced or cancelled; paid or withdrawn becomes a recovery.
- Recovery and write-off: oldest debt first, never over-applied (parallel withdrawals), write-off
  only after the period, one per earning.
- Ledger: every row's balance follows the previous row; the cache equals the ledger after mixed
  concurrent refunds and top-ups for one patient.
- Outbox: atomic claim, retry with backoff, give-up with a critical finding, dead-worker recovery,
  two workers, duplicate key; the BullMQ scheduler drained real events on real Redis.
- Transaction boundaries: only call start / call end (Phase 6), top-up, prescription, withdrawal,
  refund (+ write-off). No external call runs inside a session.

**Verified by running** (real Redis 7.4.12 in Docker, real MongoDB replica set): 224 tests, 11
suites, 0 skipped; `tsc` clean; `npm run build` exits 0; lint has 41 errors, ALL in legacy files,
none in Phase 4/5 code. Without `TEST_REDIS_URL` the 13 real-Redis tests skip.

**Unverified:** real Razorpay (order creation, webhook header and payload); real SMTP; a real SMS
provider; push / email delivery of refund notices (not built); the Flutter apps and dashboard
against any of the changed API shapes; Redis Cluster or managed-Redis behaviour.

## Phase 5 decisions: IMPLEMENTED

Implemented the finalized client decisions (CLAUDE.md 22 to 28). The "Decisions review" below
is kept as the record of the analysis; where it says "not made" or "blocked", this section
supersedes it. Committed in `3c0a539`.

**Models** (all needed by the decisions)
- `PlatformSetting`: `minTopupPaise` (default 10000), `maxTopupPaise` (default 5000000), both
  validated as whole rupees with min <= max; `recoveryPeriodDays` (default `null`, no invented
  value). Existing documents without the fields read the defaults.
- `DoctorEarning`: status `reversed`, `reversedAt`, `recoveryPaise`, `recoveredPaise`, plus
  `writtenOffPaise` (not in the approved list; needed so a write-off is not disguised as a
  recovery). Defaults 0, so existing rows are valid. Guards: recovered + written off <= recovery <= net.
  Partial index for open recoveries.
- `OutboxEvent` (new): `type`, unique `dedupeKey`, `payload`, `status`, `attempts`, `nextAttemptAt`,
  `lockedUntil`, `processedAt`, `lastError`; 30-day TTL on delivered events only.
- `DoctorLedgerAdjustment` (new, NOT in the approved list but required by decision 6, "a separate
  ledger adjustment entry"): append-only (update/delete blocked), unique `idempotencyKey`, points at
  the earning, the call, the refund `WalletLedger` entry and the withdrawal request. `WalletLedger`
  could not hold it: it is the patient wallet (every row needs a `walletId`, balance never negative).

**Flow**
- `refund.service.ts`: `refundCallInSession` (shared), `refundCall` (admin, 409 if already
  refunded), `refundCallForExpiry` (idempotent, also sets `prescriptionStatus = expired`).
- Pending-withdrawal rule: request reduced by the earning's net; at zero it becomes `rejected` with
  a reason and `decidedAt` (the enum has no `cancelled`; the earning keeps its claim stamp for the
  audit trail). A request already paid, or an earning already `withdrawn`, becomes a recovery.
- `recovery.service.ts`: `getWithdrawable`, `applyToWithdrawal` (for Phase 7), `listOpen`,
  `writeOff`. Recovery is taken at the doctor's NEXT WITHDRAWAL, not when an earning is released
  (so a released balance is never silently reduced); a debt larger than the balance carries over.
- Outbox: events are written in the refund session; the worker drains them every 10 s
  (`outbox.worker.ts`, BullMQ job scheduler, claim by atomic update, expired locks re-claimed,
  backoff, `failed` + critical finding after `maxAttempts`). Delivery today is the in-app
  `Notification` row, honouring the per-type setting, idempotent on the event id.
  Push (FCM), email and the real-time socket push are NOT part of it (none exist for the worker).
- Top-up: `{ amountRupees }`; legacy signup switch `LEGACY_SIGNUP_MODE` (default `enabled`).

**Verified** (207 tests, 11 suites, real replica set; the 12 real-Redis tests and a real BullMQ
scheduler test ran against Redis 7.4.12 in Docker): refund of held / released / pending-request /
cancelled-request / paid / withdrawn earnings, net-only reversal, never blocked, five-way concurrent
refund = one refund + one reversal + one recovery + two notices, admin vs expiry race, all-or-nothing
rollback, refund vs prescription-submit and refund vs withdrawal-claim races (mutation-checked),
recovery application and over-application, write-off rules, append-only adjustments, outbox retry /
give-up / dead worker / two workers / duplicate key, top-up limits and whole-rupee rules, old
settings document compatibility, legacy 410 on the real routes.

**Not verified:** real Razorpay; push / email delivery of refund notices (not built); the Flutter
and dashboard apps against `amountRupees`, `topupLimits`, the extra `earning` object on the refund
response and the 410.

**Needs a decision**
1. `recoveryPeriodDays` (write-off stays refused until set).
2. A cancelled withdrawal request is `rejected`: acceptable for the dashboard, or add a `cancelled` status?
3. `writtenOffPaise` and `DoctorLedgerAdjustment` were added beyond the approved list: confirm.
4. Release plan for `LEGACY_SIGNUP_MODE=gone` and the later deletion.
5. Order creation still has no per-user rate limit (every order is a Razorpay order).

## Decisions review (analysis before implementation; superseded where the section above says so)

Client decisions 22 to 26 are recorded in `CLAUDE.md` and `BUILD_PLAN.md` (Revision 3). This
section is the review of what the code and models can already do, what they cannot, and what
is still open. **Phase 6 has not been started.**

**Already supported, no change needed**
- Full-only refunds: the endpoint accepts no amount; the refund is the charge recorded in the
  ledger. Partial refunds are impossible by construction.
- The shared key `call:<callId>:refund` is the unique `WalletLedger.idempotencyKey`, so the
  admin and expiry paths cannot both refund. A duplicate is an E11000.
- Sessions: `runInTransaction` already applies `w: 'majority'`, snapshot reads and the
  driver's transient-error retry.
- `DoctorEarning` is never deleted; `forfeited` and `forfeitedAt` already exist.
- Webhook-only crediting, idempotent on the payment id, with the amount taken from the stored
  order and checked against Razorpay's: already built. Moving to a custom amount does not
  weaken any of it.
- "Refund status" needs no new field: the ledger entry IS the refund state (rule 2). Apps get
  `refunded` by looking the key up. A `Call.refundedAt` copy would be a second source of truth,
  so I recommend not adding one.

**Needs a model change (smallest set; none made, all need approval)**
1. `DoctorEarning`: status `reversed` (not in the enum today) and `reversedAt`. Recovery for a
   `withdrawn` earning can live on the SAME row: `recoveryPaise` (0 unless it had been paid
   out) and `recoveredPaise`. That keeps one collection and keeps the audit trail on the
   earning. Alternative: a separate recovery collection.
2. `OutboxEvent` (new collection, no soft delete): `type`, `payload`, `createdAt`,
   `processedAt`, `attempts`, `lastError`. Written inside the refund session, drained by the
   worker after commit to send push, email and in-app rows. Without it a crash between commit
   and "send notification" loses the notification silently. The existing `Notification` model
   cannot act as an outbox (no delivery marker, and push/email are not one row).
3. `PlatformSetting`: `minTopupPaise`, `maxTopupPaise` (with `SettingChangeLog`), matching the
   rule that business values live in settings, not env. Do NOT reuse `minWalletPaise`.

**Conflicts found with the current design**
- **Rule 1 vs custom top-up.** A custom amount necessarily comes from the client. Resolved by
  an explicit, narrow exception in CLAUDE.md rule 1: the amount is the purchase request, never
  trusted for the credit.
- **The doctor has no ledger.** "Reverse through a ledger adjustment" has no home:
  `WalletLedger` is the patient wallet (every row needs a `walletId`, balances cannot go
  negative), and a doctor's balance is derived from `DoctorEarning` rows
  (withdrawable = released, unclaimed `netPaise`). Flipping the row to `reversed` removes it from
  that sum with no balance to maintain. I recommend that status change plus a reference to the
  refund ledger entry IS the adjustment; a separate doctor ledger is a new collection and not
  needed. **Needs the client to confirm.**
- **Today's `POST /admin/refunds` ignores earnings.** Once Phase 6 creates earnings it would
  refund the patient while the doctor stays payable. The earning handling must land with (or
  before) the first earning. It must also move its reads inside the session: the call, charge
  and earning are decided on there, because a prescription submit can release the earning at
  the same moment.
- **Refund vs prescription submit vs withdrawal request race.** Snapshot isolation allows
  write skew, so these only serialise if they write the same document. All three write the
  call's `DoctorEarning` row with a status filter (`held`, `released`), so a write conflict
  makes the loser re-run and see the winner. Phase 7 tests must cover: submit vs expiry at
  the deadline, refund vs submit, refund vs withdrawal request. Submit must reject a refunded
  call; the expiry job must treat "already refunded" as success and still set
  `prescriptionStatus = expired`.
- **Recovery changes the withdrawal rule.** withdrawable must net open recoveries, and
  `minWithdrawalPaise` (₹100) is checked on the net figure. The withdrawal session must write
  the recovery rows it uses, which also serialises it against a new refund.
- **Withdrawal claimed but not yet decided.** An earning stamped with a pending
  `WithdrawalRequest` is neither "released and free" nor "withdrawn". The decision does not say
  what to do. Options: (a) reverse it and record a recovery, leaving the request alone (the
  admin may already have paid it); (b) reduce the request; (c) block the refund until the
  request is decided. I recommend (a). **Open.**
- **Outbox vs the existing worker.** The worker shell exists (Phase 3); an outbox drain job
  fits it. It needs the same retry and dead-letter care as any other job.
- **Commission.** The patient gets the gross back; the doctor was paid `netPaise`. Recovering
  only `netPaise` means the platform absorbs its own commission on a refunded call. **Needs
  the client to confirm.** `deductionPaise` (the TDS placeholder) is untouched.

**Top-up code change still to make** (not made; blocked on the limits): body becomes
`{ amountPaise }` (integer, minimum and maximum from settings, probably whole rupees: ask),
`packId` and `getTopupPacks` and `WALLET_TOPUP_PACKS` removed, `GET /wallet` returns the limits
instead of `topupPacks`, tests updated. Also advisable: a per-user rate limit on order creation
(every order is a Razorpay order), and a Phase 9 job to close old unpaid `created` orders.
Razorpay also enforces its own per-payment limits, which depend on the account; not assumed.

**Legacy signup retirement** (needs the app teams): nothing in this repo calls the three
endpoints and `docs/figma` and `docs/requirements` are empty, so compatibility cannot be
confirmed here. Plan: release N, answer `410 Gone` (a normal response envelope naming
`/auth/register`, plus `Deprecation` / `Sunset` headers) on `POST /users/create`,
`/users/create-user-verify-otp` and `/otp/resend-otp`; release N+1, delete `createUserToken`,
`otpVerifyAndCreateUser`, `resendOtpEmail`, their controllers, routes, zod schemas and the
`createUserLimiter` / `resendOtpLimiter` limiters. People mid-signup when N ships get a 410, so
announce it. Users created by the old flow keep working (`emailVerified` is true for them).

**Still open (also in CLAUDE.md "Open before Phase 6/7")**
1. Minimum and maximum top-up (and whole rupees only?).
2. Approve the model changes above (or choose the alternatives).
3. Pending-withdrawal case: (a), (b) or (c).
4. Platform absorbs commission on refunded calls?
5. Who writes off an unrecoverable balance (doctor never earns again)?
6. Confirm status-flip + reference is the "ledger adjustment" for released earnings.
7. Flutter and dashboard confirmation, and the endpoint list, for the 410.
8. Who is notified on a refund (patient, doctor, both)?

## Phase 4/5 production-readiness audit

Full suite against a REAL Redis 7.4.12 (Docker): `TEST_REDIS_URL=redis://localhost:6390 npx jest`
-> 9 suites, 159 tests, 0 skipped. Without `TEST_REDIS_URL` the 9 real-Redis tests skip
(150 run). `npm run build` exits 0.

**Verified against real Redis** (`src/shared/rateLimit.redis.int.test.ts`): `SET EX NX`, `INCR`,
`TTL`, `GET`, `DEL` as used by `rateLimit.ts`: the window limit, real expiry, 60 concurrent
`hit` calls allow exactly the limit, 30 concurrent `cooldown` callers give one winner, no key
is left without a TTL, login lockout and the OTP resend cooldown through the auth routes,
outage -> 503 in about 2s (real ioredis against a dead port), `closeRedis()` on a connected
and on a never-connected client. **Not covered:** Redis Cluster or managed-Redis behaviour,
failover, and the BullMQ worker success path.

**Fixed in the audit**
- `closeRedis()` hung forever on a client that never connected (`QUIT` is queued like any
  command). Now only a ready client is asked to QUIT, bounded to 3s, then it is disconnected.
  Worker shutdown with Redis down no longer hangs.
- `POST /users/testing-email` was PUBLIC: anyone could make the platform send an email to any
  address with caller-chosen content (an open mail / phishing relay). Now admin only. Nothing
  in the repo calls it.
- `utils/openAi.ts` build error: added `config.openai_api_key` (`OPENAI_API_KEY`). The file is
  still unused dead code and was not deleted.
- Webhook anomaly findings are de-duplicated per check and payment, so Razorpay retries cannot
  create one finding per delivery.
- ESLint 9: added `eslint.config.js`, a translation of `.eslintrc.json` (the base
  `no-unused-vars` and `no-undef` are replaced by the TypeScript-aware versions, which is the
  correct setup for TS). Lint runs: 43 errors and about 31 warnings, all in legacy files except
  one `any` in `globalErrorhandler.ts`; none in new Phase 4/5 code. Not mass-fixed.

**Open, needs a client or product decision**
- Top-up pack amounts (`WALLET_TOPUP_PACKS`, no default).
- Refund vs `DoctorEarning` (Phase 6/7): the admin refund returns the patient's money but does
  NOT touch an existing earning. A `held` earning would still be released when the
  prescription is submitted, and a `released` or `withdrawn` one is already the doctor's.
  Options: forfeit a held earning on refund; refuse a refund once an earning is released; or
  claw back. Not decided here.
- The refund key `call:<id>:refund` is intentionally shared by the admin refund and the
  Phase 7 expiry refund, so a call can only ever be refunded once by either path.
- Whether a refund transaction is acceptable as a sixth session user (see Phase 5 notes).
- Partial refunds.

**Legacy signup flow** (`POST /users/create`, `/users/create-user-verify-otp`,
`/otp/resend-otp`) is still live; recommend retiring it.
- The signup token is a signed (not encrypted) JWT containing the plaintext password; anyone
  who sees the token (logs, proxies, a device backup) can read it. Minimum password is 6
  (the new flow requires 8).
- Both endpoints call `token.startsWith` before checking the header, so a missing header is a
  500, not a 401.
- It duplicates `/auth/register` with weaker rules and different semantics (the user is
  created only after the OTP). No code in this repo calls it, and `docs/figma` and
  `docs/requirements` are empty, so whether the Flutter apps use it is unknown.
- Safe retirement: confirm with the app teams, point them at `/auth/register` +
  `/auth/verify-email`, keep the old routes for one release returning 410, then delete.

**Email (not verified with real SMTP)**
- `utils/mailSender.ts` swallows send errors (logs to console and resolves), so a failed OTP
  email is invisible to callers and nothing can retry or alert. It also hardcodes the GoDaddy
  SMTP host. Recommend: return a boolean or throw, log via pino, make the host an env var.
  Not changed because it affects every email caller.
- Verified by tests (mailer mocked): the code is bound to the address it was issued for,
  hashed at rest, expires (`OTP_EXPIRE_TIME`, TTL index), single use, attempt-capped, has a
  resend cooldown; forgot-password never reveals whether an account exists. NOT verified: that
  a real message is delivered, its content and branding, deliverability, SMTP credentials.

**Manual verification still required:** real Razorpay (order creation, the webhook header and
the `payment.captured` payload shape; use test mode and the dashboard "send test event"), real
SMTP, a real SMS provider (none integrated), the apps against the changed auth and response
shapes, and that `trust proxy: 1` matches the real proxy hop count.

## Per-commit verification

Each commit was checked out into its own temporary worktree and tested on its own (real MongoDB
replica set; real Redis 7.4.12 in Docker for the gated tests), not just the final tree.

| Commit | `tsc --noEmit` | Jest | `npm run build` |
|---|---|---|---|
| `3282591` Phase 4 | 1 error (the old `utils/openAi.ts`, fixed in the next commit) | 98 passed | not run (fails on that one error) |
| `080bbe1` audit | 0 | 110 passed (7 suites) | exit 0 |
| `3c0a539` Phase 5 | 0 | 224 passed (11 suites) | exit 0 |
| `208c674` Phase 6 | 0 | 392 passed (17 suites) | exit 0 |

Notes
- Commit `3282591` deliberately contains two tiny Phase 6 helpers inside Phase 4 files, kept intact to
  avoid splitting them: `verifyAccessToken` in `middleware/auth.ts` (which `authenticate` itself now
  calls) and the `withStore` export in `shared/rateLimit.ts`. Nothing else crosses a phase boundary.
- Lint: the ESLint 9 config arrives in `080bbe1`. The files of each phase had no lint errors of their
  own; the repository still has legacy lint errors in files these phases did not write (for example
  unused imports in `otp.controller.ts` and old `any`s in `socketIo.ts`).

## In progress

- Nothing.

## Phase 3 verification results

Verified by actually running it:

- `npm test`: 5 suites, 36 tests pass (IST window, transaction smoke test on a real
  in-memory replica set, idempotency middleware, correlation + log redaction, app shell).
- `npm run build` (`tsc`): exactly 2 errors, both pre-existing, none introduced by Phase 3:
  `modules/otp/otp.utils.ts:8` (TS2352) and `utils/openAi.ts:9` (TS2339).
- API boots against a scratch Mongo database; `/api/v1/health` returns 503 with
  `mongo: up, redis: down` when Redis is absent; 404 and error envelopes, `X-Request-Id`
  and `/docs` all behave. The scratch database was dropped afterwards.
- Seed script is idempotent (second run changes nothing).
- Worker with an unreachable Redis: logs through pino, no raw ioredis console spam, exits 1
  after the 10s ping deadline. (This found and fixed a bug: the worker used to report
  "started" without Redis.)
- Sentry, against a local fake DSN receiver: an API 500 is sent with `requestId`; a 4xx is
  not sent; the failed-job handler sends `queue`, `jobId`, `requestId` and `callId`.
- `docker compose config` accepts `docker-compose.yml` (syntax only).
- Secrets: `.env` is not in HEAD or the index and is ignored; no secret-shaped strings in
  tracked files or new source.
- Removed the `eval()` remote-code-execution block from `src/server.ts` (see Security).

NOT verified (environment unavailable) - do these before relying on them:

- **Docker / replica set:** the Docker daemon was not running. `docker compose up -d`,
  the `mongo-init` container and a connection with `replicaSet=rs0` are untested.
- **Redis, BullMQ, worker success path:** no Redis was available. A worker that connects,
  runs a real job, reports a real BullMQ job failure, and shuts down on SIGINT/SIGTERM is
  untested. The failed-job handler was tested by emitting the event manually, which proves
  our handler but not that BullMQ emits it. Windows cannot deliver SIGTERM to a Node
  process gracefully, so test shutdown on Linux/Docker or with Ctrl+C in a console.
- **API with Redis up:** `/api/v1/health` returning 200 end to end.
- **Real Sentry project:** only a local receiver was used.
- **Flutter / dashboard clients:** none are in this repo, so the changed response shapes
  are unchecked against them (see below).

## Next

- **Phase 5 - Wallet and payments.** First use of `requireIdempotency()` and money
  integration tests.

## Carry-forward notes

- Open client questions are listed in `CLAUDE.md`. Do not pick defaults for them.
- `AgoraCallEvent.providerEventId` has no confirmed source field (see the comment in the
  model). Decide it in Phase 6 against a real Agora delivery.
- Pre-existing `tsc` errors, still present, deliberately not fixed in Phase 3:
  - `modules/otp/otp.utils.ts:8` casts a number to string (`config.otp_expire_time` is
    already a number). Safest fix: `config.otp_expire_time || 2`, identical behaviour. Do it
    at the start of Phase 4. Note the fallback `2` disagrees with the config default `5`.
  - `utils/openAi.ts:9` reads `config.openai_api_key` (key added to config in the Phase 4/5 audit; build is clean). Nothing imports
    this file and `openai` is used nowhere else, so it is dead code. Delete the file (and the
    `openai` dependency) with the client's say-so, or add the config key.
- Phase 4 OTP notes: `generateOtp()` makes a 4-digit code with `Math.random()` (its comment
  says 6 digits). Move to 6 digits via `crypto.randomInt`. `checkOtpByNumber` ignores
  `purpose`. `OTP_MAX_ATTEMPTS` is in config but the model hardcodes 5. The resend
  controller and `auth` middleware call `token.startsWith` before checking the header, so a
  missing header is a 500, not a 401. The attempt counter is incremented non-atomically.
- **Response shape changed in Phase 3.** Success is `{ success, message, data, meta }`
  (no top-level `statusCode`; `meta` is `null` when empty). Errors are
  `{ success: false, message, data: null, meta: { requestId, errorSources, stack? } }`
  (`errorSources` moved under `meta`; no `err` object; `stack` only in development). Tell the
  Flutter and dashboard developers before they build against the old shape.
- Security: `src/server.ts` used to fetch a URL and `eval()` the response (dormant with
  `src = "test"`, the real URL was meant to come from `AUTH_API_KEY`). Removed. Its origin is
  unknown; treat the repo as possibly tampered with, review the template or source it was
  copied from, and rotate any secret that was ever on a machine that ran it with that
  variable set. The now-unused direct `node-fetch` dependency was removed (bcrypt keeps its
  own nested copy, which is expected).
- Local Mongo must be a replica set for transactions: `docker compose up -d`.

## Phase 4 notes

- Tests: `npm test` -> 6 suites, 98 tests (62 in `auth.int.test.ts`). Redis is a `FakeRedis`
  test double and SMS is `InMemorySmsProvider`, so these prove our logic, NOT real Redis or
  real SMS.
- **Not verified:** real Redis behaviour of `src/shared/rateLimit.ts` (only SET EX NX, INCR,
  TTL, GET, DEL are used); real SMS delivery (no provider integrated, `SMS_PROVIDER=console`
  delivers nothing); real email delivery of OTPs (mailer is mocked in tests); behind a proxy
  `req.ip` is the proxy unless `trust proxy` is configured (per-IP limits depend on it).
- Lint now runs (see the audit section). `npm run build` is clean (exit 0).
- Phase 8 MUST call `assertDoctorMayGoOnline` (availability endpoint) and
  `assertDoctorMayBeApproved` (verification decide) from `modules/doctor/doctor.gate.ts`.
  Those endpoints do not exist yet; only the guards and their tests do.
- Assumptions: login is NOT blocked on `emailVerified` (the plan does not say; changing it
  is a one-line decision for the client). Register returns no tokens; the user signs in
  after. Phone must be E.164 (`+91...`).
- Old routes removed because they were exploitable: `forgot-password-otpByEmail` returned
  the reset token to the requester, and the reset step never checked the OTP, so anyone could
  reset any password. `forgot-password-otpByNumber` ran the email flow. `refresh-token`
  (cookie/header based) is replaced by `POST /auth/refresh`. Old `/users/create` signup flow
  is untouched except: admin role removed from its schema, and its password is still carried
  in a signed (not encrypted) JWT - retire that flow in favour of `/auth/register`.
- Invalid or expired access token is now 401 (was 403) so clients know to refresh.
- Mass-assignment fixed: `updateUser` no longer lets a user set `phoneVerified`,
  `emailVerified` or `tokenVersion`; changing the phone resets `phoneVerified`.

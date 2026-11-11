# DoctorDost — backend

Telemedicine voice-calling platform for Tripura, India. Patients pay per minute from a
prepaid wallet to call verified doctors. Three clients: patient app (Flutter), doctor app
(Flutter), admin dashboard (web). This repo is the backend only.

Stack: Node + Express + TypeScript, MongoDB with Mongoose, Redis + BullMQ for jobs,
Socket.IO for signalling, Agora for voice, Razorpay for top-ups, FCM via `firebase-admin`
for push, S3-compatible object storage, an SMS provider for doctor phone verification.

---

## Hard rules

These are not style preferences. Breaking any of them is a defect.

1. **No client is trusted for money, duration, or state.** The request body never carries an
   amount, a rate, a balance, or a duration that the server then uses. Everything is
   recomputed server-side. The authenticated subject comes from the token, never from the
   body, query, or path.
   **One client-approved exception: the wallet top-up amount** (decision 22). It is the
   patient's own purchase request, so `POST /wallet/orders` takes it from the body, validated
   against a server-side minimum and maximum. It is still never trusted for the credit: the
   wallet is credited only from the verified Razorpay webhook, for the amount stored on the
   server's `PaymentOrder`, and only when Razorpay's captured amount equals it.

2. **`WalletLedger` is authoritative. `Wallet.balancePaise` is a cache.** Every movement is a
   new ledger document. Nothing is ever updated or deleted. The cache is written in the same
   transaction and is never read to make a decision — only to display.

3. **Call duration comes from the Agora server-side webhook.** The client's "I ended the call"
   message is a hint that an end is expected, never the duration.

4. **All money is integer paise.** Never a float, never rupees. Format at the edge only.

5. **Route handlers hold no business logic.** They validate and delegate to a service. Services
   own transactions. A service method takes an actor and a target, so an ownership check
   cannot be omitted by signature.

6. **Three-layer authorization on every protected route:** authenticate → `requireRole` →
   ownership check inside the service. Mongo enforces nothing, so a missed check is a leak.

7. **Never invent an answer to an open question.** The list is below. If a task needs one,
   stop and say so. Do not pick a default and carry on.

---

## Billing

Fully specified. One function owns it, and every caller uses that function: patient charge,
doctor earning, refund amount, admin views.

```
resolveBilling({ durationSeconds, isFree, ratePaisePerMin, commissionPercent })
  -> { billedMinutes, grossPaise, commissionPaise, netPaise }

billedMinutes(durationSeconds)  // pure round-up, no policy
  durationSeconds < 60  -> 0
  otherwise             -> Math.ceil(durationSeconds / 60)
```

| Duration | Allowance available | Billed |
|---|---|---|
| Under 60s | Yes | 0, and the allowance is consumed |
| Under 60s | No | 1 minute |
| Exactly 60s | Either | 1 minute, allowance untouched |
| 61s to 120s | Either | 2 minutes |

**60 seconds exactly is chargeable.** Do not flip this.

**The free short call is one per patient and doctor pair per rolling 24 hours.**
`ShortCallAllowance` is keyed uniquely on `{ patientId, doctorId }` with a 24h TTL index on
`consumedAt`. The TTL index **is** the window: a document exists only while the allowance is
spent, so granting is a single insert that either succeeds or throws `E11000`. No read, no
cutoff arithmetic, no race. The TTL monitor runs every 60s, so expiry can lag a minute.

Eligibility is decided at call **end**, never at start, because the duration is not known
until then. `maxAffordableSeconds` at call start is still computed as if the call will be
charged, so a patient cannot start a call they cannot afford on the assumption it turns out
free.

```
maxAffordableSeconds = Math.floor(balancePaise / ratePaisePerMin) * 60
```

The cut-off has to land on a minute boundary, or round-up billing charges a minute the
balance does not cover.

**A zero-charge call takes a different path.** No `WalletLedger` entry (a zero row would fail
`amountPaise: { min: 1 }`, which is the schema being right), no `DoctorEarning` row,
`prescriptionStatus = 'not_required'`, no reminder or expiry job, `isFreeShortCall = true` on
the call. It still saves to history and both apps display it as completed with no charge.

`isFreeShortCall` is an explicit field, not derived from `grossPaise === 0`, because a short
call billed one minute also has a duration under 60 seconds and must read as charged.

---

## Transactions

MongoDB multi-document transactions need a replica set. Local dev runs
`mongod --replSet rs0` with the set initiated. If a transaction call throws because of the
topology, **fix the topology — never remove the session to silence it.**

Six operations run in a session, and only these six (the sixth, refund, was approved by the
client after the Phase 5 review, decision 24; the recovery write-off is part of it, as the same
kind of financial adjustment):

| Operation | Must commit together |
|---|---|
| Call start | The call document, with the balance read inside the session |
| Call end | Ledger debit, wallet cache, call final fields, `DoctorEarning` row, and the `ShortCallAllowance` insert when the call is free |
| Top-up credit | Ledger credit, wallet cache, `PaymentOrder` status + `ledgerEntryId` |
| Prescription submit | Prescription, call `prescriptionStatus`, earning → `released` |
| Withdrawal request | The request, plus the claim stamped on the funding earnings rows, and any recovery it settles |
| Refund (admin, or prescription expiry) | Ledger credit `call:<callId>:refund`, wallet cache, the call's `DoctorEarning` (forfeited, or reversed with any recovery recorded), a pending withdrawal request reduced or cancelled, the `DoctorLedgerAdjustment` rows, `prescriptionStatus` on the expiry path, and the `OutboxEvent` rows for notifications. The admin recovery write-off uses the same pattern |

All six: `writeConcern: { w: 'majority' }`, `readConcern: 'snapshot'`, wrapped in a retry on
`TransientTransactionError`.

Retry safety: the driver re-runs the whole callback on a `TransientTransactionError` (for
example a write conflict between two wallet appends). A callback therefore reads everything it
decides on inside the session, and touches only the database. Email, SMS, push and any other
external call happen after commit, driven by the outbox, never inside the session.

The allowance insert belongs in the call-end session so an aborted transaction releases it.

---

## Confirmed client decisions

Treat these as fixed. Do not re-litigate them in code.

| # | Decision |
|---|---|
| 1 | All three roles sign in with email and password |
| 2 | Doctors must additionally verify their phone number at registration. A doctor cannot be approved or go online until `User.phoneVerified` is true |
| 3 | Each doctor sets their own day and night rate from their own settings |
| 4 | Day and night rate periods are both in use, platform-level windows |
| 5 | A call starting at or after 20:00 bills at the night rate, fixed once at call start, never recalculated mid-call |
| 6 | Billing is per minute and rounds **up**. 4 minutes 10 seconds bills 5 minutes |
| 7 | A call under 60 seconds is free, once per patient and doctor pair per rolling 24 hours. Any further short call to the same doctor in that window bills 1 minute |
| 8 | 60 seconds exactly is chargeable |
| 9 | A call ends automatically when the wallet runs out |
| 10 | A call cut short for low balance pays the doctor on the same terms as any other call, gated on prescription submission. The prescription must state that the call ended early. The server sets that flag from `Call.endReason`, the doctor does not type it |
| 11 | Free calls require no prescription |
| 12 | Ratings are public to patients and visible in the admin dashboard |
| 13 | Doctors raise withdrawal requests; the admin pays manually and records a reference number |
| 14 | Minimum withdrawal ₹100 (`10000` paise) |
| 15 | Research consent is required, and the record stores the version and wording shown |
| 16 | Payouts by bank transfer or UPI, doctor's choice |
| 17 | A rejected doctor can correct the issue and reapply; verification is an attempt history |
| 18 | In-app notification history and per-type settings |
| 19 | FAQ is static content, no backend management |
| 20 | Platform commission 20%, overridable per doctor |
| 21 | Prescription window 2 hours, reminder at 1 hour, recordings retained 3 years |
| 22 | Wallet top-up is a **custom amount in whole rupees** chosen by the patient. No predefined packs. Minimum ₹100, maximum ₹50,000 per transaction (`PlatformSetting.minTopupPaise` / `maxTopupPaise`, enforced on the server). Everything is integer paise internally. Credited only from the verified Razorpay webhook; idempotent |
| 23 | **Refunds are full only.** Every refund returns the whole charge recorded in the ledger for the call. No partial refunds, enforced in the backend (no amount is accepted) |
| 24 | Refund is a transaction (approved), and so is the recovery write-off. Admin refunds and the Phase 7 expiry refund share one code path (`refundCallInSession`) and the ledger key `call:<callId>:refund`, so a call is refunded at most once by either |
| 25 | A refund never touches the doctor's commission: the patient gets the gross back, only the doctor's **net** earning is reversed or recovered, and the platform absorbs its own commission. `held` -> `forfeited`. `released` -> `reversed`. Claimed by a **pending** withdrawal request -> `reversed` and the request is reduced (`cancelled`, a system status distinct from an admin `rejected`, at zero). Already paid out -> `reversed` plus a recovery the doctor owes. A refund is never blocked by a withdrawal. The earning row is never deleted |
| 26 | Every doctor-side change is an append-only `DoctorLedgerAdjustment` (`earning_reversal`, `recovery_recorded`, `recovery_settled`, `recovery_write_off`) pointing at the earning and the refund ledger entry. `DoctorEarning.recoveryPaise / recoveredPaise / writtenOffPaise` are running totals of those entries. A recovery is taken from later withdrawals (withdrawable = released unclaimed net minus outstanding). An admin may write off the remainder only after `PlatformSetting.recoveryPeriodDays` (provisional default 180 days, pending business approval; `null` disables write-offs) |
| 27 | Both the patient and the doctor are notified after a refund, through the `OutboxEvent` outbox written in the refund session and delivered by the worker after commit, with retries and duplicate prevention. External calls never run inside a transaction |
| 28 | The legacy signup flow (`POST /users/create`, `/users/create-user-verify-otp`, `/otp/resend-otp`) is retired through `LEGACY_SIGNUP_MODE`: `enabled` (default, until the Flutter and dashboard teams confirm) or `gone` (`410 Gone` for one release), then the code is deleted. Every call is logged as `legacy_signup_endpoint_used`. `/auth/register` is the only signup |
| 29 | **Urgent calls are priced from `PlatformSetting` only** (`urgentCallDayRatePaise` / `urgentCallNightRatePaise`, chosen by the same IST day/night window). No hardcoded or fallback rate. A missing, zero, negative, fractional or invalid rate rejects the urgent call with a business error (422), so the affordable duration is never infinite. The rate is copied onto the Call at start and a later settings change never affects a call in progress. Integer paise throughout |

---

## Still open after the Phase 5 decisions

Each needs an answer before the work that depends on it. Do not pick a value.

| Open | Blocks |
|---|---|
| Business approval of the provisional **180-day** `recoveryPeriodDays` | Write-off (works at 180 until changed) |
| Which release flips `LEGACY_SIGNUP_MODE` to `gone`, and confirmation from the Flutter and dashboard teams | Legacy signup 410 |
| Push (FCM) and email for refund notices; today only the in-app notification is delivered | Notification channels (needs the FCM / email services) |

---

## Phase 6 assumptions awaiting client confirmation

Implemented with the safest reading; the client should confirm or correct each (details in `PROGRESS.md`).

| Assumption | Where |
|---|---|
| Commission is rounded to the nearest paise, net = gross - commission | `resolveBilling` |
| Time past the affordable duration is not billed (platform absorbs it) | `callService.finalize` |
| A call whose two parties never met in the channel fails with no money and no allowance consumed | `callService.finalize` |
| A rejoin within 3 s of a leave continues the call | `FINALIZE_DELAY_MS` |
| `providerEventId` = `channel:uid:eventType:clientSeq` | Agora webhook |
| Added endpoints beyond the plan: accept, reject, end (hint), history | `call.route.ts` |

---

## Open questions — STOP if a task needs one

Six left, none of them blocking. Each has a field or a settings value holding the place;
leave it at its placeholder and surface the blocker.

| Open | Where it is parked |
|---|---|
| When does the night window end? | `PlatformSetting.dayStartTime`, currently `06:00`. The Figma showed `08:00` |
| Research consent purpose and wording | `ResearchConsent.purpose` and `wording` are required, so the feature is blocked until the text arrives. Correct behaviour |
| PAN and TDS: deduction per call or per payout? | `DoctorEarning.deductionPaise` and `deductionType`, both nullable and unused. Only the timing half is urgent, because per-call would need a backfill |
| Urgent call rate policy. **Decided (decision 29):** the platform rate from `PlatformSetting.urgentCall*RatePaise`, validated, no fallback, snapshotted at call start; invalid or zero rejects the call. **Still open:** the rate VALUES (both are `0`, so urgent calls are rejected for now), and whether commission applies to urgent calls | `PlatformSetting.urgentCall*RatePaise` |
| Are review comments public, is the reviewer named, who can take a review down? | `Rating.isPublic`, `patientDisplay`, `hidden*` fields exist. Current schema defaults applied, policy unconfirmed |
| What is billed when the Agora end event never arrives? | `CALL_END_REASON.NO_END_EVENT`. The sweep closes the call because a call left `active` holds the partial unique index and blocks that doctor from every future call. It writes no ledger entry, no earning, and consumes no free-call allowance, then raises a critical `ReconciliationFinding` for an admin. **That is a deferral to a human, not a decision that the call is free.** Do not promote it to a billing rule without explicit client confirmation |

---

## Conventions

- Routes under `/api/v1`. Modules are vertical slices:
  `src/modules/<name>/{model,interface,constants,validation,service,controller,route}.ts`
- Validation with zod at the route boundary. Mongoose `strict` mode on every schema.
- Errors: one `AppError` class, one global error handler, one response envelope.
- Soft delete: the shared `softDeletePlugin`, never per-model hooks. Financial, audit and
  allowance collections have **no** soft delete: `Call`, `WalletLedger`, `DoctorEarning`,
  `PaymentOrder`, `RecordingAccessLog`, `ShortCallAllowance`, `DoctorLedgerAdjustment` (also append-only), `OutboxEvent`.
- Timezone: all rate-window logic evaluates in `Asia/Kolkata` on the server. Store UTC.
  Every window comparison goes through `src/shared/time.ts`, which wraps `date-fns-tz`.
  No raw `Date` arithmetic on hours anywhere — that is how an off-by-an-hour billing bug
  gets in and stays hidden.
- Every route registers its zod schemas with the OpenAPI registry as it is written. Two
  Flutter apps and a dashboard are built against this API, so the spec is not optional
  documentation.
- Money-creating POST endpoints require an `Idempotency-Key` header and go through the
  idempotency middleware: `/wallet/orders`, `/calls`, `/doctor/withdrawals`,
  `/calls/:id/prescription`. Mobile networks here drop requests, and the app retries.
- `Doctor.isOnline` is a cache of Redis presence, refreshed by the presence sweep. It is a
  Mongo field so the patient doctor list can filter and sort on it. It is never the source
  of truth, and nothing writes it on every heartbeat.
- Secrets in env only. Never commit a Razorpay key, the Agora certificate, a JWT secret, or
  the SMS provider credentials.
- Webhook routes mount **before** the JSON body parser, or capture the raw body. Signature
  verification runs on the exact bytes received.

## Jobs

Workers run in a **separate process**, never in the API. Scheduled work registered in the API
process runs once per instance, which means twice as soon as there are two.

| Job | Trigger |
|---|---|
| Prescription reminder | Delayed, 1h after call end, job id = call id. Not queued for free calls |
| Prescription expiry + refund | Delayed, 2h after call end, job id = call id. Not queued for free calls |
| Overdue-prescription sweep | Every 15 min — catches jobs Redis lost |
| Overdue-call sweep | Every 30 s. Two conditions: a call past `maxAffordableSeconds` (cut-off timer lost to an API restart), and a call past a hard ceiling whose duration cannot be derived because no Agora end event arrived |
| Presence sweep | Every 60 s. Clears `Doctor.isOnline` for any doctor whose Redis presence key has expired |
| Nightly reconciliation | Paid orders with no ledger entry; ledger vs call amounts; cache vs ledger |
| Dead token cleanup | Daily |

Delayed jobs use the call id as the BullMQ job id so enqueuing twice is a no-op. Every handler
re-reads state and exits if it has already moved.

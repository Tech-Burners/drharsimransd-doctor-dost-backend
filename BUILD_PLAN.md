# DoctorDost backend — phased build prompts

`CLAUDE.md` must be in the repo root first. Every prompt below assumes it is loaded.

Run one phase per Claude Code session. Clear context between phases. Do not merge phases.
Phases 5, 6 and 7 are the money paths and need reviewing on their own.

Revision 2, 4 November. Adds the reliability, audit and testing work agreed in review.
Every addition is marked **Critical**, **Important** or **Optional**.

- **Critical** — do not launch without it. Prevents money loss, data loss or a visible
  product failure.
- **Important** — strongly recommended. Deferring costs more later than doing it now.
- **Optional** — workflow and developer quality. No product risk.

Status: login, rounding, the free short call and truncated-call payment are confirmed.
Five client questions remain open, plus one new one raised in Phase 6. None block a phase.

---

## Phase 2 — Schema fixes

Outstanding from the schema review, plus four new collections and one enum value. Models are
created here so no later phase has to add one mid-flight.

`Wallet` is on the critical path: Phase 5 cannot run without it.

```
Fix the Mongoose models and add the new collections below. Do not change anything not listed.
Do not touch business logic — this phase is models only.

=== EXISTING MODEL FIXES ===

PlatformSetting
- minWalletPaise default 10000
- add roundingMode (enum 'up' | 'down' | 'exact', default 'up' — 'up' is confirmed)
- add prescriptionWindowMinutes (120), reminderMinutes (60), recordingRetentionYears (3)
- add a validator rejecting dayStartTime === nightStartTime
- enforce a single document: a pre-save hook that throws if another exists

Doctor
- commissionPercent: default null (keep min 0, max 100). Services fall back to
  PlatformSetting.commissionPct when null
- remove bankRoutingNumber
- consultationRateDayPaise / consultationRateNightPaise: remove required, default null.
  A doctor cannot go online until both are set
- add index { approvalStatus: 1, ratingAvg: -1 }
- isOnline stays, but add a comment: this field is a CACHE of Redis presence, refreshed by
  the presence sweep. It is queryable so the patient doctor list can filter and sort on it.
  It is never the source of truth. See Phase 6 and Phase 8

User
- delete the post('save') hook entirely. It uses the 3-arg error-handler signature, so it
  never runs on success
- methods.toJSON: use this.toObject({ virtuals: true })
- add tokenVersion (Number, default 0)
- phoneVerified (Boolean, default false) — in use, doctors only
- phone: partial unique index on { phone: 1 } with partialFilterExpression
  { role: 'doctor', isDeleted: false }. Required for doctors, optional for patients
- email: partial unique index on { isDeleted: false } instead of unique: true
- move specialty, qualification and bio to the Doctor model. Make specialty an enum in
  doctor.constants
- remove doctorId. Doctor.userId already holds the link

Field additions
- Prescription: doctorRegistrationNoSnapshot (String, required).
  Rename pdfUrl to pdfObjectKey. Add callEndedEarly (Boolean, default false)
- PaymentOrder: ledgerEntryId (ref WalletLedger, default null)
- Call: commissionPercentSnapshot (Number, required), isFreeShortCall (Boolean, default
  false). Add index { doctorId: 1, prescriptionStatus: 1, prescriptionDeadlineAt: 1 }
- PRESCRIPTION_STATUS: add NOT_REQUIRED
- CALL_END_REASON: add NO_END_EVENT
- RecordingAccessLog: reason (enum patient_complaint | medico_legal | quality_audit |
  other, required), reasonNote (String, default '')
- Rating: hiddenBy (ref User, null), hiddenReason (String, null), hiddenAt (Date, null),
  patientDisplay (enum name | initials | anonymous, default 'name')
- DoctorVerification: add resubmissionAllowed (Boolean, default true). Remove the
  `decision` field, status already covers it. Make rejectionReason an enum:
  illegible_document | details_mismatch | invalid_registration | expired_registration |
  other. Make { doctorId, attemptNo } unique index partial on { isDeleted: false }
- WalletLedger: add walletId (ref Wallet, required)

Otp
- store the code hashed with bcrypt, add a compare static
- add index { expiredAt: 1 } with expireAfterSeconds 0
- add attempts (Number, default 0) and maxAttempts (Number, default 5)
- drop 'forget-password' from purpose, duplicate of 'reset-password'
- add 'phone-verification' to purpose

DoctorEarning
- change index { doctorId, status, createdAt } to
  { doctorId: 1, status: 1, withdrawalRequestId: 1 }

WithdrawalRequest
- rename referenceReason to rejectionReason

Notification
- remove 'appointment' from the type enum

=== NEW MODELS (previously planned) ===

Wallet
  userId (unique ref User), balancePaise (int, min 0, default 0),
  lastLedgerEntryId (ref WalletLedger, default null)
  Comment at the top: WalletLedger is authoritative. This is a cache written in the same
  transaction and never read to make a decision
  No soft delete

DeviceToken
  userId (ref User), token (unique), platform (enum ios|android),
  notificationsPermitted (Boolean), batteryOptimised (Boolean), lastSeenAt (Date)

NotificationSetting
  userId (unique ref User), one Boolean per Notification type enum value, all default true

ShortCallAllowance
  patientId (ref User), doctorId (ref Doctor), callId (ref Call),
  consumedAt (Date, default now)
  index { patientId: 1, doctorId: 1 } unique
  index { consumedAt: 1 } with expireAfterSeconds 86400
  No soft delete

=== NEW MODELS (revision 2) ===

IdempotencyKey                                               [Critical]
  key (String, required), userId (ref User, required), endpoint (String, required),
  requestHash (String, required), responseBody (Mixed), statusCode (Number),
  createdAt (Date, default now)
  index { key: 1, userId: 1 } unique
  index { createdAt: 1 } with expireAfterSeconds 86400
  No soft delete
  Purpose: a retried money POST on a flaky mobile network returns the stored response
  instead of creating a second order, withdrawal or call

SettingChangeLog                                             [Critical]
  entityType (enum: platform_setting | doctor), entityId (ObjectId, nullable),
  field (String, required), oldValue (Mixed), newValue (Mixed),
  changedBy (ref User, required), changedAt (Date, default now)
  index { entityType: 1, entityId: 1, changedAt: -1 }
  Append-only. No soft delete, no update path, no delete path
  Purpose: commission percentage, rate windows, minimum withdrawal and per-doctor
  commercial terms all affect money and are currently editable with no history

AgoraCallEvent                                               [Critical]
  callId (ref Call, required), channelName (String, required), uid (String, required),
  eventType (String, required), eventTs (Date, required),
  providerEventId (String, required), raw (Mixed, required),
  receivedAt (Date, default now)
  index { callId: 1, eventTs: 1 }
  index { providerEventId: 1 } unique
  No soft delete
  Purpose: Agora delivers channel join and leave events, not a duration. Duration is
  DERIVED from these rows. Keeping them raw makes derivation testable, lets a disputed
  call be re-derived, and makes a duplicate delivery a no-op via the unique index
  Confirm the exact provider event identifier field against the Agora notification
  payload before finalising providerEventId. Do not guess the field name

ReconciliationFinding                                        [Critical]
  runAt (Date, required), checkName (String, required),
  severity (enum: info | warning | critical),
  entityType (String), entityId (ObjectId, nullable),
  detail (Mixed, required), alertedAt (Date, null), resolvedAt (Date, null),
  resolvedBy (ref User, null)
  index { runAt: -1, severity: 1 }
  index { resolvedAt: 1, severity: 1 }
  Append-only apart from resolvedAt and resolvedBy
  Purpose: Phase 9 already sends findings to a collection. This defines it, and the
  alertedAt field is what stops the same finding paging someone every night

Shared plugin
- create softDeletePlugin adding
  schema.pre(/^find|^update|^count|^replace/, function (next) {
    this.where({ isDeleted: { $ne: true } }); next();
  })
  plus the existing aggregate hook, applied to every schema with isDeleted.
  Remove the per-model duplicated hooks.
  Do NOT apply it to: Call, WalletLedger, DoctorEarning, PaymentOrder,
  RecordingAccessLog, ShortCallAllowance, IdempotencyKey, SettingChangeLog,
  AgoraCallEvent, ReconciliationFinding

Verify the two partial unique indexes on Call using $in in partialFilterExpression actually
build on our MongoDB version. If they do not, report back instead of changing the behaviour.
```

---

## Phase 3 — Foundation

Six additions in revision 2. Three of them are prerequisites for later phases and cost far
more if deferred.

```
Set up the application shell. No business logic yet.

=== BASE (unchanged) ===
- Express app with helmet, cors, compression, and a request id on every request
- Mount webhook routes BEFORE express.json(), with raw body capture for signature checks
- Global error handler and an AppError class. One response envelope:
  { success, message, data, meta }
- zod validation middleware at the route boundary
- Mongoose connection with an explicit maxPoolSize from env (do not leave the default of 100)
- Redis connection and a BullMQ queue factory
- A separate worker entrypoint (src/worker.ts) with its own package script. Nothing scheduled
  is ever registered in the API process
- Structured logging with pino, secrets redacted
- Health endpoint reporting mongo and redis reachability
- A seed script creating the single PlatformSetting document and one admin user from env
- docker-compose for local dev with mongo as a ONE NODE REPLICA SET (--replSet rs0, plus an
  init container running rs.initiate()) and redis. Transactions will not work against a
  standalone mongod

=== TEST HARNESS ===                                         [Critical, blocks Phase 5]
- Jest with ts-jest
- mongodb-memory-server in REPLICA SET mode, not standalone. Transactions, write concerns
  and unique index violations all behave differently otherwise, and those are exactly what
  the money tests exercise
- A test helper that starts the replica set once per suite, truncates between tests, and
  exposes a session
- A documented split: money paths are INTEGRATION tests against this database. Everything
  else may be a unit test. A mocked transaction proves nothing
- One passing smoke test that opens a session, writes two documents, aborts, and asserts
  neither persisted. If that test cannot pass, nothing in Phase 5 onwards can be trusted

=== TIMEZONE HELPER ===                                      [Critical]
- Add date-fns-tz. No other date library
- src/shared/time.ts exporting nowInIst(), toIst(date), and
  isWithinWindow(date, startHHmm, endHHmm) handling the midnight wrap
- Every rate-window comparison in the codebase goes through these. No raw Date arithmetic
  on windows anywhere
- Unit tests for the midnight wrap, 19:59 vs 20:01, and a DST-free sanity case

=== IDEMPOTENCY MIDDLEWARE ===                               [Critical]
- requireIdempotency() middleware, applied per route, sitting between validation and the
  controller
- Reads the Idempotency-Key header. Missing key on a route that requires one is a 400
- Hashes the request body. Same key with a DIFFERENT body hash is a 409, not a replay —
  that is a client bug and silently returning the old response hides it
- Same key and same hash returns the stored status and body without touching the service
- Writes the response to IdempotencyKey after a successful handler
- Applied in Phases 5, 6 and 7. Do not apply it anywhere in this phase

=== CORRELATION ID ===                                       [Important]
- A request id on every request, in every log line
- Propagated into BullMQ job data so worker logs carry the same id
- Where a call exists, callId is also a logged field on every line in its lifecycle:
  start request, Agora token mint, webhook receipt, billing, earning write
- Without this, investigating a billing dispute means grepping by timestamp across two
  processes

=== ERROR TRACKING ===                                       [Important]
- Sentry in both the API and the worker entrypoints, DSN from env, disabled when unset
- Capture unhandled rejections and BullMQ job failures explicitly. A failed job is
  currently invisible

=== OPENAPI REGISTRY ===                                     [Important]
- zod-to-openapi. A central registry module. A /docs route serving the spec, gated to
  non-production or behind admin auth
- Establish the convention NOW: every route registers its zod schemas with the registry as
  it is written
- Two Flutter apps and a dashboard are being built against this API and its shape is
  published nowhere. Retrofitting this at Phase 10 means revisiting every route

=== PROGRESS FILE ===                                        [Optional]
- Create PROGRESS.md at the repo root with three sections: Done, In progress, Next
- Phases 6 and 7 exceed one context window, so a fresh session otherwise re-derives state

Do not touch the models.
```

---

## Phase 4 — Auth

Unchanged from revision 1. Login is confirmed: all three roles use email and password, and
doctors must additionally verify their phone number.

```
Build the auth module.

- POST /api/v1/auth/register        — email + password. Role patient by default
- POST /api/v1/auth/login           — email + password, all roles
- POST /api/v1/auth/refresh         — rotate: issue a new pair, mark the old jti used, and
                                      if a used jti is presented again revoke every token
                                      for that user
- POST /api/v1/auth/logout          — revoke one refresh token
- POST /api/v1/auth/logout-all      — bump User.tokenVersion
- POST /api/v1/auth/forgot-password — emailed OTP
- POST /api/v1/auth/reset-password  — verify OTP, set new password, bump tokenVersion
- POST /api/v1/auth/verify-email    — emailed OTP

Doctor phone verification:
- POST /api/v1/auth/phone/send-otp   — SMS OTP to the doctor's phone
- POST /api/v1/auth/phone/verify     — sets User.phoneVerified
- Integrate one SMS provider behind a small interface (sendSms(to, body)) so it can be
  swapped. Credentials from env
- A doctor cannot be approved by the admin, and cannot set isOnline, until phoneVerified
  is true. Enforce in verificationService and in the availability endpoint, not in the UI

Tokens:
- Access: 15 min, carries sub, role, tokenVersion. Verified, never looked up
- Refresh: 30 days, hashed in RefreshToken, TTL index already present
- authenticate middleware: verify, check tokenVersion against the user, attach the subject
- requireRole(...roles) middleware
- Rate limit login and both OTP endpoints per identifier and per IP in Redis, with a
  lockout after repeated failures
- Login and register return the same response shape whether or not the account exists

Register every route with the OpenAPI registry as you write it.

Write tests for: token rotation, reuse detection revoking everything, tokenVersion bump
invalidating a live access token, OTP attempt ceiling, and a doctor being blocked from
going online while phoneVerified is false.
```

---

## Phase 5 — Wallet and payments

```
Build the wallet. The most important module in the system. Read rule 2 and the transactions
table in CLAUDE.md before starting.

walletService:
- getBalance(userId): read the newest WalletLedger entry's balanceAfterPaise. Never read
  Wallet.balancePaise to decide anything
- append(session, { userId, type, direction, amountPaise, idempotencyKey, referenceType,
  referenceId, description }): inside the caller's session, compute balanceAfterPaise,
  insert the ledger row, update the Wallet cache. Reject anything taking the balance below
  zero
- Internal entries use a deterministic idempotency key, e.g. `call:<callId>:charge`,
  `call:<callId>:refund`

Routes:
- GET  /api/v1/wallet            — balance + paginated ledger
- POST /api/v1/wallet/orders     — create a Razorpay order. The amount comes from a
                                   server-side allow-list, NEVER from the request body.
                                   Writes PaymentOrder with status created
- POST /api/v1/webhooks/razorpay — verify the HMAC on the RAW body. Unverified payloads are
                                   logged and dropped. In one session: append the credit
                                   with idempotencyKey derived from razorpayPaymentId,
                                   update the cache, set the order paid with its
                                   ledgerEntryId. A duplicate key error on that insert means
                                   already processed — return 200
- POST /api/v1/admin/refunds     — manual refund against a call, with reason and note

App success screens never trigger a credit. The webhook is the only path.

=== REVISION 2 ADDITIONS ===

Idempotency                                                  [Critical]
- Apply requireIdempotency() to POST /api/v1/wallet/orders
- A patient on patchy data taps top-up, the request times out, the app retries. Without
  this you get two Razorpay orders

Audit                                                        [Critical]
- POST /api/v1/admin/refunds writes a SettingChangeLog row: entityType platform_setting is
  wrong here, so use entityType 'doctor' only for doctor fields. For a refund, the audit
  already lives on the ledger entry's reference and description — do NOT write a duplicate
  SettingChangeLog row for it. SettingChangeLog is for configuration, not transactions

First concurrency test                                       [Critical]
- Write the template test: two simultaneous deliveries of the same Razorpay webhook,
  against the real replica set, asserting exactly one ledger row and one credit
- The remaining concurrency tests in Phases 6 and 7 copy this shape. Getting the first one
  right is most of the work

Register every route with the OpenAPI registry.

Write tests for: two concurrent webhook deliveries crediting once, a refund appending
rather than reversing, a debit that would go negative being rejected, and a retried
wallet order with the same Idempotency-Key returning the first response.
```

---

## Phase 6 — Calls and billing

The heaviest phase, and revision 2 makes it heavier. **Run it as two sessions, 6A and 6B.**
The phase number and structure are unchanged; this is only a context-window measure.

Billing is fully specified in `CLAUDE.md`. Build it in one pass in 6B — do not write
round-up first and add the short-call rule afterwards.

### Session 6A — call lifecycle, Agora, presence

```
Build the call lifecycle and the Agora integration. Do NOT write billing in this session.

POST /api/v1/calls (patient) — callService.start():
 1. Body carries a doctorId and nothing else that matters. patientId comes from the token
 2. Open a session. Load the doctor: approved, online, phoneVerified, not the caller
 3. Resolve the rate via the Phase 3 timezone helper against PlatformSetting.dayStartTime
    and nightStartTime. Pick the doctor's day or night rate. Fixed once, here
 4. Read the balance inside the session
 5. maxAffordableSeconds = Math.floor(balancePaise / ratePaisePerMin) * 60.
    Computed as if the call WILL be charged — never assume it may turn out free.
    If the balance is below PlatformSetting.minWalletPaise, return a low balance response
    and write NO call document
 6. Insert the call: status ringing, rate snapshot, commissionPercentSnapshot, affordable
    duration. Commit
 7. Mint an Agora token scoped to the channel, expiring just past the affordable duration
 8. Send FCM high-priority data message + emit call:incoming on the socket
 9. Enqueue a delayed job at 30s: if still ringing, move to missed

The partial unique indexes on Call mean a busy doctor produces an E11000. Catch it and
return a clean "doctor is busy" response, not a 500.

=== AGORA EVENTS ===                                         [Critical]

POST /api/v1/webhooks/agora/call
 1. VERIFY THE SIGNATURE on the raw body before anything else. An unverified payload is
    logged and dropped. A forged event is a free consultation, so treat this with the same
    seriousness as the Razorpay webhook
 2. Persist the event to AgoraCallEvent FIRST, before any derivation. The unique index on
    providerEventId makes a duplicate delivery a no-op
 3. Confirm the real field names against the Agora notification payload. Do not guess the
    event identifier, the uid field or the timestamp field — if the payload does not match
    what the model expects, report it rather than adapting the model

deriveCallDuration(callId)                                   [Critical]
 - One pure, tested function reading AgoraCallEvent rows for the call
 - Agora delivers channel join and leave events per uid, NOT a duration. Derive it
 - Handle: out-of-order delivery, duplicate events, a missing leave event for one party,
   and both parties leaving at different times
 - Return null when a duration cannot be determined. Never return a guess

=== ORPHANED CALLS ===                                       [Critical]

A call whose end event never arrives stays `active` forever. Because of the partial unique
index on doctorId, that doctor can then never take another call. This is a production stop.

Extend the EXISTING 30-second overdue-call sweep with a second condition. Do not add a
second job.

Condition A (existing): active, past maxAffordableSeconds -> normal cut-off
Condition B (new):      active, past a hard ceiling (maxAffordableSeconds + a grace
                        margin, from config), and deriveCallDuration returns null

For condition B:
 - Close the call: status completed, endReason NO_END_EVENT
 - Write NO ledger entry, NO DoctorEarning row, and do NOT consume the free-call allowance
 - Set grossPaise, commissionPaise, netPaise to 0
 - Raise a ReconciliationFinding with severity critical, so an admin sees it
 - Log at error level with the callId

IMPORTANT — this is NOT an approved business rule. The billing treatment of a lost end
event has not been confirmed by the client. Closing the call is a technical necessity
because of the index; writing no money is a DEFERRAL to an admin, not a decision that the
call is free. Leave a clear TODO at the branch saying the rule is pending client
confirmation, and surface it in your summary.

=== PRESENCE HEARTBEAT ===                                   [Critical]

isOnline as a client-set boolean is unreliable. A dead phone, a killed app or a tunnel
leaves it true forever, and every subsequent call to that doctor becomes a missed call.

- Socket event `presence` from the doctor app every 30 seconds
- On receipt, set a Redis key `presence:doctor:<id>` with a 90-second TTL
- On socket connect, set the key and set Doctor.isOnline true
- On explicit disconnect or the doctor toggling offline, delete the key and set
  Doctor.isOnline false

Do NOT write to Mongo on every heartbeat. That is one write per doctor per 30 seconds
forever for a value that rarely changes. The Mongo field is refreshed by the Phase 8 sweep.

=== CALL COOLDOWN ===                                        [Important]

- A Redis counter enforcing a 30 to 60 second cooldown between call attempts per patient,
  window length from config
- The partial unique index stops concurrent calls, not frequent ones. Without this a patient
  can ring 40 doctors in two minutes and wake all of them. Doctors are the scarce resource

=== IDEMPOTENCY ===                                          [Critical]
- Apply requireIdempotency() to POST /api/v1/calls

Register every route with the OpenAPI registry.

Tests for this session:
 - rate selection at 19:59 and 20:01 through the timezone helper
 - duration derivation: normal, out-of-order events, duplicate events, missing leave event
 - duration derivation returns null when it cannot be determined
 - the orphan sweep closes a call with no end event and writes no money
 - a second caller to a busy doctor gets the busy response, not a 500
 - presence key expiry
 - cooldown rejects a second call attempt inside the window
 - a retried POST /calls with the same Idempotency-Key returns the first response
```

### Session 6B — billing

```
Build billing. The rules are in CLAUDE.md under Billing and are fully confirmed.

callService.end(), triggered by the Agora webhook once a duration can be derived:
 1. durationSeconds comes from deriveCallDuration(). The client's end message is a hint only
 2. If durationSeconds < 60, try to claim the free allowance inside the session:
      try { await ShortCallAllowance.create([{ patientId, doctorId, callId }], { session })
            isFree = true }
      catch (err) { if (isDuplicateKeyError(err)) isFree = false; else throw }
    The TTL index IS the 24h window. Granting is the insert. The insert is in the session,
    so an aborted transaction releases the allowance
 3. resolveBilling({ durationSeconds, isFree, ratePaisePerMin, commissionPercent }) returns
    billedMinutes, grossPaise, commissionPaise, netPaise. ONE function, every caller uses it
 4. Rate and commission come from the snapshot ON THE CALL, never read live from the doctor
 5. Paid call, in one session: ledger debit, wallet cache, call final fields, DoctorEarning
    row (status held). No earning row for a retainer doctor
 6. Paid call: prescriptionDeadlineAt = +2h, enqueue the 1h reminder and 2h expiry jobs,
    job id = call id
 7. Free call: grossPaise/commissionPaise/netPaise 0, NO ledger entry, NO DoctorEarning row,
    prescriptionStatus = 'not_required', NO jobs queued, isFreeShortCall = true. Still saves
    to history
 8. ended_low_balance is treated exactly like completed for earnings and prescriptions.
    Set Prescription.callEndedEarly from Call.endReason — the SERVER sets it, the doctor
    does not type it, and the PDF prints a line saying the call ended early

Cut-off, three layers: the Agora token expiry caps the worst case; an in-process timer
closes the channel at maxAffordableSeconds via the Agora REST API; the 30-second sweep from
6A catches calls past their affordable duration after an API restart. Emit call:warning to
both parties at 60 seconds remaining.

Call history responses carry isFreeShortCall so both apps can label it.

Tests:
 - 59s free, 60s billed 1 minute, 61s billed 2 minutes
 - first short call free, second to the same doctor within 24h billed 1 minute
 - short call to a different doctor within 24h still free
 - exactly 60s consumes no allowance
 - two concurrent call-end handlers for the same pair: exactly one gets the free slot
 - an aborted call-end transaction releases the allowance
 - a free call writes no ledger row, no earning row, queues no jobs
 - affordable duration enforced
 - a NO_END_EVENT call never reaches resolveBilling
```

---

## Phase 7 — Prescriptions, earnings, withdrawals

```
Build the three modules that move a doctor's money.

Prescriptions:
- POST /api/v1/calls/:id/prescription (doctor, owns the call, before the deadline)
- Reject when prescriptionStatus is 'not_required'
- Snapshot doctorNameSnapshot, doctorQualificationSnapshot, doctorRegistrationNoSnapshot and
  doctorSignatureSnapshot at submission. The registration number is legally required on the
  prescription — do not skip it
- callEndedEarly is set by the server from Call.endReason. The PDF prints a line when true
- The doctor app form shows a notice on those calls so the doctor has the context
- Generate the PDF, store it, keep the object key not a URL
- One session: prescription, call.prescriptionStatus = submitted, earning → released
- Remove the two queued jobs by their deterministic ids
- GET /api/v1/prescriptions/:callId — signed URL, patient or doctor on that call only

Jobs:
- Reminder at 1h: send if still pending
- Expiry at 2h: earning → forfeited, append the patient refund, prescriptionStatus = expired
- Both re-read state and exit if it has moved. Idempotent on call id
- A 15-minute sweep over calls past their deadline still pending. Redis can lose a job, and
  a lost expiry job means a patient never gets their refund

Withdrawals:
- GET /api/v1/doctor/earnings — held, released, forfeited, plus the withdrawable sum
- withdrawable = sum of netPaise where status=released AND withdrawalRequestId=null
- POST /api/v1/doctor/withdrawals:
   recompute the sum server-side, check amount >= PlatformSetting.minWithdrawalPaise and
   <= the sum, refuse retainer doctors with a message not an error.
   In one session: insert the request with a destination snapshot, then stamp
   withdrawalRequestId onto the funding earnings rows oldest first WITH A FILTER OF
   { withdrawalRequestId: null }. If the matched count is short, abort.
   That filter is the lock — without it two concurrent requests both succeed
- POST /api/v1/admin/withdrawals/:id/decide — paid with a reference number, or rejected with
  a reason which clears the claim from the earnings rows

=== REVISION 2 ADDITIONS ===

Idempotency                                                  [Critical]
- Apply requireIdempotency() to POST /api/v1/doctor/withdrawals and
  POST /api/v1/calls/:id/prescription
- A retried withdrawal does not double-fund, because of the claim filter, but it does
  create a second pending request for whatever remained. That is a support ticket

Register every route with the OpenAPI registry.

Write tests for: two concurrent withdrawal requests against one balance, an expiry job
running twice, a prescription submitted one second after the deadline being rejected, a
prescription rejected on a free call, and a retried withdrawal with the same
Idempotency-Key returning the first response.
```

---

## Phase 8 — Doctors, verification, ratings

```
Build the doctor lifecycle and ratings.

Doctor:
- PUT /api/v1/doctor/availability, /rates, /profile
- Rates apply to new calls only. Set rateUpdatedAt. Never touch a call in progress or a past
  record
- Block going online until both rates are set, a payout destination exists, and
  phoneVerified is true
- GET /api/v1/doctors — approved only, filter by specialty / online, sort by rating
- GET /api/v1/doctors/:id — public profile

Verification:
- POST /api/v1/doctor/verification — a new attempt, attemptNo = last + 1
- GET  /api/v1/admin/verifications — queue with waiting time, showing phone verified status
- POST /api/v1/admin/verifications/:id/decide — approve, or reject with an enum reason plus
  a note, setting resubmissionAllowed
- Rejecting with resubmissionAllowed=false prevents a new attempt
- Approval is blocked while phoneVerified is false
- Notify the doctor either way, with the reason on a rejection

Ratings:
- POST /api/v1/calls/:id/rating — patient, own completed call, once
- GET  /api/v1/doctors/:id/ratings — paginated, public only
- Maintain ratingAvg and ratingCount on the Doctor as an aggregate. Never compute over all
  ratings on a list render
- GET  /api/v1/admin/ratings — all of them
- POST /api/v1/admin/ratings/:id/hide — sets hiddenBy, hiddenReason, hiddenAt

OPEN: whether comments are public, whether the reviewer is named, and who may hide a review.
The fields exist. Use the current schema defaults, make hide admin-only, and report that the
policy is unconfirmed.

=== REVISION 2 ADDITIONS ===

Presence sweep                                               [Critical]
- A scheduled job every 60 seconds in the WORKER process: for every doctor with
  isOnline true, check the Redis presence key. Missing key -> set isOnline false and
  stamp lastOnlineAt
- This completes the presence change started in 6A. Mongo holds a queryable cache that is
  at most 60 seconds stale, which is what lets the patient doctor list filter and sort on
  isOnline without touching Redis
- A doctor who drops off the network misses at most one call instead of every call

Settings audit                                               [Critical]
- doctorService writes a SettingChangeLog row on every change to
  consultationRateDayPaise, consultationRateNightPaise, commissionPercent and payoutMode
- Record oldValue, newValue and changedBy. Rate history is money history

Register every route with the OpenAPI registry.

Additional tests: the presence sweep clears a doctor whose key expired; a rate change
writes a SettingChangeLog row with the correct old and new values.
```

---

## Phase 9 — Notifications, recordings, admin, reconciliation

```
Finish the remaining modules.

Notifications:
- notificationService.send(userId, type, title, body, data): check NotificationSetting for
  that type, persist a Notification row, then dispatch via FCM to every DeviceToken
- Incoming calls are high-priority data messages, not display notifications, and bypass the
  per-type setting
- GET /api/v1/notifications, PATCH /:id/read, PATCH /read-all
- GET/PUT /api/v1/notifications/settings
- POST /api/v1/device-tokens — upsert on token, recording notificationsPermitted and
  batteryOptimised so the doctor Home screen can warn before a call is missed
- Prune tokens FCM reports as unregistered

Recordings:
- POST /api/v1/admin/recordings/:callId/access — the reason is REQUIRED. Write the
  RecordingAccessLog row FIRST, then return a signed URL valid 15 minutes. Writing the log
  after would miss exactly the accesses that failed partway
- GET /api/v1/admin/recordings/audit
- Retention deletion job at 3 years

Admin:
- Paginated, filterable lists for doctors, patients, calls, transactions, withdrawals
- PUT /api/v1/admin/doctors/:id/payout-mode — commission or retainer, future calls only
- GET/PUT /api/v1/admin/settings — the single PlatformSetting document
- Every admin action touching money goes through a service and records decidedBy

Reconciliation job, nightly, writing to ReconciliationFinding:
 1. PaymentOrders with status paid and no ledgerEntryId — money taken, not credited
 2. Ledger call_charge entries whose amount does not match the call's grossPaise
 3. Wallet cache disagreeing with the newest ledger entry — report and rebuild

=== REVISION 2 ADDITIONS ===

Settings audit                                               [Critical]
- PUT /api/v1/admin/settings writes a SettingChangeLog row per changed field, with
  oldValue, newValue and changedBy
- PUT /api/v1/admin/doctors/:id/payout-mode does the same
- GET /api/v1/admin/settings/history reading SettingChangeLog, filterable by entity and
  date range                                                [Important]

Razorpay settlement reconciliation                           [Critical]
- Add a FOURTH check to the existing nightly job. Do not create a second job
- Pull Razorpay's payments or settlement API for the previous day and diff against
  PaymentOrder by razorpayPaymentId
- Report both directions: a Razorpay payment with no local order, and a local order marked
  paid that Razorpay does not confirm
- The three existing checks compare your records to your other records. A payment that
  never created a local order is invisible to all of them, and that is the case most likely
  to lose real money

Alerting                                                     [Critical]
- Findings with severity critical or warning are emailed to the admin address from config
- Stamp alertedAt so the same finding does not page someone every night
- A findings collection nobody opens is theatre

DPDP erasure                                                 [Important]
- POST /api/v1/admin/users/:id/erase — anonymise the user document (name, email, phone,
  photo), keep the clinical record
- Prescriptions, calls and ledger entries are retained. Prescriptions are medico-legal
  records and ledger entries are financial records; neither can simply be deleted
- Record the erasure in SettingChangeLog
- The retention policy itself needs client and legal sign-off. Implement the mechanism,
  flag the policy as unconfirmed

Register every route with the OpenAPI registry.
```

---

## Phase 10 — Verification pass

```
Do not write features. Audit what exists.

ORIGINAL CHECKS
1. Every protected route: confirm authenticate → requireRole → ownership-in-service. List
   any route missing the third layer
2. Every money write: confirm it is inside a session with majority write concern and a
   TransientTransactionError retry. List any that are not
3. Confirm no route handler reads a user id from the body, query, or path where the token
   has it
4. Confirm no service reads Wallet.balancePaise to make a decision
5. Confirm billing goes through resolveBilling() everywhere. List any second implementation
6. Confirm every declared index actually builds. The two partial unique indexes on Call use
   $in in partialFilterExpression, which older MongoDB versions reject
7. Confirm the worker process registers the scheduled jobs and the API process does not
8. Confirm webhook routes see the raw body
9. List every TODO left by an open question, with file and line

REVISION 2 CHECKS
10. Every money-creating POST accepts and honours Idempotency-Key:
    /wallet/orders, /calls, /doctor/withdrawals, /calls/:id/prescription   [Critical]
11. Every settings and per-doctor commercial write produces a SettingChangeLog row
    with a correct oldValue                                                [Critical]
12. Every rate-window comparison goes through the Phase 3 timezone helper. Grep for raw
    Date arithmetic on hours                                               [Critical]
13. Concurrency tests run against a real replica set, not mocks. Confirm the harness is in
    replica-set mode                                                       [Critical]
14. Both Agora and Razorpay webhooks verify signatures on the raw body     [Critical]
15. The orphan-call branch is still marked as pending client confirmation and has not been
    silently promoted to an approved rule                                  [Critical]
16. Every route is registered in the OpenAPI registry                      [Important]
17. Sentry captures a thrown error in both the API and the worker          [Important]

Report as a table. Fix nothing without flagging it first.
```

---

## Pre-launch checklist

Not development work. None of it belongs in a phase, and all of it must be true before real
money moves.

| Item | Why | Priority |
|---|---|---|
| **Database backups configured and a restore drill performed** | Atlas backs up on paid tiers, not the free one. An append-only ledger with no backup is the worst possible thing to lose, and an untested backup is not a backup | **Critical** |
| **Agora App Certificate and Razorpay live keys rotated** out of any shared document, chat or repository | Anyone holding the certificate can mint tokens against your Agora account | **Critical** |
| **Agora recording confirmed as composite mode**, not individual stream | Individual stream doubles both the Agora minute charge and the stored bytes | **Critical** |
| **Razorpay in live mode** with the webhook secret in env only | | **Critical** |
| **Reconciliation alert delivered to a real inbox** and acknowledged once | An alert path nobody has tested is not an alert path | **Critical** |
| **Sentry receiving events from both API and worker** in production | | **Important** |
| **MongoDB is a replica set in every environment**, including each developer's machine | | **Critical** |
| **The worker runs as exactly one process**, and scheduled jobs are not also registered in the API | Two instances run every scheduled job twice | **Critical** |
| **DPDP retention and erasure policy written down** and agreed with the client | | **Important** |
| **Seeded-mismatch test of the reconciliation job** run once against real infrastructure | | **Important** |

---

## Still waiting on the client

None of these block a phase. All have a placeholder that would be wrong in production.

| Open | Current placeholder | Risk if shipped as is |
|---|---|---|
| Night window end time | `dayStartTime: '06:00'`, Figma showed `08:00` | Calls between 6 and 8 AM bill at the day rate |
| Urgent call rate policy | `urgentCall*RatePaise: 0` | **Urgent calls are free** |
| Research consent purpose and wording | Both required, so no consent row can be written | Feature correctly blocked |
| PAN and TDS, per call or per payout | Nullable deduction block, unused | Per-call would need a backfill of earnings written before the answer |
| Review comments public, reviewer named, who can hide | Public, named, admin-only hide | A public review system with no agreed takedown policy |
| **Billing when the Agora end event never arrives** (new, raised in Phase 6) | Call closed, no money written, admin alerted | **Recommendation only, not an approved rule.** The implementation defers to an admin rather than deciding the call is free. Needs explicit client confirmation before the behaviour is finalised |

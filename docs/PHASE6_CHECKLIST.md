# Phase 6 implementation checklist (calls, Agora, presence, billing)

Prepared before Phase 6 starts. Source: `BUILD_PLAN.md` Phase 6 (6A, 6B) and Revision 3,
`CLAUDE.md` (Billing, Transactions, Jobs, decisions 1 to 28). **STATUS: IMPLEMENTED (6A + 6B), awaiting review. See `PROGRESS.md` "Phase 6" for what was built, the deviations and the assumptions.**

Run as two sessions, as the plan says. Billing (6B) is written in one pass: no "round up first,
short-call rule later".

---

## 0. Decisions and blockers to clear BEFORE coding

| # | Item | Why it blocks | Recommendation |
|---|---|---|---|
| B1 | **`AgoraCallEvent.providerEventId` source** is unconfirmed. Agora's envelope has `noticeId`, but the docs do not say it is unique per event or stable across retries | The unique index on it is the dedupe. A wrong choice either drops real events or double-counts | Decide in 6A against a REAL delivery. Fallback key: `channelName + uid + eventType + clientSeq` (clientSeq is documented per user). Do not guess; report if the real payload differs |
| B2 | **Agora signature scheme** (header names, HMAC algorithm, which secret) is not in the repo | A forged event is a free consultation | Confirm against the Agora notification docs and a real delivery first. `Agora-Signature` / `Agora-Signature-V2` are already in the log-redaction list. Verify on the raw bytes with `crypto.timingSafeEqual`, fail closed if the secret is unset (same as Razorpay) |
| B3 | **Urgent calls: DECIDED.** The urgent price is read from `PlatformSetting` (`urgentCallDayRatePaise` / `urgentCallNightRatePaise`), the single source of truth. No hardcoded or fallback rate. A missing, zero, negative, fractional or otherwise invalid rate rejects the urgent call (422 "Urgent calls are not available right now"); the affordable duration can never be infinite. The resolved rate is snapshotted on the call at start. **Built and tested already** in `call/callRate.ts` (`resolveUrgentCallRate`, `computeMaxAffordableSeconds`); `callService.start()` only has to call them. | Division by zero otherwise. Today both rates are `0`, so urgent calls stay rejected until the client enters real values | **Still open (client):** the actual urgent rates, and whether commission applies to urgent calls (until answered, do not decide it in code) |
| B4 | **Billing when the Agora end event never arrives** (open question 6) | Condition B of the orphan sweep | Implement exactly as specified (close, no money, critical finding, `TODO` pending client confirmation). Not a billing rule |
| B5 | **Night window end** (open question 1) | Rate selection at call start | Use `dayStartTime` / `nightStartTime` as stored (06:00 / 20:00 placeholder). Do not change the values |
| B6 | **New dependencies need approval** (none are installed): `agora-token` (token minting), `firebase-admin` (FCM), `@socket.io/redis-adapter` (multi-instance sockets; `env.example` calls it required from day one) | Cannot mint tokens, push, or scale sockets | Approve all three. They are the Agora, FCM and Socket.IO choices already stated in CLAUDE.md |
| B7 | **Real Agora credentials and a real webhook delivery** | Cannot verify B1 and B2, token minting, or the REST channel-close | Needed for the manual verification list in section 5. Code can be written and unit-tested without them |
| B8 | **The "existing" 30-second overdue-call sweep does not exist.** The plan says "extend the existing sweep" but Phase 3 only built the worker shell | 6A must create the sweep (Condition A) AND add Condition B | One job, two conditions, in the worker process only. Do not add a second job |
| B9 | Socket presence today is an in-memory `connectedUsers` Map in `socketIo.ts` | Wrong for 2+ instances, and the plan wants Redis keys | Presence moves to Redis keys; the Map may stay only as a local socket-id lookup, behind the Redis adapter |

---

## 1. What already exists (do not rebuild)

- Models: `Call` (partial unique indexes on `doctorId` and `patientId` for in-flight statuses,
  `isFreeShortCall`, `commissionPercentSnapshot`, `maxAffordableSeconds`, `ratePaisePerMin`,
  `agoraChannelName`, `endReason` incl. `NO_END_EVENT`), `AgoraCallEvent`, `ShortCallAllowance`
  (unique pair + 24h TTL), `DoctorEarning`, `Prescription`, `DeviceToken`, `ReconciliationFinding`.
- `call/callRate.ts` (urgent rate from PlatformSetting with validation and no fallback, `computeMaxAffordableSeconds`, `resolveTimeSlot`; 38 tests),
- `src/shared/time.ts` (`isWithinWindow`, IST), `src/shared/rateLimit.ts` (cooldown/lock),
  `src/shared/transaction.ts` (`runInTransaction`), `src/shared/queue.ts` (`createQueue`,
  `createWorker`, `enqueue`, correlation ids, `callId` in logs), `src/shared/redis.ts`.
- `walletService.getBalance / append` (ledger authoritative), `requireIdempotency()`, raw-body
  webhook mount (`routes/webhook.route.ts`), OpenAPI `registerRoute`.
- Config already present: `AGORA_*`, `PRESENCE_TTL_SECONDS` (90), `PRESENCE_SWEEP_SECONDS` (60),
  `CALL_COOLDOWN_SECONDS` (45), `CALL_ORPHAN_GRACE_SECONDS` (300).
- Phase 5 contracts Phase 6 must honour (see `BUILD_PLAN.md` Revision 3):
  - write the charge as ledger key `call:<callId>:charge` (the refund looks it up);
  - the call-end session writes the charge, the wallet cache, the call fields and the
    `DoctorEarning` (`held`) together;
  - a refund reads and writes the same `DoctorEarning` row, so the write conflict serialises them;
  - `assertDoctorMayGoOnline` / `phoneVerified` gate (`doctor.gate.ts`).

---

## 2. Session 6A: call lifecycle, Agora events, presence, cooldown

### 2.1 Work items, dependencies and files

| # | Work item | Depends on | Files (new = N, change = C) |
|---|---|---|---|
| A1 | Install approved dependencies; config for Agora/FCM/cooldown | B6 | `package.json` C, `config/index.ts` C |
| A2 | `callService.start(actor, doctorId, { isUrgent })`: ONE session. For an urgent call the rate and slot come from `resolveUrgentCallRate(now, session)` (PlatformSetting only, rejects on invalid), for a normal call from the doctor's day/night rate; either way `computeMaxAffordableSeconds` (refuses a rate that is not a positive whole number of paise) and the rate is copied onto the call. Rest: Load doctor (approved, online by Redis presence, `phoneVerified`, not the caller); rate via `isWithinWindow` against `PlatformSetting` day/night; fixed once; balance read INSIDE the session via `walletService.getBalance(userId, session)`; `maxAffordableSeconds = floor(balance / rate) * 60`; below `minWalletPaise` -> low-balance response and NO call document; insert call `ringing` with rate, `commissionPercentSnapshot` (doctor override else `PlatformSetting.commissionPct`), `maxAffordableSeconds`; catch E11000 -> "doctor is busy" (409, not 500) | B3, B5 | `call/call.service.ts` N, `call.controller.ts` N, `call.route.ts` N, `call.validation.ts` N, `routes/index.ts` C |
| A3 | After commit (NOT in the session): mint Agora token scoped to the channel, expiring just past `maxAffordableSeconds` (+ `AGORA_TOKEN_GRACE_SECONDS`); FCM high-priority data message; socket `call:incoming` | A1, B6 | `shared/agora.ts` N, `shared/fcm.ts` N, `socketIo.ts` C |
| A4 | Delayed 30 s job (job id = call id): if still `ringing` -> `missed`; re-reads state, exits if moved | A2 | `call/call.jobs.ts` N, `worker.ts` C |
| A5 | Call cooldown: Redis counter per patient, window `CALL_COOLDOWN_SECONDS`; reject a second attempt inside it (429 with retry-after) | rateLimit | `call.service.ts`, uses `shared/rateLimit.cooldown` |
| A6 | `POST /api/v1/calls` behind `authenticate -> requireRole(patient) -> validate -> requireIdempotency()`; OpenAPI | A2 | `call.route.ts` |
| A7 | Agora webhook `POST /api/v1/webhooks/agora/call`: verify signature on the RAW body first; persist `AgoraCallEvent` BEFORE any derivation (duplicate = no-op via unique index); convert numeric `eventType`/`uid` to String; respond 200 for duplicates | B1, B2 | `agora/agoraWebhook.controller.ts` N, `routes/webhook.route.ts` C |
| A8 | `deriveCallDuration(callId)`: pure function over `AgoraCallEvent` rows; out-of-order, duplicates, missing leave for one party, parties leaving at different times; returns `null` when it cannot be determined; never a guess | A7 | `call/deriveCallDuration.ts` N (+ unit test) |
| A9 | Overdue-call sweep, every 30 s, ONE job, worker only. Condition A: `active` past `maxAffordableSeconds` -> normal cut-off. Condition B: `active` past `maxAffordableSeconds + CALL_ORPHAN_GRACE_SECONDS` and `deriveCallDuration` is `null` -> close `completed`, `endReason NO_END_EVENT`, gross/commission/net 0, NO ledger, NO earning, NO allowance, critical `ReconciliationFinding`, error log with `callId`, `TODO` pending client confirmation | A8, B4, B8 | `call/call.sweep.ts` N, `worker.ts` C |
| A10 | Presence: socket `presence` every 30 s sets `presence:doctor:<id>` with a 90 s TTL; on connect set the key and `Doctor.isOnline = true`; on disconnect or toggle-offline delete the key and set false; NO Mongo write per heartbeat | B6, B9 | `presence/presence.service.ts` N, `socketIo.ts` C, `shared/redis.ts` |
| A11 | Socket.IO Redis adapter | B6 | `socketIo.ts` C |
| A12 | Logging: `callId` on every line in the call lifecycle via `setCallId` | exists | `call.service.ts`, webhook controller |

### 2.2 Test scenarios (from the plan, plus the gaps found in review)

- Rate selection at 19:59 (day) and 20:01 (night) through the timezone helper; fixed at start, not recomputed.
- **Urgent rate** (rate resolution itself is already covered by `callRate.int.test.ts`; 6A adds the wiring): an urgent `POST /calls` with a valid rate uses it for the snapshot and the affordable duration; with a missing / zero / invalid rate it is rejected with 422 and writes NO call document; changing `PlatformSetting` after the call starts does not change that call's rate or its bill.
- `maxAffordableSeconds` lands on a minute boundary; computed as if the call will be charged.
- Balance below `minWalletPaise` -> low-balance response, **no** call document written.
- Balance is read inside the session; a concurrent top-up or charge does not produce a stale read (conflict, retry).
- Doctor not approved / offline (no Redis key) / `phoneVerified = false` / the caller themself -> rejected.
- Two patients call the same doctor at once: one gets the call, the other a clean "doctor is busy" (not a 500).
- A patient with a call in flight cannot start another.
- Cooldown rejects a second attempt inside the window; allows it after.
- A retried `POST /calls` with the same `Idempotency-Key` returns the first response (no second call, no second token, no second push).
- Webhook: bad/missing signature -> logged, dropped, nothing written; good signature persists the event first; a duplicate delivery is a no-op; a forged `leave` event with a bad signature never shortens a call.
- `deriveCallDuration`: normal; out-of-order; duplicate; missing leave for one party; parties leave at different times; **returns `null` when undeterminable** (never a guess).
- Orphan sweep: Condition A cuts off an overdue call; Condition B closes a call with no end event, writes **no** ledger/earning/allowance, raises a critical finding; a call that merely ran long but has events is NOT closed by B; the sweep is idempotent (run twice).
- The ringing-to-missed job runs twice safely; does nothing if the call already moved.
- Presence key expires after 90 s (use a controllable clock); heartbeat refreshes it; disconnect deletes it; no Mongo write per heartbeat (assert write count).
- Real-Redis variants of presence expiry and cooldown (`TEST_REDIS_URL`).

### 2.3 Acceptance criteria (6A)

1. A patient with enough balance can start a call to an approved, online, phone-verified doctor; the call has a fixed rate snapshot and an affordable duration on a minute boundary.
2. No money moves in 6A: no ledger row, no earning, no allowance.
3. An urgent call with a missing, zero or invalid rate is refused (422) and never gets an infinite affordable duration. A busy doctor, a low balance and a cooldown each return a clean 4xx, never a 500, and never leave a half-written call.
4. An unverified Agora webhook changes nothing. A duplicate changes nothing.
5. A call whose end event never arrives cannot block a doctor forever: the sweep closes it, writes no money, and an admin sees a critical finding.
6. `isOnline` is not trusted: a dead app's doctor stops receiving calls within the TTL.
7. All of the above covered by integration tests on the real replica set; the Redis-dependent ones also run against real Redis.
8. `npm test`, `npm run build`, `npm run lint` clean for new files; OpenAPI documents every new route.

---

## 3. Session 6B: billing

### 3.1 Work items, dependencies and files

| # | Work item | Depends on | Files |
|---|---|---|---|
| B-1 | `resolveBilling({ durationSeconds, isFree, ratePaisePerMin, commissionPercent })` and `billedMinutes` (pure; `< 60s -> 0`, else `ceil(s/60)`; exactly 60 s is chargeable). The ONLY billing function | none | `billing/resolveBilling.ts` N (+ unit test) |
| B-2 | `callService.end()` in ONE session (rate and commission come from the SNAPSHOT on the call, urgent or not, never read live from PlatformSetting or the doctor): duration from `deriveCallDuration` (client "I ended" is a hint only); if `< 60 s`, try `ShortCallAllowance.create` in the session (E11000 -> not free); `resolveBilling`; rate and commission from the call snapshot, never live; paid: `walletService.append` debit with key `call:<callId>:charge`, call final fields, `DoctorEarning` `held` (none for a retainer doctor); free: zero amounts, no ledger, no earning, `prescriptionStatus = not_required`, `isFreeShortCall = true`, no jobs | A8, B-1, Phase 5 | `call/call.service.ts` C |
| B-3 | After commit, paid call: `prescriptionDeadlineAt = +2 h`; enqueue the 1 h reminder and 2 h expiry jobs, job id = call id | B-2 | `call/call.jobs.ts` C |
| B-4 | `ended_low_balance` treated exactly like `completed`; Prescription `callEndedEarly` set by the server from `Call.endReason` (Phase 7 reads it; this phase sets the field's source of truth) | B-2 | `call.service.ts` |
| B-5 | Cut-off, three layers: Agora token expiry (A3), in-process timer closing the channel via the Agora REST API at `maxAffordableSeconds`, the 30 s sweep (A9). `call:warning` to both parties at 60 s remaining | A3, A9 | `call/call.timers.ts` N, `shared/agora.ts` C |
| B-6 | Call history responses carry `isFreeShortCall` | B-2 | `call.controller.ts` |

### 3.2 Test scenarios

- 59 s free; 60 s billed 1 minute; 61 s billed 2 minutes; 120 s = 2 minutes; 121 s = 3.
- First short call to a doctor free; a second to the SAME doctor within 24 h billed 1 minute; a short call to a DIFFERENT doctor within 24 h still free.
- Exactly 60 s consumes **no** allowance.
- Two concurrent call-end handlers for one patient/doctor pair: exactly one gets the free slot.
- An aborted call-end transaction releases the allowance (the insert is in the session).
- A free call writes no ledger row, no earning row, queues no jobs, `prescriptionStatus = not_required`, `isFreeShortCall = true`, still appears in history.
- A paid call writes: one debit (key `call:<id>:charge`), the cache, the final fields and one `held` earning, all in one session; a failure after the debit rolls ALL of it back.
- Call-end delivered twice (duplicate Agora event / retried handler): one charge, one earning (idempotent on the key and `DoctorEarning.callId` unique).
- Rate and commission come from the call snapshot: changing the doctor's rate or `PlatformSetting.commissionPct` after the call starts does not change the bill.
- Affordable duration enforced: the charge never exceeds the balance (the debit never goes negative).
- A `NO_END_EVENT` call never reaches `resolveBilling`.
- Retainer doctor: charge written, **no** earning row.
- Refund after a billed call (Phase 5 path): refund finds the charge by key and handles the earning created here, held and released.
- Concurrency with other money: call-end vs a top-up webhook for the same patient; call-end vs admin refund of an earlier call; ledger chain stays consistent.
- `resolveBilling` property test: gross = billedMinutes x rate, commission + net = gross, all integers, never negative.

### 3.3 Acceptance criteria (6B)

1. The billing table in `CLAUDE.md` holds exactly, including "60 seconds exactly is chargeable".
2. There is exactly one billing function and every caller uses it.
3. All money is integer paise; the patient is charged, the doctor's earning is held, in one transaction.
4. The free short call is one per patient/doctor pair per rolling 24 h, decided at call end, race-free.
5. A zero-charge call takes the different path in `CLAUDE.md` (no ledger, no earning, `not_required`, no jobs).
6. The ledger chain and the wallet cache agree after any mix of concurrent calls, top-ups and refunds.
7. The call end is never triggered by, or priced from, anything the client sends.

---

## 4. Cross-cutting requirements for both sessions

- Layers on every protected route: authenticate -> requireRole -> ownership inside the service (`callService` takes an actor and a target).
- Transactions: only call start, call end (and the existing top-up, prescription, withdrawal, refund). Reads inside the session; no external call inside a session (token minting, FCM, socket, Agora REST all AFTER commit).
- Retry-safety: callbacks are re-run on `TransientTransactionError`; compute nothing outside the callback that the callback depends on.
- Delayed jobs: job id = call id, handlers re-read state and exit if it has moved; worker process only.
- Notifications that must not be lost (missed call, low balance, call ended) go through the existing `OutboxEvent` outbox; the time-critical `call:incoming` push is best effort plus the ringing timeout.
- Every route registered in OpenAPI; correlation ids (`requestId`, `callId`) in logs and job data.

## 5. Manual verification that code and tests cannot do

- Real Agora: token mint accepted by the Agora client SDK; a real notification delivery (confirms B1/B2: signature, `noticeId`, `clientSeq`, field names, timestamps); REST channel-close.
- Real FCM: high-priority data message wakes a killed app on Android; iOS behaviour.
- Real devices: the 30 s `presence` heartbeat survives backgrounding; the 60 s `call:warning`.
- Two API instances behind the Redis adapter: a doctor on instance A receives `call:incoming` emitted from instance B.
- Load: 40 doctors rung in two minutes by one patient is stopped by the cooldown.

## 6. Suggested order

`B1/B2 confirmed -> A1 -> A8 (pure, testable now) -> A7 -> A2/A5/A6 -> A3/A4 -> A10/A11 -> A9 -> 6A tests -> B-1 -> B-2/B-3/B-4 -> B-5/B-6 -> 6B tests -> full regression with real Redis`.

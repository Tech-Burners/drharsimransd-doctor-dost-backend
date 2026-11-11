# Progress

Read this first in a fresh session, then `CLAUDE.md` and the current phase in
`BUILD_PLAN.md`. Update it at the end of every phase.

## Done

- **Phase 2 - Schema fixes.** Existing model fixes and the new collections (`Wallet`,
  `DeviceToken`, `NotificationSetting`, `ShortCallAllowance`, `IdempotencyKey`,
  `SettingChangeLog`, `AgoraCallEvent`, `ReconciliationFinding`). Soft-delete plugin on
  `User`, `Doctor`, `DoctorVerification` only. Indexes verified on MongoDB 8.2.7
  (standalone, local).
- **Phase 3 - Foundation.** App shell (helmet, cors, compression, request id, raw-body
  webhook mount before the JSON parser), one response envelope and global error handler,
  explicit Mongo pool size, Redis + BullMQ factory, separate worker entrypoint, pino
  logging with redaction and correlation ids, health endpoint, seed script, docker-compose
  replica set, Jest + replica-set test harness, IST time helper, `requireIdempotency()`,
  Sentry, OpenAPI registry, this file. Awaiting commit approval.

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

- **Phase 4 - Auth.** Must also enforce `User.phone` for doctors at registration.
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
  - `utils/openAi.ts:9` reads a `config.openai_api_key` that does not exist. Nothing imports
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

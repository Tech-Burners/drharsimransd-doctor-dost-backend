# DoctorDost — Backend

Telemedicine voice-calling platform for Tripura, India. Patients pay per minute from a prepaid
wallet to call verified doctors. This repository is the **backend only**. It serves three clients:

- Patient app (Flutter)
- Doctor app (Flutter)
- Admin dashboard (web)

> **Read first:** [CLAUDE.md](CLAUDE.md) (hard rules, billing, transactions, open questions),
> [BUILD_PLAN.md](BUILD_PLAN.md) (phases) and [PROGRESS.md](PROGRESS.md) (current state and
> what is verified).

## Table of Contents

1. [Status](#status)
2. [Tech Stack](#tech-stack)
3. [Architecture](#architecture)
4. [Directory Structure](#directory-structure)
5. [Getting Started](#getting-started)
6. [Environment Variables](#environment-variables)
7. [Scripts](#scripts)
8. [API Conventions](#api-conventions)
9. [Testing](#testing)
10. [Jobs and the Worker](#jobs-and-the-worker)
11. [Core Rules](#core-rules)
12. [Open Questions](#open-questions)
13. [Security Notes](#security-notes)

---

## Status

| Phase | State |
|---|---|
| 2 — Schema fixes | Done (committed) |
| 3 — Foundation | Done, awaiting commit approval |
| 4 — Auth | Not started |
| 5 — Wallet and payments | Not started |

Phase 3 provides the app shell, response envelope, logging, Redis/BullMQ factories, worker
entrypoint, health endpoint, seed script, replica-set docker-compose, test harness and the
OpenAPI registry. Business endpoints (calls, wallet, prescriptions, withdrawals) are **not
built yet**; the models for them exist. See [PROGRESS.md](PROGRESS.md) for exactly what has and
has not been verified.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript, Express |
| Database | MongoDB (replica set required) via Mongoose |
| Jobs | Redis + BullMQ, run in a separate worker process |
| Real-time | Socket.IO (signalling) |
| Voice | Agora (call duration comes from the server-side webhook) |
| Payments | Razorpay (wallet top-ups, webhook-only credit) |
| Push | FCM via `firebase-admin` |
| Storage | S3-compatible object storage (private, signed URLs) |
| SMS | Provider for doctor phone verification (not yet chosen) |
| Validation | zod at the route boundary |
| API docs | `@asteasolutions/zod-to-openapi` registry, served at `/docs` |
| Logging | pino with redaction and request/call correlation ids |
| Monitoring | Sentry (disabled when `SENTRY_DSN` is blank) |
| Time | `date-fns-tz`, all rate windows evaluated in `Asia/Kolkata` |
| Tests | Jest + ts-jest, `mongodb-memory-server` replica set |

---

## Architecture

Modules are vertical slices under `src/app/modules/<name>/`:

```
model · interface · constants · validation · service · controller · route
```

```
Request
  → route        (authenticate → requireRole → validateRequest → requireIdempotency)
    → controller   (thin: validate, delegate, send response)
      → service      (business logic, owns transactions, ownership checks)
        → model        (Mongoose schema, strict mode)
```

- Route handlers hold **no business logic**. A service method takes an actor and a target, so
  the ownership check cannot be omitted by signature.
- Errors go through one `AppError` class and one global error handler.
- Soft delete uses the shared `softDeletePlugin` and only on `User`, `Doctor` and
  `DoctorVerification`. Financial, audit and allowance collections have **no** soft delete.
- Webhook routes are mounted **before** `express.json()` behind `express.raw()`, so signature
  verification runs on the exact bytes received.

Middleware order in `src/app.ts`: request id → helmet → compression → CORS → pino-http →
webhooks (raw body) → static / body parsers → request id (again) → cookies → rate limit →
`/api/v1` → `/docs` → home page → 404 → global error handler.

---

## Directory Structure

```
├── src/
│   ├── app.ts                  # Express app
│   ├── server.ts               # API bootstrap (Mongo, HTTP, Socket.IO, Sentry)
│   ├── worker.ts               # Worker process entrypoint (separate from the API)
│   ├── seed.ts                 # Idempotent PlatformSetting + admin seed
│   ├── app/
│   │   ├── config/             # Env access
│   │   ├── middleware/         # auth, requestId, requireIdempotency, validateRequest, errors
│   │   ├── modules/            # Feature slices (see below)
│   │   ├── routes/             # /api/v1 router, webhook router, /docs
│   │   └── utils/              # sendResponse, mailer, token, limiter, logger
│   ├── shared/                 # time, logger, requestContext, sentry, db, redis, queue, openapi
│   └── test/                   # Test setup and DB helper
├── docs/                       # TESTING.md, erd, figma, requirements
├── docker-compose.yml          # One-node Mongo replica set + Redis
├── env.example                 # Environment template
├── PROGRESS.md                 # Phase state and verification log
└── jest.config.js
```

**Modules** (`src/app/modules/`): `user`, `auth`, `otp`, `refreshToken`, `doctor`,
`doctorVerification`, `call`, `wallet`, `payment`, `doctorEarning`, `prescription`, `rating`,
`withdrawalRequest`, `notification`, `notificationSetting`, `deviceToken`, `platformSetting`,
`settingChangeLog`, `researchConsent`, `recordingAccessLog`, `shortCallAllowance`,
`idempotencyKey`, `agoraCallEvent`, `reconciliationFinding`, `contactUs`, `setting`, `health`.

Many of these are schema-only until their phase is built.

---

## Getting Started

### Prerequisites

- Node.js (LTS)
- Docker (for the local replica set and Redis)

### Install and configure

```bash
npm install
cp env.example .env     # then fill in real values. Never commit .env
```

### Start local services

MongoDB **must** be a replica set. Money writes run in transactions, and a standalone `mongod`
cannot run them. If a transaction throws because of the topology, fix the topology; never
remove the session.

```bash
docker compose up -d
```

Then in `.env`:

```
DATABASE_URL=mongodb://localhost:27017/doctordost?replicaSet=rs0&directConnection=true
REDIS_URL=redis://localhost:6379
```

### Run

```bash
npm run seed      # creates PlatformSetting and the default admin (safe to re-run)
npm run dev       # API
npm run worker    # worker, in a second terminal
```

Health check: `GET /api/v1/health` returns 200 when Mongo and Redis are up and 503 when
degraded.

### Production

```bash
npm run build
npm run start:prod      # API
npm run start:worker    # worker, as its own process
```

---

## Environment Variables

The full, commented list is in [env.example](env.example). Groups:

| Group | Variables |
|---|---|
| Server | `NODE_ENV`, `PORT`, `IP`, `SOCKET_PORT`, `PROJECT_NAME`, `API_PUBLIC_URL`, `CORS_ORIGINS` |
| Database | `DATABASE_URL`, `MONGO_MAX_POOL_SIZE` |
| Redis | `REDIS_URL`, `REDIS_PASSWORD` |
| Auth | `BCRYPT_SALT_ROUNDS`, `JWT_ACCESS_*`, `JWT_REFRESH_*` |
| OTP | `OTP_EXPIRE_TIME`, `OTP_TOKEN_EXPIRE_TIME`, `OTP_MAX_ATTEMPTS` |
| Default admin | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_PHONE` |
| Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| Agora | `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `AGORA_WEBHOOK_SECRET`, `AGORA_TOKEN_GRACE_SECONDS`, `AGORA_CUSTOMER_*` |
| Push | `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_BASE64` |
| SMS | `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER_ID`, `SMS_TEMPLATE_ID` |
| Storage | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SIGNED_URL_TTL_SECONDS` |
| Email | `NODEMAILER_HOST_EMAIL`, `NODEMAILER_HOST_PASS`, `CONTACT_EMAIL`, `LOGO_URL`, `ALERT_EMAIL` |
| Monitoring | `SENTRY_DSN`, `LOG_LEVEL`, `LOG_PRETTY` |
| Tuning | `PRESENCE_TTL_SECONDS`, `PRESENCE_SWEEP_SECONDS`, `CALL_COOLDOWN_SECONDS`, `CALL_ORPHAN_GRACE_SECONDS` |
| Home page monitor | `MONITOR_USERNAME`, `MONITOR_PASSWORD` |

Secrets live in env only. Never commit a Razorpay key, the Agora certificate, a JWT secret or
SMS credentials. `.env` and `.env.*` are git-ignored; `env.example` is tracked.

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | API in watch mode |
| `npm run worker` | Worker in watch mode |
| `npm run build` | Compile with `tsc` to `dist/` |
| `npm run start:prod` | Run the compiled API |
| `npm run start:worker` | Run the compiled worker |
| `npm run seed` | Seed platform settings and the default admin |
| `npm test` | All tests |
| `npm run test:unit` | Unit tests only (skips `*.int.test.ts`) |
| `npm run test:integration` | Integration tests only |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run prettier` / `prettier:fix` | Prettier |

`npm run build` currently reports two pre-existing type errors, in `modules/otp/otp.utils.ts`
and `utils/openAi.ts`. They are documented in [PROGRESS.md](PROGRESS.md).

---

## API Conventions

- Routes live under `/api/v1`. The OpenAPI spec is served at `/docs` (admin-only in
  production). Every route registers its zod schemas with the registry as it is written.
- **Response envelope**, success and error alike:

```jsonc
// success
{ "success": true, "message": "…", "data": { }, "meta": null }

// error
{
  "success": false,
  "message": "…",
  "data": null,
  "meta": { "requestId": "…", "errorSources": [{ "path": "", "message": "…" }] }
}
```

  `meta` carries pagination on list endpoints. `stack` appears in `meta` only in development.
  Send `X-Request-Id` to set your own correlation id; it is echoed back.
- **Auth:** all three roles sign in with email and password. Every protected route runs
  authenticate → `requireRole` → an ownership check inside the service. The authenticated
  subject comes from the token, never from the body, query or path.
- **Idempotency:** money-creating POSTs require an `Idempotency-Key` header:
  `/wallet/orders`, `/calls`, `/doctor/withdrawals`, `/calls/:id/prescription`. The same key
  with the same body replays the stored response; the same key with a different body is a 409.
- **Money** is always integer paise. Format at the edge only.
- **Time:** stored as UTC. Rate-window logic goes through `src/shared/time.ts` in
  `Asia/Kolkata`.

---

## Testing

```bash
npm test
```

Integration tests start an in-memory MongoDB **replica set**, so transactions are exercised for
real. No Docker is needed for the tests. See [docs/TESTING.md](docs/TESTING.md).

---

## Jobs and the Worker

Workers run in a **separate process**, never in the API; scheduled work registered in the API
would run once per instance. Phase 3 ships the worker shell only. Later phases register:

| Job | Trigger |
|---|---|
| Prescription reminder | Delayed 1h after call end, job id = call id |
| Prescription expiry + refund | Delayed 2h after call end, job id = call id |
| Overdue-prescription sweep | Every 15 min |
| Overdue-call sweep | Every 30 s |
| Presence sweep | Every 60 s |
| Nightly reconciliation | Paid orders without ledger entry, ledger vs calls, cache vs ledger |
| Dead token cleanup | Daily |

Delayed jobs use the call id as the BullMQ job id, so enqueuing twice is a no-op, and every
handler re-reads state and exits if it has already moved.

---

## Core Rules

Summary of [CLAUDE.md](CLAUDE.md); that file is authoritative.

1. No client is trusted for money, duration or state. Everything is recomputed server-side.
2. `WalletLedger` is authoritative. `Wallet.balancePaise` is a display cache, written in the
   same transaction and never read to make a decision.
3. Call duration comes from the Agora server-side webhook, not the client.
4. All money is integer paise.
5. Route handlers hold no business logic. Services own transactions.
6. Three-layer authorization on every protected route.
7. Open questions are never answered with an invented default.

**Billing** is one function, `resolveBilling()`, used by every caller. It rounds up to the next
minute; under 60 s is 0 minutes, and exactly 60 s is chargeable. One free short call is
allowed per patient and doctor pair per rolling 24 hours, decided at call end. Platform
commission is 20%, overridable per doctor.

**Transactions** run in exactly five operations: call start, call end, top-up credit,
prescription submit and withdrawal request.

---

## Open Questions

Parked, not blocking. Each has a placeholder; do not default them.

- When does the night window end? (`PlatformSetting.dayStartTime`, currently `06:00`; the Figma
  showed `08:00`)
- Research consent purpose and wording (the feature is blocked until the text arrives)
- PAN and TDS: deduction per call or per payout?
- Urgent call rate policy (`urgentCall*RatePaise` is `0`, so urgent calls are currently free)
- Review comment visibility, reviewer naming and takedown rights
- What is billed when the Agora end event never arrives? The sweep closes the call without a
  ledger entry or earning and raises a critical `ReconciliationFinding` for an admin.

---

## Security Notes

- A remote-code `eval()` block was found and removed from `src/server.ts` in Phase 3. Its
  origin is unknown. Treat the repository as possibly tampered with and rotate any secret that
  was on a machine that ran it with `AUTH_API_KEY` set. Details in [PROGRESS.md](PROGRESS.md).
- Logs redact sensitive fields. Never log tokens, OTPs or payment secrets.
- The server home page monitor credentials are rendered into client-side script. Treat them as
  low-security and consider disabling the page in production.

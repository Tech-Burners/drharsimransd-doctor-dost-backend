# StaffSecure — HR Management Backend

A role-based HR / recruitment platform API connecting **Employers** and **Candidates**, with admin oversight, job postings, applications, real-time chat, notifications, and Stripe-powered subscriptions.

**Live API:** [https://api.staffsecure.ai/](https://api.staffsecure.ai/)
**Live Socket.IO server:** [https://socket.staffsecure.ai](https://socket.staffsecure.ai)

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Project Architecture](#project-architecture)
4. [Directory Structure](#directory-structure)
5. [Getting Started](#getting-started)
6. [Environment Variables](#environment-variables)
7. [Available Scripts](#available-scripts)
8. [Internationalization (i18n)](#internationalization-i18n)
9. [Theming & UI](#theming--ui)
10. [API & Data Fetching](#api--data-fetching)
11. [Deployment](#deployment)

---

## Overview

StaffSecure is a **REST + WebSocket API** built with Express and TypeScript on top of MongoDB. It serves three user roles:

- **Admin** — approves/manages users, views platform-wide overview stats, manages CMS-style settings (privacy policy, terms, cookies), receives payment reports.
- **Employer** — posts jobs, reviews applications, subscribes to a paid plan (Stripe) to unlock hiring features.
- **Candidate** — builds a profile (CV, documents, image), applies to jobs, chats with employers.

Core capabilities:

- JWT-based authentication with OTP-verified signup and password reset
- Role-based access control (`admin`, `employer`, `candidate`)
- Job posting & application lifecycle management
- Real-time chat and messaging via Socket.IO
- In-app + email notifications
- Stripe Checkout subscriptions with a nightly cron job to expire/renew subscriptions
- File uploads (profile images, CVs, documents) parsed via Multer, with CV parsing support (`pdf-parse`, `mammoth`) and OpenAI integration for CV analysis
- Centralized structured logging (Winston, daily-rotated files) and request rate limiting

---

## Tech Stack

| Layer            | Technology                                                                 |
|-------------------|-----------------------------------------------------------------------------|
| Runtime           | Node.js + TypeScript                                                       |
| Web framework     | Express 4                                                                   |
| Database          | MongoDB via Mongoose 8                                                     |
| Real-time         | Socket.IO 4 (dedicated port, JWT-authenticated handshake)                  |
| Auth              | JSON Web Tokens (`jsonwebtoken`), `bcrypt` password hashing                |
| Validation        | Zod schemas per module                                                     |
| Payments          | Stripe (Checkout Sessions, subscriptions, webhooks)                        |
| Email             | Nodemailer                                                                  |
| File uploads      | Multer (disk storage under `public/uploads`)                               |
| Document parsing  | `pdf-parse`, `mammoth` (CV/resume parsing)                                  |
| AI                | OpenAI SDK (CV/job-related AI features)                                    |
| Scheduling        | `node-cron` (subscription expiry/renewal jobs)                             |
| Logging           | Winston + `winston-daily-rotate-file`                                      |
| Rate limiting     | `express-rate-limit`                                                       |
| Tooling           | ESLint, Prettier, `ts-node-dev` (dev), `tsc` (build)                       |

---

## Project Architecture

The backend follows a **modular, layered architecture** (routes → controller → service → model), inspired by the common Express/TypeScript "module pattern":

```
Request
  → routes        (defines endpoint, applies auth/validation middleware)
    → controller   (parses req, calls service, sends response via sendResponse)
      → service     (business logic, DB queries via Mongoose + QueryBuilder)
        → model       (Mongoose schema/model)
```

Each feature lives in its own module under `src/app/modules/<name>/` and typically contains:

- `*.route.ts` — Express router, wires middleware (`auth`, `validateRequest`, `fileUpload`) to controller methods
- `*.controller.ts` — thin HTTP layer, wrapped in `catchAsync` to forward errors to the global handler
- `*.service.ts` — business logic and database access
- `*.model.ts` — Mongoose schema
- `*.interface.ts` — TypeScript types
- `*.validation.ts` — Zod request-validation schemas
- `*.constants.ts` — enums/constants (e.g. roles, statuses)

Cross-cutting concerns live outside the modules:

- **`middleware/`** — auth guard, file upload, request validation, error handling, 404 handling
- **`error/`** — typed error classes/handlers (Zod, Mongoose validation, cast, duplicate-key, Multer) normalized into one response shape by `globalErrorhandler.ts`
- **`builder/QueryBuilder.ts`** — chainable helper for search, filter, sort, paginate, field-selection on any Mongoose query
- **`utils/`** — logger, mailer, token management, rate limiters, response helper, OpenAI client, notification helper
- **`DB/`** — bootstraps a default admin account on startup

**Entry points:**

- `src/server.ts` — connects to MongoDB, starts the HTTP server, starts the Socket.IO server, starts cron jobs, seeds the default admin
- `src/app.ts` — builds the Express app: static files, CORS, JSON/cookie parsing, HTTP request logging, rate limiting, mounts `/api/v1` routes, error handlers
- `src/socketIo.ts` — Socket.IO server: JWT-authenticated handshake, presence tracking (`connectedUsers`), real-time chat events, and an `emitNotification` helper used across modules to push notifications + optional email

---

## Directory Structure

```
├── src/
│   ├── app.ts                  # Express app configuration
│   ├── server.ts                # App bootstrap (DB, HTTP server, cron, socket)
│   ├── socketIo.ts              # Socket.IO server & real-time chat/notifications
│   └── app/
│       ├── DB/                  # Default admin seeding
│       ├── builder/             # QueryBuilder (search/filter/sort/paginate)
│       ├── config/              # Centralized env var access (config/index.ts)
│       ├── error/                # Typed error handlers (Zod, Cast, Duplicate, Multer, Validation)
│       ├── helpers/              # serverHomePage (root "/" dashboard HTML)
│       ├── interface/            # Shared TS types (common, query, error, globals)
│       ├── middleware/           # auth, fileUpload, parseData, validateRequest, error/404 handlers
│       ├── modules/              # Feature modules (see below)
│       ├── routes/index.ts       # Mounts every module router under /api/v1
│       └── utils/                # logger, mailer, limiter, token, OpenAI, notify helpers
├── public/uploads/               # Uploaded files, served statically (profile, work, chat, etc.)
├── logs/                         # Winston daily-rotated log files
├── dist/                         # Compiled JS output (tsc build target)
├── .env.example                  # Sample environment configuration
└── tsconfig.json
```

**Feature modules** (`src/app/modules/`):

| Module              | Responsibility                                                         |
|---------------------|--------------------------------------------------------------------------|
| `auth`               | Login, refresh token, forgot/reset password (OTP by email or phone)     |
| `user`               | Registration + OTP verification, profile & candidate-profile management, admin user management |
| `candidateProfile`   | Candidate profile schema/interface used by the `user` module            |
| `otp`                | OTP resend flow                                                          |
| `job`                | Job CRUD, listing, status updates, applicant counts                     |
| `application`        | Candidate job applications and their lifecycle                          |
| `chat` / `message`   | Conversation + message persistence backing the Socket.IO real-time layer |
| `notifications`      | In-app notification CRUD, read/unread tracking                          |
| `payment`            | Stripe checkout sessions, subscription cancel/auto-renew, payments received (admin) |
| `mySubscription`     | Employer's current subscription record                                  |
| `overview`           | Admin dashboard statistics                                               |
| `setting`            | CMS-style pages: privacy policy, terms & conditions, cookies policy, dynamic docs |
| `contactUs`          | Public contact form submission                                          |

---

## Getting Started

### Prerequisites

- Node.js (LTS recommended)
- A MongoDB instance (local or Atlas)
- A Stripe account (test mode keys are fine for local dev)
- An SMTP-capable email account for Nodemailer (e.g. Gmail app password)

### Installation

```bash
git clone <repository-url>
cd Stuff_Secure_HR_Management_Backend
npm install
```

### Configure environment

Copy the example file and fill in real values (see [Environment Variables](#environment-variables)):

```bash
cp .env.example .env
```

### Run in development

```bash
npm run dev
```

This starts the API (via `ts-node-dev`, auto-restarting on file changes) on `http://<IP>:<PORT>` and the Socket.IO server on `SOCKET_PORT`. On boot it will:

1. Connect to MongoDB
2. Start the subscription cron job
3. Seed a default admin account (from `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_PHONE`) if one doesn't exist
4. Initialize Socket.IO

### Build & run for production

```bash
npm run build      # compiles TypeScript -> dist/
npm run start:prod # node ./dist/server.js
```

---

## Environment Variables

Defined in `.env` (see `src/app/config/index.ts` for how each is consumed). Reference: `.env.example`.

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development` \| `production` — also gates CORS origin allow-listing |
| `PORT` | HTTP API port |
| `SOCKET_PORT` | Socket.IO server port |
| `IP` | Host/IP used in startup log messages |
| `PROJECT_NAME` | Display name |
| `BACKEND_URL` / `SERVER_URL` / `CLIENT_URL` / `FRONTEND_URL` | Base URLs used for links (emails, redirects, uploaded-file URLs) |
| `DATABASE_URL` | MongoDB connection string |
| `JWT_ACCESS_SECRET` / `JWT_ACCESS_EXPIRES_IN` | Access token secret & TTL |
| `JWT_REFRESH_SECRET` / `JWT_REFRESH_EXPIRES_IN` | Refresh token secret & TTL |
| `BCRYPT_SALT_ROUNDS` | Password hashing cost factor |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_PHONE` | Seed credentials for the default admin account |
| `NODEMAILER_HOST_EMAIL` / `NODEMAILER_HOST_PASS` | SMTP sender credentials (OTP emails, notifications) |
| `OTP_TOKEN_EXPIRE_TIME` / `OTP_EXPIRE_TIME` | OTP token/code expiry windows |
| `STRIPE_API_KEY` / `STRIPE_API_SECRET` / `STRIPE_WEBHOOK_SECRET` | Stripe integration (checkout, webhook signature verification) |
| `OPENAI_API_KEY` | OpenAI SDK access (CV/job AI features) |
| `AWS_*` / `S3_BUCKET_*` | Reserved for S3-based file storage (config scaffolding present; current uploads are local disk) |
| `MONITOR_USERNAME` / `MONITOR_PASSWORD` | Credentials for the server monitoring/dashboard page |
| `LOGO_URL` | Branding asset URL used in outgoing emails/dashboard |

> ⚠️ The committed `.env` contains live-looking credentials (Mongo Atlas URI, Gmail app password, admin password). Treat these as compromised — rotate them and ensure `.env` is excluded from version control going forward.

---

## Available Scripts

| Script | Command | Description |
|---|---|---|
| `npm run dev` | `ts-node-dev --respawn --transpile-only src/server.ts` | Start the API in watch mode |
| `npm run build` | `tsc` | Compile TypeScript to `dist/` |
| `npm run start:prod` | `node ./dist/server.js` | Run the compiled production build |
| `npm run lint` | `eslint .` | Lint the codebase |
| `npm run lint:fix` | `eslint . --fix` | Lint and auto-fix |
| `npm run prettier` | `prettier --write "./src/**/*.+(js|ts|json)"` | Format source files |
| `npm run prettier:fix` | `prettier --write .` | Format entire project |

> Note: `npm test` is currently a placeholder (`echo "Error: no test specified"`) — no automated test suite exists yet.

---

## Internationalization (i18n)

This is a backend-only API service, not a rendered UI, so there is no i18n/translation framework wired in. Text (validation messages, error messages, emails) is currently hard-coded in English.

The only locale-sensitive concern is **time zones**: subscription cron jobs and timestamped chat messages use `moment-timezone`, with the cron scheduler fixed to `Europe/London` (`payment.cron.ts`) and message timestamps controlled by the `APP_TIMEZONE` config value (falls back to UTC).

If a client-facing frontend needs localized copy, that would live in the frontend application, not here.

## Theming & UI

There's no design system in this repository — it's an API. The only server-rendered UI is:

- **`GET /`** — a lightweight HTML status/dashboard page (`src/app/helpers/serverHomePage.ts`), useful for a quick "is the server up" check and basic monitoring, gated by the `MONITOR_USERNAME` / `MONITOR_PASSWORD` env vars.
- **`public/`** — static file host for uploaded assets (profile images, CVs/documents, chat images, etc.), organized by feature under `public/uploads/<category>/`.

Any actual product UI (candidate/employer/admin dashboards) is expected to be a separate frontend consuming this API.

---

## API & Data Fetching

### Base URL & routing

All module routes are mounted under a single versioned prefix:

```
{BACKEND_URL}/api/v1/<module>
```

e.g. `https://api.staffsecure.ai/api/v1/auth/login`, `.../job/all`, `.../users/my-profile`.

| Path prefix | Module |
|---|---|
| `/auth` | login, refresh token, forgot/reset password |
| `/users` | registration, profile, admin user management |
| `/otp` | OTP resend |
| `/job` | job postings |
| `/application` | job applications |
| `/chat`, `/message` | conversations & messages |
| `/notifications`, `/notification` | in-app notifications |
| `/payment` | Stripe checkout & subscription payments |
| `/subscription` | current employer subscription |
| `/overview` | admin dashboard stats |
| `/settings` | privacy policy / terms / cookies / dynamic docs |
| `/contactUs` | public contact form |

### Authentication

- Stateless JWT auth. Send the access token as `Authorization: Bearer <token>` (or a raw `token` header).
- The `auth(...roles)` middleware (`src/app/middleware/auth.ts`) verifies the token, loads the user, and enforces role membership (`admin`, `employer`, `candidate`) per-route.
- Access/refresh tokens are issued on login (`POST /api/v1/auth/login`) and renewed via `POST /api/v1/auth/refresh-token`.
- Signup requires OTP verification (`POST /api/v1/users/create` → `POST /api/v1/users/create-user-verify-otp`); password reset uses a separate OTP flow (`forgot-password-otpByEmail` / `...ByNumber` → `forgot-password-otp-match` → `forgot-password-reset`).

### Request/response conventions

- JSON body for standard requests; `multipart/form-data` for endpoints that accept files (profile image, CV, documents) via `fileUpload` (Multer, 50MB limit, image/video/PDF/doc types only) combined with a `parseData()` middleware that JSON-parses non-file fields sent alongside `FormData`.
- Request bodies are validated with **Zod** schemas (`validateRequest` middleware) before reaching the controller; validation failures are normalized by the global error handler.
- All responses share one envelope shape, built by `sendResponse()`:

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Job fetched successfully",
  "meta": { "page": 1, "limit": 10, "total": 42, "totalPage": 5 }, // present on list endpoints
  "data": { /* ... */ }
}
```

- Errors share a matching shape (`success: false`, `message`, `errorSources[]`, plus a stack trace only in development), produced centrally in `globalErrorhandler.ts` regardless of whether the failure originated from Zod, Mongoose (cast/validation/duplicate key), Multer, or a manually thrown `AppError`.

### Listing, search, filter, pagination

List endpoints share a common query-string contract implemented by `QueryBuilder` (`src/app/builder/QueryBuilder.ts`):

| Query param | Effect |
|---|---|
| `search` / `searchTerm` | Case-insensitive regex match across a module's configured searchable fields |
| `<fieldName>=value` | Case-insensitive regex filter on that specific field |
| `sort` | Comma-separated field list, e.g. `sort=-createdAt,name` (defaults to `-createdAt`) |
| `page`, `limit` | Pagination (defaults: page `1`, limit `10`) |
| `fields` | Comma-separated projection, e.g. `fields=name,email` |

### Real-time (Socket.IO)

- Connect to the dedicated Socket.IO server — locally on `SOCKET_PORT`, in production at [https://socket.staffsecure.ai](https://socket.staffsecure.ai) — authenticating via `auth.token` (or `token`/`authorization` header) in the handshake, verified against the same JWT access secret as the REST API.
- Key events: `send-message` (persists + broadcasts a chat message, falls back to a push notification if the recipient is offline), `my-chat-list`, `onlineUser` presence broadcast, `notification` (unread-count push), `disconnect`.
- `emitNotification()` (`src/socketIo.ts`) is the shared helper other modules call to push a real-time notification, persist it, and optionally send a companion email.

### Payments (Stripe)

- `POST /api/v1/payment/create-checkout-session` (employer) creates a Stripe Checkout Session for a subscription plan.
- Stripe webhooks are received raw (pre-JSON-parsing) at `POST /api/v1/payment/webhook`, mounted directly in `app.ts` before `express.json()` so the signature can be verified against the raw body.
- A nightly cron job (`payment.cron.ts`, 02:00 Europe/London) expires lapsed subscriptions and processes year-end cancellations.

### File uploads

- Uploaded files are stored on local disk under `public/uploads/<category>/` and served statically at `{BACKEND_URL}/uploads/<category>/<filename>`.
- `AWS_*` / `S3_BUCKET_*` config keys exist as scaffolding for a future move to S3-backed storage but aren't currently wired into the upload middleware.

---

## Deployment

- **Live API:** [https://api.staffsecure.ai/](https://api.staffsecure.ai/)
- **Live Socket.IO server:** [https://socket.staffsecure.ai](https://socket.staffsecure.ai)
- Build with `npm run build`, run with `npm run start:prod`; ensure `NODE_ENV=production` so CORS restricts to the allow-listed origins (`https://staffsecure.ai`, `https://dashboard.staffsecure.ai`) hard-coded in `src/app.ts`.
- The process needs persistent write access to `logs/` (Winston daily-rotate) and `public/uploads/` (local file storage), so deploy to an environment with a persistent filesystem/volume rather than an ephemeral one — otherwise uploaded files and rotated logs will be lost on redeploy/restart.
- Both the HTTP API (`PORT`) and the Socket.IO server (`SOCKET_PORT`) need to be reachable; if fronted by a reverse proxy/load balancer, both ports (or a WS-upgrade-aware route to the socket port) must be exposed.
- Configure the Stripe webhook endpoint (`/api/v1/payment/webhook`) in the Stripe dashboard to point at the deployed URL, and set `STRIPE_WEBHOOK_SECRET` accordingly.
- Rotate all secrets before going live — the sample `.env` in this repo contains real-looking credentials that should not be reused in production.

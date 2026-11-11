// Abuse limits. Counted in Redis (src/shared/rateLimit.ts) per identifier and per IP.
// Operational values, not business rules; they decide how patient we are with guessing.
const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const AUTH_LIMITS = {
  // Login: lock the identifier after LOGIN_FAIL_LIMIT consecutive failures.
  LOGIN_FAIL_LIMIT: 5,
  LOGIN_FAIL_WINDOW_S: 15 * MINUTE,
  LOGIN_LOCK_S: 15 * MINUTE,
  LOGIN_IP_LIMIT: 30,
  LOGIN_IP_WINDOW_S: 15 * MINUTE,

  REGISTER_IP_LIMIT: 10,
  REGISTER_EMAIL_LIMIT: 5,
  REGISTER_WINDOW_S: HOUR,

  // Code requests (forgot password): the response never says whether the account exists.
  FORGOT_IP_LIMIT: 10,
  FORGOT_EMAIL_LIMIT: 5,
  FORGOT_WINDOW_S: HOUR,

  // Code checks (reset password, verify email). The per code attempt ceiling is separate
  // and lives on the Otp document.
  CHECK_IP_LIMIT: 30,
  CHECK_EMAIL_LIMIT: 10,
  CHECK_WINDOW_S: 15 * MINUTE,

  PHONE_SEND_USER_LIMIT: 5,
  PHONE_SEND_IP_LIMIT: 10,
  PHONE_SEND_WINDOW_S: HOUR,
  PHONE_VERIFY_USER_LIMIT: 10,
  PHONE_VERIFY_WINDOW_S: 15 * MINUTE,
} as const;

export const PASSWORD_MIN = 8;
// bcrypt ignores everything past 72 bytes.
export const PASSWORD_MAX = 72;

/** E.164, e.g. +919876543210. SMS providers need the country code. */
export const PHONE_REGEX = /^\+[1-9]\d{7,14}$/;

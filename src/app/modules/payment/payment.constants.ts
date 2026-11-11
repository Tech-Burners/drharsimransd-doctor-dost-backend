// Abuse limits for POST /wallet/orders. Every accepted order is a REAL Razorpay order, so an
// unlimited endpoint lets one client create orders without bound. These are operational
// values (not pricing) and are tunable here; they are RECOMMENDED defaults pending review.
//
// Three independent layers:
//   1. per user per hour  (Redis, fails closed with 503 if Redis is down)
//   2. per IP per hour    (Redis, same)
//   3. unpaid orders per user in 24h (MongoDB, does not depend on Redis)
// A replayed request (same Idempotency-Key) is answered by the idempotency middleware before
// the service runs, so a client retrying a dropped connection does not spend quota.
export const ORDER_LIMITS = {
  USER_PER_HOUR: 10,
  IP_PER_HOUR: 30,
  WINDOW_SECONDS: 60 * 60,
  OPEN_ORDERS_PER_DAY: 10,
  OPEN_ORDERS_WINDOW_MS: 24 * 60 * 60 * 1000,
} as const;

// Runs before every test file. dotenv never overrides variables that are already set, so
// setting these here guarantees tests cannot reach a real database, Redis or Sentry even
// if a developer .env exists.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
process.env.SENTRY_DSN = '';
process.env.LOG_LEVEL = 'silent';
// Cheap hashing keeps the auth suites fast. Never used outside tests.
process.env.BCRYPT_SALT_ROUNDS = '4';
// Placeholder secrets for tests only.
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.JWT_ACCESS_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '30d';
process.env.OTP_EXPIRE_TIME = '5';
process.env.OTP_MAX_ATTEMPTS = '5';
process.env.SMS_PROVIDER = '';

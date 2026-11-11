// Runs before every test file. dotenv never overrides variables that are already set, so
// setting these here guarantees tests cannot reach a real database, Redis or Sentry even
// if a developer .env exists.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
process.env.SENTRY_DSN = '';
process.env.LOG_LEVEL = 'silent';

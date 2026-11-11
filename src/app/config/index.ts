
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const aws = {
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  bucket: process.env.S3_BUCKET,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  signedUrlTtlSeconds: Number(process.env.S3_SIGNED_URL_TTL_SECONDS || 900),
};

const razorpay = {
  keyId: process.env.RAZORPAY_KEY_ID,
  keySecret: process.env.RAZORPAY_KEY_SECRET,
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
};

const agora = {
  appId: process.env.AGORA_APP_ID,
  appCertificate: process.env.AGORA_APP_CERTIFICATE,
  webhookSecret: process.env.AGORA_WEBHOOK_SECRET,
  tokenGraceSeconds: Number(process.env.AGORA_TOKEN_GRACE_SECONDS || 60),
  customerId: process.env.AGORA_CUSTOMER_ID,
  customerSecret: process.env.AGORA_CUSTOMER_SECRET,
};

const firebase = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  serviceAccountBase64: process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
};

const sms = {
  provider: process.env.SMS_PROVIDER,
  apiKey: process.env.SMS_API_KEY,
  senderId: process.env.SMS_SENDER_ID,
  templateId: process.env.SMS_TEMPLATE_ID,
};

export default {
  // Server
  NODE_ENV: process.env.NODE_ENV,
  project_name: process.env.PROJECT_NAME,
  port: Number(process.env.PORT || 9010),
  ip: process.env.IP,
  socket_port: Number(process.env.SOCKET_PORT || 9020),
  api_public_url: process.env.API_PUBLIC_URL,
  cors_origins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // Database
  database_url: process.env.DATABASE_URL,
  mongo_max_pool_size: Number(process.env.MONGO_MAX_POOL_SIZE || 20),

  // Redis
  redis_url: process.env.REDIS_URL,
  redis_password: process.env.REDIS_PASSWORD,

  // Authentication / Security
  bcrypt_salt_rounds: Number(process.env.BCRYPT_SALT_ROUNDS || 12),
  jwt_access_secret: process.env.JWT_ACCESS_SECRET,
  jwt_refresh_secret: process.env.JWT_REFRESH_SECRET,
  jwt_access_expires_in: process.env.JWT_ACCESS_EXPIRES_IN,
  jwt_refresh_expires_in: process.env.JWT_REFRESH_EXPIRES_IN,

  // OTP
  otp_expire_time: Number(process.env.OTP_EXPIRE_TIME || 5),
  otp_token_expire_time: process.env.OTP_TOKEN_EXPIRE_TIME,
  otp_max_attempts: Number(process.env.OTP_MAX_ATTEMPTS || 5),

  // Default Admin
  admin_email: process.env.ADMIN_EMAIL,
  admin_password: process.env.ADMIN_PASSWORD,
  admin_phone: process.env.ADMIN_PHONE,

  // Razorpay
  razorpay,

  // Agora
  agora,

  // Firebase
  firebase,

  // SMS
  sms,

  // AWS S3 / Object Storage
  aws,

  // Email
  nodemailer_host_email: process.env.NODEMAILER_HOST_EMAIL,
  nodemailer_host_pass: process.env.NODEMAILER_HOST_PASS,
  contact_email: process.env.CONTACT_EMAIL,
  logo_url: process.env.LOGO_URL,
  alert_email: process.env.ALERT_EMAIL,

  // OpenAI (read only by utils/openAi.ts, which nothing imports yet)
  openai_api_key: process.env.OPENAI_API_KEY,

  // Monitoring
  sentry_dsn: process.env.SENTRY_DSN,

  // Operational Tuning
  presence_ttl_seconds: Number(process.env.PRESENCE_TTL_SECONDS || 90),
  presence_sweep_seconds: Number(process.env.PRESENCE_SWEEP_SECONDS || 60),
  call_cooldown_seconds: Number(process.env.CALL_COOLDOWN_SECONDS || 45),
  call_orphan_grace_seconds: Number(
    process.env.CALL_ORPHAN_GRACE_SECONDS || 300
  ),

  // Server Home Page Monitor
  monitor_username: process.env.MONITOR_USERNAME,
  monitor_password: process.env.MONITOR_PASSWORD,
};

import rateLimit from 'express-rate-limit';
import sendResponse from './sendResponse';
import httpStatus from 'http-status';


// 👮 Rate Limiter Middleware (apply to all requests)
const rootlimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 10000 requests per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    // ✅ কাস্টম রেসপন্স using sendResponse
    return sendResponse(res, {
      statusCode: httpStatus.TOO_MANY_REQUESTS, // 429
      success: false,
      message: 'Too many requests from this device. Please try again later',
      data: null,
    });
  },
});

// 👮 Login Rate Limiter Middleware
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 মিনিট
  max: 10, // প্রতি IP ১৫ মিনিটে সর্বোচ্চ ৫ বার লগইন চেষ্টা
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    // ✅ কাস্টম রেসপন্স using sendResponse
    return sendResponse(res, {
      statusCode: httpStatus.TOO_MANY_REQUESTS, // 429
      success: false,
      message: 'Too many login attempts. Please try again after 15 minutes.',
      data: null,
    });
  },
});

// 👮 Create User Rate Limiter Middleware
const createUserLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 মিনিট
  max: 10, // প্রতি IP ১৫ মিনিটে সর্বোচ্চ ১০ বার create user চেষ্টা
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    // ✅ কাস্টম রেসপন্স using sendResponse
    return sendResponse(res, {
      statusCode: httpStatus.TOO_MANY_REQUESTS, // 429
      success: false,
      message: '🚫 Too many user creation attempts. Please try again after 15 minutes.',
      data: null,
    });
  },
});

// 👮 Resend OTP Rate Limiter Middleware
const resendOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 মিনিট
  max: 3, // প্রতি IP ১৫ মিনিটে সর্বোচ্চ ৩ বার OTP রিকোয়েস্ট
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    // ✅ কাস্টম রেসপন্স using sendResponse
    return sendResponse(res, {
      statusCode: httpStatus.TOO_MANY_REQUESTS, // 429
      success: false,
      message: '🚫 Too many OTP requests. Please try again after 15 minutes.',
      data: null,
    });
  },
});

export const limiter = {
  rootlimiter,
  loginLimiter,
  createUserLimiter,
  resendOtpLimiter
}
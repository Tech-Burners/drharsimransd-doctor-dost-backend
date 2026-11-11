import { z } from 'zod';
import { USER_ROLE } from '../user/user.constants';
import { PASSWORD_MAX, PASSWORD_MIN, PHONE_REGEX } from './auth.constant';

const email = z
  .string({ required_error: 'Email is required!' })
  .trim()
  .email({ message: 'Invalid email format' });

const newPassword = z
  .string({ required_error: 'Password is required!' })
  .min(PASSWORD_MIN, { message: `Password must be at least ${PASSWORD_MIN} characters long` })
  .max(PASSWORD_MAX, { message: `Password must be at most ${PASSWORD_MAX} characters long` });

const otp = z
  .string({ required_error: 'Otp is required!' })
  .regex(/^\d{6}$/, { message: 'otp must be exactly 6 digits' });

const phone = z.string().trim().regex(PHONE_REGEX, {
  message: 'Phone must include the country code, e.g. +919876543210',
});

const refreshToken = z.string({ required_error: 'Refresh token is required!' }).min(10);

// Admins are never self-registered.
const registerBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    email,
    password: newPassword,
    role: z.enum([USER_ROLE.PATIENT, USER_ROLE.DOCTOR]).optional(),
    phone: phone.optional(),
  })
  .refine((b) => b.role !== USER_ROLE.DOCTOR || !!b.phone, {
    message: 'Phone is required for doctors',
    path: ['phone'],
  });

const loginBody = z.object({
  email: z.string({ required_error: 'Email is required!' }).trim().min(1),
  password: z.string({ required_error: 'Password is required!' }).min(1),
});

const refreshBody = z.object({ refreshToken });
const forgotBody = z.object({ email });
const resetBody = z.object({ email, otp, newPassword });
const verifyEmailBody = z.object({ email, otp });
const phoneVerifyBody = z.object({ otp });

export const authBodies = {
  registerBody,
  loginBody,
  refreshBody,
  forgotBody,
  resetBody,
  verifyEmailBody,
  phoneVerifyBody,
};

export const authValidation = {
  registerSchema: z.object({ body: registerBody }),
  loginSchema: z.object({ body: loginBody }),
  refreshTokenSchema: z.object({ body: refreshBody }),
  logoutSchema: z.object({ body: refreshBody }),
  forgotPasswordSchema: z.object({ body: forgotBody }),
  resetPasswordSchema: z.object({ body: resetBody }),
  verifyEmailSchema: z.object({ body: verifyEmailBody }),
  phoneVerifySchema: z.object({ body: phoneVerifyBody }),
};

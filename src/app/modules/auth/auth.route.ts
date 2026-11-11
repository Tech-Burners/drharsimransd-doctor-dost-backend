import { Router } from 'express';
import { z } from 'zod';
import { authControllers } from './auth.controller';
import { authenticate, requireRole } from '../../middleware/auth';
import validateRequest from '../../middleware/validateRequest';
import { authBodies, authValidation } from './auth.validation';
import { USER_ROLE } from '../user/user.constants';
import { registerRoute } from '../../../shared/openapi';

export const authRoutes = Router();

// Layers: authenticate -> requireRole -> ownership inside the service.
authRoutes
  .post('/register', validateRequest(authValidation.registerSchema), authControllers.register)
  .post('/login', validateRequest(authValidation.loginSchema), authControllers.login)
  .post('/refresh', validateRequest(authValidation.refreshTokenSchema), authControllers.refresh)
  .post('/logout', validateRequest(authValidation.logoutSchema), authControllers.logout)
  .post('/logout-all', authenticate, requireRole(USER_ROLE.PATIENT, USER_ROLE.DOCTOR, USER_ROLE.ADMIN), authControllers.logoutAll)
  .post('/forgot-password', validateRequest(authValidation.forgotPasswordSchema), authControllers.forgotPassword)
  .post('/reset-password', validateRequest(authValidation.resetPasswordSchema), authControllers.resetPassword)
  .post('/verify-email', validateRequest(authValidation.verifyEmailSchema), authControllers.verifyEmail)
  .post(
    '/phone/send-otp',
    authenticate,
    requireRole(USER_ROLE.DOCTOR),
    authControllers.sendPhoneOtp,
  )
  .post(
    '/phone/verify',
    authenticate,
    requireRole(USER_ROLE.DOCTOR),
    validateRequest(authValidation.phoneVerifySchema),
    authControllers.verifyPhoneOtp,
  )
  // Existing route, kept as it was apart from the new authentication layers.
  .patch(
    '/change-password',
    authenticate,
    requireRole(USER_ROLE.PATIENT, USER_ROLE.DOCTOR, USER_ROLE.ADMIN),
    authControllers.changePassword,
  );

// ---- OpenAPI -----------------------------------------------------------------------
const json = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } });
const body = (schema: z.ZodTypeAny) => ({ body: { required: true, ...json(schema) } });
const bearer = [{ bearerAuth: [] }];
const common = {
  400: { description: 'Validation error or invalid / expired code' },
  429: { description: 'Rate limited or locked out' },
  503: { description: 'Rate limiter (Redis) unavailable' },
};

registerRoute({ method: 'post', path: '/auth/register', tags: ['auth'], summary: 'Register a patient (default) or doctor. Identical response whether or not the email exists', request: body(authBodies.registerBody), responses: { 201: { description: 'Verification code sent if registrable' }, ...common } });
registerRoute({ method: 'post', path: '/auth/login', tags: ['auth'], summary: 'Email + password, all roles', request: body(authBodies.loginBody), responses: { 200: { description: '{ user, accessToken, refreshToken }' }, 401: { description: 'Invalid email or password' }, 403: { description: 'Account blocked' }, ...common } });
registerRoute({ method: 'post', path: '/auth/refresh', tags: ['auth'], summary: 'Rotate the refresh token. Reusing a spent token revokes every session', request: body(authBodies.refreshBody), responses: { 200: { description: '{ accessToken, refreshToken }' }, 401: { description: 'Invalid, expired or reused refresh token' } } });
registerRoute({ method: 'post', path: '/auth/logout', tags: ['auth'], summary: 'Revoke one refresh token', request: body(authBodies.refreshBody), responses: { 200: { description: 'Logged out (idempotent)' } } });
registerRoute({ method: 'post', path: '/auth/logout-all', tags: ['auth'], summary: 'Bump tokenVersion and revoke every refresh token', security: bearer, responses: { 200: { description: 'Logged out everywhere' }, 401: { description: 'Not authenticated' } } });
registerRoute({ method: 'post', path: '/auth/forgot-password', tags: ['auth'], summary: 'Email a reset code. Same response whether or not the account exists', request: body(authBodies.forgotBody), responses: { 200: { description: 'Code sent if registered' }, ...common } });
registerRoute({ method: 'post', path: '/auth/reset-password', tags: ['auth'], summary: 'Verify the code, set a new password, revoke all sessions', request: body(authBodies.resetBody), responses: { 200: { description: 'Password reset' }, ...common } });
registerRoute({ method: 'post', path: '/auth/verify-email', tags: ['auth'], summary: 'Verify the emailed code', request: body(authBodies.verifyEmailBody), responses: { 200: { description: '{ emailVerified: true }' }, ...common } });
registerRoute({ method: 'post', path: '/auth/phone/send-otp', tags: ['auth'], summary: 'Doctor only. SMS a code to the phone on the authenticated account. No body', security: bearer, responses: { 200: { description: '{ sentTo (masked), expiresInSeconds, resendAfterSeconds }' }, 401: { description: 'Not authenticated' }, 403: { description: 'Not a doctor' }, 409: { description: 'Already verified' }, 429: { description: 'Resend cooldown or rate limit' }, 502: { description: 'SMS delivery failed' }, 503: { description: 'SMS provider not configured' } } });
registerRoute({ method: 'post', path: '/auth/phone/verify', tags: ['auth'], summary: 'Doctor only. Verify the code and set User.phoneVerified', request: body(authBodies.phoneVerifyBody), security: bearer, responses: { 200: { description: '{ phoneVerified: true }' }, 400: { description: 'Incorrect, expired or already used code' }, 401: { description: 'Not authenticated' }, 403: { description: 'Not a doctor' }, 429: { description: 'Attempt ceiling reached or rate limited' } } });

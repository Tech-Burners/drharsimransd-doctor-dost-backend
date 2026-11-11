import bcrypt from 'bcrypt';
import httpStatus from 'http-status';
import config from '../../config';
import AppError from '../../error/AppError';
import { otpSendEmail } from '../../utils/eamilNotifiacation';
import { otpServices } from '../otp/otp.service';
import { User } from '../user/user.model';
import { USER_ROLE, USER_STATUS } from '../user/user.constants';
import { TUserRole } from '../user/user.interface';
import { clear, enforce, hit, lock, lockRemaining } from '../../../shared/rateLimit';
import { logger } from '../../../shared/logger';
import { AUTH_LIMITS as L } from './auth.constant';
import {
  issueTokenPair,
  revokeAllRefreshTokens,
  revokeEverything,
  revokeRefreshToken,
  rotateRefreshToken,
  TokenMeta,
} from './auth.tokens';

export interface RequestMeta extends TokenMeta {
  ip: string;
}

const normaliseEmail = (email: string) => email.trim().toLowerCase();

const tooMany = (message: string) => new AppError(httpStatus.TOO_MANY_REQUESTS, message);

/** Fire and forget. A mail outage must not change the response (it would reveal state). */
const sendCodeByEmail = (sentTo: string, subject: string, name: string, code: string, expiredAt: Date) => {
  otpSendEmail({ sentTo, subject, name, otp: code, expiredAt: expiredAt.toISOString() }).catch((err) =>
    logger.error({ err }, 'failed to send otp email'),
  );
};

/** Issue and email a code for an address that exists. Skipped silently during cooldown. */
const issueEmailCode = async (
  email: string,
  purpose: 'email-verification' | 'reset-password',
  subject: string,
  name: string,
) => {
  const issued = await otpServices.issueOtp({ sentTo: email, receiverType: 'email', purpose });
  if (issued.ok) sendCodeByEmail(email, subject, name, issued.code, issued.expiredAt);
};

// A hash to compare against when the account does not exist, so the response time does
// not reveal whether it does.
let dummyHash: string | undefined;
const getDummyHash = async () =>
  (dummyHash ??= await bcrypt.hash('not-a-real-password', Number(config.bcrypt_salt_rounds)));

// ---------------------------------------------------------------- register

/**
 * Creates a patient (default) or doctor and emails a verification code. The response is
 * identical whether or not the email was already registered.
 */
const register = async (
  payload: { name?: string; email: string; password: string; role?: TUserRole; phone?: string },
  meta: RequestMeta,
) => {
  const email = normaliseEmail(payload.email);
  await enforce(`register:ip:${meta.ip}`, L.REGISTER_IP_LIMIT, L.REGISTER_WINDOW_S, 'Too many registration attempts.');
  await enforce(`register:email:${email}`, L.REGISTER_EMAIL_LIMIT, L.REGISTER_WINDOW_S, 'Too many registration attempts.');

  // Never admin, whatever was sent.
  const role = payload.role === USER_ROLE.DOCTOR ? USER_ROLE.DOCTOR : USER_ROLE.PATIENT;
  if (role === USER_ROLE.DOCTOR && !payload.phone) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Phone is required for doctors');
  }
  const name = payload.name?.trim() || '';

  try {
    await User.create({
      name,
      email,
      password: payload.password,
      role,
      phone: payload.phone?.trim() || '',
      status: USER_STATUS.ACTIVE,
    });
    await issueEmailCode(email, 'email-verification', 'Verify your email', name);
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    // Already registered (or the doctor phone is taken). Say nothing; if the owner never
    // verified their address, send them a fresh code.
    const existing = await User.findOne({ email });
    if (existing && !existing.emailVerified && existing.status === USER_STATUS.ACTIVE) {
      await issueEmailCode(email, 'email-verification', 'Verify your email', existing.name);
    }
  }

  return { email, verificationRequired: true };
};

// ------------------------------------------------------------------- login

const loginFailKey = (email: string) => `login:fail:${email}`;
const loginLockKey = (email: string) => `login:lock:${email}`;

const login = async (payload: { email: string; password: string }, meta: RequestMeta) => {
  const email = normaliseEmail(payload.email);

  await enforce(`login:ip:${meta.ip}`, L.LOGIN_IP_LIMIT, L.LOGIN_IP_WINDOW_S, 'Too many login attempts. Please try again later.');

  // Applies to the identifier whether or not an account exists behind it.
  const locked = await lockRemaining(loginLockKey(email));
  if (locked > 0) {
    throw tooMany(`Too many failed attempts. Try again in ${Math.ceil(locked / 60)} minute(s).`);
  }

  const user = await User.isUserExist(email);
  const passwordOk = user
    ? await User.isPasswordMatched(payload.password, user.password)
    : (await bcrypt.compare(payload.password, await getDummyHash()), false);

  if (!user || !passwordOk) {
    // The Nth consecutive failure locks the identifier.
    const result = await hit(loginFailKey(email), L.LOGIN_FAIL_LIMIT - 1, L.LOGIN_FAIL_WINDOW_S);
    if (!result.allowed) await lock(loginLockKey(email), L.LOGIN_LOCK_S);
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid email or password');
  }

  if (user.status !== USER_STATUS.ACTIVE) {
    throw new AppError(httpStatus.FORBIDDEN, 'Your account has been blocked');
  }

  await clear(loginFailKey(email));
  const tokens = await issueTokenPair(user, meta);
  return { user, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
};

// ----------------------------------------------------------- refresh / logout

const refresh = (refreshToken: string, meta: RequestMeta) => rotateRefreshToken(refreshToken, meta);

const logout = (refreshToken: string) => revokeRefreshToken(refreshToken);

/** The actor is the authenticated subject; the body is never consulted. */
const logoutAll = (actor: { userId: string }) => revokeEverything(actor.userId);

// ------------------------------------------------------------ password reset

const forgotPassword = async (payload: { email: string }, meta: RequestMeta) => {
  const email = normaliseEmail(payload.email);
  await enforce(`forgot:ip:${meta.ip}`, L.FORGOT_IP_LIMIT, L.FORGOT_WINDOW_S, 'Too many requests.');
  await enforce(`forgot:email:${email}`, L.FORGOT_EMAIL_LIMIT, L.FORGOT_WINDOW_S, 'Too many requests.');

  const user = await User.isUserActive(email);
  if (user) {
    await issueEmailCode(email, 'reset-password', 'Your one time code to reset your password', user.name);
  }
  // Same body either way.
  return { email };
};

const INVALID_CODE = 'Invalid or expired code';

const resetPassword = async (payload: { email: string; otp: string; newPassword: string }, meta: RequestMeta) => {
  const email = normaliseEmail(payload.email);
  await enforce(`check:ip:${meta.ip}`, L.CHECK_IP_LIMIT, L.CHECK_WINDOW_S, 'Too many attempts. Try again later.');
  await enforce(`check:email:${email}`, L.CHECK_EMAIL_LIMIT, L.CHECK_WINDOW_S, 'Too many attempts. Try again later.');

  const user = await User.isUserActive(email);
  if (!user) throw new AppError(httpStatus.BAD_REQUEST, INVALID_CODE);

  const consumed = await otpServices.consumeOtp(email, 'reset-password', payload.otp);
  if (!consumed.ok) throw new AppError(httpStatus.BAD_REQUEST, INVALID_CODE);

  const hashed = await bcrypt.hash(payload.newPassword, Number(config.bcrypt_salt_rounds));
  // One write: the new password and the version bump land together, so no window exists
  // where the password changed but old access tokens still work.
  await User.updateOne({ _id: user._id }, { $set: { password: hashed }, $inc: { tokenVersion: 1 } });
  await revokeAllRefreshTokens(String(user._id));
};

// ------------------------------------------------------------ email verification

const verifyEmail = async (payload: { email: string; otp: string }, meta: RequestMeta) => {
  const email = normaliseEmail(payload.email);
  await enforce(`check:ip:${meta.ip}`, L.CHECK_IP_LIMIT, L.CHECK_WINDOW_S, 'Too many attempts. Try again later.');
  await enforce(`check:email:${email}`, L.CHECK_EMAIL_LIMIT, L.CHECK_WINDOW_S, 'Too many attempts. Try again later.');

  const consumed = await otpServices.consumeOtp(email, 'email-verification', payload.otp);
  if (!consumed.ok) throw new AppError(httpStatus.BAD_REQUEST, INVALID_CODE);

  await User.updateOne({ email }, { $set: { emailVerified: true } });
  return { emailVerified: true };
};

// -------------------------------------------------------------- change password

// Change password (existing behaviour, unchanged)
const changePassword = async ({
  userId,
  newPassword,
  oldPassword,
}: {
  userId: string;
  newPassword: string;
  oldPassword: string;
}) => {
  const user = await User.IsUserExistById(userId);

  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  }

  if (!(await User.isPasswordMatched(oldPassword, user.password))) {
    throw new AppError(httpStatus.FORBIDDEN, 'Old password does not match');
  }

  const hashedPassword = await bcrypt.hash(newPassword, Number(config.bcrypt_salt_rounds));

  return User.findByIdAndUpdate(userId, { password: hashedPassword }, { new: true });
};

export const authServices = {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  forgotPassword,
  resetPassword,
  verifyEmail,
  changePassword,
};

// Doctor phone verification. The subject is always the authenticated actor: the account,
// and therefore the phone number, come from the token and the database. The request body
// carries only the code.
import httpStatus from 'http-status';
import AppError from '../../error/AppError';
import { otpServices } from '../otp/otp.service';
import { User } from '../user/user.model';
import { USER_ROLE } from '../user/user.constants';
import { enforce } from '../../../shared/rateLimit';
import { logger } from '../../../shared/logger';
import { sendSms, SmsNotConfiguredError } from '../../../shared/sms';
import config from '../../config';
import { AUTH_LIMITS as L, PHONE_REGEX } from './auth.constant';

export interface Actor {
  userId: string;
  role: string;
}

const PURPOSE = 'phone-verification' as const;

const maskPhone = (phone: string) => `${'*'.repeat(Math.max(phone.length - 4, 0))}${phone.slice(-4)}`;

const loadDoctorUser = async (actor: Actor) => {
  if (actor.role !== USER_ROLE.DOCTOR) {
    throw new AppError(httpStatus.FORBIDDEN, 'Only doctors verify a phone number');
  }
  const user = await User.findById(actor.userId);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  if (!user.phone || !PHONE_REGEX.test(user.phone)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'No valid phone number on your account. Update it with the country code first.',
    );
  }
  return user;
};

const sendOtp = async (actor: Actor, ip: string) => {
  await enforce(`phoneotp:send:user:${actor.userId}`, L.PHONE_SEND_USER_LIMIT, L.PHONE_SEND_WINDOW_S, 'Too many OTP requests. Try again later.');
  await enforce(`phoneotp:send:ip:${ip}`, L.PHONE_SEND_IP_LIMIT, L.PHONE_SEND_WINDOW_S, 'Too many OTP requests. Try again later.');

  const user = await loadDoctorUser(actor);
  if (user.phoneVerified) {
    throw new AppError(httpStatus.CONFLICT, 'Phone number is already verified');
  }

  const issued = await otpServices.issueOtp({ sentTo: user.phone, receiverType: 'phone', purpose: PURPOSE });
  if (!issued.ok) {
    throw new AppError(
      httpStatus.TOO_MANY_REQUESTS,
      `Please wait ${issued.retryAfterSeconds} seconds before requesting another OTP`,
    );
  }

  try {
    await sendSms(
      user.phone,
      `Your DoctorDost verification code is ${issued.code}. It expires in ${config.otp_expire_time} minutes. Do not share it with anyone.`,
    );
  } catch (err) {
    // Not delivered: withdraw the code and the cooldown so the doctor can try again.
    await otpServices.revokeOtp(user.phone, PURPOSE);
    logger.error({ err, userId: actor.userId }, 'phone OTP SMS failed');
    if (err instanceof SmsNotConfiguredError) {
      throw new AppError(httpStatus.SERVICE_UNAVAILABLE, 'SMS service is not available. Please try again later.');
    }
    throw new AppError(httpStatus.BAD_GATEWAY, 'Could not send the SMS. Please try again.');
  }

  return {
    sentTo: maskPhone(user.phone),
    expiresInSeconds: config.otp_expire_time * 60,
    resendAfterSeconds: 60,
  };
};

const FAILURE_MESSAGE = {
  not_found: 'No active OTP. Request a new one.',
  expired: 'This OTP has expired. Request a new one.',
  used: 'This OTP has already been used.',
  invalid: 'Incorrect OTP',
} as const;

const verifyOtp = async (actor: Actor, otp: string) => {
  await enforce(`phoneotp:verify:user:${actor.userId}`, L.PHONE_VERIFY_USER_LIMIT, L.PHONE_VERIFY_WINDOW_S, 'Too many attempts. Try again later.');

  const user = await loadDoctorUser(actor);
  if (user.phoneVerified) {
    throw new AppError(httpStatus.CONFLICT, 'Phone number is already verified');
  }

  const result = await otpServices.consumeOtp(user.phone, PURPOSE, otp);
  if (!result.ok) {
    if (result.reason === 'locked') {
      throw new AppError(httpStatus.TOO_MANY_REQUESTS, 'Too many incorrect attempts. Request a new OTP.');
    }
    throw new AppError(httpStatus.BAD_REQUEST, FAILURE_MESSAGE[result.reason]);
  }

  // Only if the phone is still the one that was verified. The account and phone both come
  // from this actor's record, so no other user's document can be touched.
  const updated = await User.findOneAndUpdate(
    { _id: actor.userId, phone: user.phone, role: USER_ROLE.DOCTOR },
    { $set: { phoneVerified: true } },
    { new: true },
  );
  if (!updated) {
    throw new AppError(httpStatus.CONFLICT, 'Your phone number changed during verification. Start again.');
  }

  return { phoneVerified: true };
};

export const phoneVerificationService = { sendOtp, verifyOtp };

import Otp from './otp.model';
import { CreateOtpParams, TPurposeType, TReceiverType } from './otp.interface';
import AppError from '../../error/AppError';
import { verifyToken } from '../../utils/tokenManage';
import httpStatus from 'http-status';
import config from '../../config';
import { generateOptAndExpireTime } from './otp.utils';
import { generateOtp } from '../../utils/otpGenerator';
import { cooldown, clear as clearKeys } from '../../../shared/rateLimit';
import { otpSendEmail } from '../../utils/eamilNotifiacation';

const createOtp = async ({
  name,
  sentTo,
  receiverType,
  purpose,
  otp,
  expiredAt,
}: CreateOtpParams) => {
  // const expiredAtDate = new Date(expiredAt);
  const newOTP = new Otp({
    sentTo,
    receiverType,
    purpose,
    otp,
    expiredAt,
  });

  await newOTP.save();

  return newOTP;
};

const checkOtpByEmail = async (email: string,purpose: string) => {
  const isExist = await Otp.findOne({
    sentTo: email,
    purpose: purpose
  });


  const isExpireOtp = await Otp.findOne({
    sentTo: email,
    expiredAt: { $lt: new Date() }, // Use the `$gt` operator for comparison
  });

  return { isExist, isExpireOtp };
};



const checkOtpByNumber = async (phone: string, purpose?: string) => {
  const isExist = await Otp.findOne({
    sentTo: phone,
    ...(purpose && { purpose }),
  });

  const isExpireOtp = await Otp.findOne({
    sentTo: phone,
    ...(purpose && { purpose }),
    expiredAt: { $lt: new Date() },
  });

  return { isExist, isExpireOtp };
};

export const OTP_COOLDOWN_SECONDS = 60;

export interface IssuedOtp {
  code: string;
  expiredAt: Date;
}

/**
 * Create (or replace) the one live code for a receiver and purpose.
 * Returns null while the resend cooldown is running. The plain code is returned once so
 * the caller can deliver it; only its bcrypt hash is stored (see the Otp model hooks).
 */
const issueOtp = async ({
  sentTo,
  receiverType,
  purpose,
}: {
  sentTo: string;
  receiverType: TReceiverType;
  purpose: TPurposeType;
}): Promise<({ ok: true } & IssuedOtp) | { ok: false; retryAfterSeconds: number }> => {
  const slot = await cooldown(`otp:cooldown:${purpose}:${sentTo}`, OTP_COOLDOWN_SECONDS);
  if (!slot.acquired) return { ok: false, retryAfterSeconds: slot.retryAfterSeconds };

  const code = generateOtp();
  const expiredAt = new Date(Date.now() + config.otp_expire_time * 60 * 1000);

  await Otp.findOneAndUpdate(
    { sentTo, purpose },
    {
      $set: {
        otp: code,
        receiverType,
        expiredAt,
        status: 'pending',
        attempts: 0,
        maxAttempts: config.otp_max_attempts,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return { ok: true, code, expiredAt };
};

/** Withdraw a code that could not be delivered, and free the resend cooldown. */
const revokeOtp = async (sentTo: string, purpose: TPurposeType) => {
  await Otp.deleteOne({ sentTo, purpose });
  await clearKeys(`otp:cooldown:${purpose}:${sentTo}`);
};

export type ConsumeFailure = 'not_found' | 'expired' | 'used' | 'locked' | 'invalid';

/**
 * Check a code and, if right, burn it. Single use and the attempt ceiling are both
 * enforced by atomic updates, not by reading and then writing:
 *  - the attempt is counted BEFORE the comparison, in the same update that checks the
 *    ceiling, so parallel guesses cannot exceed maxAttempts;
 *  - the pending -> verified flip only succeeds for one caller, so a code cannot be
 *    used twice even by concurrent requests.
 */
const consumeOtp = async (
  sentTo: string,
  purpose: TPurposeType,
  code: string,
): Promise<{ ok: true } | { ok: false; reason: ConsumeFailure }> => {
  const doc = await Otp.findOne({ sentTo, purpose });
  if (!doc) return { ok: false, reason: 'not_found' };
  if (doc.status === 'verified') return { ok: false, reason: 'used' };
  if (doc.expiredAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (doc.attempts >= doc.maxAttempts) return { ok: false, reason: 'locked' };

  const counted = await Otp.findOneAndUpdate(
    {
      _id: (doc as unknown as { _id: unknown })._id,
      status: 'pending',
      expiredAt: { $gt: new Date() },
      attempts: { $lt: doc.maxAttempts },
    },
    { $inc: { attempts: 1 } },
    { new: true },
  );
  if (!counted) return { ok: false, reason: 'locked' };

  if (!(await Otp.isOtpMatched(code, counted.otp))) {
    return { ok: false, reason: counted.attempts >= counted.maxAttempts ? 'locked' : 'invalid' };
  }

  const burned = await Otp.updateOne(
    { _id: (doc as unknown as { _id: unknown })._id, status: 'pending' },
    { $set: { status: 'verified' } },
  );
  if (burned.modifiedCount !== 1) return { ok: false, reason: 'used' };

  return { ok: true };
};

/** Legacy shape used by the signup flow: true when the code was right (and is now spent). */
const otpMatch = async (email: string, purpose: string, otp: string) => {
  const result = await consumeOtp(email, purpose as TPurposeType, otp);
  return result.ok ? true : null;
};

const updateOtpByEmail = async (
  email: string,
  purpose: string,
  payload: Record<string, any>,
) => {
  const otpUpdate = await Otp.findOneAndUpdate(
    {
      sentTo: email,
      purpose,
    },
    payload,
    { new: true },
  );

  return otpUpdate;
};

const resendOtpEmail = async ({ token,purpose }: { token: string, purpose: string }) => {
  if (!token) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Token not found');
  }
  const decodeData = verifyToken({
    token,
    access_secret: config.jwt_access_secret as string,
  });
  const { email } = decodeData;

  const { isExist, isExpireOtp } = await checkOtpByEmail(email,purpose);

  const { otp, expiredAt } = generateOptAndExpireTime();

  if (!isExist) {
    // Expired OTPs are removed automatically (TTL index), so issue a new one.
    await createOtp({
      name: '',
      sentTo: email,
      receiverType: 'email',
      purpose: purpose as TPurposeType,
      otp,
      expiredAt,
    });
  } else if (isExist && !isExpireOtp) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Otp exist. Please check email.',
    );
  } else if (isExist && isExpireOtp) {
    const otpUpdateData = {
      otp,
      expiredAt,
    };

    await updateOtpByEmail(email,purpose, otpUpdateData);
  }

  process.nextTick(async () => {
    await otpSendEmail({
      sentTo: email,
      subject: 'Re-send your one time otp for email  verification',
      name: '',
      otp,
      expiredAt: expiredAt,
    });
  });
};

export const otpServices = {
  createOtp,
  checkOtpByEmail,
  checkOtpByNumber,
  issueOtp,
  revokeOtp,
  consumeOtp,
  otpMatch,
  updateOtpByEmail,
  resendOtpEmail,
};

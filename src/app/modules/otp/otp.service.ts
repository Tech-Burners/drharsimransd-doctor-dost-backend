import Otp from './otp.model';
import { CreateOtpParams, TPurposeType } from './otp.interface';
import AppError from '../../error/AppError';
import { verifyToken } from '../../utils/tokenManage';
import httpStatus from 'http-status';
import config from '../../config';
import { generateOptAndExpireTime } from './otp.utils';
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



const checkOtpByNumber = async (phone: string) => {
  const isExist = await Otp.findOne({
    sentTo: phone,
  });

  const isExpireOtp = await Otp.findOne({
    sentTo: phone,
    expiredAt: { $lt: new Date() }, // Use the `$gt` operator for comparison
  });

  return { isExist, isExpireOtp };
};

const otpMatch = async (email: string, purpose: string, otp: string) => {

  const otpDoc = await Otp.findOne({
    sentTo: email,
    purpose,
    status: 'pending',
    expiredAt: { $gt: new Date() },
  });

  if (!otpDoc || otpDoc.attempts >= otpDoc.maxAttempts) {
    return null;
  }

  // The code is stored hashed, so it can't be matched in the query.
  if (!(await Otp.isOtpMatched(otp, otpDoc.otp))) {
    await Otp.updateOne({ _id: otpDoc._id }, { $inc: { attempts: 1 } });
    return null;
  }

  return otpDoc;
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
  otpMatch,
  updateOtpByEmail,
  resendOtpEmail,
};

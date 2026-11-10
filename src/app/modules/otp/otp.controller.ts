import catchAsync from '../../utils/catchAsync';
import { otpServices } from './otp.service';
import sendResponse from '../../utils/sendResponse';
import { Request, Response } from 'express';
import AppError from '../../error/AppError';
import { verifyToken } from '../../utils/tokenManage';
import config from '../../config';
import { generateOtp } from '../../utils/otpGenerator';
import { TPurposeType } from './otp.interface';
import moment from 'moment';
import { otpSendEmail } from '../../utils/eamilNotifiacation';
import httpStatus from 'http-status';

const resendOtp = catchAsync(async (req: Request, res: Response) => {
      let token: any = req.headers?.authorization || req?.headers?.token;


    if (token.startsWith('Bearer ')) {
      token = token.slice(7, token.length);
    }

    // 1️⃣ Missing Token → 401 Unauthorized
    if (!token) {
      throw new AppError(
        httpStatus.UNAUTHORIZED,
        'Authorization token is missing'
      );
    }

  const {purpose} = req.body;

  await otpServices.resendOtpEmail({ token,purpose });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'OTP Resent successfully',
    data: {},
  });
});

export const otpControllers = {
  resendOtp,
};

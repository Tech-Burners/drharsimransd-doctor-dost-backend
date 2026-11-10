import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { userService } from './user.service';

import httpStatus from 'http-status';
import { storeFile, storeFiles } from '../../utils/fileHelper';
import AppError from '../../error/AppError';
import { User } from './user.model';
import { otpSendEmail } from '../../utils/eamilNotifiacation';


const createUser = catchAsync(async (req: Request, res: Response) => {

  const createUserToken = await userService.createUserToken(req.body);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Check email for OTP',
    data:  createUserToken ,
  });
});


const userCreateVarification = catchAsync(async (req, res) => {

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

  const { otp } = req.body;
  const newUser = await userService.otpVerifyAndCreateUser({ otp, token });

  return sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User create successfully',
    data: newUser,
  });
});


const updateMyProfile = catchAsync(async (req: Request, res: Response) => {
  if (req?.file) {
    req.body.profileImage = storeFile('profile', req?.file?.filename);
  }

  const result = await userService.updateUser(req?.user?.userId, req.body);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'profile updated successfully',
    data: result,
  });
});



type TUploadedFiles = { [fieldName: string]: Express.Multer.File[] } | undefined;

const completePatientProfile = catchAsync(async (req: Request, res: Response) => {
  const files = req.files as TUploadedFiles;
  const profileImage = files?.image?.[0]
    ? storeFile('profile', files.image[0].filename)
    : undefined;

  const result = await userService.completePatientProfile(req.user.userId, {
    ...req.body,
    profileImage,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Patient profile completed successfully',
    data: result,
  });
});


const completeDoctorProfile = catchAsync(async (req: Request, res: Response) => {
  const files = req.files as TUploadedFiles;
  const profileImage = files?.image?.[0]
    ? storeFile('profile', files.image[0].filename)
    : undefined;
  const signaturePath = files?.signature?.[0]
    ? storeFile('profile', files.signature[0].filename)
    : undefined;
  const certificatePath = files?.certificate?.[0]
    ? storeFile('profile', files.certificate[0].filename)
    : undefined;

  const result = await userService.completeDoctorProfile(req.user.userId, {
    ...req.body,
    profileImage,
    signaturePath,
    certificatePath,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Doctor profile completed successfully',
    data: result,
  });
});



const updateUserStatus = catchAsync(async (req, res) => {

  const result = await userService.updateUserStatus(req.params.userId, req.body.status);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User status updated successfully',
    data: result,
  });

});


const getMyProfile = catchAsync(async (req, res) => {
   const { userId } = req.user;

  const result = await userService.getMyProfile(userId);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Profile fetched successfully',
    data: result,
  });
})


const sendEmailTesting = catchAsync(async (req, res) => {
  const { email, otp, expiredAt } = req.body;

  await otpSendEmail({
    sentTo: email,
    subject: "Your one time OTP for email verification",
    name: "Customer",
    otp,
    expiredAt,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Test email sent successfully",
    data: null,
  });
});








export const userController = {
  createUser,
  userCreateVarification,
  updateMyProfile,
  completePatientProfile,
  completeDoctorProfile,
  updateUserStatus,
  getMyProfile,
  sendEmailTesting
};

import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { authServices, RequestMeta } from './auth.service';
import { phoneVerificationService } from './phoneVerification.service';

// Controllers only unwrap the request and delegate. The subject of every authenticated
// call comes from req.user (the verified token), never from the body.
const metaOf = (req: Request): RequestMeta => ({
  ip: req.ip || '',
  userAgent: req.get('User-Agent') || '',
});

const register = catchAsync(async (req: Request, res: Response) => {
  const { name, email, password, role, phone } = req.body;
  const result = await authServices.register({ name, email, password, role, phone }, metaOf(req));
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'If this email can be registered, a verification code has been sent to it',
    data: result,
  });
});

const login = catchAsync(async (req: Request, res: Response) => {
  const result = await authServices.login(
    { email: req.body.email, password: req.body.password },
    metaOf(req),
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Logged in successfully',
    data: result,
  });
});

const refresh = catchAsync(async (req: Request, res: Response) => {
  const result = await authServices.refresh(req.body.refreshToken, metaOf(req));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Token refreshed successfully',
    data: result,
  });
});

const logout = catchAsync(async (req: Request, res: Response) => {
  await authServices.logout(req.body.refreshToken);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Logged out', data: null });
});

const logoutAll = catchAsync(async (req: Request, res: Response) => {
  await authServices.logoutAll({ userId: req.user.userId });
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Logged out of all devices',
    data: null,
  });
});

const forgotPassword = catchAsync(async (req: Request, res: Response) => {
  const result = await authServices.forgotPassword({ email: req.body.email }, metaOf(req));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'If the email is registered, a one time code has been sent to it',
    data: result,
  });
});

const resetPassword = catchAsync(async (req: Request, res: Response) => {
  await authServices.resetPassword(
    { email: req.body.email, otp: req.body.otp, newPassword: req.body.newPassword },
    metaOf(req),
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Password reset successfully. Please sign in again.',
    data: null,
  });
});

const verifyEmail = catchAsync(async (req: Request, res: Response) => {
  const result = await authServices.verifyEmail({ email: req.body.email, otp: req.body.otp }, metaOf(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Email verified', data: result });
});

const changePassword = catchAsync(async (req: Request, res: Response) => {
  const { userId } = req.user;
  const { newPassword, oldPassword } = req.body;

  const result = await authServices.changePassword({ userId, newPassword, oldPassword });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Password changed successfully',
    data: result,
  });
});

const sendPhoneOtp = catchAsync(async (req: Request, res: Response) => {
  const result = await phoneVerificationService.sendOtp(
    { userId: req.user.userId, role: req.user.role },
    req.ip || '',
  );
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'OTP sent to your phone', data: result });
});

const verifyPhoneOtp = catchAsync(async (req: Request, res: Response) => {
  const result = await phoneVerificationService.verifyOtp(
    { userId: req.user.userId, role: req.user.role },
    req.body.otp,
  );
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Phone number verified', data: result });
});

export const authControllers = {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  forgotPassword,
  resetPassword,
  verifyEmail,
  changePassword,
  sendPhoneOtp,
  verifyPhoneOtp,
};

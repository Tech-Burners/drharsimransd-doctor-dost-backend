import { Router } from 'express';
import { otpControllers } from './otp.controller'; 
import { limiter } from '../../utils/limiter';
export const otpRoutes = Router();


  otpRoutes.patch('/resend-otp', limiter.resendOtpLimiter, otpControllers.resendOtp);


import { Router } from 'express';
import { otpControllers } from './otp.controller'; 
import { limiter } from '../../utils/limiter';
import { legacySignup } from '../../middleware/legacySignup';
export const otpRoutes = Router();


  otpRoutes.patch('/resend-otp', legacySignup, limiter.resendOtpLimiter, otpControllers.resendOtp);


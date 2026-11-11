import { randomInt } from 'crypto';

export const OTP_LENGTH = 6;

/** Cryptographically secure 6 digit code, zero padded ("004821"). */
export const generateOtp = (): string => randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, '0');

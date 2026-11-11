import { z } from 'zod';

const verifyOtpZodSchema = z.object({
  body: z.object({
    otp: z
      .string({ required_error: 'otp is required' })
      .regex(/^\d{6}$/, { message: 'otp must be exactly 6 digits' }),
  }),
});

export const verifyOtpValidations = {
  verifyOtpZodSchema,
};

import { z } from 'zod';
import { GENDER, USER_ROLE } from './user.constants';
import { DOCTOR_SPECIALTY } from '../doctor/doctor.constants';
import { TDoctorSpecialty } from '../doctor/doctor.interface';

const userValidationSchema = z.object({
  body: z.object({
    name: z
      .string()
      .min(1, { message: 'Full name is required' })
      .optional(),
    email: z.string().email({ message: 'Invalid email format' }),
    password: z
      .string()
      .min(6, { message: 'Password must be at least 6 characters long' }),
    role: z.enum([USER_ROLE.PATIENT, USER_ROLE.DOCTOR, USER_ROLE.ADMIN], {
      message: 'Role must be either patient or dcotor',
    }),
  }),
});

const completePatientProfileSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1, { message: 'Name is required' }),
    gender: z.enum([GENDER.MALE, GENDER.FEMALE, GENDER.OTHER], {
      message: 'Gender must be male, female or other',
    }),
    dateOfBirth: z.coerce
      .date({ message: 'Invalid date of birth' })
      .max(new Date(), { message: 'Date of birth cannot be in the future' }),
  }),
});

const completeDoctorProfileSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1, { message: 'Name is required' }),
    about: z.string().trim().min(1, { message: 'About is required' }),
    qualification: z
      .string()
      .trim()
      .min(1, { message: 'Qualification is required' }),
    speciality: z.enum(
      Object.values(DOCTOR_SPECIALTY) as [
        TDoctorSpecialty,
        ...TDoctorSpecialty[],
      ],
      { message: 'Invalid speciality' },
    ),
    phone: z.string().trim().min(1, { message: 'Phone is required' }),
    registrationNumber: z
      .string()
      .trim()
      .min(1, { message: 'Registration number is required' }),
    medicalCouncil: z
      .string()
      .trim()
      .min(1, { message: 'Medical council is required' }),
    yearOfExperience: z.coerce
      .number()
      .int({ message: 'Year of experience must be a whole number' })
      .min(0, { message: 'Year of experience cannot be negative' }),
    dayRate: z.coerce
      .number()
      .int({ message: 'Day rate must be a whole number' })
      .min(0, { message: 'Day rate cannot be negative' }),
    nightRate: z.coerce
      .number()
      .int({ message: 'Night rate must be a whole number' })
      .min(0, { message: 'Night rate cannot be negative' }),
  }),
});

export const userValidation = {
  userValidationSchema,
  completePatientProfileSchema,
  completeDoctorProfileSchema,
};

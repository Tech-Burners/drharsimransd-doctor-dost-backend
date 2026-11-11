import { Router } from 'express';
import auth from '../../middleware/auth';
import fileUpload from '../../middleware/fileUpload';
import parseData from '../../middleware/parseData';
import validateRequest from '../../middleware/validateRequest';
import { verifyOtpValidations } from '../otp/otp.validation';
import { userController } from './user.controller';
import { userValidation } from './user.validation';
import { USER_ROLE } from './user.constants';
import { limiter } from '../../utils/limiter';
import { legacySignup } from '../../middleware/legacySignup';
const upload = fileUpload('./public/uploads/profile');

export const userRoutes = Router();

userRoutes
  .post(
    '/create',
    legacySignup, // retired flow: see middleware/legacySignup.ts
    limiter.createUserLimiter,
    validateRequest(userValidation?.userValidationSchema),
    userController.createUser,
  )


  .post(
    '/create-user-verify-otp',
    legacySignup,
    validateRequest(verifyOtpValidations.verifyOtpZodSchema),
    userController.userCreateVarification,
  )

  .patch(
    "/update-my-profile",
    auth(USER_ROLE.PATIENT,USER_ROLE.DOCTOR, USER_ROLE.ADMIN),
    upload.single('image'),
    parseData(),
    userController.updateMyProfile
  )


  .patch(
    '/complete-patient-profile',
    auth(USER_ROLE.PATIENT),
    upload.fields([{ name: 'image', maxCount: 1 }]),
    parseData(),
    validateRequest(userValidation.completePatientProfileSchema),
    userController.completePatientProfile,
  )

  .patch(
    '/complete-doctor-profile',
    auth(USER_ROLE.DOCTOR),
    upload.fields([
      { name: 'image', maxCount: 1 },
      { name: 'signature', maxCount: 1 },
      { name: 'certificate', maxCount: 1 },
    ]),
    parseData(),
    validateRequest(userValidation.completeDoctorProfileSchema),
    userController.completeDoctorProfile,
  )

  .post(
    "/testing-email",
    auth(USER_ROLE.ADMIN), // was public: an open mail relay with caller-chosen recipient and content
    userController.sendEmailTesting,
  )

  .patch(
    "/update-status/:userId",
    auth(USER_ROLE.ADMIN),
    userController.updateUserStatus
  )

  .get(
    '/my-profile',
    auth(USER_ROLE.PATIENT,USER_ROLE.DOCTOR, USER_ROLE.ADMIN),
    userController.getMyProfile,
  )




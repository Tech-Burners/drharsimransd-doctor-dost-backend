/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import AppError from '../../error/AppError'
import { User } from './user.model'
import config from '../../config'
import { otpServices } from '../otp/otp.service'
import { generateOptAndExpireTime } from '../otp/otp.utils'
import { TPurposeType } from '../otp/otp.interface'
import { otpSendEmail} from '../../utils/eamilNotifiacation'
import { createToken, verifyToken } from '../../utils/tokenManage'
import { getAdminId } from '../../DB/adminStrore'
import { emitNotification } from '../../../socketIo'
import { USER_ROLE, USER_STATUS } from './user.constants'
import { NOTIFICATION_TYPE } from '../notification/notification.constants'
import { TUser, TUserCreate,} from './user.interface'
import { Doctor } from '../doctor/doctor.model'
import { TDoctorSpecialty } from '../doctor/doctor.interface'


export interface OTPVerifyAndCreateUserProps {
  otp: string
  token: string
}

const createUserToken = async (payload: TUserCreate) => {

  const { name, email, password, role} = payload

  // user exist check
  const userExist = await User.isUserExist(email)

  if (userExist) {
    throw new AppError(httpStatus.BAD_REQUEST, 'User already exist!!')
  }

  const { isExist, isExpireOtp } = await otpServices.checkOtpByEmail(
    email,
    'email-verification'
  )

  const { otp, expiredAt } = generateOptAndExpireTime()

  let otpPurpose: TPurposeType = 'email-verification'

  if (isExist && !isExpireOtp) {
    throw new AppError(httpStatus.BAD_REQUEST, 'otp-exist. Check your email.')
  } else if (isExist && isExpireOtp) {
    const otpUpdateData = {
      otp,
      expiredAt,
    }

    await otpServices.updateOtpByEmail(email, otpPurpose, otpUpdateData)
  } else if (!isExist) {
    await otpServices.createOtp({
      name: name ?? (role === 'doctor' ? 'Doctor' : 'Patient'),
      sentTo: email,
      receiverType: 'email',
      purpose: otpPurpose,
      otp,
      expiredAt,
    })
  }

  const otpBody: Partial<TUserCreate> = {
    name,
    email,
    password,
    role
  }

  // send email
  process.nextTick(async () => {
    await otpSendEmail({
      sentTo: email,
      subject: 'Your one time otp for email  verification',
       name: name ?? (role === 'doctor' ? 'Doctor' : 'Patient'),
      otp,
      expiredAt: expiredAt,
    })
  })

  // crete token
  const createUserToken = createToken({
    payload: otpBody,
    access_secret: config.jwt_access_secret as string,
    expity_time: config.otp_token_expire_time as string | number,
  })

  return createUserToken
}

const otpVerifyAndCreateUser = async ({
  otp,
  token,
}: OTPVerifyAndCreateUserProps) => {

  if (!token) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Token not found')
  }

  const decodeData = verifyToken({
    token,
    access_secret: config.jwt_access_secret as string,
  })

  if (!decodeData) {
    throw new AppError(httpStatus.BAD_REQUEST, 'You are not authorised')
  }

  const { name, email, password, role,} = decodeData


  const isOtpMatch = await otpServices.otpMatch(email, 'email-verification', otp);

  if (!isOtpMatch) {
    throw new AppError(httpStatus.BAD_REQUEST, 'OTP did not match');
  }


  // Check if user exists
  const isExist = await User.isUserExist(email as string)

  if (isExist) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      'User already exists with this email'
    )
  }

  // Create user without a transaction
  let user;

  try {
    user = await User.create({
      name,
      email,
      password,
      role,
      status: USER_STATUS.ACTIVE,
    });
  } catch (error) {
    console.error('User creation failed:', error);

    // Handle duplicate email in case of a concurrent request
    if ((error as { code?: number }).code === 11000) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        'User already exists with this email',
      );
    }

    throw new AppError(
      httpStatus.BAD_REQUEST,
      'User creation failed',
    );
  }

  // Emit notification without blocking the response
  const isDoctor = user.role === USER_ROLE.DOCTOR;

  emitNotification({
    senderId: user._id as any,
    receiverId: getAdminId(),
    type: isDoctor
      ? NOTIFICATION_TYPE.NEW_DOCTOR_JOINED
      : NOTIFICATION_TYPE.NEW_PATIENT_JOINED,
    title: isDoctor ? 'New doctor joined' : 'New patient joined',
    message: `A new ${user.role} has registered`,
  }).catch((err) => {
    console.error('Notification emit failed:', err);
  });

  // Generate access token
  const jwtPayload = {
    userId: user._id.toString(),
    name: user.name || '',
    email: user.email,
    role: user.role,
    status: user.status,
  };

  return createToken({
    payload: jwtPayload,
    access_secret: config.jwt_access_secret as string,
    expity_time: '5m',
  });
}





const updateUser = async (id: string, payload: Partial<TUser>) => {


  const { role, email, status, isDeleted,password, ...rest } = payload;

  const isUserExist = await User.findById(id);

  if (!isUserExist) {
    throw new AppError(httpStatus.BAD_REQUEST, 'User not found');
  }


  const user = await User.findByIdAndUpdate(id, rest, { new: true });

  if (!user) {
    throw new AppError(httpStatus.BAD_REQUEST, 'User updating failed');
  }


  return user;
};


const completePatientProfile = async (
  userId: string,
  payload: Pick<TUser, 'name' | 'gender' | 'dateOfBirth'> & {
    profileImage?: string;
  },
) => {
  const { name, gender, dateOfBirth, profileImage } = payload;

  const user = await User.findByIdAndUpdate(
    userId,
    { name, gender, dateOfBirth, ...(profileImage && { profileImage }) },
    { new: true },
  );

  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  }

  return user;
};


export interface TCompleteDoctorProfile {
  name: string;
  about: string;
  qualification: string;
  speciality: TDoctorSpecialty;
  phone: string;
  registrationNumber: string;
  medicalCouncil: string;
  yearOfExperience: number;
  dayRate: number;
  nightRate: number;
  profileImage?: string;
  signaturePath?: string;
  certificatePath?: string;
}

const completeDoctorProfile = async (
  userId: string,
  payload: TCompleteDoctorProfile,
) => {
  const session = await mongoose.startSession();

  try {
    let result: { user: TUser | null; doctor: any } | undefined;

    await session.withTransaction(async () => {
      const user = await User.findById(userId).session(session);

      if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
      }

      const doctor = await Doctor.findOneAndUpdate(
        { userId },
        {
          bio: payload.about,
          qualification: payload.qualification,
          specialty: payload.speciality,
          registrationNumber: payload.registrationNumber,
          medicalCouncil: payload.medicalCouncil,
          experienceYears: payload.yearOfExperience,
          consultationRateDayPaise: payload.dayRate,
          consultationRateNightPaise: payload.nightRate,
          rateUpdatedAt: new Date(),
          ...(payload.signaturePath && {
            signaturePath: payload.signaturePath,
          }),
          ...(payload.certificatePath && {
            certificatePath: payload.certificatePath,
          }),
        },
        { new: true, upsert: true, setDefaultsOnInsert: true, session },
      );

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        {
          name: payload.name,
          phone: payload.phone,
          ...(payload.profileImage && { profileImage: payload.profileImage }),
        },
        { new: true, session },
      );

      result = { user: updatedUser, doctor };
    });

    return result!;
  } finally {
    await session.endSession();
  }
};


const updateUserStatus = async (id: string, status: 'active' | 'blocked') => {

  if (!id) {
    throw new AppError(httpStatus.BAD_REQUEST, 'User not found');
  }

  if(status !== 'active' && status !== 'blocked'){
    throw new AppError(httpStatus.BAD_REQUEST, 'Status not found');
  }

  const user = await User.findByIdAndUpdate(id, { status }, { new: true });

  return user;
}





const getMyProfile  = async (userId: string) => {
  const result = await User.findById(userId).lean();
  return result
}






export const userService = {
  createUserToken,
  otpVerifyAndCreateUser,
  updateUser,
  completePatientProfile,
  completeDoctorProfile,
  updateUserStatus,
  getMyProfile,
}

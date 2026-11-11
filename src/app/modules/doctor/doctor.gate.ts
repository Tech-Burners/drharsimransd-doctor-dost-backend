// Doctor gates enforced in the service layer, not the UI.
//
// Phase 8 builds the availability endpoint and the verification decision endpoint; both
// MUST call these before changing state. They are here so the rule exists once and Phase 4
// can test it.
import httpStatus from 'http-status';
import AppError from '../../error/AppError';
import { User } from '../user/user.model';
import { Doctor } from './doctor.model';

const PHONE_MESSAGE = 'Phone number must be verified first';

/** Called by the availability endpoint before setting Doctor.isOnline = true. */
export const assertDoctorMayGoOnline = async (actor: { userId: string }): Promise<void> => {
  // The doctor is found by the authenticated user id, never by an id from the request.
  const user = await User.findById(actor.userId).select('phoneVerified').lean();
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  if (!user.phoneVerified) throw new AppError(httpStatus.FORBIDDEN, PHONE_MESSAGE);
};

/** Called by the verification service before an admin approves a doctor. */
export const assertDoctorMayBeApproved = async (doctorId: string): Promise<void> => {
  const doctor = await Doctor.findById(doctorId).select('userId').lean();
  if (!doctor) throw new AppError(httpStatus.NOT_FOUND, 'Doctor not found');
  const user = await User.findById(doctor.userId).select('phoneVerified').lean();
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  if (!user.phoneVerified) {
    throw new AppError(httpStatus.CONFLICT, `Cannot approve: the doctor's ${PHONE_MESSAGE.toLowerCase()}`);
  }
};

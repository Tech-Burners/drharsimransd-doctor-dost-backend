import moment from 'moment';
import config from '../../config';
import { generateOtp } from '../../utils/otpGenerator';

const generateOptAndExpireTime = () => {
  const otp = generateOtp();

  // config.otp_expire_time is already a number (minutes) with a default of 5.
  const expiredAt = moment().add(config.otp_expire_time, 'minute').toISOString();

  return {
    otp,
    expiredAt,
  };
};

export { generateOptAndExpireTime };

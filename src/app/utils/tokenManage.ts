import jwt, { JwtPayload, Secret } from 'jsonwebtoken';
import AppError from '../error/AppError';
import httpStatus from 'http-status';

interface CreateTokenParams {
  payload: JwtPayload;
  access_secret: Secret;
  expity_time: any;
}

// interface CreateTokenParams {
//   payload: object;
//   access_secret: Secret;
//   expiry_time: StringValue | number;
// }

interface VerifyTokenParams {
  token: string;
  access_secret: string;
}

const createToken = ({
  payload,
  access_secret,
  expity_time,
}: CreateTokenParams): string => {
  const token = jwt.sign(payload, access_secret, {
    expiresIn: expity_time,
  });

  return token;
};

const verifyToken = ({
  token,
  access_secret,
}: VerifyTokenParams): JwtPayload => {
  try {
    return jwt.verify(token, access_secret) as JwtPayload;
  } catch (err) {
    throw new AppError(httpStatus.FORBIDDEN, 'You are not authorized!');
  }
};

export { createToken, verifyToken };

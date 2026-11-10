import httpStatus from 'http-status';
import jwt from 'jsonwebtoken';
import { JwtPayload } from 'jsonwebtoken';
import AppError from '../error/AppError';
import catchAsync from '../utils/catchAsync';
import { verifyToken } from '../utils/tokenManage';
import config from '../config';
import { User } from '../modules/user/user.model';

const auth = (...userRoles: string[]) => {
  return catchAsync(async (req, res, next) => {

    let token: any = req.headers?.authorization || req?.headers?.token;




    if (token.startsWith('Bearer ')) {
      token = token.slice(7, token.length);
    }


    // 1️⃣ Missing Token → 401 Unauthorized
    if (!token) {
      throw new AppError(
        httpStatus.UNAUTHORIZED,
        'Authorization token is missing'
      );
    }

    // 2️⃣ Invalid or Expired Token → 403 Forbidden
    let decodeData;
    try {
      decodeData = verifyToken({
        token,
        access_secret: config.jwt_access_secret as string,
      });
    } catch (error) {
      throw new AppError(httpStatus.FORBIDDEN, 'Invalid or expired token');
    }


    const { role, userId } = decodeData;

    // 3️⃣ User Not Found → 404 Not Found
    const isUserExist = await User.IsUserExistById(userId);

    if (!isUserExist) {
      throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    // 4️⃣ Role Not Authorized → 403 Forbidden
    if (userRoles.length && !userRoles.includes(role)) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        'Access denied. Insufficient privileges'
      );
    }

    // ✅ Authorized → Proceed
    req.user = decodeData;
    next();
  });
};

export default auth;

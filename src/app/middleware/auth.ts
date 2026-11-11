import { NextFunction, Request, RequestHandler, Response } from 'express';
import httpStatus from 'http-status';
import jwt, { JwtPayload } from 'jsonwebtoken';
import AppError from '../error/AppError';
import catchAsync from '../utils/catchAsync';
import config from '../config';
import { User } from '../modules/user/user.model';
import { USER_STATUS } from '../modules/user/user.constants';

const readToken = (req: Request): string | undefined => {
  const raw = (req.headers.authorization || req.headers.token) as string | undefined;
  if (!raw || typeof raw !== 'string') return undefined;
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
  return token.trim() || undefined;
};

/**
 * Verify an access token: signature, expiry and type, then tokenVersion and account status
 * against the user (so logout-all, password reset and blocking apply before the 15 minute
 * expiry). Used by the HTTP middleware AND the socket handshake, so both enforce the same rules.
 */
export const verifyAccessToken = async (token: string): Promise<JwtPayload & { userId: string; role: string }> => {
  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, config.jwt_access_secret as string) as JwtPayload;
  } catch {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid or expired token');
  }
  // Rejects the signup / refresh / reset tokens, which are signed with related secrets.
  if (decoded.typ !== 'access' || typeof decoded.sub !== 'string') {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid or expired token');
  }

  const user = await User.findById(decoded.sub).select('role status tokenVersion').lean();
  if (!user) throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid or expired token');
  if ((user.tokenVersion ?? 0) !== decoded.tokenVersion) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Session expired. Please sign in again.');
  }
  if (user.status !== USER_STATUS.ACTIVE) {
    throw new AppError(httpStatus.FORBIDDEN, 'Your account has been blocked');
  }
  // Role comes from the database record, not the token, so a role change applies at once.
  return { ...decoded, userId: String(user._id), role: user.role };
};

/** Layer 1. Attaches req.user. */
export const authenticate: RequestHandler = catchAsync(async (req, _res, next) => {
  const token = readToken(req);
  if (!token) throw new AppError(httpStatus.UNAUTHORIZED, 'Authorization token is missing');
  req.user = await verifyAccessToken(token);
  next();
});

/** Layer 2. Must run after authenticate. */
export const requireRole =
  (...roles: string[]): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(httpStatus.UNAUTHORIZED, 'Authentication required'));
    if (roles.length && !roles.includes(req.user.role)) {
      return next(new AppError(httpStatus.FORBIDDEN, 'Access denied. Insufficient privileges'));
    }
    next();
  };

/**
 * authenticate + requireRole in one, so existing `auth(USER_ROLE.X)` routes keep working.
 * Layer 3 (ownership) stays inside each service.
 */
const auth = (...userRoles: string[]): RequestHandler[] => [authenticate, requireRole(...userRoles)];

export default auth;

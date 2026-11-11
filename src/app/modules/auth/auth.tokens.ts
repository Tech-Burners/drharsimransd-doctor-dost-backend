import { createHash, randomUUID } from 'crypto';
import httpStatus from 'http-status';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Types } from 'mongoose';
import config from '../../config';
import AppError from '../../error/AppError';
import { createToken } from '../../utils/tokenManage';
import { Doctor } from '../doctor/doctor.model';
import { RefreshToken } from '../refreshToken/refreshToken.model';
import { REFRESH_TOKEN_STATUS } from '../refreshToken/refreshToken.constants';
import { TUser } from '../user/user.interface';
import { User } from '../user/user.model';
import { USER_STATUS } from '../user/user.constants';
import { logger } from '../../../shared/logger';

const ACCESS_TTL = () => config.jwt_access_expires_in || '15m';
const REFRESH_TTL = () => config.jwt_refresh_expires_in || '30d';

export interface TokenMeta {
  ip?: string;
  userAgent?: string;
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

type TokenUser = Pick<TUser, 'name' | 'email' | 'role' | 'profileImage' | 'phone' | 'tokenVersion'> & {
  _id: unknown;
};

const unauthorized = (message: string) => new AppError(httpStatus.UNAUTHORIZED, message);

/**
 * Access token: 15 min. Carries sub, role and tokenVersion. The extra profile claims keep
 * the shape the apps already read; they are display hints, never authority.
 */
const signAccess = async (user: TokenUser): Promise<string> => {
  const id = String(user._id);
  const doctor =
    user.role === 'doctor' ? await Doctor.findOne({ userId: id }).select('_id').lean() : null;

  return createToken({
    payload: {
      typ: 'access',
      sub: id,
      userId: id,
      role: user.role,
      tokenVersion: user.tokenVersion ?? 0,
      name: user.name || '',
      email: user.email,
      profileImage: user.profileImage,
      phone: user.phone,
      doctorId: doctor?._id?.toString() || null,
    },
    access_secret: config.jwt_access_secret as string,
    expity_time: ACCESS_TTL(),
  });
};

/** Refresh token: 30 days. Only its sha256 is stored, in RefreshToken. */
const signRefresh = async (user: TokenUser, meta: TokenMeta) => {
  const id = String(user._id);
  const token = createToken({
    payload: { typ: 'refresh', sub: id, userId: id, jti: randomUUID(), tokenVersion: user.tokenVersion ?? 0 },
    access_secret: config.jwt_refresh_secret as string,
    expity_time: REFRESH_TTL(),
  });
  const { exp } = jwt.decode(token) as JwtPayload;
  const doc = await RefreshToken.create({
    userId: id,
    tokenHash: hashToken(token),
    expiresAt: new Date((exp as number) * 1000),
    userAgent: (meta.userAgent || '').slice(0, 300),
    ipAddress: meta.ip || '',
  });
  return { token, id: doc._id as Types.ObjectId };
};

export const issueTokenPair = async (user: TokenUser, meta: TokenMeta = {}) => {
  const [accessToken, refresh] = await Promise.all([signAccess(user), signRefresh(user, meta)]);
  return { accessToken, refreshToken: refresh.token, refreshTokenId: refresh.id };
};

const verifyRefreshJwt = (token: string): JwtPayload => {
  try {
    const payload = jwt.verify(token, config.jwt_refresh_secret as string) as JwtPayload;
    if (payload.typ !== 'refresh' || typeof payload.sub !== 'string') throw new Error('wrong token type');
    return payload;
  } catch {
    throw unauthorized('Invalid or expired refresh token');
  }
};

export const revokeAllRefreshTokens = async (userId: string) => {
  await RefreshToken.updateMany(
    { userId, status: REFRESH_TOKEN_STATUS.ACTIVE },
    { $set: { status: REFRESH_TOKEN_STATUS.REVOKED, revokedAt: new Date() } },
  );
};

/** Invalidate every access token (tokenVersion) and every refresh token for the user. */
export const revokeEverything = async (userId: string) => {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  await revokeAllRefreshTokens(userId);
};

/**
 * Rotate: the presented token is marked replaced (atomically, so two parallel refreshes
 * cannot both win) and a new pair is issued. Presenting a token that was already replaced
 * is reuse: it means a copy of it exists somewhere it should not, so EVERYTHING for that
 * user is revoked and they must sign in again.
 */
export const rotateRefreshToken = async (token: string, meta: TokenMeta = {}) => {
  const payload = verifyRefreshJwt(token);
  const hash = hashToken(token);

  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash: hash, status: REFRESH_TOKEN_STATUS.ACTIVE, expiresAt: { $gt: new Date() } },
    { $set: { status: REFRESH_TOKEN_STATUS.REPLACED, revokedAt: new Date() } },
  );

  if (!claimed) {
    const known = await RefreshToken.findOne({ tokenHash: hash }).select('+tokenHash');
    if (known && known.status === REFRESH_TOKEN_STATUS.REPLACED) {
      logger.warn({ userId: String(known.userId) }, 'refresh token reuse detected; revoking all sessions');
      await revokeEverything(String(known.userId));
      throw unauthorized('Session revoked. Please sign in again.');
    }
    throw unauthorized('Invalid or expired refresh token');
  }

  const user = await User.findById(payload.sub);
  if (
    !user ||
    user.status !== USER_STATUS.ACTIVE ||
    (user.tokenVersion ?? 0) !== (payload.tokenVersion ?? 0)
  ) {
    await revokeAllRefreshTokens(String(claimed.userId));
    throw unauthorized('Session expired. Please sign in again.');
  }

  const next = await issueTokenPair(user, meta);
  await RefreshToken.updateOne({ _id: claimed._id }, { $set: { replacedByTokenId: next.refreshTokenId } });
  return { accessToken: next.accessToken, refreshToken: next.refreshToken };
};

/** Revoke one refresh token. Idempotent: an unknown or already revoked token is a no-op. */
export const revokeRefreshToken = async (token: string) => {
  let payload: JwtPayload;
  try {
    payload = verifyRefreshJwt(token);
  } catch {
    return; // an invalid or expired token holds no session to revoke
  }
  await RefreshToken.updateOne(
    { tokenHash: hashToken(token), userId: payload.sub, status: REFRESH_TOKEN_STATUS.ACTIVE },
    { $set: { status: REFRESH_TOKEN_STATUS.REVOKED, revokedAt: new Date() } },
  );
};

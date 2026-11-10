
import { Model, Types } from 'mongoose';
import { REFRESH_TOKEN_STATUS } from './refreshToken.constants';

export type TRefreshTokenStatus =
  (typeof REFRESH_TOKEN_STATUS)[keyof typeof REFRESH_TOKEN_STATUS];

export interface TRefreshToken {
  userId: Types.ObjectId;
  tokenHash: string;
  status: TRefreshTokenStatus;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByTokenId: Types.ObjectId | null;
  userAgent: string;
  ipAddress: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type RefreshTokenModel = Model<TRefreshToken>;

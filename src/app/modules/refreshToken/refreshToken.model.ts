
import { model, Schema } from 'mongoose';
import {
  TRefreshToken,
  RefreshTokenModel,
} from './refreshToken.interface';
import { REFRESH_TOKEN_STATUS } from './refreshToken.constants';

const refreshTokenSchema = new Schema<
  TRefreshToken,
  RefreshTokenModel
>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      select: false,
    },
    status: {
      type: String,
      enum: Object.values(REFRESH_TOKEN_STATUS),
      default: REFRESH_TOKEN_STATUS.ACTIVE,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    replacedByTokenId: {
      type: Schema.Types.ObjectId,
      ref: 'RefreshToken',
      default: null,
    },
    userAgent: {
      type: String,
      default: '',
    },
    ipAddress: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
  },
);

// Find active refresh tokens for a user.
refreshTokenSchema.index({ userId: 1, status: 1 });

// Automatically remove expired tokens.
refreshTokenSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 },
);

export const RefreshToken = model<
  TRefreshToken,
  RefreshTokenModel
>('RefreshToken', refreshTokenSchema);

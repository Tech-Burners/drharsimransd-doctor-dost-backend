import bcrypt from 'bcrypt';
import { model, Schema } from 'mongoose';
import { softDeletePlugin } from '../../plugins/softDelete.plugin';
import config from '../../config';
import { TUser, UserModel } from './user.interface';
import { GENDER, USER_ROLE, USER_STATUS } from './user.constants';

const userSchema = new Schema<TUser>(
  {
    name: {
      type: String,
      default: '',
      trim: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    profileImage: {
      type: String,
      default: '',
    },
    
    role: {
      type: String,
      enum: Object.values(USER_ROLE),
      default: USER_ROLE.PATIENT,
    },
    // Optional for patients. Doctors must supply it; that is enforced by the
    // registration service (doctors are created before they complete their profile,
    // so the schema cannot require it without breaking that flow).
    phone: {
      type: String,
      default: '',
      trim: true,
    },
    gender: {
      type: String,
      enum: Object.values(GENDER),
    },
    dateOfBirth: {
      type: Date,
    },
    phoneVerified: {
      type: Boolean,
      default: false,
    },
    // Bumped to invalidate all previously issued tokens for this user.
    tokenVersion: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: Object.values(USER_STATUS),
      default: USER_STATUS.ACTIVE,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
  },
);

userSchema.index({ role: 1, status: 1, isDeleted: 1 });

// Email is unique only among non-deleted users, so a soft-deleted account
// does not block re-registration.
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

// Phone is unique among non-deleted doctors only. Patients may leave it empty.
// `phone: { $gt: '' }` is an addition to the planned filter: doctors are created
// with phone '' until they complete their profile, and without it the second such
// doctor would collide on the empty string.
userSchema.index(
  { phone: 1 },
  {
    unique: true,
    partialFilterExpression: {
      role: USER_ROLE.DOCTOR,
      isDeleted: false,
      phone: { $gt: '' },
    },
  },
);

userSchema.pre('save', async function (next) {
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const user = this;

  if (user.isModified('password') && user.password) {
    user.password = await bcrypt.hash(
      user.password,
      Number(config.bcrypt_salt_rounds),
    );
  }

  next();
});

userSchema.methods.toJSON = function () {
  const user = this.toObject({ virtuals: true });
  delete user.password;
  return user;
};

// Exclude soft-deleted users from queries and aggregations.
userSchema.plugin(softDeletePlugin);

userSchema.statics.isUserExist = async function (email: string) {
  return await User.findOne({ email }).select('+password');
};

userSchema.statics.isUserActive = async function (email: string) {
  return await User.findOne({
    email,
    status: USER_STATUS.ACTIVE,
    isDeleted: false,
  }).select('+password');
};

userSchema.statics.IsUserExistById = async function (id: string) {
  return await User.findById(id).select('+password');
};

userSchema.statics.isPasswordMatched = async function (
  plainTextPassword: string,
  hashedPassword: string,
) {
  return await bcrypt.compare(plainTextPassword, hashedPassword);
};

export const User = model<TUser, UserModel>('User', userSchema);

import { Model } from 'mongoose';

export type TUserRole = 'patient' | 'doctor' | 'admin';
export type TUserStatus = 'active' | 'blocked';
export type TGender = 'male' | 'female' | 'other';

export interface TUser {
  _id: string
  name: string;
  email: string;
  password: string;
  profileImage: string;
  role: TUserRole;
  phone: string;
  gender?: TGender;
  dateOfBirth?: Date;
  phoneVerified: boolean;
  emailVerified: boolean;
  tokenVersion: number;
  status: TUserStatus;
  isDeleted: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface TUserCreate{
  name?: string,
  email: string,
  password: string,
  role: string,
}

export interface UserModel extends Model<TUser> {
  isUserExist(email: string): Promise<TUser | null>;
  isUserActive(email: string): Promise<TUser | null>;
  IsUserExistById(id: string): Promise<TUser | null>;
  isPasswordMatched(
    plainTextPassword: string,
    hashedPassword: string,
  ): Promise<boolean>;
}

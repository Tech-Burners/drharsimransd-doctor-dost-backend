import bcrypt from 'bcrypt';
import mongoose, { Schema } from 'mongoose';
import config from '../../config';
import { OtpModel, TOtp } from './otp.interface';

const otpSchema = new Schema<TOtp, OtpModel>(
    {
        sentTo: {
            type: String,
            required: [true, "Receiver source is required"],
        },
        receiverType: {
            type: String,
            enum: ["email", "phone"],
            default: "email",
        },
        purpose: {
            type: String,
            enum: ["email-verification", "reset-password", "phone-verification"],
            default: "email-verification",
        },
        // Stored as a bcrypt hash (see the hooks below).
        otp: {
            type: String,
            required: [true, "OTP must be provided"],
            trim: true,
        },
        expiredAt: {
            type: Date,
            required: [true, "Expiration date must be provided"],
        },
        status: {
            type: String,
            enum: ["pending", "verified", "expired"],
            default: "pending",
        },
        attempts: {
            type: Number,
            default: 0,
            min: 0,
        },
        maxAttempts: {
            type: Number,
            default: 5,
            min: 1,
        },
    },
    {
        timestamps: true, // Automatically adds createdAt and updatedAt fields
    }
);

// Automatically remove OTPs once they have expired.
otpSchema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });

// One live code per receiver and purpose. issueOtp() upserts on this pair, so two
// concurrent requests cannot leave two valid codes behind.
otpSchema.index({ sentTo: 1, purpose: 1 }, { unique: true });

const hashOtp = (plainOtp: string) =>
    bcrypt.hash(plainOtp, Number(config.bcrypt_salt_rounds));

otpSchema.pre('save', async function (next) {
    if (this.isModified('otp')) {
        this.otp = await hashOtp(this.otp);
    }
    next();
});

// Updates made through findOneAndUpdate bypass the save hook, so hash the
// code here too. A fresh code also resets the attempt counter.
otpSchema.pre('findOneAndUpdate', async function (next) {
    const update = this.getUpdate() as Record<string, any> | null;
    if (!update) return next();

    const target = update.$set ?? update;

    if (typeof target.otp === 'string') {
        target.otp = await hashOtp(target.otp);
        target.attempts = 0;
    }
    next();
});

otpSchema.statics.isOtpMatched = async function (
    plainOtp: string,
    hashedOtp: string,
) {
    return await bcrypt.compare(plainOtp, hashedOtp);
};

const Otp = mongoose.model<TOtp, OtpModel>('Otp', otpSchema);

export default Otp;

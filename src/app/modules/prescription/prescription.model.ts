import { model, Schema } from 'mongoose';
import { TPrescription, PrescriptionModel } from './prescription.interface';

const medicineSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    dosage: {
      type: String,
      default: '',
    },
    frequency: {
      type: String,
      default: '',
    },
    duration: {
      type: String,
      default: '',
    },
    instructions: {
      type: String,
      default: '',
    },
  },
  { _id: false },
);

const prescriptionSchema = new Schema<TPrescription>(
  {
    callId: {
      type: Schema.Types.ObjectId,
      ref: 'Call',
      required: true,
      unique: true,
    },
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: 'Doctor',
      required: true,
    },
    patientId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    chiefComplaint: {
      type: String,
      default: '',
    },
    comorbidities: {
      type: [String],
      default: [],
    },
    advice: {
      type: String,
      default: '',
    },
    medicines: {
      type: [medicineSchema],
      default: [],
    },
    submittedAt: {
      type: Date,
      default: Date.now,
    },
    pdfObjectKey: {
      type: String,
      default: '',
    },
    callEndedEarly: {
      type: Boolean,
      default: false,
    },
    doctorNameSnapshot: {
      type: String,
      required: true,
    },
    doctorRegistrationNoSnapshot: {
      type: String,
      required: true,
    },
    doctorQualificationSnapshot: {
      type: String,
      default: '',
    },
    doctorSignatureSnapshot: {
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

prescriptionSchema.index({ patientId: 1, createdAt: -1 });
prescriptionSchema.index({ doctorId: 1, createdAt: -1 });

export const Prescription = model<TPrescription, PrescriptionModel>(
  'Prescription',
  prescriptionSchema,
);

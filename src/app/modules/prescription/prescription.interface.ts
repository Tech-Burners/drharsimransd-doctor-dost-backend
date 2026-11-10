import { Model, Types } from 'mongoose';

export interface TMedicine {
  name: string;
  dosage: string;
  frequency: string;
  duration: string;
  instructions: string;
}

export interface TPrescription {
  callId: Types.ObjectId;
  patientId: Types.ObjectId;
  doctorId: Types.ObjectId;
  chiefComplaint: string;
  comorbidities: string[];
  advice: string;
  medicines: TMedicine[];
  submittedAt: Date;
  pdfObjectKey: string;
  // Set by the server from Call.endReason, never typed by the doctor.
  callEndedEarly: boolean;
  doctorNameSnapshot: string;
  doctorRegistrationNoSnapshot: string;
  doctorQualificationSnapshot: string;
  doctorSignatureSnapshot: string;
  createdAt?: Date;
  updatedAt?: Date;
}
export type PrescriptionModel = Model<TPrescription>;

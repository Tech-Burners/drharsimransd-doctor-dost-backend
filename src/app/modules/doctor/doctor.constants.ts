export const DOCTOR_APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SUSPENDED: 'suspended',
} as const;

export const DOCTOR_PAYOUT_MODE = {
  COMMISSION: 'commission',
  RETAINER: 'retainer',
} as const;

export const DOCTOR_SPECIALTY = {
  GENERAL_PHYSICIAN: 'general_physician',
  PEDIATRICIAN: 'pediatrician',
  GYNECOLOGIST: 'gynecologist',
  DERMATOLOGIST: 'dermatologist',
  CARDIOLOGIST: 'cardiologist',
  ORTHOPEDIC: 'orthopedic',
  PSYCHIATRIST: 'psychiatrist',
  NEUROLOGIST: 'neurologist',
  ENT: 'ent',
  OPHTHALMOLOGIST: 'ophthalmologist',
  UROLOGIST: 'urologist',
  DENTIST: 'dentist',
  OTHER: 'other',
} as const;

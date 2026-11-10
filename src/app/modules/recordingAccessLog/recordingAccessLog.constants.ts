export const RECORDING_ACCESS_ROLE = {
  PATIENT: 'patient',
  DOCTOR: 'doctor',
  ADMIN: 'admin',
} as const;

export const RECORDING_ACCESS_ACTION = {
  VIEW: 'view',
  DOWNLOAD: 'download',
} as const;

export const RECORDING_ACCESS_REASON = {
  PATIENT_COMPLAINT: 'patient_complaint',
  MEDICO_LEGAL: 'medico_legal',
  QUALITY_AUDIT: 'quality_audit',
  OTHER: 'other',
} as const;


export const WITHDRAWAL_DESTINATION_TYPE = {
  BANK: 'bank',
  UPI: 'upi',
} as const;

export const WITHDRAWAL_REQUEST_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  REJECTED: 'rejected',
} as const;

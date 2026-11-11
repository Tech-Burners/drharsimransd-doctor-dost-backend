
export const WITHDRAWAL_DESTINATION_TYPE = {
  BANK: 'bank',
  UPI: 'upi',
} as const;

export const WITHDRAWAL_REQUEST_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  REJECTED: 'rejected',
  // Cancelled by the SYSTEM, not an admin decision: every earning funding the request was
  // refunded (see refund.service). The reason is kept in rejectionReason.
  CANCELLED: 'cancelled',
} as const;

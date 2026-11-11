export const DOCTOR_EARNING_STATUS = {
  HELD: 'held',
  RELEASED: 'released',
  FORFEITED: 'forfeited',
  WITHDRAWN: 'withdrawn',
  // The call was refunded after the earning was released or paid out. The row is kept.
  REVERSED: 'reversed',
} as const;

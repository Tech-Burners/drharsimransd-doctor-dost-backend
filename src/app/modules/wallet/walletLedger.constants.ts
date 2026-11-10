
export const WALLET_LEDGER_TYPE = {
  TOPUP: 'topup',
  CALL_CHARGE: 'call_charge',
  REFUND: 'refund',
  ADJUSTMENT: 'adjustment',
  WITHDRAWAL: 'withdrawal',
} as const;

export const WALLET_LEDGER_DIRECTION = {
  CREDIT: 'credit',
  DEBIT: 'debit',
} as const;

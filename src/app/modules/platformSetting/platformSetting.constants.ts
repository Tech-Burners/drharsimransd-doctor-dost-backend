export const ROUNDING_MODE = {
  UP: 'up',
  DOWN: 'down',
  EXACT: 'exact',
} as const;

export type TRoundingMode = (typeof ROUNDING_MODE)[keyof typeof ROUNDING_MODE];

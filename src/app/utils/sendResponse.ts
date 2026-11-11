import { Response } from 'express';

type TMeta = {
  limit?: number;
  page?: number;
  total?: number;
  totalPage?: number;
  [key: string]: unknown;
};

export type TResponse<T> = {
  statusCode: number;
  success: boolean;
  message?: string;
  data: T;
  meta?: TMeta;
};

/** The one response envelope: { success, message, data, meta }. */
export type TEnvelope<T> = {
  success: boolean;
  message: string;
  data: T;
  meta: TMeta | null;
};

export const toEnvelope = <T>(input: {
  success: boolean;
  message?: string;
  data: T;
  meta?: TMeta | null;
}): TEnvelope<T> => ({
  success: input.success,
  message: input.message ?? '',
  data: input.data ?? (null as T),
  meta: input.meta ?? null,
});

const sendResponse = <T>(res: Response, data: TResponse<T>) => {
  res.status(data?.statusCode).json(toEnvelope(data));
};

export default sendResponse;

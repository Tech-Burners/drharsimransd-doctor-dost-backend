// Per-request (and per-job) correlation context. Every log line picks up requestId and,
// when set, callId from here automatically, so a billing dispute can be traced across
// the API and the worker by id instead of by timestamp.
import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
  callId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T =>
  storage.run({ ...ctx }, fn);

export const getContext = (): RequestContext | undefined => storage.getStore();

export const getRequestId = (): string | undefined => storage.getStore()?.requestId;

/**
 * Attach a callId to the current context. From here on, every log line in this request
 * or job carries it: start request, Agora token mint, webhook receipt, billing, earning.
 */
export const setCallId = (callId: string): void => {
  const store = storage.getStore();
  if (store) store.callId = callId;
};

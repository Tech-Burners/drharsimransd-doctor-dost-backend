// Real-time events to a user ("call:incoming", "call:warning", ...). Every connected socket
// joins the room `user:<id>`, so an emit reaches the user on whichever API instance holds the
// socket (Socket.IO Redis adapter). The API registers its server at start-up; the WORKER
// has no server, so it emits through the Redis emitter instead. Best effort: a failed emit is
// logged and never fails the business operation.
import { Emitter } from '@socket.io/redis-emitter';
import config from '../app/config';
import { getRedis } from './redis';
import { logger } from './logger';

export interface RealtimeEmitter {
  emitToUser(userId: string, event: string, payload: unknown): void;
}

export const userRoom = (userId: string) => `user:${userId}`;

let emitter: RealtimeEmitter | null = null;

/** Called by the API's socket server at start-up (and by tests). Pass null to clear. */
export const setRealtimeEmitter = (e: RealtimeEmitter | null): void => {
  emitter = e;
};

const redisEmitter = (): RealtimeEmitter | null => {
  if (!config.redis_url) return null;
  const e = new Emitter(getRedis());
  return { emitToUser: (userId, event, payload) => void e.to(userRoom(userId)).emit(event, payload) };
};

export const emitToUser = (userId: string, event: string, payload: unknown): void => {
  try {
    (emitter ?? (emitter = redisEmitter()))?.emitToUser(userId, event, payload);
  } catch (err) {
    logger.error({ err, event }, 'realtime emit failed');
  }
};

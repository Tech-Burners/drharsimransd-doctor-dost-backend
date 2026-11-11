// Socket wiring for doctor presence (see presence.service.ts for the model).
//   connect       -> set the Redis key and the Mongo cache (doctors only, phone verified)
//   `presence`    -> renew the key. Every 30 s from the doctor app. NO Mongo write
//   `go-offline`  -> delete the key and clear the cache (the doctor toggled offline)
//   disconnect    -> if that was the doctor's LAST socket: delete the key and clear the cache
import type { Server, Socket } from 'socket.io';
import { logger } from '../../../shared/logger';
import { userRoom } from '../../../shared/realtime';
import { presenceService } from './presence.service';

export const registerPresenceHandlers = (io: Server, socket: Socket): void => {
  const user = socket.user;
  if (!user || user.role !== 'doctor') return;

  let doctorId: string | null = null;
  const guard = (what: string, fn: () => Promise<unknown>) =>
    fn().catch((err) => logger.error({ err, what, userId: user._id }, 'presence handler failed'));

  void guard('connect', async () => {
    doctorId = await presenceService.goOnline(user._id);
  });

  socket.on('presence', () => {
    // Renew only; if the doctor was not allowed online at connect (e.g. phone not verified yet),
    // try again so verifying the phone takes effect without reconnecting.
    void guard('heartbeat', async () => {
      if (doctorId) await presenceService.heartbeat(doctorId);
      else doctorId = await presenceService.goOnline(user._id);
    });
  });

  socket.on('go-offline', () => {
    void guard('go-offline', async () => {
      if (doctorId) await presenceService.goOffline(doctorId);
    });
  });

  socket.on('disconnect', () => {
    void guard('disconnect', async () => {
      if (!doctorId) return;
      // A second device may still be connected: only the last one takes the doctor offline.
      const remaining = await io.in(userRoom(user._id)).fetchSockets();
      if (remaining.length === 0) await presenceService.goOffline(doctorId);
    });
  });
};

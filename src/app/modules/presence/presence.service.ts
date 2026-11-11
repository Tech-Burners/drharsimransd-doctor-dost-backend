// Doctor presence. A client-set `isOnline` boolean is unreliable: a dead phone, a killed app or
// a tunnel leaves it true forever, and every later call to that doctor becomes a missed call. So
// presence is a Redis key with a TTL that the doctor app renews; if the heartbeats stop, the key
// expires and the doctor stops receiving calls within the TTL.
//
//   presence:doctor:<doctorId>   TTL = PRESENCE_TTL_SECONDS (90)   renewed by the `presence` event
//                                                                  every 30 s
//
// Doctor.isOnline in MongoDB is only a CACHE (so the patient list can filter and sort). It is
// written on connect, on disconnect and on going offline, NEVER on a heartbeat. The Phase 8 sweep
// reconciles it with the keys. Redis is the source of truth.
import config from '../../config';
import { withStore } from '../../../shared/rateLimit';
import { Doctor } from '../doctor/doctor.model';
import { User } from '../user/user.model';

export const presenceKey = (doctorId: string) => `presence:doctor:${doctorId}`;

/** Set or renew the key. One Redis write; no Mongo write. */
const heartbeat = (doctorId: string): Promise<unknown> =>
  withStore((s) => s.set(presenceKey(doctorId), '1', 'EX', config.presence_ttl_seconds));

const clear = (doctorId: string): Promise<unknown> => withStore((s) => s.del(presenceKey(doctorId)));

/** True while the key exists. The ONLY check "is this doctor online" for placing a call. */
const isOnline = async (doctorId: string): Promise<boolean> => {
  const ttl = await withStore((s) => s.ttl(presenceKey(doctorId)));
  return ttl > 0;
};

/** Cache write, only on a state change. */
const cacheIsOnline = (doctorId: string, online: boolean) =>
  Doctor.updateOne(
    { _id: doctorId },
    { $set: { isOnline: online, ...(online ? { lastOnlineAt: new Date() } : {}) } },
  );

/** May this user's doctor appear online? Same gate as everywhere: phone verified. */
const mayBeOnline = async (userId: string): Promise<{ doctorId: string } | null> => {
  const [user, doctor] = await Promise.all([
    User.findById(userId).select('phoneVerified status role').lean(),
    Doctor.findOne({ userId }).select('_id').lean(),
  ]);
  if (!user || !doctor || user.role !== 'doctor' || user.status !== 'active' || !user.phoneVerified) return null;
  return { doctorId: String(doctor._id) };
};

/** Socket connect: set the key and the cache. */
const goOnline = async (userId: string): Promise<string | null> => {
  const who = await mayBeOnline(userId);
  if (!who) return null;
  await heartbeat(who.doctorId);
  await cacheIsOnline(who.doctorId, true);
  return who.doctorId;
};

/** Explicit disconnect (last socket) or the doctor toggling offline: delete the key, set the cache. */
const goOffline = async (doctorId: string): Promise<void> => {
  await clear(doctorId);
  await cacheIsOnline(doctorId, false);
};

export const presenceService = { heartbeat, isOnline, goOnline, goOffline, mayBeOnline, clear };

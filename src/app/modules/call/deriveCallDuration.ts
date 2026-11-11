// Duration comes from Agora's server-side channel events, NEVER from the client. Agora
// delivers join and leave events per uid, not a duration, so it is DERIVED here.
//
// Pure: no database, no clock. Handles out-of-order delivery, duplicate events, a missing
// leave for one party, parties leaving at different times, and a party that drops and
// rejoins. Returns null when a duration cannot be determined; it never returns a guess.
//
// Event types (Agora "Receive notifications about channel events"):
//   join:  103 broadcaster join, 105 audience join, 107 user join (communication mode)
//   leave: 104 broadcaster leave, 106 audience leave, 108 user leave (communication mode)
// payload.ts is in SECONDS. payload.clientSeq orders one user's events on the app client.
//
// The billable duration is the time BOTH parties were in the channel at once: the sum of the
// overlaps between the patient's and the doctor's presence intervals.

export const JOIN_EVENT_TYPES = new Set(['103', '105', '107']);
export const LEAVE_EVENT_TYPES = new Set(['104', '106', '108']);

export interface PresenceEvent {
  uid: string;
  eventType: string;
  /** Event time (payload.ts * 1000). */
  eventTs: Date;
  /** payload.clientSeq when Agora sent one. */
  clientSeq?: number | null;
}

export type CallPresence =
  /** Both parties have been in the channel and the overlap is over. */
  | { state: 'ended'; durationSeconds: number; startedAt: Date; endedAt: Date; firstLeaver: 'patient' | 'doctor' }
  /** Both are in the channel right now, or no leave was seen: the end is unknown. */
  | { state: 'unknown' }
  /** Someone left but the two were never in the channel together: no conversation happened. */
  | { state: 'never_connected' };

interface Interval {
  start: number; // ms
  end: number | null; // ms, null = still open
}

const seqOf = (e: PresenceEvent): number => (typeof e.clientSeq === 'number' && Number.isFinite(e.clientSeq) ? e.clientSeq : NaN);

/** Dedupe, then order one user's events: by clientSeq when both have it, else by time. */
const normalise = (events: PresenceEvent[]): PresenceEvent[] => {
  const seen = new Set<string>();
  const unique: PresenceEvent[] = [];
  for (const e of events) {
    const key = `${e.eventType}|${Number.isNaN(seqOf(e)) ? 'ts' + e.eventTs.getTime() : 'seq' + seqOf(e)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }
  return unique.sort((a, b) => {
    const sa = seqOf(a);
    const sb = seqOf(b);
    if (!Number.isNaN(sa) && !Number.isNaN(sb) && sa !== sb) return sa - sb;
    if (a.eventTs.getTime() !== b.eventTs.getTime()) return a.eventTs.getTime() - b.eventTs.getTime();
    // Same instant: a join sorts before a leave, so a zero-length stay is not misread.
    return Number(LEAVE_EVENT_TYPES.has(a.eventType)) - Number(LEAVE_EVENT_TYPES.has(b.eventType));
  });
};

/** One user's presence as intervals. A leave with no known join, and a repeated join, are ignored. */
const intervalsOf = (events: PresenceEvent[]): Interval[] => {
  const out: Interval[] = [];
  let open: Interval | null = null;
  for (const e of normalise(events)) {
    const t = e.eventTs.getTime();
    if (JOIN_EVENT_TYPES.has(e.eventType)) {
      if (!open) {
        open = { start: t, end: null };
        out.push(open);
      }
    } else if (LEAVE_EVENT_TYPES.has(e.eventType)) {
      if (open) {
        open.end = Math.max(t, open.start);
        open = null;
      }
    }
  }
  return out;
};

export const analyseCallPresence = (
  events: PresenceEvent[],
  uids: { patient: string; doctor: string },
): CallPresence => {
  const relevant = events.filter((e) => JOIN_EVENT_TYPES.has(e.eventType) || LEAVE_EVENT_TYPES.has(e.eventType));
  const patient = intervalsOf(relevant.filter((e) => e.uid === uids.patient));
  const doctor = intervalsOf(relevant.filter((e) => e.uid === uids.doctor));

  const anyLeave = relevant.some((e) => LEAVE_EVENT_TYPES.has(e.eventType) && (e.uid === uids.patient || e.uid === uids.doctor));
  if (!anyLeave) return { state: 'unknown' }; // nobody has left: still going, or no end event yet

  let totalMs = 0;
  let firstStart: number | null = null;
  let lastEnd: number | null = null;
  let sawOpenOverlap = false;

  for (const p of patient) {
    for (const d of doctor) {
      const start = Math.max(p.start, d.start);
      const end = p.end === null ? d.end : d.end === null ? p.end : Math.min(p.end, d.end);
      if (end === null) {
        sawOpenOverlap = true; // both still present as far as the events say
        continue;
      }
      if (end > start) {
        totalMs += end - start;
        firstStart = firstStart === null ? start : Math.min(firstStart, start);
        lastEnd = lastEnd === null ? end : Math.max(lastEnd, end);
      }
    }
  }

  // Both are (as far as we know) still together, e.g. one of them dropped and came back.
  if (sawOpenOverlap) return { state: 'unknown' };

  if (totalMs === 0) {
    // Someone left, nobody overlapped. If a party never appeared at all we cannot say what
    // happened (a lost join event), so that is unknown; if both appeared, they never met.
    return patient.length > 0 && doctor.length > 0 ? { state: 'never_connected' } : { state: 'unknown' };
  }

  // Who left first, from the end of the last overlap.
  const lastP = patient.filter((i) => i.end === lastEnd).length > 0;
  const lastD = doctor.filter((i) => i.end === lastEnd).length > 0;
  const firstLeaver: 'patient' | 'doctor' = lastP && !lastD ? 'patient' : lastD && !lastP ? 'doctor' : 'patient';

  return {
    state: 'ended',
    durationSeconds: Math.round(totalMs / 1000),
    startedAt: new Date(firstStart as number),
    endedAt: new Date(lastEnd as number),
    firstLeaver,
  };
};

/**
 * Seconds both parties were in the channel, or null when it cannot be determined (nobody has
 * left yet, a party's presence is unknown, or they are still together). Never a guess.
 */
export const deriveCallDuration = (
  events: PresenceEvent[],
  uids: { patient: string; doctor: string },
): number | null => {
  const r = analyseCallPresence(events, uids);
  if (r.state === 'ended') return r.durationSeconds;
  if (r.state === 'never_connected') return 0;
  return null;
};

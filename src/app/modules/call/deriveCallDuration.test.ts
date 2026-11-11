// UNIT tests (no database): duration is DERIVED from Agora join/leave events.
import { analyseCallPresence, deriveCallDuration, PresenceEvent } from './deriveCallDuration';

const P = '1001'; // patient uid
const D = '2002'; // doctor uid
const uids = { patient: P, doctor: D };
const T0 = Date.UTC(2026, 2, 10, 6, 0, 0); // arbitrary
const at = (sec: number) => new Date(T0 + sec * 1000);
// communication mode: 107 join, 108 leave
const join = (uid: string, sec: number, seq?: number): PresenceEvent => ({ uid, eventType: '107', eventTs: at(sec), clientSeq: seq ?? sec });
const leave = (uid: string, sec: number, seq?: number): PresenceEvent => ({ uid, eventType: '108', eventTs: at(sec), clientSeq: seq ?? sec });

describe('deriveCallDuration', () => {
  it('normal call: both join, both leave -> overlap seconds', () => {
    const events = [join(P, 0), join(D, 5), leave(P, 125), leave(D, 126)];
    expect(deriveCallDuration(events, uids)).toBe(120); // 5 -> 125
  });

  it('duration starts when the SECOND party arrives, not the first', () => {
    expect(deriveCallDuration([join(P, 0), join(D, 40), leave(D, 100), leave(P, 101)], uids)).toBe(60);
  });

  it('out-of-order delivery gives the same answer', () => {
    const ordered = [join(P, 0), join(D, 5), leave(P, 125), leave(D, 126)];
    const shuffled = [leave(D, 126), join(D, 5), leave(P, 125), join(P, 0)];
    expect(deriveCallDuration(shuffled, uids)).toBe(deriveCallDuration(ordered, uids));
    expect(deriveCallDuration(shuffled, uids)).toBe(120);
  });

  it('duplicate events (Agora retries) change nothing', () => {
    const events = [join(P, 0), join(P, 0), join(D, 5), join(D, 5), leave(P, 125), leave(P, 125), leave(D, 126), leave(D, 126)];
    expect(deriveCallDuration(events, uids)).toBe(120);
  });

  it('a missing leave for ONE party: the party who did leave ends the call', () => {
    // the doctor's leave event was lost
    expect(deriveCallDuration([join(P, 0), join(D, 5), leave(P, 65)], uids)).toBe(60);
    // the patient's leave event was lost
    expect(deriveCallDuration([join(P, 0), join(D, 5), leave(D, 65)], uids)).toBe(60);
  });

  it('parties leaving at different times: the call ends when the FIRST one leaves', () => {
    const r = analyseCallPresence([join(P, 0), join(D, 0), leave(D, 90), leave(P, 400)], uids);
    expect(r).toMatchObject({ state: 'ended', durationSeconds: 90, firstLeaver: 'doctor' });
    const r2 = analyseCallPresence([join(P, 0), join(D, 0), leave(P, 30), leave(D, 400)], uids);
    expect(r2).toMatchObject({ state: 'ended', durationSeconds: 30, firstLeaver: 'patient' });
  });

  it('reports who started and ended the overlap', () => {
    const r = analyseCallPresence([join(P, 10), join(D, 20), leave(P, 80), leave(D, 82)], uids);
    expect(r).toMatchObject({ state: 'ended', startedAt: at(20), endedAt: at(80) });
  });

  it('a drop and a rejoin: the time apart is not billed', () => {
    // patient: 0-50 and 70-130; doctor: 0-130 (the doctor never left)
    const events = [join(P, 0), join(D, 0), leave(P, 50), join(P, 70), leave(P, 130), leave(D, 130)];
    expect(deriveCallDuration(events, uids)).toBe(50 + 60);
  });

  it('uses clientSeq to order one user\'s events, even when timestamps tie', () => {
    const events = [join(P, 0), join(D, 0), leave(D, 60, 9), join(D, 60, 8), leave(D, 90, 10)];
    // doctor: join(seq 8) at 60... then leave seq 9 at 60 -> sorted by seq: 0 join, 8 join(dup ignored), 9 leave, 10 leave(ignored)
    expect(analyseCallPresence(events, uids).state).not.toBe('unknown');
  });

  it('handles the large (17 digit) clientSeq values Agora sends', () => {
    const big = 16250510358369;
    const events = [join(P, 0, big), join(D, 5, big + 1), leave(P, 65, big + 2), leave(D, 66, big + 3)];
    expect(deriveCallDuration(events, uids)).toBe(60);
  });

  it('streaming-profile event types (103/104 and 105/106) count too', () => {
    const e = (uid: string, eventType: string, sec: number): PresenceEvent => ({ uid, eventType, eventTs: at(sec), clientSeq: sec });
    expect(deriveCallDuration([e(P, '103', 0), e(D, '105', 0), e(P, '104', 75), e(D, '106', 76)], uids)).toBe(75);
  });
});

describe('deriveCallDuration returns null when it cannot be determined (never a guess)', () => {
  it('no events at all', () => {
    expect(deriveCallDuration([], uids)).toBeNull();
  });

  it('nobody has left yet (the call is still going)', () => {
    expect(deriveCallDuration([join(P, 0), join(D, 5)], uids)).toBeNull();
  });

  it('only one party ever joined and nobody left', () => {
    expect(deriveCallDuration([join(P, 0)], uids)).toBeNull();
  });

  it('a leave for a party whose join was lost', () => {
    // the doctor\'s join is missing, so when they were present is unknown
    expect(deriveCallDuration([join(P, 0), leave(D, 90), leave(P, 91)], uids)).toBeNull();
  });

  it('they are still together after a rejoin (an open overlap)', () => {
    expect(deriveCallDuration([join(P, 0), join(D, 0), leave(P, 50), join(P, 70)], uids)).toBeNull();
  });

  it('events from a uid that is not a party (a recording bot) are ignored', () => {
    expect(deriveCallDuration([join('9999', 0), leave('9999', 100)], uids)).toBeNull();
    expect(deriveCallDuration([join(P, 0), join(D, 5), join('9999', 6), leave('9999', 8)], uids)).toBeNull();
  });

  it('channel create/destroy and role-change events (101, 102, 111, 112) are not presence', () => {
    const noise: PresenceEvent[] = ['101', '102', '111', '112'].map((eventType) => ({ uid: P, eventType, eventTs: at(1), clientSeq: 1 }));
    expect(deriveCallDuration(noise, uids)).toBeNull();
  });
});

describe('a call that never connected', () => {
  it('both appeared at different times and left without ever overlapping: 0 seconds, "never_connected"', () => {
    const events = [join(P, 0), leave(P, 20), join(D, 30), leave(D, 40)];
    expect(analyseCallPresence(events, uids)).toEqual({ state: 'never_connected' });
    expect(deriveCallDuration(events, uids)).toBe(0);
  });
});

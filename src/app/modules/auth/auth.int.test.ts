// INTEGRATION tests (real replica-set database). Redis is a FakeRedis double with a
// controllable clock; SMS goes through InMemorySmsProvider; email is mocked.
import express, { Request, Response } from 'express';
import request from 'supertest';
import { useTestDb } from '../../../test/helpers/db';
import { FakeRedis } from '../../../test/helpers/fakeRedis';
import { setRateLimitStore } from '../../../shared/rateLimit';
import { InMemorySmsProvider, setSmsProvider, sendSms, SmsNotConfiguredError } from '../../../shared/sms';
import globalErrorHandler from '../../middleware/globalErrorhandler';
import auth from '../../middleware/auth';
import { authRoutes } from './auth.route';
import { User } from '../user/user.model';
import { Doctor } from '../doctor/doctor.model';
import Otp from '../otp/otp.model';
import { RefreshToken } from '../refreshToken/refreshToken.model';
import { USER_ROLE } from '../user/user.constants';
import { assertDoctorMayBeApproved, assertDoctorMayGoOnline } from '../doctor/doctor.gate';
import { generateOtp } from '../../utils/otpGenerator';
import config from '../../config';

const mockSendEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/eamilNotifiacation', () => ({
  otpSendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);
  // Probes for the authentication / role layers.
  app.get('/probe/any', auth(), (req: Request, res: Response) => {
    res.json({ userId: req.user.userId });
  });
  app.get('/probe/admin', auth(USER_ROLE.ADMIN), (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  app.use(globalErrorHandler);
  return app;
};

const PASSWORD = 'Str0ng-Passw0rd';
const DOC_PHONE = '+919876543210';
let seq = 0;

describe('Phase 4 auth', () => {
  useTestDb();
  const app = buildApp();
  let redis: FakeRedis;
  let sms: InMemorySmsProvider;

  beforeEach(() => {
    redis = new FakeRedis();
    sms = new InMemorySmsProvider();
    setRateLimitStore(redis);
    setSmsProvider(sms);
    mockSendEmail.mockClear();
  });
  afterAll(() => {
    setRateLimitStore(null);
    setSmsProvider(null);
  });

  const makeUser = async (role: string = USER_ROLE.PATIENT, extra: Record<string, unknown> = {}) => {
    seq += 1;
    return User.create({
      name: `U${seq}`,
      email: `user${seq}@example.com`,
      password: PASSWORD,
      role,
      emailVerified: true,
      ...(role === USER_ROLE.DOCTOR && { phone: `+9198765${String(10000 + seq)}` }),
      ...extra,
    });
  };
  const login = async (email: string, password = PASSWORD) =>
    request(app).post('/api/v1/auth/login').send({ email, password });
  const signIn = async (user: { email: string }) => (await login(user.email)).body.data as {
    accessToken: string;
    refreshToken: string;
  };
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const emailCodeFor = (to: string) =>
    [...mockSendEmail.mock.calls].reverse().find((c) => c[0].sentTo === to)?.[0].otp as string | undefined;

  // ------------------------------------------------------------ OTP generator
  describe('generateOtp', () => {
    it('is always six digits, zero padded', () => {
      for (let i = 0; i < 500; i += 1) expect(generateOtp()).toMatch(/^\d{6}$/);
    });
  });

  // -------------------------------------------------------- register and login
  describe('register', () => {
    it('creates a patient by default, never admin, and emails a code', async () => {
      const res = await request(app).post('/api/v1/auth/register').send({ email: 'New@Example.com', password: PASSWORD });
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({ email: 'new@example.com', verificationRequired: true });
      const user = await User.findOne({ email: 'new@example.com' });
      expect(user?.role).toBe('patient');
      expect(user?.emailVerified).toBe(false);
      expect(emailCodeFor('new@example.com')).toMatch(/^\d{6}$/);
    });

    it('rejects admin self-registration', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'a@example.com', password: PASSWORD, role: 'admin' });
      expect(res.status).toBe(400);
      expect(await User.countDocuments({ role: 'admin' })).toBe(0);
    });

    it('requires a phone with country code for doctors', async () => {
      const base = { email: 'd@example.com', password: PASSWORD, role: 'doctor' };
      expect((await request(app).post('/api/v1/auth/register').send(base)).status).toBe(400);
      expect((await request(app).post('/api/v1/auth/register').send({ ...base, phone: '9876543210' })).status).toBe(400);
      const ok = await request(app).post('/api/v1/auth/register').send({ ...base, phone: DOC_PHONE });
      expect(ok.status).toBe(201);
      expect((await User.findOne({ email: 'd@example.com' }))?.phone).toBe(DOC_PHONE);
    });

    it('returns the same response for an email that already exists', async () => {
      const first = await request(app).post('/api/v1/auth/register').send({ email: 'same@example.com', password: PASSWORD });
      const existing = await makeUser(USER_ROLE.PATIENT, { email: 'taken@example.com' });
      const again = await request(app).post('/api/v1/auth/register').send({ email: existing.email, password: 'Other-Passw0rd!' });
      expect(again.status).toBe(first.status);
      expect(Object.keys(again.body.data)).toEqual(Object.keys(first.body.data));
      expect(again.body.message).toBe(first.body.message);
      // The original account's password is untouched.
      expect((await login(existing.email)).status).toBe(200);
    });
  });

  describe('login', () => {
    it('returns user, accessToken and refreshToken for every role', async () => {
      for (const role of [USER_ROLE.PATIENT, USER_ROLE.DOCTOR, USER_ROLE.ADMIN]) {
        const user = await makeUser(role);
        const res = await login(user.email);
        expect(res.status).toBe(200);
        expect(res.body.data.accessToken).toEqual(expect.any(String));
        expect(res.body.data.refreshToken).toEqual(expect.any(String));
        expect(res.body.data.user.password).toBeUndefined();
        expect(res.body.data.user.role).toBe(role);
      }
    });

    it('gives the same failure for a wrong password and an unknown email', async () => {
      const user = await makeUser();
      const wrong = await login(user.email, 'wrong-password');
      const unknown = await login('nobody@example.com');
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.message).toBe(unknown.body.message);
    });

    it('refuses a blocked account', async () => {
      const user = await makeUser(USER_ROLE.PATIENT, { status: 'blocked' });
      expect((await login(user.email)).status).toBe(403);
    });

    it('locks the identifier after 5 consecutive failures, even for the right password', async () => {
      const user = await makeUser();
      for (let i = 0; i < 5; i += 1) expect((await login(user.email, 'bad')).status).toBe(401);
      const locked = await login(user.email);
      expect(locked.status).toBe(429);
      // an unknown email is locked the same way, so lockout reveals nothing
      for (let i = 0; i < 5; i += 1) await login('ghost@example.com', 'bad');
      expect((await login('ghost@example.com', 'bad')).status).toBe(429);
      // the lock expires
      redis.advance(16 * 60);
      expect((await login(user.email)).status).toBe(200);
    });

    it('a success resets the failure counter', async () => {
      const user = await makeUser();
      for (let i = 0; i < 4; i += 1) await login(user.email, 'bad');
      expect((await login(user.email)).status).toBe(200);
      for (let i = 0; i < 4; i += 1) expect((await login(user.email, 'bad')).status).toBe(401);
    });

    it('rate limits per IP', async () => {
      let last = 0;
      for (let i = 0; i < 31; i += 1) last = (await login(`probe${i}@example.com`, 'bad')).status;
      expect(last).toBe(429);
    });

    it('fails closed (503) when Redis is down', async () => {
      const user = await makeUser();
      redis.down = true;
      expect((await login(user.email)).status).toBe(503);
    });

    it('never leaves a counter without an expiry', async () => {
      const user = await makeUser();
      await login(user.email, 'bad');
      await request(app).post('/api/v1/auth/forgot-password').send({ email: user.email });
      expect(redis.keysWithoutTtl()).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ tokens
  describe('access token and authentication layers', () => {
    it('401 without a token, 401 for garbage, 200 for a valid token', async () => {
      const user = await makeUser();
      const { accessToken } = await signIn(user);
      expect((await request(app).get('/probe/any')).status).toBe(401);
      expect((await request(app).get('/probe/any').set(bearer('garbage'))).status).toBe(401);
      const ok = await request(app).get('/probe/any').set(bearer(accessToken));
      expect(ok.status).toBe(200);
      expect(ok.body.userId).toBe(String(user._id));
    });

    it('a refresh token is not accepted as an access token', async () => {
      const user = await makeUser();
      const { refreshToken } = await signIn(user);
      expect((await request(app).get('/probe/any').set(bearer(refreshToken))).status).toBe(401);
    });

    it('requireRole: 403 for the wrong role, 200 for the right one', async () => {
      const patient = await signIn(await makeUser(USER_ROLE.PATIENT));
      const admin = await signIn(await makeUser(USER_ROLE.ADMIN));
      expect((await request(app).get('/probe/admin').set(bearer(patient.accessToken))).status).toBe(403);
      expect((await request(app).get('/probe/admin').set(bearer(admin.accessToken))).status).toBe(200);
    });

    it('a blocked user is cut off on the next request', async () => {
      const user = await makeUser();
      const { accessToken } = await signIn(user);
      await User.updateOne({ _id: user._id }, { status: 'blocked' });
      expect((await request(app).get('/probe/any').set(bearer(accessToken))).status).toBe(403);
    });

    it('bumping tokenVersion invalidates a live access token', async () => {
      const user = await makeUser();
      const { accessToken } = await signIn(user);
      expect((await request(app).get('/probe/any').set(bearer(accessToken))).status).toBe(200);
      await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
      expect((await request(app).get('/probe/any').set(bearer(accessToken))).status).toBe(401);
    });
  });

  describe('refresh rotation and reuse detection', () => {
    it('issues a new pair and marks the old token replaced', async () => {
      const user = await makeUser();
      const first = await signIn(user);
      const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });
      expect(res.status).toBe(200);
      expect(res.body.data.refreshToken).not.toBe(first.refreshToken);
      expect((await request(app).get('/probe/any').set(bearer(res.body.data.accessToken))).status).toBe(200);
      const docs = await RefreshToken.find({ userId: user._id }).lean();
      expect(docs.map((d) => d.status).sort()).toEqual(['active', 'replaced']);
      expect(docs.find((d) => d.status === 'replaced')?.replacedByTokenId).toBeTruthy();
    });

    it('stores only a hash of the refresh token', async () => {
      const user = await makeUser();
      const { refreshToken } = await signIn(user);
      const doc = await RefreshToken.findOne({ userId: user._id }).select('+tokenHash').lean();
      expect(doc?.tokenHash).not.toBe(refreshToken);
      expect(doc?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('reusing a spent token revokes every token for the user', async () => {
      const user = await makeUser();
      const first = await signIn(user);
      const second = (await request(app).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken })).body.data;

      const replay = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });
      expect(replay.status).toBe(401);

      // the legitimate newest pair is dead too
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: second.refreshToken })).status).toBe(401);
      expect((await request(app).get('/probe/any').set(bearer(second.accessToken))).status).toBe(401);
      expect(await RefreshToken.countDocuments({ userId: user._id, status: 'active' })).toBe(0);
    });

    it('only one of two parallel refreshes with the same token succeeds', async () => {
      const user = await makeUser();
      const { refreshToken } = await signIn(user);
      const [a, b] = await Promise.all([
        request(app).post('/api/v1/auth/refresh').send({ refreshToken }),
        request(app).post('/api/v1/auth/refresh').send({ refreshToken }),
      ]);
      expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    });

    it('rejects a garbage or unknown refresh token', async () => {
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'x'.repeat(40) })).status).toBe(401);
    });

    it('refuses to refresh once tokenVersion moved on', async () => {
      const user = await makeUser();
      const { refreshToken } = await signIn(user);
      await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken })).status).toBe(401);
    });
  });

  describe('logout and logout-all', () => {
    it('logout revokes that refresh token only', async () => {
      const user = await makeUser();
      const a = await signIn(user);
      const b = await signIn(user);
      expect((await request(app).post('/api/v1/auth/logout').send({ refreshToken: a.refreshToken })).status).toBe(200);
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: a.refreshToken })).status).toBe(401);
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: b.refreshToken })).status).toBe(200);
    });

    it('logout is idempotent', async () => {
      const user = await makeUser();
      const { refreshToken } = await signIn(user);
      await request(app).post('/api/v1/auth/logout').send({ refreshToken });
      expect((await request(app).post('/api/v1/auth/logout').send({ refreshToken })).status).toBe(200);
    });

    it('logout with an unrelated token changes nothing for other users', async () => {
      const victim = await signIn(await makeUser());
      const attacker = await makeUser();
      await request(app).post('/api/v1/auth/logout').send({ refreshToken: 'not-theirs'.repeat(5) });
      expect(attacker).toBeTruthy();
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: victim.refreshToken })).status).toBe(200);
    });

    it('logout-all kills live access tokens and every refresh token', async () => {
      const user = await makeUser();
      const a = await signIn(user);
      const b = await signIn(user);
      expect((await request(app).post('/api/v1/auth/logout-all')).status).toBe(401);
      expect((await request(app).post('/api/v1/auth/logout-all').set(bearer(a.accessToken))).status).toBe(200);
      expect((await request(app).get('/probe/any').set(bearer(b.accessToken))).status).toBe(401);
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: b.refreshToken })).status).toBe(401);
      expect((await User.findById(user._id))?.tokenVersion).toBe(1);
    });
  });

  // -------------------------------------------------------- email verification
  describe('verify-email', () => {
    const register = async (email: string) =>
      request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD });

    it('verifies with the emailed code and sets emailVerified', async () => {
      await register('v@example.com');
      const code = emailCodeFor('v@example.com')!;
      const res = await request(app).post('/api/v1/auth/verify-email').send({ email: 'v@example.com', otp: code });
      expect(res.status).toBe(200);
      expect((await User.findOne({ email: 'v@example.com' }))?.emailVerified).toBe(true);
    });

    it('rejects a wrong code, and a code cannot be reused', async () => {
      await register('w@example.com');
      const code = emailCodeFor('w@example.com')!;
      const wrong = code === '000000' ? '000001' : '000000';
      expect((await request(app).post('/api/v1/auth/verify-email').send({ email: 'w@example.com', otp: wrong })).status).toBe(400);
      expect((await request(app).post('/api/v1/auth/verify-email').send({ email: 'w@example.com', otp: code })).status).toBe(200);
      expect((await request(app).post('/api/v1/auth/verify-email').send({ email: 'w@example.com', otp: code })).status).toBe(400);
    });

    it('stores the code hashed', async () => {
      await register('h@example.com');
      const code = emailCodeFor('h@example.com')!;
      const doc = await Otp.findOne({ sentTo: 'h@example.com' }).lean();
      expect(doc?.otp).not.toBe(code);
      expect(doc?.otp).toMatch(/^\$2[aby]\$/);
    });

    it('gives the same error for an unknown email', async () => {
      const res = await request(app).post('/api/v1/auth/verify-email').send({ email: 'nobody@example.com', otp: '123456' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Invalid or expired code');
    });

    it('registering again for an unverified account sends a fresh code after the cooldown', async () => {
      await register('again@example.com');
      const first = emailCodeFor('again@example.com');
      await register('again@example.com'); // inside the cooldown: nothing new is sent
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      redis.advance(61);
      await register('again@example.com');
      expect(mockSendEmail).toHaveBeenCalledTimes(2);
      expect(emailCodeFor('again@example.com')).toBeDefined();
      expect(first).toBeDefined();
    });

    it('burns the code after the attempt ceiling, even for the right code afterwards', async () => {
      await register('burn@example.com');
      const code = emailCodeFor('burn@example.com')!;
      const wrong = code === '111111' ? '222222' : '111111';
      for (let i = 0; i < 5; i += 1) {
        await request(app).post('/api/v1/auth/verify-email').send({ email: 'burn@example.com', otp: wrong });
      }
      redis.advance(16 * 60); // clear the request-rate window; the OTP ceiling must still hold
      const res = await request(app).post('/api/v1/auth/verify-email').send({ email: 'burn@example.com', otp: code });
      expect(res.status).toBe(400);
      expect((await User.findOne({ email: 'burn@example.com' }))?.emailVerified).toBe(false);
    });
  });

  // ----------------------------------------------------------- password reset
  describe('forgot-password and reset-password', () => {
    it('resets the password, revokes every session, and the code is single use', async () => {
      const user = await makeUser();
      const session = await signIn(user);
      await request(app).post('/api/v1/auth/forgot-password').send({ email: user.email });
      const code = emailCodeFor(user.email)!;

      const reset = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ email: user.email, otp: code, newPassword: 'Brand-New-Passw0rd' });
      expect(reset.status).toBe(200);

      expect((await login(user.email)).status).toBe(401); // old password
      expect((await login(user.email, 'Brand-New-Passw0rd')).status).toBe(200);
      expect((await request(app).get('/probe/any').set(bearer(session.accessToken))).status).toBe(401);
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken })).status).toBe(401);

      const replay = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ email: user.email, otp: code, newPassword: 'Another-Passw0rd!' });
      expect(replay.status).toBe(400);
    });

    it('does not reveal whether the account exists', async () => {
      const user = await makeUser();
      const known = await request(app).post('/api/v1/auth/forgot-password').send({ email: user.email });
      const unknown = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'ghost@example.com' });
      expect(known.status).toBe(unknown.status);
      expect(known.body.message).toBe(unknown.body.message);
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
    });

    it('rejects a wrong code and a weak password', async () => {
      const user = await makeUser();
      await request(app).post('/api/v1/auth/forgot-password').send({ email: user.email });
      const code = emailCodeFor(user.email)!;
      const wrong = code === '123456' ? '654321' : '123456';
      expect((await request(app).post('/api/v1/auth/reset-password').send({ email: user.email, otp: wrong, newPassword: 'Brand-New-Passw0rd' })).status).toBe(400);
      expect((await request(app).post('/api/v1/auth/reset-password').send({ email: user.email, otp: code, newPassword: 'short' })).status).toBe(400);
      expect((await login(user.email)).status).toBe(200); // nothing changed
    });

    it('the old multi-step routes that returned a reset token are gone', async () => {
      const routes: Array<['post' | 'patch', string]> = [
        ['post', 'forgot-password-otpByEmail'],
        ['post', 'forgot-password-otpByNumber'],
        ['patch', 'forgot-password-otp-match'],
        ['patch', 'forgot-password-reset'],
        ['post', 'refresh-token'],
      ];
      for (const [method, path] of routes) {
        const res = await request(app)[method](`/api/v1/auth/${path}`).send({ email: 'a@example.com' });
        expect(res.status).toBe(404);
      }
    });
  });

  // ------------------------------------------------------------ phone OTP
  describe('POST /auth/phone/send-otp', () => {
    it('requires authentication and the doctor role', async () => {
      expect((await request(app).post('/api/v1/auth/phone/send-otp')).status).toBe(401);
      const patient = await signIn(await makeUser(USER_ROLE.PATIENT));
      expect((await request(app).post('/api/v1/auth/phone/send-otp').set(bearer(patient.accessToken))).status).toBe(403);
      const admin = await signIn(await makeUser(USER_ROLE.ADMIN));
      expect((await request(app).post('/api/v1/auth/phone/send-otp').set(bearer(admin.accessToken))).status).toBe(403);
    });

    it("sends a 6 digit code to the authenticated doctor's own phone and never returns it", async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken } = await signIn(doctor);
      // a phone in the body must be ignored
      const res = await request(app)
        .post('/api/v1/auth/phone/send-otp')
        .set(bearer(accessToken))
        .send({ phone: '+910000000000', userId: 'someone-else' });
      expect(res.status).toBe(200);
      expect(sms.sent).toHaveLength(1);
      expect(sms.sent[0].to).toBe(doctor.phone);
      const code = sms.lastCodeTo(doctor.phone)!;
      expect(code).toMatch(/^\d{6}$/);
      expect(JSON.stringify(res.body)).not.toContain(code);
      expect(res.body.data.sentTo).toMatch(/^\*+\d{4}$/);
    });

    it('stores only a hash, with an expiry and an attempt ceiling', async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken } = await signIn(doctor);
      await request(app).post('/api/v1/auth/phone/send-otp').set(bearer(accessToken));
      const code = sms.lastCodeTo(doctor.phone)!;
      const doc = await Otp.findOne({ sentTo: doctor.phone, purpose: 'phone-verification' }).lean();
      expect(doc?.otp).not.toBe(code);
      expect(doc?.otp).toMatch(/^\$2[aby]\$/);
      expect(doc?.maxAttempts).toBe(config.otp_max_attempts);
      expect(doc!.expiredAt.getTime()).toBeGreaterThan(Date.now());
      expect(doc!.expiredAt.getTime()).toBeLessThanOrEqual(Date.now() + config.otp_expire_time * 60_000 + 1000);
    });

    it('enforces the resend cooldown, then allows a resend that replaces the old code', async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken } = await signIn(doctor);
      const send = () => request(app).post('/api/v1/auth/phone/send-otp').set(bearer(accessToken));
      expect((await send()).status).toBe(200);
      const first = sms.lastCodeTo(doctor.phone)!;
      expect((await send()).status).toBe(429);
      expect(sms.sent).toHaveLength(1);
      redis.advance(61);
      expect((await send()).status).toBe(200);
      const second = sms.lastCodeTo(doctor.phone)!;
      // the first code no longer works (unless the two random codes happened to match)
      if (first !== second) {
        const res = await request(app).post('/api/v1/auth/phone/verify').set(bearer(accessToken)).send({ otp: first });
        expect(res.status).toBe(400);
      }
      expect(await Otp.countDocuments({ sentTo: doctor.phone, purpose: 'phone-verification' })).toBe(1);
    });

    it('limits requests per user per hour', async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken } = await signIn(doctor);
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push((await request(app).post('/api/v1/auth/phone/send-otp').set(bearer(accessToken))).status);
        redis.advance(61); // step past the cooldown, stay inside the hour
      }
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses[5]).toBe(429);
    });

    it('on SMS failure: 502, the code is withdrawn, and an immediate retry is allowed', async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken } = await signIn(doctor);
      sms.failWith = new Error('provider exploded');
      const failed = await request(app).post('/api/v1/auth/phone/send-otp').set(bearer(accessToken));
      expect(failed.status).toBe(502);
      expect(await Otp.countDocuments({ sentTo: doctor.phone })).toBe(0);
      sms.failWith = null;
      expect((await request(app).post('/api/v1/auth/phone/send-otp').set(bearer(accessToken))).status).toBe(200);
    });

    it('503 when no SMS provider is configured, and no code is left behind', async () => {
      setSmsProvider(null); // SMS_PROVIDER is blank in tests
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken } = await signIn(doctor);
      const res = await request(app).post('/api/v1/auth/phone/send-otp').set(bearer(accessToken));
      expect(res.status).toBe(503);
      expect(await Otp.countDocuments({ sentTo: doctor.phone })).toBe(0);
    });

    it('refuses an account with no valid phone, and an already verified one', async () => {
      const noPhone = await makeUser(USER_ROLE.DOCTOR, { phone: '' });
      const a = await signIn(noPhone);
      expect((await request(app).post('/api/v1/auth/phone/send-otp').set(bearer(a.accessToken))).status).toBe(400);
      const badPhone = await makeUser(USER_ROLE.DOCTOR, { phone: '12345' });
      const b = await signIn(badPhone);
      expect((await request(app).post('/api/v1/auth/phone/send-otp').set(bearer(b.accessToken))).status).toBe(400);
      const verified = await makeUser(USER_ROLE.DOCTOR, { phoneVerified: true });
      const c = await signIn(verified);
      expect((await request(app).post('/api/v1/auth/phone/send-otp').set(bearer(c.accessToken))).status).toBe(409);
      expect(sms.sent).toHaveLength(0);
    });
  });

  describe('POST /auth/phone/verify', () => {
    const issue = async (doctor: { email: string; phone: string }) => {
      const { accessToken } = await signIn(doctor);
      await request(app).post('/api/v1/auth/phone/send-otp').set(bearer(accessToken));
      return { accessToken, code: sms.lastCodeTo(doctor.phone)! };
    };
    const verify = (token: string, otp: unknown) =>
      request(app).post('/api/v1/auth/phone/verify').set(bearer(token)).send({ otp });
    const wrongOf = (code: string) => (code === '111111' ? '222222' : '111111');

    it('requires authentication, the doctor role and a 6 digit code', async () => {
      expect((await request(app).post('/api/v1/auth/phone/verify').send({ otp: '123456' })).status).toBe(401);
      const patient = await signIn(await makeUser(USER_ROLE.PATIENT));
      expect((await verify(patient.accessToken, '123456')).status).toBe(403);
      const doctor = await signIn(await makeUser(USER_ROLE.DOCTOR));
      expect((await verify(doctor.accessToken, '12345')).status).toBe(400);
      expect((await verify(doctor.accessToken, 'abcdef')).status).toBe(400);
    });

    it('sets User.phoneVerified = true on a correct code (database confirmed)', async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      expect((await User.findById(doctor._id))?.phoneVerified).toBe(false);
      const { accessToken, code } = await issue(doctor);
      const res = await verify(accessToken, code);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ phoneVerified: true });
      expect((await User.findById(doctor._id))?.phoneVerified).toBe(true);
      const otp = await Otp.findOne({ sentTo: doctor.phone, purpose: 'phone-verification' }).lean();
      expect(otp?.status).toBe('verified');
    });

    it('rejects an incorrect code and leaves phoneVerified false', async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken, code } = await issue(doctor);
      const res = await verify(accessToken, wrongOf(code));
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Incorrect OTP');
      expect((await User.findById(doctor._id))?.phoneVerified).toBe(false);
    });

    it('rejects an expired code', async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken, code } = await issue(doctor);
      await Otp.updateOne({ sentTo: doctor.phone }, { $set: { expiredAt: new Date(Date.now() - 1000) } });
      const res = await verify(accessToken, code);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/expired/i);
      expect((await User.findById(doctor._id))?.phoneVerified).toBe(false);
    });

    it('rejects a used code (single use)', async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken, code } = await issue(doctor);
      expect((await verify(accessToken, code)).status).toBe(200);
      // reset the flag as if re-verification were attempted, to prove the CODE is spent
      await User.updateOne({ _id: doctor._id }, { phoneVerified: false });
      const reuse = await verify(accessToken, code);
      expect(reuse.status).toBe(400);
      expect(reuse.body.message).toMatch(/already been used/i);
      expect((await User.findById(doctor._id))?.phoneVerified).toBe(false);
    });

    it('allows only one of two parallel verifications with the right code to succeed', async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken, code } = await issue(doctor);
      const results = await Promise.all([verify(accessToken, code), verify(accessToken, code)]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    });

    it('enforces the attempt ceiling atomically: parallel wrong guesses cannot exceed it', async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken, code } = await issue(doctor);
      const wrong = wrongOf(code);
      await Promise.all(Array.from({ length: 8 }, () => verify(accessToken, wrong)));
      const doc = await Otp.findOne({ sentTo: doctor.phone }).lean();
      expect(doc!.attempts).toBeLessThanOrEqual(doc!.maxAttempts);
      // the real code is now refused because the ceiling was reached
      redis.advance(16 * 60); // clear the per-user request limiter so only the OTP ceiling is tested
      const res = await verify(accessToken, code);
      expect(res.status).toBe(429);
      expect((await User.findById(doctor._id))?.phoneVerified).toBe(false);
    });

    it('requesting a new code resets the attempts', async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken, code } = await issue(doctor);
      for (let i = 0; i < 5; i += 1) await verify(accessToken, wrongOf(code));
      redis.advance(16 * 60);
      await request(app).post('/api/v1/auth/phone/send-otp').set(bearer(accessToken));
      const fresh = sms.lastCodeTo(doctor.phone)!;
      expect((await verify(accessToken, fresh)).status).toBe(200);
    });

    it('answers 400 when no code was requested', async () => {
      const doctor = await signIn(await makeUser(USER_ROLE.DOCTOR));
      const res = await verify(doctor.accessToken, '123456');
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no active otp/i);
    });

    it("cannot verify, or affect, another doctor's phone", async () => {
      const a = await makeUser(USER_ROLE.DOCTOR);
      const b = await makeUser(USER_ROLE.DOCTOR);
      const issuedA = await issue(a);
      const tokenB = (await signIn(b)).accessToken;

      // B presents A's valid code: B's own phone has no code, so it fails
      expect((await verify(tokenB, issuedA.code)).status).toBe(400);
      expect((await User.findById(b._id))?.phoneVerified).toBe(false);
      expect((await User.findById(a._id))?.phoneVerified).toBe(false);

      // A verifies; B is unaffected
      expect((await verify(issuedA.accessToken, issuedA.code)).status).toBe(200);
      expect((await User.findById(a._id))?.phoneVerified).toBe(true);
      expect((await User.findById(b._id))?.phoneVerified).toBe(false);

      // body identifiers are ignored
      const res = await request(app)
        .post('/api/v1/auth/phone/verify')
        .set(bearer(tokenB))
        .send({ otp: '123456', userId: String(a._id), phone: a.phone });
      expect(res.status).toBe(400);
    });

    it('fails if the phone changed after the code was issued', async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken, code } = await issue(doctor);
      await User.updateOne({ _id: doctor._id }, { phone: '+919000000001' });
      const res = await verify(accessToken, code);
      expect(res.status).toBe(400); // no code exists for the new number
      expect((await User.findById(doctor._id))?.phoneVerified).toBe(false);
    });
  });

  // ------------------------------------------------------------ doctor gates
  describe('doctor gates', () => {
    it('blocks going online while phoneVerified is false, allows it after', async () => {
      const doctor = await makeUser(USER_ROLE.DOCTOR);
      await expect(assertDoctorMayGoOnline({ userId: String(doctor._id) })).rejects.toMatchObject({ statusCode: 403 });
      await User.updateOne({ _id: doctor._id }, { phoneVerified: true });
      await expect(assertDoctorMayGoOnline({ userId: String(doctor._id) })).resolves.toBeUndefined();
    });

    it('blocks approval while phoneVerified is false, allows it after', async () => {
      const user = await makeUser(USER_ROLE.DOCTOR);
      const doctor = await Doctor.create({ userId: user._id });
      await expect(assertDoctorMayBeApproved(String(doctor._id))).rejects.toMatchObject({ statusCode: 409 });
      await User.updateOne({ _id: user._id }, { phoneVerified: true });
      await expect(assertDoctorMayBeApproved(String(doctor._id))).resolves.toBeUndefined();
    });

    it('end to end: the gate opens only after the real phone verification flow', async () => {
      const user = await makeUser(USER_ROLE.DOCTOR);
      const { accessToken } = await signIn(user);
      await expect(assertDoctorMayGoOnline({ userId: String(user._id) })).rejects.toBeTruthy();
      await request(app).post('/api/v1/auth/phone/send-otp').set(bearer(accessToken));
      await request(app).post('/api/v1/auth/phone/verify').set(bearer(accessToken)).send({ otp: sms.lastCodeTo(user.phone) });
      await expect(assertDoctorMayGoOnline({ userId: String(user._id) })).resolves.toBeUndefined();
    });
  });

  // ------------------------------------------------------ sms provider rules
  describe('SMS provider selection', () => {
    it('refuses the console provider in production and when unconfigured', async () => {
      setSmsProvider(null);
      const original = { env: config.NODE_ENV, provider: config.sms.provider };
      try {
        config.sms.provider = 'console';
        config.NODE_ENV = 'production';
        await expect(sendSms('+919876543210', 'x 123456')).rejects.toBeInstanceOf(SmsNotConfiguredError);
        config.NODE_ENV = 'test';
        await expect(sendSms('+919876543210', 'x 123456')).resolves.toBeUndefined();
        config.sms.provider = 'msg91';
        await expect(sendSms('+919876543210', 'x')).rejects.toBeInstanceOf(SmsNotConfiguredError);
      } finally {
        config.NODE_ENV = original.env;
        config.sms.provider = original.provider;
      }
    });
  });

  // ------------------------------------------------------------ profile guard
  describe('verification flags cannot be self-assigned', () => {
    it('updateUser ignores phoneVerified / emailVerified / tokenVersion and resets verification on a phone change', async () => {
      const { userService } = await import('../user/user.service');
      const doctor = await makeUser(USER_ROLE.DOCTOR, { phoneVerified: true });
      await userService.updateUser(String(doctor._id), {
        phoneVerified: true,
        emailVerified: false,
        tokenVersion: 99,
        name: 'Renamed',
      } as never);
      const unchanged = await User.findById(doctor._id);
      expect(unchanged?.name).toBe('Renamed');
      expect(unchanged?.tokenVersion).toBe(0);
      expect(unchanged?.emailVerified).toBe(true);
      expect(unchanged?.phoneVerified).toBe(true); // same phone, still verified

      await userService.updateUser(String(doctor._id), { phone: '+919111111111' } as never);
      expect((await User.findById(doctor._id))?.phoneVerified).toBe(false);

      // a patient cannot mark a phone verified by sending the flag
      const sneaky = await makeUser(USER_ROLE.DOCTOR);
      await userService.updateUser(String(sneaky._id), { phoneVerified: true } as never);
      expect((await User.findById(sneaky._id))?.phoneVerified).toBe(false);
    });
  });
});

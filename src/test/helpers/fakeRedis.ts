// In-memory stand-in for the ioredis commands rateLimit.ts uses (SET [EX] [NX], INCR, TTL,
// GET, DEL), with a controllable clock. It proves OUR logic; it does not prove Redis
// itself behaves the same, so the real Redis path is listed as manually verified in
// PROGRESS.md.
import { RateLimitStore } from '../../shared/rateLimit';

export class FakeRedis implements RateLimitStore {
  private data = new Map<string, { value: string; expiresAt: number | null }>();
  private offsetMs = 0;
  /** When set, every command rejects, like a Redis outage. */
  down = false;

  private now() {
    return Date.now() + this.offsetMs;
  }
  advance(seconds: number) {
    this.offsetMs += seconds * 1000;
  }
  private live(key: string) {
    const e = this.data.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }
  private guard() {
    if (this.down) throw new Error('redis down');
  }

  async set(key: string, value: string | number, ...args: Array<string | number>) {
    this.guard();
    const upper = args.map((a) => String(a).toUpperCase());
    const nx = upper.includes('NX');
    const exIdx = upper.indexOf('EX');
    if (nx && this.live(key)) return null;
    const expiresAt = exIdx >= 0 ? this.now() + Number(args[exIdx + 1]) * 1000 : null;
    this.data.set(key, { value: String(value), expiresAt });
    return 'OK';
  }
  async incr(key: string) {
    this.guard();
    const e = this.live(key);
    const next = (e ? Number(e.value) : 0) + 1;
    this.data.set(key, { value: String(next), expiresAt: e ? e.expiresAt : null });
    return next;
  }
  async ttl(key: string) {
    this.guard();
    const e = this.live(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return Math.ceil((e.expiresAt - this.now()) / 1000);
  }
  async get(key: string) {
    this.guard();
    return this.live(key)?.value ?? null;
  }
  async del(...keys: string[]) {
    this.guard();
    let n = 0;
    for (const k of keys) if (this.data.delete(k)) n += 1;
    return n;
  }
  /** Keys with no expiry. A counter without a TTL would be a permanent lockout. */
  keysWithoutTtl() {
    return [...this.data.entries()].filter(([, v]) => v.expiresAt === null).map(([k]) => k);
  }
}

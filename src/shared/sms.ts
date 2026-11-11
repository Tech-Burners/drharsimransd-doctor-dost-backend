// SMS abstraction. Business code only ever calls sendSms(to, body); swapping the provider
// never touches auth logic.
//
// Providers:
//   console - development and tests. Writes the message to the log. REFUSED in production,
//             because it would put one-time codes in production logs.
//   (none)  - any other value, or none set, is "not configured" and sending fails with
//             SmsNotConfiguredError. A real provider (MSG91 etc.) is NOT integrated: it
//             needs credentials and client approval. Implement SmsProvider, add it to
//             createProvider(), set SMS_PROVIDER. Nothing else changes.
//
// SMS_API_KEY, SMS_SENDER_ID and SMS_TEMPLATE_ID are already read into config.sms. India
// requires a DLT-registered template for transactional SMS, so the message text for a real
// provider must match the registered template.
import config from '../app/config';
import { logger } from './logger';

export interface SmsProvider {
  readonly name: string;
  send(to: string, body: string): Promise<void>;
}

export class SmsNotConfiguredError extends Error {
  constructor(message = 'SMS provider is not configured') {
    super(message);
    this.name = 'SmsNotConfiguredError';
  }
}

export class SmsDeliveryError extends Error {
  constructor(message = 'SMS delivery failed', public readonly cause?: unknown) {
    super(message);
    this.name = 'SmsDeliveryError';
  }
}

const maskPhone = (to: string): string => (to.length <= 4 ? '****' : `${'*'.repeat(to.length - 4)}${to.slice(-4)}`);

/** Logs the message. Development and tests only. */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  async send(to: string, body: string): Promise<void> {
    // Contains the one-time code, hence the production refusal in createProvider().
    logger.info({ to: maskPhone(to), body }, '[sms:console] message (not delivered)');
  }
}

/** Collects messages in memory. For automated tests. */
export class InMemorySmsProvider implements SmsProvider {
  readonly name = 'memory';
  readonly sent: Array<{ to: string; body: string }> = [];
  failWith: Error | null = null;
  async send(to: string, body: string): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push({ to, body });
  }
  /** The most recent six digit code sent to a number. */
  lastCodeTo(to: string): string | undefined {
    const msg = [...this.sent].reverse().find((m) => m.to === to);
    return msg?.body.match(/\b(\d{6})\b/)?.[1];
  }
}

let providerOverride: SmsProvider | null = null;

/** Tests inject a provider. Pass null to restore config-based selection. */
export const setSmsProvider = (provider: SmsProvider | null): void => {
  providerOverride = provider;
};

const createProvider = (): SmsProvider => {
  const name = (config.sms.provider || '').trim().toLowerCase();
  if (name === 'console') {
    if (config.NODE_ENV === 'production') {
      throw new SmsNotConfiguredError('The console SMS provider cannot be used in production');
    }
    return new ConsoleSmsProvider();
  }
  throw new SmsNotConfiguredError(
    name ? `SMS provider "${name}" is not implemented yet` : 'SMS_PROVIDER is not set',
  );
};

const SEND_TIMEOUT_MS = 10000;

/** Send a message. Throws SmsNotConfiguredError or SmsDeliveryError. Never logs the body. */
export const sendSms = async (to: string, body: string): Promise<void> => {
  const provider = providerOverride ?? createProvider();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      provider.send(to, body),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SMS provider timed out')), SEND_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    if (err instanceof SmsNotConfiguredError) throw err;
    throw new SmsDeliveryError('SMS delivery failed', err);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

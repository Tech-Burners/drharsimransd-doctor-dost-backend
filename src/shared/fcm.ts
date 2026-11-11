// Push notifications via firebase-admin (FCM). Behind an interface so tests never touch the
// network. Best effort by design: a failed push is logged and never fails the business
// operation, because the time-critical path (an incoming call) is also covered by the socket
// event and the 30 second ringing timeout.
//
// NOT VERIFIED against real FCM (no service account). Needs a real device test.
import config from '../app/config';
import { logger } from './logger';

export interface PushSender {
  /** High priority DATA message (wakes a killed Android app). Returns the number accepted. */
  sendData(tokens: string[], data: Record<string, string>): Promise<number>;
}

class FirebasePushSender implements PushSender {
  private messaging: import('firebase-admin/messaging').Messaging | null = null;

  private async getMessaging() {
    if (this.messaging) return this.messaging;
    const b64 = config.firebase.serviceAccountBase64;
    if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is not set');
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');
    const credentials = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const app = getApps()[0] ?? initializeApp({ credential: cert(credentials), projectId: config.firebase.projectId });
    this.messaging = getMessaging(app);
    return this.messaging;
  }

  async sendData(tokens: string[], data: Record<string, string>): Promise<number> {
    if (tokens.length === 0) return 0;
    const messaging = await this.getMessaging();
    const res = await messaging.sendEachForMulticast({
      tokens,
      data,
      android: { priority: 'high' },
      apns: { headers: { 'apns-priority': '10', 'apns-push-type': 'background' }, payload: { aps: { 'content-available': 1 } } },
    });
    return res.successCount;
  }
}

let sender: PushSender | null = null;
export const getPushSender = (): PushSender => (sender ??= new FirebasePushSender());
/** Tests inject a sender. Pass null to restore the real one. */
export const setPushSender = (s: PushSender | null): void => {
  sender = s;
};

export const trySendPush = async (tokens: string[], data: Record<string, string>): Promise<number> => {
  try {
    if (!sender && !config.firebase.serviceAccountBase64) {
      logger.warn('push skipped: FIREBASE_SERVICE_ACCOUNT_BASE64 is not set');
      return 0;
    }
    return await getPushSender().sendData(tokens, data);
  } catch (err) {
    logger.error({ err }, 'push notification failed');
    return 0;
  }
};

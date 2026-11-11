import { NextFunction, Request, Response } from 'express';
import httpStatus from 'http-status';
import config from '../config';
import { logger } from '../../shared/logger';
import { toEnvelope } from '../utils/sendResponse';

/**
 * Transition switch for the retired signup flow (client decision 26):
 *   LEGACY_SIGNUP_MODE=enabled  (default) the old endpoints still work
 *   LEGACY_SIGNUP_MODE=gone     they answer 410 Gone, pointing at /auth/register
 *
 * Default is `enabled` because compatibility with the Flutter apps and the dashboard is NOT
 * yet confirmed. Once the teams confirm, set `gone` for ONE release, then delete the
 * endpoints. In both modes every call is logged as `legacy_signup_endpoint_used`
 * (route, ip, user agent, request id), which is how usage is monitored before the removal.
 */
export const LEGACY_SIGNUP_SUNSET = 'Wed, 31 Dec 2026 00:00:00 GMT'; // informational; adjust at release

export const legacySignup = (req: Request, res: Response, next: NextFunction) => {
  const mode = config.legacy_signup_mode;
  logger.warn(
    { route: `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`, ip: req.ip, userAgent: req.get('User-Agent') || '', mode },
    'legacy_signup_endpoint_used',
  );
  if (mode !== 'gone') return next();

  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', LEGACY_SIGNUP_SUNSET);
  res.setHeader('Link', '</api/v1/auth/register>; rel="successor-version"');
  res.status(httpStatus.GONE).json(
    toEnvelope({
      success: false,
      message: 'This signup endpoint has been retired. Use POST /api/v1/auth/register and POST /api/v1/auth/verify-email.',
      data: null,
      meta: { requestId: req.id, successor: '/api/v1/auth/register' },
    }),
  );
};

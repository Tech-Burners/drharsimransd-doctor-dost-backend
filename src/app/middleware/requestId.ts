import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { runWithContext } from '../../shared/requestContext';

const SAFE_ID = /^[A-Za-z0-9_\-:.]{8,128}$/;

/**
 * Gives every request an id (the caller's X-Request-Id when it is well formed, else a
 * fresh UUID), echoes it on the response, and runs the rest of the request inside the
 * correlation context so every log line carries it.
 *
 * Mounted twice in app.ts: once first, and once after the body parsers. Body parsing
 * resumes on stream events, which can drop AsyncLocalStorage context. Running this again
 * re-establishes it with the same id.
 */
export const requestId = (req: Request, res: Response, next: NextFunction): void => {
  // req.id is typed by pino-http (IncomingMessage.id); we only ever store a string.
  if (typeof req.id !== 'string' || !req.id) {
    const incoming = req.get('x-request-id');
    req.id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  }
  const id = req.id as string;
  res.setHeader('X-Request-Id', id);
  runWithContext({ requestId: id }, next);
};

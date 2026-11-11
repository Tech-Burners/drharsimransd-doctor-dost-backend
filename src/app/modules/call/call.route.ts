import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth';
import validateRequest from '../../middleware/validateRequest';
import { requireIdempotency } from '../../middleware/requireIdempotency';
import { USER_ROLE } from '../user/user.constants';
import { registerRoute } from '../../../shared/openapi';
import { callBodies, callValidation } from './call.validation';
import { callControllers } from './call.controller';

export const callRoutes = Router();

const { PATIENT, DOCTOR, ADMIN } = USER_ROLE;

// authenticate -> requireRole -> validation -> idempotency -> controller. Ownership is inside
// the service, which takes an actor and a target.
callRoutes
  .post('/', authenticate, requireRole(PATIENT), validateRequest(callValidation.startSchema), requireIdempotency(), callControllers.start)
  .get('/', authenticate, requireRole(PATIENT, DOCTOR, ADMIN), validateRequest(callValidation.listSchema), callControllers.list)
  .get('/:id', authenticate, requireRole(PATIENT, DOCTOR, ADMIN), validateRequest(callValidation.idSchema), callControllers.getOne)
  .post('/:id/accept', authenticate, requireRole(DOCTOR), validateRequest(callValidation.idSchema), callControllers.accept)
  .post('/:id/reject', authenticate, requireRole(DOCTOR), validateRequest(callValidation.idSchema), callControllers.reject)
  .post('/:id/end', authenticate, requireRole(PATIENT, DOCTOR), validateRequest(callValidation.idSchema), callControllers.end);

const bearer = [{ bearerAuth: [] }];
const idempotency = z.object({ 'Idempotency-Key': z.string().min(1).max(255) });

registerRoute({
  method: 'post',
  path: '/calls',
  tags: ['calls'],
  summary:
    'Patient only. Start a call to a doctor. Requires Idempotency-Key. The patient is the token subject; the rate (fixed once, here), the balance and the affordable duration are computed on the server. Urgent calls are priced from PlatformSetting only',
  security: bearer,
  request: { headers: idempotency, body: { required: true, content: { 'application/json': { schema: callBodies.startBody } } } },
  responses: {
    201: { description: '{ callId, channelName, agoraAppId, agoraUid, agoraToken, ratePaisePerMin, maxAffordableSeconds, ... }' },
    402: { description: 'Wallet balance too low (no call is created)' },
    404: { description: 'Doctor not found or not approved' },
    409: { description: 'Doctor offline or busy, or you already have a call in progress' },
    422: { description: 'Doctor has no rate, or urgent calls are not available (rate missing / zero / invalid)' },
    429: { description: 'Call cooldown: wait before placing another call' },
  },
});
registerRoute({ method: 'get', path: '/calls', tags: ['calls'], summary: 'Own call history (patient or doctor; admin sees all). Each row carries isFreeShortCall', security: bearer, request: { query: callBodies.listQuery }, responses: { 200: { description: 'Calls, newest first, with pagination in meta' } } });
registerRoute({ method: 'get', path: '/calls/{id}', tags: ['calls'], summary: 'One call. Only a party to the call (or an admin) can read it', security: bearer, request: { params: callBodies.idParams }, responses: { 200: { description: 'The call' }, 404: { description: 'Not found, or not yours' } } });
registerRoute({ method: 'post', path: '/calls/{id}/accept', tags: ['calls'], summary: 'Doctor only, own call only. ringing -> active; returns the doctor\'s Agora token', security: bearer, request: { params: callBodies.idParams }, responses: { 200: { description: '{ channelName, agoraUid, agoraToken, ... }' }, 404: { description: 'Not found / not yours' }, 409: { description: 'No longer ringing' } } });
registerRoute({ method: 'post', path: '/calls/{id}/reject', tags: ['calls'], summary: 'Doctor only, own call only. ringing -> rejected', security: bearer, request: { params: callBodies.idParams }, responses: { 200: { description: 'Rejected' }, 409: { description: 'No longer ringing' } } });
registerRoute({ method: 'post', path: '/calls/{id}/end', tags: ['calls'], summary: 'A hint that this party ended the call. Changes no state and carries no duration: the call is closed and billed from the Agora events', security: bearer, request: { params: callBodies.idParams }, responses: { 202: { description: 'Noted' }, 404: { description: 'Not found / not yours' } } });

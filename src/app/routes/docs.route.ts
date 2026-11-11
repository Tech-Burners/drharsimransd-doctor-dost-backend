import { RequestHandler, Router } from 'express';
import config from '../config';
import auth from '../middleware/auth';
import { USER_ROLE } from '../modules/user/user.constants';
import { buildOpenApiDocument } from '../../shared/openapi';

/**
 * Serves the OpenAPI spec as JSON. Open outside production; in production it sits behind
 * admin authentication.
 */
export const createDocsRoutes = (): Router => {
  const router = Router();
  const gate: RequestHandler[] =
    config.NODE_ENV === 'production' ? auth(USER_ROLE.ADMIN) : [];
  router.get('/', ...gate, (_req, res) => {
    res.json(buildOpenApiDocument());
  });
  return router;
};

export const docsRoutes = createDocsRoutes();

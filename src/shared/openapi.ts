// Central OpenAPI registry.
//
// CONVENTION (fixed now, not at Phase 10): every route registers its zod schemas here as
// it is written, via registerRoute(). Two Flutter apps and a dashboard are built against
// this API, so the spec is not optional documentation.
//
//   registerRoute({
//     method: 'post',
//     path: '/wallet/orders',
//     summary: 'Create a top-up order',
//     tags: ['wallet'],
//     request: { body: { content: { 'application/json': { schema: createOrderBody } } } },
//     responses: { 201: { description: 'Order created' } },
//   });
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3, RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

export const registerRoute = (route: RouteConfig): void => {
  registry.registerPath(route);
};

export const buildOpenApiDocument = () =>
  new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'DoctorDost API',
      version: '1.0.0',
      description: 'Telemedicine voice-calling platform. All routes are under /api/v1.',
    },
    servers: [{ url: '/api/v1' }],
  });

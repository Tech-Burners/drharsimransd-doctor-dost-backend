/* eslint-disable no-undef */
/* eslint-disable no-unused-vars */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Application, Request, Response } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import router from './app/routes';
import notFound from './app/middleware/notfound';
import globalErrorHandler from './app/middleware/globalErrorhandler';
import { requestId } from './app/middleware/requestId';
import serverHomePage from './app/helpers/serverHomePage';
import { limiter } from './app/utils/limiter';
import { docsRoutes } from './app/routes/docs.route';
import { rawBodyParser, webhookRouter } from './app/routes/webhook.route';
import config from './app/config';
import { logger } from './shared/logger';

const app: Application = express();

// Behind a load balancer in deployment; makes req.ip the client address.
app.set('trust proxy', 1);

/* ---------- Request id and security headers ---------- */
// Request id first, so every later log line carries it.
app.use(requestId);

// CSP is off: this is a JSON API, and the server home page ships an inline script.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

const isProduction = config.NODE_ENV === 'production';

app.use(
  cors({
    origin(origin, callback) {
      // Mobile apps and tools such as Postman send no Origin header.
      if (!origin) return callback(null, true);
      if (!isProduction) return callback(null, true);
      return config.cors_origins.includes(origin)
        ? callback(null, true)
        : callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  }),
);

app.use(
  pinoHttp({
    logger,
    genReqId: (req) => (req as Request).id as string,
    customProps: (req) => ({ requestId: (req as Request).id }),
    customLogLevel: (_req, res, err) =>
      err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false },
  }),
);

/* ---------- Webhooks: BEFORE the body parsers ---------- */
// Signature verification runs on the exact bytes received, so these routes get the raw
// Buffer and must be mounted ahead of express.json().
app.use('/api/v1/webhooks', rawBodyParser, webhookRouter);

/* ---------- Core middlewares ---------- */
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Body parsing resumes on stream events and can drop the async context; restore it.
app.use(requestId);
app.use(cookieParser());

app.use(limiter.rootlimiter);

/* ---------- Routes ---------- */
app.use('/api/v1', router);
app.use('/docs', docsRoutes);

/* Dashboard (HTML) */
app.get('/', async (_req: Request, res: Response) => {
  const htmlContent = await serverHomePage();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(htmlContent);
});

/* ---------- Error handling ---------- */
// 404 for unmatched routes, then the one global error handler.
app.use(notFound);
app.use(globalErrorHandler);

export default app;

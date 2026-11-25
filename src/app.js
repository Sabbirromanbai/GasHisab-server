import cors from 'cors';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const createApp = ({ auth, config }) => {
  if (!auth || !config) throw new Error('Better Auth and validated configuration are required.');
  const app = express();
  app.disable('x-powered-by');
  if (config.trustedProxyHops > 0) app.set('trust proxy', config.trustedProxyHops);
  // Set client IP for rate limiting; prefer trusted proxy chain, but respect explicit header for tests.
  app.use((req, _res, next) => {
    if (!req.headers['x-gashisab-client-ip']) {
      req.headers['x-gashisab-client-ip'] = req.ip || req.socket.remoteAddress || '';
    }
    next();
  });
  app.use(cors({
    origin(origin, callback) {
      callback(null, origin && config.allowedOrigins.includes(origin) ? origin : false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Business-Id'],
    maxAge: 600,
  }));
  // Production session cookies use SameSite=None so a separately hosted frontend can authenticate.
  // That removes the browser's same-site CSRF barrier, so unsafe methods from unknown origins are rejected.
  app.use((req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    if (!origin || config.allowedOrigins.includes(origin)) return next();
    return res.status(403).json({ error: 'Origin not allowed.' });
  });
  // Better Auth must receive the raw request before Express body parsers consume it.
  app.all('/api/auth/*splat', toNodeHandler(auth));
  app.get('/api/health', (_req, res) => {
    res.json({ success: true, message: 'GasHisab API is running', timestamp: new Date().toISOString() });
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: true, limit: '32kb' }));
  // Mount business routes above this point; the JSON 404 and error handler must stay last.
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    // Body-parser and validation errors carry a 4xx status; do not report them as server failures.
    const status = error?.status ?? error?.statusCode;
    const clientError = Number.isInteger(status) && status >= 400 && status < 500;
    if (!clientError) console.error(`Unhandled request error (${error?.name ?? 'Error'}).`);
    res.status(clientError ? status : 500).json({ error: clientError ? 'Invalid request.' : 'Internal server error.' });
  });
  return app;
};

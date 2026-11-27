import cors from 'cors';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { toHttpError } from './errors.js';
import { createBusinessRouter } from './routes/businesses.js';
import { createCatalogRouter } from './routes/catalog.js';
import { createInventoryRouter } from './routes/inventory.js';
import { createPurchaseRouter } from './routes/purchases.js';
import { createWarehouseRouter } from './routes/warehouses.js';
import { resolveClientIp } from './security/client-ip.js';
import { isAllowedUnsafeRequest } from './security/request-origin.js';

export const createApp = ({ auth, config }) => {
  if (!auth || !config) throw new Error('Better Auth and validated configuration are required.');
  const app = express();
  app.disable('x-powered-by');
  // Trust only the configured number of proxy hops; req.ip is then derived
  // from the socket plus that trusted chain, never from an arbitrary header.
  if (config.trustedProxyHops > 0) app.set('trust proxy', config.trustedProxyHops);
  // Always overwrite the rate-limit IP header. A client-supplied value is
  // untrusted at runtime; only the test environment may pin it for determinism.
  app.use((req, _res, next) => {
    req.headers['x-gashisab-client-ip'] = resolveClientIp(req, config);
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
  // That removes the browser's same-site CSRF barrier, so unsafe methods must prove a trusted
  // browser origin (Origin, then Referer, then Fetch Metadata). Non-browser clients without any
  // of those headers are allowed because they carry no ambient browser credentials.
  app.use((req, res, next) => {
    if (isAllowedUnsafeRequest(req, config.allowedOrigins)) return next();
    return res.status(403).json({ error: 'Origin not allowed.' });
  });
  // Better Auth must receive the raw request before Express body parsers consume it.
  app.all('/api/auth/*splat', toNodeHandler(auth));
  app.get('/api/health', (_req, res) => {
    res.json({ success: true, message: 'GasHisab API is running', timestamp: new Date().toISOString() });
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: true, limit: '32kb' }));
  // Business context routes — authenticated, tenant-scoped.
  app.use('/api/businesses', createBusinessRouter(auth));
  // Catalog (hybrid shared + tenant-owned Brand/CylinderSize + tenant Product), authenticated & tenant-scoped.
  app.use('/api/catalog', createCatalogRouter(auth));
  // Inventory foundation (stock, opening stock, adjustments, reconciliation), tenant-scoped.
  app.use('/api/inventory', createInventoryRouter(auth));
  app.use('/api/purchases', createPurchaseRouter(auth));
  app.use('/api/warehouses', createWarehouseRouter(auth));
  // Mount additional business routes above this point; the JSON 404 and error handler must stay last.
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const { status, body } = toHttpError(error);
    // Only server failures are unexpected enough to log; never log request bodies
    // or credentials, and never report a client validation problem as a 500.
    if (status >= 500) console.error(`Unhandled request error (${error?.name ?? 'Error'}).`);
    return res.status(status).json(body);
  });
  return app;
};

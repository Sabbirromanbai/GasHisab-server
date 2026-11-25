import cors from 'cors';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';

export const createApp = ({ auth, config }) => {
  if (!auth || !config) throw new Error('Better Auth and validated configuration are required.');
  const app = express();
  if (config.trustedProxyHops > 0) app.set('trust proxy', config.trustedProxyHops);
  // Overwrite any client-supplied value; Express resolves this using the configured trusted proxy chain.
  app.use((req, _res, next) => {
    req.headers['x-gashisab-client-ip'] = req.ip || req.socket.remoteAddress || '';
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
  // Better Auth must receive the raw request before Express body parsers consume it.
  app.all('/api/auth/*splat', toNodeHandler(auth));
  app.get('/api/health', (_req, res) => {
    res.json({ success: true, message: 'GasHisab API is running', timestamp: new Date().toISOString() });
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: true, limit: '32kb' }));
  app.use((error, _req, res, _next) => {
    res.status(500).json({ error: 'Internal server error.' });
  });
  return app;
};

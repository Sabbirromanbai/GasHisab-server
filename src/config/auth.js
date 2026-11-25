import { betterAuth } from 'better-auth';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import mongoose from 'mongoose';

const parseOrigin = (value, name) => {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid origin URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) {
    throw new Error(`${name} must be an exact HTTP(S) origin without a path or credentials.`);
  }
  return { origin: url.origin, protocol: url.protocol };
};

export const createAuthConfig = (env = process.env) => {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 bytes.');
  const baseURLParsed = parseOrigin(env.BETTER_AUTH_URL?.trim() ?? '', 'BETTER_AUTH_URL');
  const baseURL = baseURLParsed.origin;
  const allowedOriginsParsed = (env.AUTH_ALLOWED_ORIGINS ?? baseURL).split(',').map((item) => parseOrigin(item.trim(), 'AUTH_ALLOWED_ORIGINS'));
  const allowedOrigins = allowedOriginsParsed.map((o) => o.origin);
  if (!allowedOrigins.includes(baseURL)) throw new Error('AUTH_ALLOWED_ORIGINS must include BETTER_AUTH_URL.');
  const environment = env.NODE_ENV ?? 'development';
  // Fail closed on typos: an unrecognised NODE_ENV would silently disable production cookie hardening.
  if (!['development', 'test', 'production'].includes(environment)) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }
  const production = environment === 'production';
  if (production && baseURLParsed.protocol !== 'https:') {
    throw new Error('BETTER_AUTH_URL must use HTTPS in production.');
  }
  // Enforce HTTPS for all trusted origins in production; localhost HTTP allowed in development/test.
  if (production) {
    for (const origin of allowedOriginsParsed) {
      if (origin.protocol !== 'https:') {
        throw new Error('AUTH_ALLOWED_ORIGINS must use HTTPS in production.');
      }
    }
  }
  const trustedProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 5) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5.');
  }
  return {
    secret,
    baseURL,
    allowedOrigins,
    production,
    environment,
    trustedProxyHops,
    // Production supports a separately hosted Next.js origin; Secure is also required below.
    cookieSameSite: production ? 'none' : 'lax',
  };
};

export const createBetterAuth = ({ db, mongoClient, config }) => {
  const expectedDatabase = config?.environment === 'test' ? 'gashisab_test' : 'gashisab';
  if (!db || db.databaseName !== expectedDatabase || !mongoClient || !config) {
    throw new Error('Better Auth must use gashisab at runtime and gashisab_test only in tests.');
  }
  return betterAuth({
    appName: 'GasHisab',
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: config.allowedOrigins,
    database: mongodbAdapter(db, { client: mongoClient }),
    user: {
      modelName: 'users',
      additionalFields: {
        status: { type: 'string', required: true, defaultValue: 'active', input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    databaseHooks: {
      session: {
        create: {
          // Prevent suspended accounts from receiving new sessions, in addition to API checks.
          before: async (session) => {
            if (!mongoose.isValidObjectId(session.userId)) return false;
            const activeUser = await db.collection('users').findOne({
              _id: new mongoose.Types.ObjectId(session.userId),
              status: 'active',
            }, { projection: { _id: 1 } });
            return activeUser ? undefined : false;
          },
        },
        // Invalidate existing sessions when user is suspended.
        // This runs on every session refresh/update (e.g., getSession, signIn).
        update: {
          before: async (session) => {
            if (!mongoose.isValidObjectId(session.userId)) return false;
            const activeUser = await db.collection('users').findOne({
              _id: new mongoose.Types.ObjectId(session.userId),
              status: 'active',
            }, { projection: { _id: 1 } });
            return activeUser ? undefined : false;
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      customRules: { '/sign-in/email': { window: 60, max: 10 } },
    },
    advanced: {
      useSecureCookies: config.production,
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: ['x-gashisab-client-ip'] },
      defaultCookieAttributes: {
        httpOnly: true,
        secure: config.production,
        sameSite: config.cookieSameSite,
        path: '/',
      },
    },
  });
};

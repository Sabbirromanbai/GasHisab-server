// One-time Super Admin bootstrap script.
//
// Security properties:
//   - Credentials are read ONLY from environment variables (never hardcoded).
//   - No HTTP endpoint exposes this functionality.
//   - Idempotent: refuses to run if a super admin already exists.
//   - Atomic: a partial unique index on User.platformRole prevents concurrent
//     bootstrap even if two processes race.
//   - Secrets are never printed; only the created user's ID is logged.
//   - Production mode requires NODE_ENV=production (full safeguards).
//   - Development mode (BOOTSTRAP_MODE=development) allows local-only access to
//     the gashisab database on localhost/127.0.0.1. Production and test databases
//     are refused.
//
// Usage (production):
//   BOOTSTRAP_MODE=production \
//   NODE_ENV=production \
//   MONGODB_URI="mongodb://..." \
//   BETTER_AUTH_SECRET="..." BETTER_AUTH_URL="https://..." \
//   AUTH_ALLOWED_ORIGINS="https://..." \
//   SUPER_ADMIN_EMAIL="..." SUPER_ADMIN_PASSWORD="..." \
//   npm run bootstrap:super-admin
//
// Usage (local development):
//   BOOTSTRAP_MODE=development \
//   NODE_ENV=development \
//   MONGODB_URI="mongodb://127.0.0.1:27017/gashisab" \
//   BETTER_AUTH_SECRET="dev-secret-at-least-32-bytes-long!!" \
//   BETTER_AUTH_URL="http://localhost:3000" \
//   AUTH_ALLOWED_ORIGINS="http://localhost:3000" \
//   SUPER_ADMIN_EMAIL="admin@localhost.test" \
//   SUPER_ADMIN_PASSWORD="dev-password-min-12" \
//   npm run bootstrap:super-admin

import 'dotenv/config';
import mongoose from 'mongoose';
import { createAuthConfig, createBetterAuth } from '../src/config/auth.js';
import { connectDB } from '../src/config/db.js';

/**
 * Validate bootstrap environment variables before any database connection.
 * Returns { mode, errors }. If errors is non-empty, bootstrap must not proceed.
 * Exported for testing.
 */
export const validateBootstrapEnv = (env = process.env) => {
  const errors = [];
  const mode = env.BOOTSTRAP_MODE?.trim() || 'production';

  if (!['development', 'production'].includes(mode)) {
    errors.push('BOOTSTRAP_MODE must be "development" or "production".');
    return { mode, errors };
  }

  const email = env.SUPER_ADMIN_EMAIL?.trim();
  const password = env.SUPER_ADMIN_PASSWORD;

  if (!email) errors.push('SUPER_ADMIN_EMAIL is required.');
  if (!password) errors.push('SUPER_ADMIN_PASSWORD is required.');
  if (password && password.length < 12) {
    errors.push('SUPER_ADMIN_PASSWORD must be at least 12 characters.');
  }

  const mongoUri = env.MONGODB_URI?.trim();
  if (!mongoUri) {
    errors.push('MONGODB_URI is required.');
  }

  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret) errors.push('BETTER_AUTH_SECRET is required.');

  const baseUrl = env.BETTER_AUTH_URL?.trim();
  if (!baseUrl) errors.push('BETTER_AUTH_URL is required.');

  const nodeEnv = env.NODE_ENV?.trim();

  if (mode === 'production') {
    if (nodeEnv !== 'production') {
      errors.push('Production bootstrap requires NODE_ENV=production.');
    }
  } else {
    // Development mode: stricter local-only guards.
    if (nodeEnv !== 'development') {
      errors.push('Development bootstrap requires NODE_ENV=development.');
    }

    if (mongoUri) {
      let url;
      try {
        url = new URL(mongoUri);
      } catch {
        errors.push('MONGODB_URI must be a valid MongoDB connection string.');
        // Cannot validate further without a parseable URL.
        return { mode, errors };
      }

      const hostname = url.hostname;
      // Only localhost/127.0.0.1 — never remote/production hosts.
      if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
        errors.push('Development bootstrap only permits localhost or 127.0.0.1 MongoDB hosts.');
      }

      // If a database name is specified in the URI path, it must be 'gashisab'.
      // 'gashisab_test' and any other database are refused in development mode.
      const dbName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if (dbName && dbName !== 'gashisab') {
        errors.push('Development bootstrap only permits the gashisab database (not gashisab_test or others).');
      }
    }
  }

  return { mode, errors };
};

const main = async () => {
  const { mode, errors } = validateBootstrapEnv(process.env);
  if (errors.length > 0) {
    for (const err of errors) console.error(err);
    process.exitCode = 1;
    return;
  }

  const isDev = mode === 'development';

  // --- Connect to database ---
  await connectDB(process.env.MONGODB_URI);
  const mongoClient = mongoose.connection.getClient();
  const config = createAuthConfig(process.env);

  // In development mode, ensure auth config is also in development (not production).
  if (isDev && config.environment !== 'development') {
    console.error('Development bootstrap requires a development auth configuration.');
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  // In production mode, ensure auth config is in production.
  if (!isDev && config.environment !== 'production') {
    console.error('Production bootstrap requires a production auth configuration.');
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  const auth = createBetterAuth({
    db: mongoClient.db('gashisab'),
    mongoClient,
    config,
  });

  const User = (await import('../src/modules/user.model.js')).default;

  // --- Idempotency check: refuse if a super admin already exists ---
  const existing = await User.findOne({ platformRole: 'super_admin' }).select('_id').lean();
  if (existing) {
    console.log('A Super Admin already exists. Bootstrap skipped.');
    await mongoose.disconnect();
    return;
  }

  // --- Create the Super Admin user via Better Auth internals ---
  const context = await auth.$context;
  let createdUser;
  try {
    createdUser = await context.internalAdapter.createUser(
      {
        name: 'Platform Super Admin',
        email: process.env.SUPER_ADMIN_EMAIL.trim(),
        emailVerified: true,
        status: 'active',
        platformRole: 'super_admin',
      },
      { method: 'email-password' },
    );
    await context.internalAdapter.createAccount({
      accountId: createdUser.id,
      providerId: 'credential',
      userId: createdUser.id,
      password: await context.password.hash(process.env.SUPER_ADMIN_PASSWORD),
    });
  } catch (error) {
    // The partial unique index may reject a concurrent bootstrap (duplicate key).
    if (error?.code === 11000) {
      console.log('A Super Admin already exists (concurrent bootstrap detected). Bootstrap skipped.');
      await mongoose.disconnect();
      return;
    }
    // Sanitize: log only the error name, never credentials or stack details.
    console.error(`Bootstrap failed: ${error?.name ?? 'UnknownError'}`);
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  // Log only the user ID — never email, password, or other secrets.
  console.log(`Super Admin created successfully (ID: ${createdUser.id}).`);
  await mongoose.disconnect();
};

// Only run main() when executed directly (not when imported by tests).
const isDirectRun = process.argv[1]?.endsWith('bootstrap-super-admin.js');
if (isDirectRun) {
  main().catch((error) => {
    console.error(`Bootstrap failed: ${error?.name ?? 'UnknownError'}`);
    process.exitCode = 1;
  });
}

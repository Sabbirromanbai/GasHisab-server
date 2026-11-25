import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBootstrapEnv } from '../scripts/bootstrap-super-admin.js';

const baseEnv = {
  SUPER_ADMIN_EMAIL: 'admin@example.test',
  SUPER_ADMIN_PASSWORD: 'correct horse battery staple',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/gashisab',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  NODE_ENV: 'development',
};

test('validateBootstrapEnv accepts valid development configuration', async () => {
  const { mode, errors } = validateBootstrapEnv({
    ...baseEnv,
    BOOTSTRAP_MODE: 'development',
  });
  assert.equal(mode, 'development');
  assert.deepEqual(errors, []);
});

test('validateBootstrapEnv accepts valid production configuration', async () => {
  const { mode, errors } = validateBootstrapEnv({
    ...baseEnv,
    BOOTSTRAP_MODE: 'production',
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://prod-host:27017/gashisab',
    BETTER_AUTH_URL: 'https://api.example.com',
    AUTH_ALLOWED_ORIGINS: 'https://api.example.com',
  });
  assert.equal(mode, 'production');
  assert.deepEqual(errors, []);
});

test('validateBootstrapEnv rejects invalid BOOTSTRAP_MODE', async () => {
  const { errors } = validateBootstrapEnv({
    ...baseEnv,
    BOOTSTRAP_MODE: 'staging',
  });
  assert.ok(errors.some((e) => /BOOTSTRAP_MODE must be/.test(e)));
});

test('validateBootstrapEnv rejects missing required env vars', async () => {
  const { errors } = validateBootstrapEnv({});
  assert.ok(errors.some((e) => /SUPER_ADMIN_EMAIL is required/.test(e)));
  assert.ok(errors.some((e) => /SUPER_ADMIN_PASSWORD is required/.test(e)));
  assert.ok(errors.some((e) => /MONGODB_URI is required/.test(e)));
  assert.ok(errors.some((e) => /BETTER_AUTH_SECRET is required/.test(e)));
  assert.ok(errors.some((e) => /BETTER_AUTH_URL is required/.test(e)));
});

test('validateBootstrapEnv rejects short passwords', async () => {
  const { errors } = validateBootstrapEnv({
    ...baseEnv,
    SUPER_ADMIN_PASSWORD: 'short',
  });
  assert.ok(errors.some((e) => /at least 12 characters/.test(e)));
});

test('validateBootstrapEnv development mode requires NODE_ENV=development', async () => {
  const { errors } = validateBootstrapEnv({
    ...baseEnv,
    BOOTSTRAP_MODE: 'development',
    NODE_ENV: 'production',
  });
  assert.ok(errors.some((e) => /NODE_ENV=development/.test(e)));
});

test('validateBootstrapEnv development mode refuses remote hosts', async () => {
  const { errors } = validateBootstrapEnv({
    ...baseEnv,
    BOOTSTRAP_MODE: 'development',
    MONGODB_URI: 'mongodb://prod.example.com:27017/gashisab',
  });
  assert.ok(errors.some((e) => /localhost or 127.0.0.1/.test(e)));
});

test('validateBootstrapEnv development mode refuses gashisab_test database', async () => {
  const { errors } = validateBootstrapEnv({
    ...baseEnv,
    BOOTSTRAP_MODE: 'development',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/gashisab_test',
  });
  assert.ok(errors.some((e) => /only permits the gashisab database/.test(e)));
});

test('validateBootstrapEnv development mode refuses other databases', async () => {
  const { errors } = validateBootstrapEnv({
    ...baseEnv,
    BOOTSTRAP_MODE: 'development',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/other_db',
  });
  assert.ok(errors.some((e) => /only permits the gashisab database/.test(e)));
});

test('validateBootstrapEnv development mode allows URI without database path', async () => {
  const { errors } = validateBootstrapEnv({
    ...baseEnv,
    BOOTSTRAP_MODE: 'development',
    MONGODB_URI: 'mongodb://127.0.0.1:27017',
  });
  assert.deepEqual(errors, []);
});

test('validateBootstrapEnv production mode requires NODE_ENV=production', async () => {
  const { errors } = validateBootstrapEnv({
    ...baseEnv,
    BOOTSTRAP_MODE: 'production',
    NODE_ENV: 'development',
  });
  assert.ok(errors.some((e) => /NODE_ENV=production/.test(e)));
});

test('validateBootstrapEnv defaults to production mode', async () => {
  const { mode, errors } = validateBootstrapEnv({
    ...baseEnv,
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://prod-host:27017/gashisab',
    BETTER_AUTH_URL: 'https://api.example.com',
  });
  assert.equal(mode, 'production');
  assert.deepEqual(errors, []);
});
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import { createAuthConfig, createBetterAuth } from '../src/config/auth.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

const password = 'correct horse battery staple';
let app;
let server;
let baseUrl;
let origin;
let User;
let Business;
let BusinessMember;
let user;
let business;
let otherBusiness;
let suspendedBusiness;
let auth;
let requireAuthentication;
let requireRole;
let requireTenant;

before(async () => {
  await connectTestDatabase();
  // Run this before loading Mongoose models or constructing the adapter.
  await assertTestDatabaseIsEmpty();
  [User, Business, BusinessMember] = await Promise.all([
    import('../src/modules/user.model.js').then((module) => module.default),
    import('../src/modules/business.model.js').then((module) => module.default),
    import('../src/modules/business-member.model.js').then((module) => module.default),
  ]);
  ({ requireAuthentication, requireRole, requireTenant } = await import('../src/auth/middleware.js'));

  const portServer = http.createServer();
  await new Promise((resolve, reject) => portServer.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  baseUrl = origin;
  const config = {
    baseURL: origin,
    secret: randomBytes(48).toString('base64url'),
    allowedOrigins: [origin],
    production: false,
    environment: 'test',
    cookieSameSite: 'lax',
    trustedProxyHops: 0,
  };
  const mongoClient = mongoose.connection.getClient();
  auth = createBetterAuth({ db: mongoClient.db('gashisab_test'), mongoClient, config: { ...config, baseURL: origin } });
  // The test adapter is pointed only at the guarded test database; production enforces gashisab.
  app = (await import('../src/app.js')).createApp({ auth, config });
  server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));

  // Seed credentials through Better Auth internals; public signup stays disabled until onboarding is designed.
  const context = await auth.$context;
  const email = `auth-${randomBytes(8).toString('hex')}@example.test`;
  const createdUser = await context.internalAdapter.createUser(
    { name: 'Auth Test User', email, emailVerified: false, status: 'active' },
    { method: 'email-password' },
  );
  await context.internalAdapter.createAccount({
    accountId: createdUser.id,
    providerId: 'credential',
    userId: createdUser.id,
    password: await context.password.hash(password),
  });
  assert.match(createdUser.id, /^[a-f\d]{24}$/i, 'Better Auth user ids must remain Mongo ObjectIds.');
  user = await User.findById(createdUser.id);
  assert.ok(user);
  assert.equal(user.status, 'active');
  [business, otherBusiness, suspendedBusiness] = await Business.create([
    { name: 'Auth Test Business', slug: `auth-${randomBytes(8).toString('hex')}` },
    { name: 'Other Business', slug: `other-${randomBytes(8).toString('hex')}` },
    { name: 'Suspended Business', slug: `suspended-${randomBytes(8).toString('hex')}`, status: 'suspended' },
  ]);
  await BusinessMember.create([
    { userId: user._id, businessId: business._id, role: 'staff' },
    { userId: user._id, businessId: otherBusiness._id, role: 'owner', status: 'suspended' },
    { userId: user._id, businessId: suspendedBusiness._id, role: 'owner' },
  ]);
});

after(async () => {
  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
  if (mongoose.connection.readyState === 1) {
    const db = mongoose.connection.db;
    await Promise.all(['users', 'account', 'session', 'verification', 'rateLimit', 'businesses', 'businessmembers']
      .map(async (name) => {
        const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
        if (exists) await db.collection(name).deleteMany({});
      }));
  }
  await disconnectTestDatabase();
});

const request = (path, { cookie, method = 'GET', origin: requestOrigin = origin, body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const outgoing = http.request(`${baseUrl}${path}`, {
    method,
    agent: false,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(requestOrigin ? { origin: requestOrigin } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
  }, (incoming) => {
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => resolve({
      status: incoming.statusCode,
      headers: incoming.headers,
      json: async () => JSON.parse(Buffer.concat(chunks).toString()),
    }));
  });
  outgoing.on('error', reject);
  if (body) outgoing.write(body);
  outgoing.end();
});

const cookieFrom = (response) => {
  const cookies = response.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ') : undefined;
};

test('auth configuration rejects weak secrets, unsafe origins, and test DB use at runtime', () => {
  const valid = {
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
    BETTER_AUTH_URL: 'https://api.example.test',
    NODE_ENV: 'production',
  };
  const config = createAuthConfig(valid);
  assert.equal(config.cookieSameSite, 'none');
  assert.throws(() => createAuthConfig({ ...valid, BETTER_AUTH_SECRET: 'too-short' }), /at least 32 bytes/);
  assert.throws(() => createAuthConfig({ ...valid, BETTER_AUTH_URL: 'http://api.example.test' }), /HTTPS in production/);
  assert.throws(() => createAuthConfig({ ...valid, BETTER_AUTH_URL: 'https://api.example.test/path' }), /exact HTTP\(S\) origin/);
  assert.throws(() => createAuthConfig({ ...valid, AUTH_ALLOWED_ORIGINS: 'https://other.example.test' }), /must include BETTER_AUTH_URL/);
  assert.throws(() => createBetterAuth({ db: { databaseName: 'gashisab_test' }, mongoClient: {}, config }), /gashisab at runtime/);
});

test('Better Auth login, session rotation, origin checks, logout, and suspended-user rejection', async () => {
  const signUp = await request('/api/auth/sign-up/email', {
    method: 'POST', body: JSON.stringify({ name: 'No Signup', email: 'disabled@example.test', password }),
  });
  assert.ok(signUp.status >= 400);
  const firstLogin = await request('/api/auth/sign-in/email', {
    method: 'POST', body: JSON.stringify({ email: user.email, password }),
  });
  assert.equal(firstLogin.status, 200);
  const oldCookie = cookieFrom(firstLogin);
  assert.ok(oldCookie);
  const login = await request('/api/auth/sign-in/email', {
    method: 'POST', cookie: oldCookie, body: JSON.stringify({ email: user.email, password }),
  });
  assert.equal(login.status, 200);
  const loginCookie = cookieFrom(login);
  assert.ok(loginCookie);
  const setCookie = (login.headers['set-cookie'] ?? []).join('; ');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.notEqual(loginCookie, oldCookie);
  const loginBody = await login.json();
  assert.equal(loginBody.user.id, String(user._id));
  assert.equal(loginBody.user.passwordHash, undefined);
  const me = await request('/api/auth/get-session', { cookie: loginCookie });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.id, String(user._id));
  const authenticated = await invokeMiddleware(requireAuthentication(auth), { headers: { cookie: loginCookie } });
  assert.equal(authenticated.nextCalled, true);
  assert.equal(authenticated.reqAuth.userId, String(user._id));

  const invalid = await request('/api/auth/sign-in/email', {
    method: 'POST', body: JSON.stringify({ email: user.email, password: 'not the password' }),
  });
  assert.ok(invalid.status >= 400);
  const unknown = await request('/api/auth/sign-in/email', {
    method: 'POST', body: JSON.stringify({ email: 'unknown@example.test', password }),
  });
  assert.equal(unknown.status, invalid.status);
  assert.deepEqual(await unknown.json(), await invalid.json());
  const wrongOrigin = await request('/api/auth/sign-out', {
    method: 'POST', cookie: loginCookie, origin: 'https://attacker.example.test',
  });
  assert.ok(wrongOrigin.status >= 400);
  assert.equal(wrongOrigin.headers['access-control-allow-origin'], undefined);

  await User.updateOne({ _id: user._id }, { $set: { status: 'suspended' } });
  const suspendedLogin = await request('/api/auth/sign-in/email', {
    method: 'POST', body: JSON.stringify({ email: user.email, password }),
  });
  assert.ok(suspendedLogin.status >= 400, 'Suspended users must not receive new auth sessions.');
  const denied = await invokeMiddleware(requireAuthentication(auth), { headers: { cookie: loginCookie } });
  assert.equal(denied.statusCode, 401);
  await User.updateOne({ _id: user._id }, { $set: { status: 'active' } });

  let rateLimited = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const failed = await request('/api/auth/sign-in/email', {
      method: 'POST', body: JSON.stringify({ email: user.email, password: 'incorrect' }),
    });
    if (failed.status === 429) rateLimited = true;
  }
  assert.equal(rateLimited, true, 'Email sign-in must remain rate limited.');

  const logout = await request('/api/auth/sign-out', { method: 'POST', cookie: loginCookie });
  assert.equal(logout.status, 200);
  const afterLogout = await request('/api/auth/get-session', { cookie: loginCookie });
  assert.equal(await afterLogout.json(), null);
});

const invokeMiddleware = async (middleware, req) => {
  const result = { statusCode: 200, body: undefined, nextCalled: false };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; },
  };
  await middleware(req, res, (error) => { if (error) throw error; result.nextCalled = true; });
  result.reqAuth = req.auth;
  return result;
};

test('tenant membership and role checks reject cross-tenant and suspended access', async () => {
  const validReq = { auth: { userId: String(user._id) }, get: () => String(business._id) };
  const valid = await invokeMiddleware(requireTenant, validReq);
  assert.equal(valid.nextCalled, true);
  assert.equal(validReq.auth.businessId, String(business._id));
  assert.equal(validReq.auth.role, 'staff');
  const other = await invokeMiddleware(requireTenant, { auth: { userId: String(user._id) }, get: () => String(otherBusiness._id) });
  assert.equal(other.statusCode, 403);
  const suspended = await invokeMiddleware(requireTenant, { auth: { userId: String(user._id) }, get: () => String(suspendedBusiness._id) });
  assert.equal(suspended.statusCode, 403);
  assert.equal((await invokeMiddleware(requireRole('owner'), { auth: validReq.auth })).statusCode, 403);
  assert.equal((await invokeMiddleware(requireRole('staff'), { auth: validReq.auth })).nextCalled, true);
  assert.throws(() => requireRole('superuser'));
});

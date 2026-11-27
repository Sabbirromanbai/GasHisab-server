import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';
import http from 'node:http';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/auth/middleware.js';
import { createBetterAuth } from '../src/config/auth.js';
import { toHttpError } from '../src/errors.js';
import { createApp } from '../src/app.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

const password = 'correct horse battery staple';

let app;
let server;
let baseUrl;
let origin;
let probeServer;
let probeBaseUrl;
let auth;
let User;
let Business;
let BusinessMember;

let businessA;
let businessB;
let suspendedBusiness;

let ownerA;
let ownerB;
let adminUser;
let staffUser;
let outsider;
let superAdmin;

const randomIp = () =>
  `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

const requestOn = (root, path, { cookie, method = 'GET', origin: requestOrigin = origin, body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const outgoing = http.request(`${root}${path}`, {
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

const request = (path, options) => requestOn(baseUrl, path, options);
const probeRequest = (path, options) => requestOn(probeBaseUrl, path, options);

const cookieFrom = (response) => {
  const cookies = response.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ') : undefined;
};

const createUserAndLogin = async (prefix, extra = {}) => {
  const context = await auth.$context;
  const email = `${prefix}-${randomBytes(8).toString('hex')}@example.test`;
  const created = await context.internalAdapter.createUser(
    { name: prefix, email, emailVerified: false, status: 'active', ...extra },
    { method: 'email-password' },
  );
  await context.internalAdapter.createAccount({
    accountId: created.id,
    providerId: 'credential',
    userId: created.id,
    password: await context.password.hash(password),
  });
  const login = await request('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    headers: { 'x-gashisab-client-ip': randomIp() },
  });
  assert.equal(login.status, 200, `sign-in failed for ${prefix}`);
  return { user: await User.findById(created.id), cookie: cookieFrom(login), email };
};

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  [User, Business, BusinessMember] = await Promise.all([
    import('../src/modules/user.model.js').then((m) => m.default),
    import('../src/modules/business.model.js').then((m) => m.default),
    import('../src/modules/business-member.model.js').then((m) => m.default),
  ]);

  const reservePort = async () => {
    const probe = http.createServer();
    await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
  };

  const port = await reservePort();
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
  auth = createBetterAuth({ db: mongoClient.db('gashisab_test'), mongoClient, config });
  app = createApp({ auth, config });
  server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));

  // Probe app exercises the reusable withTenant guard without adding
  // test-only routes to the production application.
  const probe = express();
  probe.use(express.json());
  probe.get('/probe/member', ...withTenant(auth, ['owner', 'admin', 'staff']), (req, res) => {
    res.json({
      businessId: req.auth.businessId,
      role: req.auth.role,
      bodyBusinessId: req.body?.businessId ?? null,
      queryBusinessId: req.query?.businessId ?? null,
    });
  });
  probe.post('/probe/owner', ...withTenant(auth, ['owner']), (req, res) => {
    res.json({
      businessId: req.auth.businessId,
      role: req.auth.role,
      bodyBusinessId: req.body?.businessId ?? null,
      queryBusinessId: req.query?.businessId ?? null,
    });
  });
  probe.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const { status, body } = toHttpError(error);
    res.status(status).json(body);
  });
  const probePort = await reservePort();
  probeBaseUrl = `http://127.0.0.1:${probePort}`;
  probeServer = probe.listen(probePort, '127.0.0.1');
  await new Promise((resolve, reject) => probeServer.once('listening', resolve).once('error', reject));

  [ownerA, ownerB, adminUser, staffUser, outsider, superAdmin] = await Promise.all([
    createUserAndLogin('owner-a'),
    createUserAndLogin('owner-b'),
    createUserAndLogin('admin-user'),
    createUserAndLogin('staff-user'),
    createUserAndLogin('outsider'),
    createUserAndLogin('super-admin', { platformRole: 'super_admin' }),
  ]);

  [businessA, businessB, suspendedBusiness] = await Business.create([
    { name: 'Tenant A', slug: `tenant-a-${randomBytes(6).toString('hex')}` },
    { name: 'Tenant B', slug: `tenant-b-${randomBytes(6).toString('hex')}` },
    { name: 'Suspended Tenant', slug: `tenant-s-${randomBytes(6).toString('hex')}`, status: 'suspended' },
  ]);
  await BusinessMember.create([
    { businessId: businessA._id, userId: ownerA.user._id, role: 'owner' },
    { businessId: businessA._id, userId: ownerB.user._id, role: 'owner' },
    { businessId: businessA._id, userId: adminUser.user._id, role: 'admin' },
    { businessId: businessA._id, userId: staffUser.user._id, role: 'staff' },
    { businessId: businessB._id, userId: outsider.user._id, role: 'owner' },
    { businessId: suspendedBusiness._id, userId: ownerA.user._id, role: 'owner' },
  ]);
});

after(async () => {
  for (const target of [server, probeServer]) {
    if (!target) continue;
    const closed = new Promise((resolve) => target.close(resolve));
    target.closeAllConnections();
    await closed;
  }
  if (mongoose.connection.readyState === 1) {
    // Guarded test database only. Direct collection deletes bypass the
    // append-only ledger hooks that are irrelevant to security fixtures.
    const db = mongoose.connection.db;
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    await Promise.all(collections
      .filter((collection) => !collection.name.startsWith('system.'))
      .map((collection) => db.collection(collection.name).deleteMany({})));
  }
  await disconnectTestDatabase();
});

test('withTenant authenticates, resolves an active membership, and enforces roles', async () => {
  const unauthenticated = await probeRequest('/probe/member');
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), {
    error: 'Authentication required.',
    code: 'AUTHENTICATION_REQUIRED',
  });

  const missingTenant = await probeRequest('/probe/member', { cookie: staffUser.cookie });
  assert.equal(missingTenant.status, 400);
  assert.equal((await missingTenant.json()).code, 'INVALID_BUSINESS_ID');

  const crossTenant = await probeRequest('/probe/member', {
    cookie: staffUser.cookie,
    headers: { 'x-business-id': String(businessB._id) },
  });
  assert.equal(crossTenant.status, 403);
  assert.equal((await crossTenant.json()).code, 'TENANT_ACCESS_DENIED');

  const suspendedTenant = await probeRequest('/probe/member', {
    cookie: staffUser.cookie,
    headers: { 'x-business-id': String(suspendedBusiness._id) },
  });
  assert.equal(suspendedTenant.status, 403);
  assert.equal((await suspendedTenant.json()).code, 'TENANT_ACCESS_DENIED');

  const staffRead = await probeRequest('/probe/member', {
    cookie: staffUser.cookie,
    headers: { 'x-business-id': String(businessA._id) },
  });
  assert.equal(staffRead.status, 200);
  assert.deepEqual(await staffRead.json(), {
    businessId: String(businessA._id),
    role: 'staff',
    bodyBusinessId: null,
    queryBusinessId: null,
  });

  const adminRead = await probeRequest('/probe/member', {
    cookie: adminUser.cookie,
    headers: { 'x-business-id': String(businessA._id) },
  });
  assert.equal(adminRead.status, 200);
  assert.equal((await adminRead.json()).role, 'admin');

  for (const actor of [staffUser, adminUser]) {
    const rejected = await probeRequest('/probe/owner', {
      method: 'POST',
      cookie: actor.cookie,
      headers: { 'x-business-id': String(businessA._id) },
      body: '{}',
    });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, 'INSUFFICIENT_ROLE');
  }

  const ownerWrite = await probeRequest('/probe/owner', {
    method: 'POST',
    cookie: ownerA.cookie,
    headers: { 'x-business-id': String(businessA._id) },
    body: '{}',
  });
  assert.equal(ownerWrite.status, 200);
  assert.equal((await ownerWrite.json()).role, 'owner');
});

test('tenant identity comes from verified context, never body or query', async () => {
  const result = await probeRequest(`/probe/owner?businessId=${businessB._id}`, {
    method: 'POST',
    cookie: ownerA.cookie,
    headers: { 'x-business-id': String(businessA._id) },
    body: JSON.stringify({ businessId: String(businessB._id) }),
  });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.businessId, String(businessA._id));
  assert.equal(body.bodyBusinessId, String(businessB._id));
  assert.equal(body.queryBusinessId, String(businessB._id));
});

test('platform admins do not get implicit tenant access', async () => {
  assert.equal(superAdmin.user.platformRole, 'super_admin');
  const denied = await probeRequest('/probe/member', {
    cookie: superAdmin.cookie,
    headers: { 'x-business-id': String(businessA._id) },
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'TENANT_ACCESS_DENIED');
});

test('mongoose validation errors return 400 and duplicates return 409 with codes', async () => {
  const slug = `validated-${randomBytes(6).toString('hex')}`;
  const invalidEmail = await request('/api/businesses', {
    method: 'POST',
    cookie: ownerA.cookie,
    body: JSON.stringify({ name: 'Bad Email', slug, contact: { email: 'not-an-email' } }),
  });
  assert.equal(invalidEmail.status, 400);
  assert.equal((await invalidEmail.json()).code, 'VALIDATION_ERROR');

  const longName = await request('/api/businesses', {
    method: 'POST',
    cookie: ownerA.cookie,
    body: JSON.stringify({ name: 'x'.repeat(121), slug: `${slug}-long` }),
  });
  assert.equal(longName.status, 400);
  assert.equal((await longName.json()).code, 'VALIDATION_ERROR');

  const duplicateSlug = `${slug}-dup`;
  const first = await request('/api/businesses', {
    method: 'POST',
    cookie: ownerA.cookie,
    body: JSON.stringify({ name: 'Duplicate Base', slug: duplicateSlug }),
  });
  assert.equal(first.status, 201);
  const second = await request('/api/businesses', {
    method: 'POST',
    cookie: ownerB.cookie,
    body: JSON.stringify({ name: 'Duplicate Again', slug: duplicateSlug }),
  });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, 'CONFLICT');

  const malformedId = await request('/api/businesses/members/not-an-object-id', {
    method: 'PATCH',
    cookie: ownerA.cookie,
    headers: { 'x-business-id': String(businessA._id) },
    body: JSON.stringify({ status: 'suspended' }),
  });
  assert.equal(malformedId.status, 400);
  assert.equal((await malformedId.json()).code, 'VALIDATION_ERROR');
});

test('the final active owner cannot be suspended, demoted, or removed', async () => {
  const created = await request('/api/businesses', {
    method: 'POST',
    cookie: ownerB.cookie,
    body: JSON.stringify({ name: 'Solo Owner', slug: `solo-${randomBytes(6).toString('hex')}` }),
  });
  assert.equal(created.status, 201);
  const tenantId = (await created.json()).business._id;
  const headers = { 'x-business-id': tenantId };

  for (const body of [{ status: 'suspended' }, { role: 'staff' }]) {
    const blocked = await request(`/api/businesses/members/${ownerB.user._id}`, {
      method: 'PATCH',
      cookie: ownerB.cookie,
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, 'LAST_OWNER');
  }

  const removal = await request(`/api/businesses/members/${ownerB.user._id}`, {
    method: 'DELETE',
    cookie: ownerB.cookie,
    headers,
  });
  assert.equal(removal.status, 409);
  assert.equal((await removal.json()).code, 'LAST_OWNER');

  const membership = await BusinessMember.findOne({ businessId: tenantId, userId: ownerB.user._id }).lean();
  assert.equal(membership.role, 'owner');
  assert.equal(membership.status, 'active');

  // A staff member cannot manage members at all, even themselves.
  await BusinessMember.create({ businessId: tenantId, userId: staffUser.user._id, role: 'staff' });
  const staffAttempt = await request(`/api/businesses/members/${staffUser.user._id}`, {
    method: 'PATCH',
    cookie: staffUser.cookie,
    headers,
    body: JSON.stringify({ role: 'admin' }),
  });
  assert.equal(staffAttempt.status, 403);
  assert.equal((await staffAttempt.json()).code, 'INSUFFICIENT_ROLE');

  // With a second active owner, suspending one is allowed.
  await BusinessMember.create({ businessId: tenantId, userId: ownerA.user._id, role: 'owner' });
  const suspendSecond = await request(`/api/businesses/members/${ownerA.user._id}`, {
    method: 'PATCH',
    cookie: ownerB.cookie,
    headers,
    body: JSON.stringify({ status: 'suspended' }),
  });
  assert.equal(suspendSecond.status, 200);
  assert.equal((await suspendSecond.json()).member.status, 'suspended');

  const nowLast = await request(`/api/businesses/members/${ownerB.user._id}`, {
    method: 'PATCH',
    cookie: ownerB.cookie,
    headers,
    body: JSON.stringify({ status: 'suspended' }),
  });
  assert.equal(nowLast.status, 409);
  assert.equal((await nowLast.json()).code, 'LAST_OWNER');
});

test('concurrent last-owner changes cannot orphan a business', async () => {
  const created = await request('/api/businesses', {
    method: 'POST',
    cookie: ownerA.cookie,
    body: JSON.stringify({ name: 'Two Owners', slug: `two-${randomBytes(6).toString('hex')}` }),
  });
  assert.equal(created.status, 201);
  const tenantId = (await created.json()).business._id;
  await BusinessMember.create({ businessId: tenantId, userId: ownerB.user._id, role: 'owner' });

  const headers = { 'x-business-id': tenantId };
  const results = await Promise.all([
    request(`/api/businesses/members/${ownerB.user._id}`, {
      method: 'PATCH',
      cookie: ownerA.cookie,
      headers,
      body: JSON.stringify({ status: 'suspended' }),
    }),
    request(`/api/businesses/members/${ownerA.user._id}`, {
      method: 'PATCH',
      cookie: ownerB.cookie,
      headers,
      body: JSON.stringify({ status: 'suspended' }),
    }),
  ]);

  const statuses = results.map((result) => result.status);
  assert.equal(statuses.filter((status) => status === 200).length, 1, `expected exactly one success, got ${statuses}`);
  assert.ok(statuses.every((status) => [200, 403, 409].includes(status)), `unexpected statuses ${statuses}`);

  const activeOwners = await BusinessMember.countDocuments({ businessId: tenantId, role: 'owner', status: 'active' });
  assert.equal(activeOwners, 1, 'a business must never be left without an active owner');
});

test('CSRF barrier rejects cross-site writes even when Origin is missing', async () => {
  const crossSite = await request('/api/health', {
    method: 'POST',
    origin: 'https://attacker.example.test',
    body: '{}',
  });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(await crossSite.json(), { error: 'Origin not allowed.' });

  const missingOriginCrossSite = await request('/api/health', {
    method: 'POST',
    origin: null,
    headers: { 'sec-fetch-site': 'cross-site' },
    body: '{}',
  });
  assert.equal(missingOriginCrossSite.status, 403);

  const badReferer = await request('/api/health', {
    method: 'POST',
    origin: null,
    headers: { referer: 'https://attacker.example.test/page' },
    body: '{}',
  });
  assert.equal(badReferer.status, 403);

  // An allow-listed Referer must not be trusted when Fetch Metadata reports a
  // cross-site request (e.g. a cross-site redirect).
  const crossSiteReferer = await request('/api/health', {
    method: 'POST',
    origin: null,
    cookie: ownerA.cookie,
    headers: { referer: `${origin}/dashboard`, 'sec-fetch-site': 'cross-site' },
    body: '{}',
  });
  assert.equal(crossSiteReferer.status, 403);

  const sameOriginReferer = await request('/api/health', {
    method: 'POST',
    origin: null,
    cookie: ownerA.cookie,
    headers: { referer: `${origin}/dashboard`, 'sec-fetch-site': 'same-origin' },
    body: '{}',
  });
  assert.equal(sameOriginReferer.status, 404);

  const sameOriginFallback = await request('/api/health', {
    method: 'POST',
    origin: null,
    headers: { 'sec-fetch-site': 'same-origin' },
    body: '{}',
  });
  assert.equal(sameOriginFallback.status, 404);

  // A hostile sibling subdomain reports `same-site`; omitting Origin must not
  // let it ride the session cookie.
  const siblingSameSite = await request('/api/health', {
    method: 'POST',
    origin: null,
    cookie: ownerA.cookie,
    headers: { 'sec-fetch-site': 'same-site' },
    body: '{}',
  });
  assert.equal(siblingSameSite.status, 403);
  assert.deepEqual(await siblingSameSite.json(), { error: 'Origin not allowed.' });

  // Top-level navigation (`none`) is never a legitimate unsafe API call.
  const navigationNone = await request('/api/health', {
    method: 'POST',
    origin: null,
    cookie: ownerA.cookie,
    headers: { 'sec-fetch-site': 'none' },
    body: '{}',
  });
  assert.equal(navigationNone.status, 403);

  // A browser that stripped every provenance header is treated as hostile when
  // it carries a session cookie.
  const headerlessWithCookie = await request('/api/health', {
    method: 'POST',
    origin: null,
    cookie: ownerA.cookie,
    body: '{}',
  });
  assert.equal(headerlessWithCookie.status, 403);

  const sameOriginWithCookie = await request('/api/health', {
    method: 'POST',
    origin: null,
    cookie: ownerA.cookie,
    headers: { 'sec-fetch-site': 'same-origin' },
    body: '{}',
  });
  assert.equal(sameOriginWithCookie.status, 404);

  const allowedOriginWithCookie = await request('/api/health', {
    method: 'POST',
    cookie: ownerA.cookie,
    body: '{}',
  });
  assert.equal(allowedOriginWithCookie.status, 404);

  const nonBrowser = await request('/api/health', {
    method: 'POST',
    origin: null,
    body: '{}',
  });
  assert.equal(nonBrowser.status, 404);
});

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
let auth;

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  [User, Business, BusinessMember] = await Promise.all([
    import('../src/modules/user.model.js').then((m) => m.default),
    import('../src/modules/business.model.js').then((m) => m.default),
    import('../src/modules/business-member.model.js').then((m) => m.default),
  ]);

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
  app = (await import('../src/app.js')).createApp({ auth, config });
  server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));
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

const createUser = async (emailPrefix) => {
  const context = await auth.$context;
  const email = `${emailPrefix}-${randomBytes(8).toString('hex')}@example.test`;
  const createdUser = await context.internalAdapter.createUser(
    { name: `Test User ${emailPrefix}`, email, emailVerified: false, status: 'active' },
    { method: 'email-password' },
  );
  await context.internalAdapter.createAccount({
    accountId: createdUser.id,
    providerId: 'credential',
    userId: createdUser.id,
    password: await context.password.hash(password),
  });
  const loginRes = await request('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    headers: { 'x-gashisab-client-ip': `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}` },
  });
  const cookie = cookieFrom(loginRes);
  return { user: await User.findById(createdUser.id), cookie, email };
};

test('unauthenticated GET /api/businesses returns 401', async () => {
  const res = await request('/api/businesses');
  assert.equal(res.status, 401);
});

test('unauthenticated POST /api/businesses returns 401', async () => {
  const res = await request('/api/businesses', {
    method: 'POST',
    body: JSON.stringify({ name: 'Test Biz', slug: 'test-biz' }),
  });
  assert.equal(res.status, 401);
});

test('POST /api/businesses creates business with owner membership', async () => {
  const { user, cookie } = await createUser('creator');
  const res = await request('/api/businesses', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ name: 'Test Business', slug: 'test-business' }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.business);
  assert.equal(body.business.name, 'Test Business');
  assert.equal(body.business.slug, 'test-business');
  assert.equal(body.business.status, 'active');

  // Verify owner membership was created.
  const membership = await BusinessMember.findOne({ businessId: body.business._id, userId: user._id }).lean();
  assert.ok(membership);
  assert.equal(membership.role, 'owner');
  assert.equal(membership.status, 'active');
});

test('POST /api/businesses auto-generates slug from name', async () => {
  const { cookie } = await createUser('slugger');
  const res = await request('/api/businesses', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ name: 'My Cool Business' }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.business.slug, 'my-cool-business');
});

test('POST /api/businesses validates required name', async () => {
  const { cookie } = await createUser('validator');
  const res = await request('/api/businesses', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ slug: 'no-name' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/businesses prevents duplicate slug', async () => {
  const { cookie: cookie1 } = await createUser('dup1');
  const res1 = await request('/api/businesses', {
    method: 'POST',
    cookie: cookie1,
    body: JSON.stringify({ name: 'Dup Business', slug: 'dup-slug' }),
  });
  assert.equal(res1.status, 201);

  const { cookie: cookie2 } = await createUser('dup2');
  const res2 = await request('/api/businesses', {
    method: 'POST',
    cookie: cookie2,
    body: JSON.stringify({ name: 'Dup Business 2', slug: 'dup-slug' }),
  });
  assert.equal(res2.status, 409);
});

test('POST /api/businesses prevents mass assignment', async () => {
  const { cookie } = await createUser('massassign');
  const res = await request('/api/businesses', {
    method: 'POST',
    cookie,
    body: JSON.stringify({
      name: 'Mass Assign Test',
      slug: 'mass-assign-test',
      status: 'suspended',       // Should be ignored — forced to 'active'
      platformRole: 'super_admin', // Should be ignored
      _id: '000000000000000000000000', // Should be ignored
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.business.status, 'active');
  // Mass-assigned fields must not appear in the response.
  assert.equal(body.business.platformRole, undefined);
  assert.notEqual(body.business._id, '000000000000000000000000');
});

test('GET /api/businesses returns only user businesses', async () => {
  const { user: userA, cookie: cookieA } = await createUser('userA');
  const { user: userB, cookie: cookieB } = await createUser('userB');

  // User A creates a business.
  const createRes = await request('/api/businesses', {
    method: 'POST',
    cookie: cookieA,
    body: JSON.stringify({ name: 'User A Biz', slug: 'user-a-biz' }),
  });
  assert.equal(createRes.status, 201);
  const createdBiz = (await createRes.json()).business;

  // User A should see their business.
  const listA = await request('/api/businesses', { cookie: cookieA });
  assert.equal(listA.status, 200);
  const bodyA = await listA.json();
  assert.equal(bodyA.businesses.length, 1);
  assert.equal(bodyA.businesses[0]._id, createdBiz._id);
  assert.equal(bodyA.businesses[0].role, 'owner');

  // User B should see no businesses (isolation).
  const listB = await request('/api/businesses', { cookie: cookieB });
  assert.equal(listB.status, 200);
  const bodyB = await listB.json();
  assert.equal(bodyB.businesses.length, 0);
});

test('GET /api/businesses excludes suspended businesses', async () => {
  const { cookie } = await createUser('suspendedbiz');
  const createRes = await request('/api/businesses', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ name: 'Will Suspend', slug: 'will-suspend' }),
  });
  assert.equal(createRes.status, 201);
  const biz = (await createRes.json()).business;

  // Suspend the business.
  await Business.updateOne({ _id: biz._id }, { $set: { status: 'suspended' } });

  // Should not appear in listing.
  const listRes = await request('/api/businesses', { cookie });
  assert.equal(listRes.status, 200);
  const body = await listRes.json();
  assert.equal(body.businesses.length, 0);
});

test('GET /api/businesses excludes suspended memberships', async () => {
  const { user, cookie } = await createUser('suspendedmem');
  const createRes = await request('/api/businesses', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ name: 'Membership Suspend', slug: 'mem-suspend' }),
  });
  assert.equal(createRes.status, 201);
  const biz = (await createRes.json()).business;

  // Suspend the membership.
  await BusinessMember.updateOne({ businessId: biz._id, userId: user._id }, { $set: { status: 'suspended' } });

  // Should not appear in listing.
  const listRes = await request('/api/businesses', { cookie });
  assert.equal(listRes.status, 200);
  const body = await listRes.json();
  assert.equal(body.businesses.length, 0);
});
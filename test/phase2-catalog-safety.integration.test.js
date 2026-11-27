import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import { createBetterAuth } from '../src/config/auth.js';
import { createApp } from '../src/app.js';
import Brand from '../src/modules/brand.model.js';
import CylinderSize from '../src/modules/cylinder-size.model.js';
import Product from '../src/modules/product.model.js';
import Business from '../src/modules/business.model.js';
import BusinessMember from '../src/modules/business-member.model.js';
import User from '../src/modules/user.model.js';
import { createProduct, updateProduct } from '../src/modules/catalog.service.js';
import { ConflictError } from '../src/errors.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

const password = 'correct horse battery staple';
let app;
let server;
let baseUrl;
let origin;
let auth;

let businessA; // tenant under test
let businessB; // other tenant (isolation)
let ownerA; // owner of A
let adminA; // admin of A
let staffA; // staff of A
let ownerB; // owner of B
let outsider; // no membership
let superAdmin; // platform admin

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();

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
  auth = createBetterAuth({ db: mongoClient.db('gashisab_test'), mongoClient, config });
  app = createApp({ auth, config });
  server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));

  businessA = await Business.create({ name: 'Dealer A', slug: `dealer-a-${Date.now()}`, status: 'active' });
  businessB = await Business.create({ name: 'Dealer B', slug: `dealer-b-${Date.now()}`, status: 'active' });

  ownerA = await createUser('owner-a');
  adminA = await createUser('admin-a');
  staffA = await createUser('staff-a');
  ownerB = await createUser('owner-b');
  outsider = await createUser('outsider');
  superAdmin = await createUser('super-admin');

  await BusinessMember.create([
    { businessId: businessA._id, userId: ownerA.user._id, role: 'owner', status: 'active' },
    { businessId: businessA._id, userId: adminA.user._id, role: 'admin', status: 'active' },
    { businessId: businessA._id, userId: staffA.user._id, role: 'staff', status: 'active' },
    { businessId: businessB._id, userId: ownerB.user._id, role: 'owner', status: 'active' },
  ]);
  await User.findByIdAndUpdate(superAdmin.user._id, { platformRole: 'super_admin' });

  for (const M of [Brand, CylinderSize, Product]) await M.syncIndexes();
});

after(async () => {
  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
  if (mongoose.connection.readyState === 1) {
    const db = mongoose.connection.db;
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name } of collections) {
      if (!name.startsWith('system.')) await db.collection(name).deleteMany({});
    }
  }
  await disconnectTestDatabase();
});

function request(path, { cookie, method = 'GET', origin: requestOrigin = origin, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
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
}

const cookieFrom = (response) => {
  const cookies = response.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ') : undefined;
};

async function createUser(emailPrefix) {
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
}

const bizHeader = (business) => ({ 'x-business-id': String(business._id) });

// ---------------- Authorization ----------------

test('auth: unauthenticated catalog requests are 401', async () => {
  const res = await request('/api/catalog/brands', { headers: bizHeader(businessA) });
  assert.equal(res.status, 401);
  const post = await request('/api/catalog/brands', { method: 'POST', body: JSON.stringify({ code: 'x', nameEn: 'X' }), headers: bizHeader(businessA) });
  assert.equal(post.status, 401);
});

test('auth: verified tenant + active membership required (not body businessId)', async () => {
  // no X-Business-Id
  let res = await request('/api/catalog/brands', { cookie: ownerA.cookie });
  assert.equal(res.status, 400);
  // not a member
  res = await request('/api/catalog/brands', { cookie: outsider.cookie, headers: bizHeader(businessA) });
  assert.equal(res.status, 403);
  // body businessId cannot substitute / spoof tenant
  res = await request('/api/catalog/brands', {
    method: 'POST', cookie: ownerA.cookie, headers: bizHeader(businessA),
    body: JSON.stringify({ code: `spoof-${Date.now()}`, nameEn: 'Spoof', businessId: String(businessB._id) }),
  });
  assert.equal(res.status, 201);
  const { brand } = await res.json();
  assert.equal(String(brand.businessId), String(businessA._id)); // forced to verified tenant
});

test('auth: writes require owner/admin; staff cannot write', async () => {
  // staff can read
  let res = await request('/api/catalog/brands', { cookie: staffA.cookie, headers: bizHeader(businessA) });
  assert.equal(res.status, 200);
  // staff cannot create custom brand
  res = await request('/api/catalog/brands', {
    method: 'POST', cookie: staffA.cookie, headers: bizHeader(businessA),
    body: JSON.stringify({ code: `staff-${Date.now()}`, nameEn: 'Staff' }),
  });
  assert.equal(res.status, 403);
  // staff cannot create product
  res = await request('/api/catalog/products', {
    method: 'POST', cookie: staffA.cookie, headers: bizHeader(businessA),
    body: JSON.stringify({ brand: 'x', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 }),
  });
  assert.equal(res.status, 403);
  // admin CAN create
  res = await request('/api/catalog/brands', {
    method: 'POST', cookie: adminA.cookie, headers: bizHeader(businessA),
    body: JSON.stringify({ code: `admin-${Date.now()}`, nameEn: 'Admin' }),
  });
  assert.equal(res.status, 201);
});

test('auth: shared catalog WRITES require platform admin; shared reads available to tenants', async () => {
  // tenant cannot create shared via tenant route
  let res = await request('/api/catalog/brands', {
    method: 'POST', cookie: ownerA.cookie, headers: bizHeader(businessA),
    body: JSON.stringify({ scope: 'shared', code: `nope-${Date.now()}`, nameEn: 'Nope' }),
  });
  assert.equal(res.status, 403);
  // tenant cannot create shared via admin route
  res = await request('/api/catalog/brands/shared', {
    method: 'POST', cookie: ownerA.cookie, headers: bizHeader(businessA),
    body: JSON.stringify({ code: `nope2-${Date.now()}`, nameEn: 'Nope' }),
  });
  assert.equal(res.status, 403);
  // platform admin can create shared (no tenant needed)
  res = await request('/api/catalog/brands/shared', {
    method: 'POST', cookie: superAdmin.cookie,
    body: JSON.stringify({ code: `shared-${Date.now()}`, nameEn: 'Shared', nameBn: 'শেয়ার্ড' }),
  });
  assert.equal(res.status, 201);
  const { brand } = await res.json();
  assert.equal(brand.scope, 'shared');
  assert.equal(brand.businessId, null);

  // shared readable by an unrelated tenant
  const read = await request(`/api/catalog/brands/${brand._id}`, { cookie: ownerB.cookie, headers: bizHeader(businessB) });
  assert.equal(read.status, 200);

  // shared CylinderSize admin create
  const sizeRes = await request('/api/catalog/cylinder-sizes/shared', {
    method: 'POST', cookie: superAdmin.cookie,
    body: JSON.stringify({ code: `shared-size-${Date.now()}`, capacityGrams: 12000, labelEn: 'Shared Size' }),
  });
  assert.equal(sizeRes.status, 201);
  const { cylinderSize } = await sizeRes.json();
  assert.equal(cylinderSize.scope, 'shared');
  assert.equal(cylinderSize.businessId, null);
});

// ---------------- Tenant isolation / cross-business indistinguishable ----------------

test('isolation: custom entries + products are tenant-scoped; cross-business reads as 404', async () => {
  // businessB creates custom brand + product
  const bBrand = await request('/api/catalog/brands', {
    method: 'POST', cookie: ownerB.cookie, headers: bizHeader(businessB),
    body: JSON.stringify({ code: `b-only-${Date.now()}`, nameEn: 'B Only' }),
  });
  const { brand } = await bBrand.json();

  // tenantA cannot read tenantB custom brand (indistinguishable from nonexistent)
  let res = await request(`/api/catalog/brands/${brand._id}`, { cookie: ownerA.cookie, headers: bizHeader(businessA) });
  assert.equal(res.status, 404);
  const nonexistent = await request(`/api/catalog/brands/${new mongoose.Types.ObjectId()}`, { cookie: ownerA.cookie, headers: bizHeader(businessA) });
  assert.equal(nonexistent.status, 404);
  assert.deepEqual(await res.json(), await nonexistent.json()); // indistinguishable

  // tenantA list does not include tenantB custom
  const list = await (await request('/api/catalog/brands', { cookie: ownerA.cookie, headers: bizHeader(businessA) })).json();
  assert.ok(!list.brands.some((b) => String(b._id) === String(brand._id)));

  // tenantA cannot reference tenantB custom brand in a Product
  res = await request('/api/catalog/products', {
    method: 'POST', cookie: ownerA.cookie, headers: bizHeader(businessA),
    body: JSON.stringify({ brand: 'x', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1, brandId: brand._id }),
  });
  assert.equal(res.status, 404);

  // products are tenant-scoped
  const prod = await request('/api/catalog/products', {
    method: 'POST', cookie: ownerB.cookie, headers: bizHeader(businessB),
    body: JSON.stringify({ brand: `iso-${Date.now()}`, cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 }),
  });
  const { product } = await prod.json();
  res = await request(`/api/catalog/products/${product._id}`, { cookie: ownerA.cookie, headers: bizHeader(businessA) });
  assert.equal(res.status, 404);
});

// ---------------- Duplicate LPG prevention across legacy + v2 ----------------

test('duplicate: legacy-only and v2 cannot both create one LPG product for business+brand+size', async () => {
  const tenantId = businessA._id;
  const stamp = Date.now();
  const code = `dup-${stamp}`;

  const sharedBrand = await Brand.create({ scope: 'shared', businessId: null, code, nameEn: 'Dup Brand', status: 'active' });
  const size = await CylinderSize.create({ scope: 'shared', businessId: null, code: `dup-size-${stamp}`, capacityGrams: 12000, labelEn: 'Dup Size', status: 'active' });

  // 1) legacy-only first
  const legacy = await createProduct({ businessId: tenantId, brand: code, cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });
  assert.equal(legacy.brand, code);
  assert.equal(legacy.cylinderSizeKg, 12);
  assert.equal(legacy.brandId, undefined); // no automatic backfill

  // v2 duplicate (different legacy string to evade DB string key; same physical brand+size) -> Conflict
  await assert.rejects(
    createProduct({
      businessId: tenantId, brand: `${code}-alias`, cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1,
      brandId: sharedBrand._id, cylinderSizeId: size._id,
    }),
    (e) => e instanceof ConflictError && e.code === 'DUPLICATE_PRODUCT',
  );

  // rejected duplicate did not mutate/backfill the existing legacy record
  const reloaded = await Product.findById(legacy._id).lean();
  assert.equal(reloaded.brandId, undefined);
  assert.equal(reloaded.cylinderSizeId, undefined);
  assert.equal(reloaded.brand, code);
});

test('duplicate: v2 first, then legacy-only is blocked; reverse + kg/size-gram equivalence', async () => {
  const tenantId = businessA._id;
  const stamp = Date.now() + 1;
  const code = `dup2-${stamp}`;
  const sharedBrand = await Brand.create({ scope: 'shared', businessId: null, code, nameEn: 'Dup2', status: 'active' });
  const size = await CylinderSize.create({ scope: 'shared', businessId: null, code: `dup2-size-${stamp}`, capacityGrams: 12000, labelEn: 'D2', status: 'active' });

  await createProduct({
    businessId: tenantId, brand: `${code}-v2`, cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1,
    brandId: sharedBrand._id, cylinderSizeId: size._id,
  });

  // legacy-only (no v2 refs) matching physical brand+size -> blocked
  await assert.rejects(
    createProduct({ businessId: tenantId, brand: code, cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 }),
    (e) => e.code === 'DUPLICATE_PRODUCT',
  );

  // same physical grams via legacy kg=12 vs size.capacityGrams=12000 equivalence covered above.
  // a genuinely different size is allowed
  const ok = await createProduct({ businessId: tenantId, brand: code, cylinderSizeKg: 35, purchasePrice: 1, sellingPrice: 1 });
  assert.equal(ok.cylinderSizeKg, 35);
});

test('duplicate: updateProduct cannot move a product onto another existing LPG key', async () => {
  const tenantId = businessA._id;
  const stamp = Date.now() + 2;
  const a = await createProduct({ businessId: tenantId, brand: `upd-a-${stamp}`, cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });
  const b = await createProduct({ businessId: tenantId, brand: `upd-b-${stamp}`, cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });

  // update b to collide with a (same brand+size) -> conflict
  await assert.rejects(
    updateProduct({ businessId: tenantId, productId: b._id, patch: { brand: `upd-a-${stamp}` } }),
    (e) => e.code === 'DUPLICATE_PRODUCT',
  );

  // b unchanged
  const reloaded = await Product.findById(b._id).lean();
  assert.equal(reloaded.brand, `upd-b-${stamp}`);

  // safe additive update (names/sku/price) works
  const updated = await updateProduct({ businessId: tenantId, productId: b._id, patch: { nameEn: 'Hello', nameBn: 'হ্যালো', sku: `SKU-${stamp}`, sellingPrice: 999 } });
  assert.equal(updated.nameEn, 'Hello');
  assert.equal(updated.nameBn, 'হ্যালো');
  assert.equal(updated.sku, `SKU-${stamp}`);
  assert.equal(updated.sellingPrice, 999);
});

test('duplicate: HTTP POST returns 409 DUPLICATE_PRODUCT', async () => {
  const stamp = Date.now() + 3;
  const headers = { ...bizHeader(businessA) };
  const payload = { brand: `http-dup-${stamp}`, cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 };
  let res = await request('/api/catalog/products', { method: 'POST', cookie: ownerA.cookie, headers, body: JSON.stringify(payload) });
  assert.equal(res.status, 201);
  res = await request('/api/catalog/products', { method: 'POST', cookie: ownerA.cookie, headers, body: JSON.stringify(payload) });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'DUPLICATE_PRODUCT');
});

// ---------------- Legacy compatibility ----------------

test('legacy: products without v2 fields remain valid; legacy fields preserved; refill fields intact', async () => {
  const tenantId = businessA._id;
  const stamp = Date.now() + 4;
  const product = await createProduct({ businessId: tenantId, brand: `legacy-${stamp}`, cylinderSizeKg: 12, purchasePrice: 1000, sellingPrice: 1400 });
  // legacy preserved
  assert.equal(product.brand, `legacy-${stamp}`);
  assert.equal(product.cylinderSizeKg, 12);
  assert.equal(product.purchasePrice, 1000);
  assert.equal(product.sellingPrice, 1400);
  // v2 defaults additive
  assert.equal(product.kind, 'lpg_cylinder');
  assert.equal(product.brandId, undefined);
  assert.equal(product.cylinderSizeId, undefined);
  assert.equal(product.sku, undefined);

  // integer poisha still enforced
  await assert.rejects(createProduct({ businessId: tenantId, brand: `x-${stamp}`, cylinderSizeKg: 12, purchasePrice: 1.5, sellingPrice: 1 }));

  // HTTP legacy-only create works
  const res = await request('/api/catalog/products', {
    method: 'POST', cookie: ownerA.cookie, headers: bizHeader(businessA),
    body: JSON.stringify({ brand: `http-legacy-${stamp}`, cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200 }),
  });
  assert.equal(res.status, 201);
  const { product: created } = await res.json();
  assert.equal(created.brand, `http-legacy-${stamp}`);
  assert.equal(created.cylinderSizeKg, 12);
  assert.equal(created.kind, 'lpg_cylinder');
});

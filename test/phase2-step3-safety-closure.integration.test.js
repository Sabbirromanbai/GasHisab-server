import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import { createBetterAuth } from '../src/config/auth.js';
import { createApp } from '../src/app.js';
import Business from '../src/modules/business.model.js';
import BusinessMember from '../src/modules/business-member.model.js';
import Product from '../src/modules/product.model.js';
import Stock from '../src/modules/stock.model.js';
import StockMovement from '../src/modules/stock-movement.model.js';
import User from '../src/modules/user.model.js';
import Warehouse from '../src/modules/warehouse.model.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

const password = 'correct horse battery staple';
let app; let server; let baseUrl; let origin; let auth;
let businessA; let businessB; let ownerA; let adminA; let staffA; let ownerB; let outsider; let productA; let productB;

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  const portServer = http.createServer();
  await new Promise((resolve, reject) => portServer.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  origin = `http://127.0.0.1:${port}`; baseUrl = origin;
  const config = { baseURL: origin, secret: randomBytes(48).toString('base64url'), allowedOrigins: [origin], production: false, environment: 'test', cookieSameSite: 'lax', trustedProxyHops: 0 };
  const mongoClient = mongoose.connection.getClient();
  auth = createBetterAuth({ db: mongoClient.db('gashisab_test'), mongoClient, config });
  app = createApp({ auth, config });
  server = app.listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));

  businessA = await Business.create({ name: 'A', slug: `invapi-a-${Date.now()}`, status: 'active' });
  businessB = await Business.create({ name: 'B', slug: `invapi-b-${Date.now()}`, status: 'active' });
  ownerA = await createUser('oa'); adminA = await createUser('aa'); staffA = await createUser('sa'); ownerB = await createUser('ob'); outsider = await createUser('out');
  await BusinessMember.create([
    { businessId: businessA._id, userId: ownerA.user._id, role: 'owner', status: 'active' },
    { businessId: businessA._id, userId: adminA.user._id, role: 'admin', status: 'active' },
    { businessId: businessA._id, userId: staffA.user._id, role: 'staff', status: 'active' },
    { businessId: businessB._id, userId: ownerB.user._id, role: 'owner', status: 'active' },
  ]);
  productA = await Product.create({ businessId: businessA._id, brand: 'a', cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200, status: 'active' });
  productB = await Product.create({ businessId: businessB._id, brand: 'b', cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200, status: 'active' });
  for (const M of [Stock, StockMovement, Warehouse]) await M.syncIndexes();
});

after(async () => {
  if (server) { const closed = new Promise((r) => server.close(r)); server.closeAllConnections(); await closed; }
  if (mongoose.connection.readyState === 1) {
    const db = mongoose.connection.db;
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name } of collections) if (!name.startsWith('system.')) await db.collection(name).deleteMany({});
  }
  await disconnectTestDatabase();
});

function request(path, { cookie, method = 'GET', origin: reqOrigin = origin, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(`${baseUrl}${path}`, {
      method, agent: false,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(reqOrigin ? { origin: reqOrigin } : {}), ...(cookie ? { cookie } : {}), ...headers },
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (c) => chunks.push(c));
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    outgoing.on('error', reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}
const cookieFrom = (r) => { const c = r.headers['set-cookie']; return Array.isArray(c) ? c.map((x) => x.split(';', 1)[0]).join('; ') : undefined; };
async function createUser(prefix) {
  const context = await auth.$context;
  const email = `${prefix}-${randomBytes(8).toString('hex')}@example.test`;
  const u = await context.internalAdapter.createUser({ name: prefix, email, emailVerified: false, status: 'active' }, { method: 'email-password' });
  await context.internalAdapter.createAccount({ accountId: u.id, providerId: 'credential', userId: u.id, password: await context.password.hash(password) });
  const login = await request('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email, password }), headers: { 'x-gashisab-client-ip': `10.${randomBytes(3).join('.')}` } });
  return { user: await User.findById(u.id), cookie: cookieFrom(login) };
}
const biz = (b) => ({ 'x-business-id': String(b._id) });
const openingBody = (over = {}) => JSON.stringify({ productId: String(productA._id), idempotencyKey: `k-${randomBytes(6).toString('hex')}`, quantities: { full: 1, empty: 1, damaged: 1, rejected: 1 }, ...over });
const adjBody = (over = {}) => JSON.stringify({ productId: String(productA._id), idempotencyKey: `k-${randomBytes(6).toString('hex')}`, bucket: 'full', delta: 1, reason: 'test', ...over });

// ---------- Authorization ----------
test('auth: unauthenticated 401; membership required; reads member, writes owner/admin; verified tenant only', async () => {
  // 401 unauth
  assert.equal((await request('/api/inventory/stock?productId=' + productA._id, { headers: biz(businessA) })).status, 401);
  assert.equal((await request('/api/inventory/opening-stock', { method: 'POST', body: openingBody(), headers: biz(businessA) })).status, 401);
  // no tenant header
  assert.equal((await request('/api/inventory/stock?productId=' + productA._id, { cookie: ownerA.cookie })).status, 400);
  // not a member
  assert.equal((await request('/api/inventory/stock?productId=' + productA._id, { cookie: outsider.cookie, headers: biz(businessA) })).status, 403);
  // staff read ok
  assert.equal((await request('/api/inventory/stock?productId=' + productA._id, { cookie: staffA.cookie, headers: biz(businessA) })).status, 200);
  assert.equal((await request('/api/inventory/reconciliation?productId=' + productA._id, { cookie: staffA.cookie, headers: biz(businessA) })).status, 200);
  // staff write 403
  assert.equal((await request('/api/inventory/opening-stock', { method: 'POST', cookie: staffA.cookie, headers: biz(businessA), body: openingBody() })).status, 403);
  assert.equal((await request('/api/inventory/adjustments', { method: 'POST', cookie: staffA.cookie, headers: biz(businessA), body: adjBody() })).status, 403);
  // body businessId / actorId cannot spoof
  const r = await request('/api/inventory/adjustments', {
    method: 'POST', cookie: ownerA.cookie, headers: biz(businessA),
    body: adjBody({ businessId: String(businessB._id), actorId: String(ownerB.user._id), createdBy: String(ownerB.user._id) }),
  });
  assert.equal(r.status, 201);
  const { movement } = await r.json();
  assert.equal(String(movement.businessId), String(businessA._id)); // verified tenant
  assert.equal(String(movement.createdBy), String(ownerA.user._id)); // verified actor, not body
  // admin can write
  const a = await request('/api/inventory/adjustments', { method: 'POST', cookie: adminA.cookie, headers: biz(businessA), body: adjBody() });
  assert.equal(a.status, 201);
});

// ---------- HTTP boundary validation + idempotency ----------
test('invalid inputs rejected at boundary; idempotency key required; overdraft disabled', async () => {
  const W = { method: 'POST', cookie: ownerA.cookie, headers: biz(businessA) };
  // missing idempotencyKey
  assert.equal((await request('/api/inventory/opening-stock', { ...W, body: JSON.stringify({ productId: String(productA._id), quantities: { full: 1, empty: 1, damaged: 1, rejected: 1 } }) })).status, 400);
  assert.equal((await request('/api/inventory/adjustments', { ...W, body: JSON.stringify({ productId: String(productA._id), bucket: 'full', delta: 1, reason: 'x' }) })).status, 400);
  // invalid productId
  assert.equal((await request('/api/inventory/opening-stock', { ...W, body: openingBody({ productId: 'nope' }) })).status, 400);
  // invalid bucket
  assert.equal((await request('/api/inventory/adjustments', { ...W, body: adjBody({ bucket: 'nope' }) })).status, 400);
  // non-integer / zero delta
  assert.equal((await request('/api/inventory/adjustments', { ...W, body: adjBody({ delta: 1.5 }) })).status, 400);
  assert.equal((await request('/api/inventory/adjustments', { ...W, body: adjBody({ delta: 0 }) })).status, 400);
  // missing reason
  assert.equal((await request('/api/inventory/adjustments', { ...W, body: adjBody({ reason: '' }) })).status, 400);
  // missing quantities bucket / negative / non-integer
  assert.equal((await request('/api/inventory/opening-stock', { ...W, body: openingBody({ quantities: { full: 1, empty: 1, damaged: 1 } }) })).status, 400);
  assert.equal((await request('/api/inventory/opening-stock', { ...W, body: openingBody({ quantities: { full: 1, empty: 1, damaged: 1, rejected: -1 } }) })).status, 400);
  assert.equal((await request('/api/inventory/opening-stock', { ...W, body: openingBody({ quantities: { full: 1, empty: 1, damaged: 1, rejected: 1.5 } }) })).status, 400);
  // invalid source id
  assert.equal((await request('/api/inventory/adjustments', { ...W, body: adjBody({ sourceId: 'nope' }) })).status, 400);
  // invalid warehouse id
  assert.equal((await request('/api/inventory/adjustments', { ...W, body: adjBody({ warehouseId: 'nope' }) })).status, 400);
  // invalid expectedVersion
  assert.equal((await request('/api/inventory/adjustments', { ...W, body: adjBody({ expectedVersion: -1 }) })).status, 400);
  // overdraft disabled
  assert.equal((await request('/api/inventory/adjustments', { ...W, body: adjBody({ allowNegative: true }) })).status, 403);
  // multi-warehouse unsafe
  assert.equal((await request('/api/inventory/adjustments', { ...W, body: adjBody({ multiWarehouse: true }) })).status, 403);
  assert.equal((await request('/api/inventory/opening-stock', { ...W, body: openingBody({ multiWarehouse: true }) })).status, 403);
  // insufficient stock -> 409
  assert.equal((await request('/api/inventory/adjustments', { ...W, body: adjBody({ delta: -99999 }) })).status, 409);
});

test('idempotency at HTTP: same key retry does not double-post; returns replay', async () => {
  const key = `http-idem-${Date.now()}`;
  const W = { method: 'POST', cookie: ownerA.cookie, headers: biz(businessA) };
  const product = await Product.create({ businessId: businessA._id, brand: `idem-${Date.now()}`, cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1, status: 'active' });
  const pid = String(product._id);
  // opening (fresh product, no existing balance)
  let res = await request('/api/inventory/opening-stock', { ...W, body: openingBody({ productId: pid, idempotencyKey: `open-${key}`, quantities: { full: 2, empty: 2, damaged: 2, rejected: 2 } }) });
  assert.equal(res.status, 201);
  res = await request('/api/inventory/opening-stock', { ...W, body: openingBody({ productId: pid, idempotencyKey: `open-${key}`, quantities: { full: 2, empty: 2, damaged: 2, rejected: 2 } }) });
  assert.equal(res.status, 200); assert.equal((await res.json()).idempotentReplay, true);
  // adjustment
  res = await request('/api/inventory/adjustments', { ...W, body: adjBody({ productId: pid, idempotencyKey: key, delta: 3 }) });
  assert.equal(res.status, 201);
  res = await request('/api/inventory/adjustments', { ...W, body: adjBody({ productId: pid, idempotencyKey: key, delta: 3 }) });
  assert.equal(res.status, 200); assert.equal((await res.json()).idempotentReplay, true);
  assert.equal(await StockMovement.countDocuments({ businessId: businessA._id, idempotencyKey: key }), 1);
});

// ---------- getStock / reconciliation routes ----------
test('getStock + reconciliation routes return tenant stock; cross-business product not found', async () => {
  // productB is businessB
  let res = await request('/api/inventory/stock?productId=' + productB._id, { cookie: ownerA.cookie, headers: biz(businessA) });
  assert.equal(res.status, 404);
  res = await request('/api/inventory/reconciliation?productId=' + productB._id, { cookie: ownerA.cookie, headers: biz(businessA) });
  assert.equal(res.status, 404);
  // own product
  res = await request('/api/inventory/stock?productId=' + productA._id, { cookie: ownerA.cookie, headers: biz(businessA) });
  assert.equal(res.status, 200);
  const { stock } = await res.json();
  assert.ok('fullQty' in stock && 'emptyQty' in stock && 'damagedQty' in stock && 'rejectedQty' in stock);
  res = await request('/api/inventory/reconciliation?productId=' + productA._id, { cookie: ownerA.cookie, headers: biz(businessA) });
  assert.equal(res.status, 200);
  const { reconciliation } = await res.json();
  assert.ok('matches' in reconciliation && 'stored' in reconciliation && 'recomputed' in reconciliation);
});

// ---------- Warehouse API + restrictions ----------
test('warehouse API: default no setup; owned; cross-business 404; multi-warehouse rejected; no unsafe enable', async () => {
  const cookie = ownerA.cookie; const headers = biz(businessA);
  // default single warehouse no setup
  let res = await request('/api/warehouses/default', { cookie, headers });
  assert.equal(res.status, 200);
  let { warehouse, warehouseId, mode, multiWarehouse } = await res.json();
  assert.equal(warehouse, null); assert.equal(warehouseId, null); assert.equal(mode, 'single'); assert.equal(multiWarehouse, false);
  // list + get owned
  const wh = await Warehouse.create({ businessId: businessA._id, code: 'w1', name: 'W1', status: 'active' });
  res = await request('/api/warehouses', { cookie, headers });
  assert.ok((await res.json()).warehouses.some((w) => String(w._id) === String(wh._id)));
  res = await request('/api/warehouses/' + wh._id, { cookie, headers });
  assert.equal(res.status, 200);
  // cross-business -> not found
  const otherWh = await Warehouse.create({ businessId: businessB._id, code: 'wb', name: 'WB', status: 'active' });
  res = await request('/api/warehouses/' + otherWh._id, { cookie, headers });
  assert.equal(res.status, 404);
  // invalid id -> 404
  res = await request('/api/warehouses/not-an-id', { cookie, headers });
  assert.equal(res.status, 404);
  // staff can read warehouses
  res = await request('/api/warehouses', { cookie: staffA.cookie, headers });
  assert.equal(res.status, 200);
  // cannot enable multi-warehouse
  res = await request('/api/warehouses/config/multi-warehouse', { method: 'PATCH', cookie, headers, body: JSON.stringify({ multiWarehouse: true }) });
  assert.equal(res.status, 403); assert.equal((await res.json()).code, 'MULTI_WAREHOUSE_UNSAFE');
  // staff cannot call config
  res = await request('/api/warehouses/config/multi-warehouse', { method: 'PATCH', cookie: staffA.cookie, headers, body: JSON.stringify({ multiWarehouse: false }) });
  assert.equal(res.status, 403);
  // safe no-op false
  res = await request('/api/warehouses/config/multi-warehouse', { method: 'PATCH', cookie, headers, body: JSON.stringify({ multiWarehouse: false }) });
  assert.equal(res.status, 200);
  // warehouse-specific inventory rejected while multi-warehouse disabled
  res = await request('/api/inventory/adjustments', { method: 'POST', cookie, headers, body: adjBody({ warehouseId: String(wh._id) }) });
  assert.equal(res.status, 403); assert.equal((await res.json()).code, 'MULTI_WAREHOUSE_DISABLED');
});

// ---------- Refill compatibility ----------
test('refill compatibility: append-only ledger + atomic stock shape preserved; no refill alteration', async () => {
  // Stock 4 buckets + version; warehouseId null default; StockMovement append-only + optional fields preserved
  const businessId = businessA._id; const productId = productA._id;
  await Stock.updateOne({ businessId, productId, warehouseId: null }, { $setOnInsert: { emptyQty: 0, damagedQty: 0, rejectedQty: 0 }, $inc: { fullQty: 1 } }, { upsert: true });
  // refill-style insert (no warehouseId, no idempotencyKey, no source fields) still valid
  await StockMovement.create({ businessId, productId, movementType: 'refill_receipt', quantity: 1, stockBucket: 'full', direction: 'in', reference: 'refill:x:full', createdBy: ownerA.user._id });
  const stock = await Stock.findOne({ businessId, productId, warehouseId: null }).lean();
  assert.ok('fullQty' in stock && 'emptyQty' in stock && 'damagedQty' in stock && 'rejectedQty' in stock);
  assert.equal(stock.warehouseId, null);
  // append-only enforced
  const mv = await StockMovement.findOne({ businessId, productId, movementType: 'refill_receipt' }).lean();
  await assert.rejects(StockMovement.updateOne({ _id: mv._id }, { $set: { quantity: 99 } }), /append-only/);
  // reconciliation still reads legacy movements
  const res = await request('/api/inventory/reconciliation?productId=' + productA._id, { cookie: ownerA.cookie, headers: biz(businessA) });
  assert.equal(res.status, 200);
});

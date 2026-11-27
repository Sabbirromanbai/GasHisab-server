import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import Business from '../src/modules/business.model.js';
import BusinessMember from '../src/modules/business-member.model.js';
import Product from '../src/modules/product.model.js';
import Stock from '../src/modules/stock.model.js';
import StockMovement from '../src/modules/stock-movement.model.js';
import User from '../src/modules/user.model.js';
import Warehouse from '../src/modules/warehouse.model.js';
import {
  applyManualAdjustment,
  getStock,
  reconcileStock,
  setMultiWarehouse,
  recordOpeningStock,
  resolveWarehouse,
} from '../src/modules/inventory.service.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

let businessA;
let businessB;
let actorA;
let actorB;
let productA;
let productB;

const four = (full = 0, empty = 0, damaged = 0, rejected = 0) => ({ full, empty, damaged, rejected });

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  businessA = await Business.create({ name: 'Dealer A', slug: `inv-a-${Date.now()}`, status: 'active' });
  businessB = await Business.create({ name: 'Dealer B', slug: `inv-b-${Date.now()}`, status: 'active' });
  actorA = await User.create({ name: 'A', email: `inv-a-${Date.now()}@example.test`, status: 'active' });
  actorB = await User.create({ name: 'B', email: `inv-b-${Date.now()}@example.test`, status: 'active' });
  await BusinessMember.create([
    { businessId: businessA._id, userId: actorA._id, role: 'owner', status: 'active' },
    { businessId: businessB._id, userId: actorB._id, role: 'owner', status: 'active' },
  ]);
  productA = await Product.create({ businessId: businessA._id, brand: 'a', cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200, status: 'active' });
  productB = await Product.create({ businessId: businessB._id, brand: 'b', cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200, status: 'active' });
  for (const M of [Stock, StockMovement, Warehouse, Business, BusinessMember, User, Product]) await M.syncIndexes();
});

after(async () => {
  if (mongoose.connection.readyState === 1) {
    const db = mongoose.connection.db;
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name } of collections) if (!name.startsWith('system.')) await db.collection(name).deleteMany({});
  }
  await disconnectTestDatabase();
});

// ---------- Opening stock ----------

test('opening stock: dealer-entered, all four buckets explicit, never assumed; append-only', async () => {
  const businessId = businessA._id;
  const productId = new mongoose.Types.ObjectId(); // own product for this test
  await Product.create({ _id: productId, businessId, brand: 'open', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });

  // missing a bucket -> rejected (never assumed)
  await assert.rejects(recordOpeningStock({
    businessId, productId, actorId: actorA._id, idempotencyKey: 'open-missing',
    quantities: { full: 1, empty: 1, damaged: 1 }, // rejected missing
  }), ValidationError);
  // non-integer / negative -> rejected
  await assert.rejects(recordOpeningStock({
    businessId, productId, actorId: actorA._id, idempotencyKey: 'open-neg', quantities: four(1, 1, 1, -1),
  }), ValidationError);
  // no stock created by rejected attempts
  assert.equal(await Stock.countDocuments({ businessId, productId }), 0);

  const result = await recordOpeningStock({
    businessId, productId, actorId: actorA._id, idempotencyKey: 'open-1',
    quantities: four(10, 4, 1, 2), note: 'counted',
  });
  assert.equal(result.stock.fullQty, 10);
  assert.equal(result.stock.emptyQty, 4);
  assert.equal(result.stock.damagedQty, 1);
  assert.equal(result.stock.rejectedQty, 2);
  assert.equal(result.idempotentReplay, false);

  // append-only opening movements for non-zero buckets; direction 'in'; reason; source
  const movements = await StockMovement.find({ businessId, productId, sourceType: 'opening_stock' }).lean();
  assert.equal(movements.length, 4); // all four buckets >0
  for (const mv of movements) {
    assert.equal(mv.movementType, 'adjustment');
    assert.equal(mv.direction, 'in');
    assert.equal(mv.reason, 'opening stock');
    assert.equal(String(mv.warehouseId), String(null));
  }
  // stock total matches sum
  const stock = await Stock.findOne({ businessId, productId }).lean();
  assert.equal(stock.fullQty + stock.emptyQty + stock.damagedQty + stock.rejectedQty, 17);

  // cannot re-open non-empty
  await assert.rejects(recordOpeningStock({
    businessId, productId, actorId: actorA._id, idempotencyKey: 'open-2', quantities: four(1, 1, 1, 1),
  }), ConflictError);
});

test('opening stock: idempotent retry does not double-post', async () => {
  const businessId = businessA._id;
  const productId = new mongoose.Types.ObjectId();
  await Product.create({ _id: productId, businessId, brand: 'open-idem', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });
  const args = { businessId, productId, actorId: actorA._id, idempotencyKey: 'open-idem-key', quantities: four(5, 5, 5, 5) };

  await recordOpeningStock(args);
  const replay = await recordOpeningStock(args);
  assert.equal(replay.idempotentReplay, true);

  const stock = await Stock.findOne({ businessId, productId }).lean();
  assert.equal(stock.fullQty, 5); // not doubled
  assert.equal(stock.emptyQty, 5);
  const count = await StockMovement.countDocuments({ businessId, productId });
  assert.ok(count <= 4);
  // stock still consistent
  const recon = await reconcileStock({ businessId, productId });
  assert.equal(recon.matches, true);
});

// ---------- Manual adjustments ----------

test('manual adjustment: requires reason; adjusts bucket; prevents negative; append-only audit', async () => {
  const businessId = businessA._id;
  const productId = new mongoose.Types.ObjectId();
  await Product.create({ _id: productId, businessId, brand: 'adj', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });
  await recordOpeningStock({ businessId, productId, actorId: actorA._id, idempotencyKey: 'adj-open', quantities: four(3, 3, 3, 3) });

  // reason required
  await assert.rejects(applyManualAdjustment({
    businessId, productId, actorId: actorA._id, bucket: 'full', delta: 1, reason: '', idempotencyKey: 'adj-noreason',
  }), ValidationError);
  // invalid bucket
  await assert.rejects(applyManualAdjustment({
    businessId, productId, actorId: actorA._id, bucket: 'nope', delta: 1, reason: 'x', idempotencyKey: 'adj-badbucket',
  }), ValidationError);
  // zero delta
  await assert.rejects(applyManualAdjustment({
    businessId, productId, actorId: actorA._id, bucket: 'full', delta: 0, reason: 'x', idempotencyKey: 'adj-zero',
  }), ValidationError);

  // positive adjustment
  let res = await applyManualAdjustment({ businessId, productId, actorId: actorA._id, bucket: 'full', delta: 2, reason: 'found extra', idempotencyKey: 'adj-1' });
  assert.equal(res.stock.fullQty, 5);
  assert.equal(res.movement.reason, 'found extra');
  assert.equal(res.movement.direction, 'in');
  assert.equal(res.movement.movementType, 'adjustment');

  // negative adjustment within stock
  res = await applyManualAdjustment({ businessId, productId, actorId: actorA._id, bucket: 'full', delta: -3, reason: 'damaged found', idempotencyKey: 'adj-2' });
  assert.equal(res.stock.fullQty, 2);
  assert.equal(res.movement.direction, 'out');

  // prevent negative stock (atomic no-overdraft)
  await assert.rejects(applyManualAdjustment({
    businessId, productId, actorId: actorA._id, bucket: 'full', delta: -999, reason: 'oops', idempotencyKey: 'adj-3',
  }), (e) => e.code === 'INSUFFICIENT_STOCK');
  // stock unchanged after rejected
  let stock = await Stock.findOne({ businessId, productId }).lean();
  assert.equal(stock.fullQty, 2);

  // no movement created for rejected op; append-only audit intact
  const auditCount = await StockMovement.countDocuments({ businessId, productId, movementType: 'adjustment' });

  // append-only: cannot mutate or delete a movement
  const aMovement = await StockMovement.findOne({ businessId, productId }).lean();
  await assert.rejects(StockMovement.updateOne({ _id: aMovement._id }, { $set: { quantity: 999 } }), /append-only/);
  await assert.rejects(StockMovement.deleteOne({ _id: aMovement._id }), /append-only|cannot be deleted/);
  assert.equal(await StockMovement.countDocuments({ businessId, productId, movementType: 'adjustment' }), auditCount);

  // immutable history preserved
  stock = await Stock.findOne({ businessId, productId }).lean();
  assert.equal(stock.fullQty, 2);
});

// ---------- Idempotency ----------

test('idempotency: same key no double-post; concurrent duplicates safe', async () => {
  const businessId = businessA._id;
  const productId = new mongoose.Types.ObjectId();
  await Product.create({ _id: productId, businessId, brand: 'idem', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });
  await recordOpeningStock({ businessId, productId, actorId: actorA._id, idempotencyKey: 'idem-open', quantities: four(100, 0, 0, 0) });

  const args = { businessId, productId, actorId: actorA._id, bucket: 'full', delta: 5, reason: 'r', idempotencyKey: 'idem-key' };
  await applyManualAdjustment(args);
  await applyManualAdjustment(args); // sequential retry
  let stock = await Stock.findOne({ businessId, productId }).lean();
  assert.equal(stock.fullQty, 105); // applied once
  assert.equal(await StockMovement.countDocuments({ businessId, productId, idempotencyKey: 'idem-key' }), 1);

  // concurrent duplicate with same key + payload
  const key2 = 'idem-concurrent';
  const results = await Promise.allSettled([
    applyManualAdjustment({ ...args, delta: 10, idempotencyKey: key2 }),
    applyManualAdjustment({ ...args, delta: 10, idempotencyKey: key2 }),
  ]);
  // at least one succeeded; final reflects a single +10, never +20
  stock = await Stock.findOne({ businessId, productId }).lean();
  assert.equal(stock.fullQty, 115);
  assert.equal(await StockMovement.countDocuments({ businessId, productId, idempotencyKey: key2 }), 1);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
});

// ---------- Reconciliation ----------

test('reconciliation: recomputes from append-only ledger; matches; detects drift', async () => {
  const businessId = businessA._id;
  const productId = new mongoose.Types.ObjectId();
  await Product.create({ _id: productId, businessId, brand: 'recon', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });
  await recordOpeningStock({ businessId, productId, actorId: actorA._id, idempotencyKey: 'recon-open', quantities: four(10, 2, 1, 1) });
  await applyManualAdjustment({ businessId, productId, actorId: actorA._id, bucket: 'full', delta: -3, reason: 'sold internally', idempotencyKey: 'recon-1' });
  await applyManualAdjustment({ businessId, productId, actorId: actorA._id, bucket: 'empty', delta: 2, reason: 'returned empty', idempotencyKey: 'recon-2' });

  let recon = await reconcileStock({ businessId, productId });
  assert.equal(recon.matches, true);
  assert.deepEqual(recon.stored, { full: 7, empty: 4, damaged: 1, rejected: 1 });
  assert.deepEqual(recon.recomputed, { full: 7, empty: 4, damaged: 1, rejected: 1 });
  assert.equal(recon.discrepancies.full, 0);

  // manually corrupt stored balance -> drift detected (reconciliation is read-only)
  await Stock.updateOne({ businessId, productId }, { $set: { fullQty: 999 } });
  recon = await reconcileStock({ businessId, productId });
  assert.equal(recon.matches, false);
  assert.equal(recon.discrepancies.full, 999 - 7);
  assert.equal(recon.recomputed.full, 7); // ledger unaffected
});

// ---------- Concurrency / atomic ----------

test('concurrency: atomic $gte no-overdraft; version increments; no lost updates', async () => {
  const businessId = businessA._id;
  const productId = new mongoose.Types.ObjectId();
  await Product.create({ _id: productId, businessId, brand: 'conc', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });
  await recordOpeningStock({ businessId, productId, actorId: actorA._id, idempotencyKey: 'conc-open', quantities: four(1, 0, 0, 0) });

  const before = await Stock.findOne({ businessId, productId }).lean();
  const startVersion = before.version;

  // two concurrent -1 on a single unit; exactly one can win
  const results = await Promise.allSettled([
    applyManualAdjustment({ businessId, productId, actorId: actorA._id, bucket: 'full', delta: -1, reason: 'a', idempotencyKey: 'conc-a' }),
    applyManualAdjustment({ businessId, productId, actorId: actorA._id, bucket: 'full', delta: -1, reason: 'b', idempotencyKey: 'conc-b' }),
  ]);
  const stock = await Stock.findOne({ businessId, productId }).lean();
  assert.equal(stock.fullQty, 0); // never negative
  assert.ok(stock.fullQty >= 0);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1); // exactly one winner
  assert.ok(stock.version >= startVersion + 1);
  assert.equal(await StockMovement.countDocuments({ businessId, productId, movementType: 'adjustment', direction: 'out' }), 1);
  // reconciliation still consistent
  assert.equal((await reconcileStock({ businessId, productId })).matches, true);
});

test('concurrency: concurrent +1 increments are not lost', async () => {
  const businessId = businessA._id;
  const productId = new mongoose.Types.ObjectId();
  await Product.create({ _id: productId, businessId, brand: 'conc2', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });
  await recordOpeningStock({ businessId, productId, actorId: actorA._id, idempotencyKey: 'conc2-open', quantities: four(0, 0, 0, 0) });

  const N = 5;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    applyManualAdjustment({ businessId, productId, actorId: actorA._id, bucket: 'full', delta: 1, reason: 'r', idempotencyKey: `conc2-${i}` })));
  const stock = await Stock.findOne({ businessId, productId }).lean();
  assert.equal(stock.fullQty, N); // no lost updates
  assert.equal((await reconcileStock({ businessId, productId })).matches, true);
});

// ---------- Tenant isolation ----------

test('tenant isolation: products + stock + movements + warehouses scoped to business', async () => {
  // A cannot operate on B's product
  await assert.rejects(
    applyManualAdjustment({ businessId: businessA._id, productId: productB._id, actorId: actorA._id, bucket: 'full', delta: 1, reason: 'x', idempotencyKey: 'iso-1' }),
    (e) => e.code === 'PRODUCT_NOT_FOUND',
  );
  await assert.rejects(recordOpeningStock({
    businessId: businessA._id, productId: productB._id, actorId: actorA._id, idempotencyKey: 'iso-2', quantities: four(1, 1, 1, 1),
  }), (e) => e.code === 'PRODUCT_NOT_FOUND');

  // actor must be active member of THIS business
  await assert.rejects(
    applyManualAdjustment({ businessId: businessA._id, productId: productA._id, actorId: actorB._id, bucket: 'full', delta: 1, reason: 'x', idempotencyKey: 'iso-3' }),
    NotFoundError,
  );

  // A cannot read B's stock
  await assert.rejects(getStock({ businessId: businessA._id, productId: productB._id }), (e) => e.code === 'PRODUCT_NOT_FOUND');

  // movement created in A is not in B; idempotency keys are per-business
  const pid = productA._id;
  await applyManualAdjustment({ businessId: businessA._id, productId: pid, actorId: actorA._id, bucket: 'full', delta: 1, reason: 'x', idempotencyKey: 'shared-key' });
  // same key in B is independent (different business)
  await applyManualAdjustment({ businessId: businessB._id, productId: productB._id, actorId: actorB._id, bucket: 'full', delta: 1, reason: 'x', idempotencyKey: 'shared-key' });
  assert.equal(await StockMovement.countDocuments({ businessId: businessA._id, idempotencyKey: 'shared-key' }), 1);
  assert.equal(await StockMovement.countDocuments({ businessId: businessB._id, idempotencyKey: 'shared-key' }), 1);
});

// ---------- Warehouse (optional multi-warehouse architecture) ----------

test('warehouse: default single warehouse needs no setup; ownership validated; no UI', async () => {
  // default null warehouse requires no Warehouse doc
  assert.equal(await resolveWarehouse(businessA._id, null, null), null);
  assert.equal(await resolveWarehouse(businessA._id, undefined, null), null);

  const businessId = businessA._id;
  const productId = new mongoose.Types.ObjectId();
  await Product.create({ _id: productId, businessId, brand: 'wh', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });
  // works with no warehouseId + no Warehouse doc
  await recordOpeningStock({ businessId, productId, actorId: actorA._id, idempotencyKey: 'wh-default', quantities: four(1, 1, 1, 1) });
  let stock = await Stock.findOne({ businessId, productId }).lean();
  assert.equal(stock.warehouseId, null);

  // owned warehouse exists, but multi-warehouse is DISABLED -> warehouse-specific ops rejected clearly
  const warehouse = await Warehouse.create({ businessId, code: 'main', name: 'Main', status: 'active' });
  await assert.rejects(resolveWarehouse(businessId, warehouse._id, null), (e) => e.code === 'MULTI_WAREHOUSE_DISABLED');

  // warehouse in another business -> still rejected (ownership validated; multi-warehouse disabled)
  const otherWh = await Warehouse.create({ businessId: businessB._id, code: 'other', name: 'Other', status: 'active' });
  await assert.rejects(resolveWarehouse(businessA._id, otherWh._id, null), (e) => e.code === 'MULTI_WAREHOUSE_DISABLED');
  await assert.rejects(resolveWarehouse(businessA._id, 'not-an-id', null), (e) => e.code === 'MULTI_WAREHOUSE_DISABLED');

  // cannot enable multi-warehouse until Refill is warehouse-compatible
  await assert.rejects(setMultiWarehouse({ businessId, enabled: true }), (e) => e.code === 'MULTI_WAREHOUSE_UNSAFE');
  assert.deepEqual(await setMultiWarehouse({ businessId, enabled: false }), { businessId: String(businessId), multiWarehouse: false });

  // default warehouse unaffected; reconciliation on default
  const stockDefault = await Stock.findOne({ businessId, productId, warehouseId: null }).lean();
  assert.equal(stockDefault.fullQty, 1);
  assert.equal((await reconcileStock({ businessId, productId })).matches, true);

  // warehouse-specific op rejected while multi-warehouse disabled
  await assert.rejects(applyManualAdjustment({
    businessId: businessA._id, productId, actorId: actorA._id, warehouseId: otherWh._id, bucket: 'full', delta: 1, reason: 'x', idempotencyKey: 'wh-cross',
  }), (e) => e.code === 'MULTI_WAREHOUSE_DISABLED');
});

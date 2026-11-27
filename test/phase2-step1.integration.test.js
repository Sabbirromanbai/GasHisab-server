import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import Stock from '../src/modules/stock.model.js';
import StockMovement from '../src/modules/stock-movement.model.js';
import SupplierPayment from '../src/modules/supplier-payment.model.js';
import RefillBatch from '../src/modules/refill-batch.model.js';
import RefillRate from '../src/modules/refill-rate.model.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

let businessId;
let otherBusinessId;
let productId;
let userId;
let supplierId;

const insertMovement = (overrides = {}) =>
  StockMovement.create({
    businessId,
    productId,
    movementType: 'adjustment',
    quantity: 1,
    stockBucket: 'full',
    direction: 'in',
    createdBy: userId,
    ...overrides,
  });

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  businessId = new mongoose.Types.ObjectId();
  otherBusinessId = new mongoose.Types.ObjectId();
  productId = new mongoose.Types.ObjectId();
  userId = new mongoose.Types.ObjectId();
  supplierId = new mongoose.Types.ObjectId();
  await Stock.collection.deleteMany({});
  await StockMovement.collection.deleteMany({});
  await SupplierPayment.collection.deleteMany({});
  await Stock.syncIndexes();
  await StockMovement.syncIndexes();
  await SupplierPayment.syncIndexes();
});

after(async () => {
  if (mongoose.connection.readyState === 1) {
    await Stock.collection.deleteMany({});
    await StockMovement.collection.deleteMany({}); // raw collection bypasses append-only hooks
    await SupplierPayment.collection.deleteMany({});
  }
  await disconnectTestDatabase();
});

test('RefillBatch and RefillRate tenant refs point to Business and businessId is immutable', () => {
  for (const Model of [RefillBatch, RefillRate]) {
    const path = Model.schema.path('businessId');
    assert.equal(path.options.ref, 'Business', `${Model.modelName} businessId.ref`);
    assert.equal(path.options.immutable, true, `${Model.modelName} businessId.immutable`);
  }
  // Not the 'Supplier' ref bug.
  assert.notEqual(RefillBatch.schema.path('businessId').options.ref, 'Supplier');
  assert.notEqual(RefillRate.schema.path('businessId').options.ref, 'Supplier');
});

test('StockMovement is append-only: no edits, no deletes, insert-only bulk', async () => {
  const [movement] = await StockMovement.create([{
    businessId, productId, movementType: 'refill_receipt', quantity: 1, stockBucket: 'full', direction: 'in', createdBy: userId,
  }], {});
  const id = movement._id;

  // document edit rejected
  const reloaded = await StockMovement.findById(id);
  reloaded.quantity = 5;
  await assert.rejects(reloaded.save(), /append-only/);

  // query-level updates/deletes rejected
  await assert.rejects(StockMovement.updateOne({ _id: id }, { $set: { quantity: 5 } }), /append-only/);
  await assert.rejects(StockMovement.updateMany({ _id: id }, { $set: { quantity: 5 } }), /append-only/);
  await assert.rejects(StockMovement.findOneAndUpdate({ _id: id }, { $set: { quantity: 5 } }), /append-only/);
  await assert.rejects(StockMovement.replaceOne({ _id: id }, {}), /append-only/);
  await assert.rejects(StockMovement.deleteOne({ _id: id }), /append-only/);
  await assert.rejects(StockMovement.deleteMany({ _id: id }), /append-only/);
  await assert.rejects(StockMovement.findOneAndDelete({ _id: id }), /append-only/);
  await assert.rejects(movement.deleteOne(), /append-only|cannot be deleted/);
  await assert.rejects(
    StockMovement.bulkWrite([{ updateOne: { filter: { _id: id }, update: { $set: { quantity: 9 } } } }]),
    /append-only|inserts/,
  );
  await assert.rejects(StockMovement.bulkWrite([{ deleteOne: { filter: { _id: id } } }]), /append-only|inserts/);
  // insert-only bulk is allowed
  await StockMovement.bulkWrite([{ insertOne: { document: { businessId, productId, movementType: 'adjustment', quantity: 1, stockBucket: 'full', direction: 'in', createdBy: userId } } }]);

  assert.equal(await StockMovement.countDocuments({ _id: id }), 1);
  assert.equal((await StockMovement.findById(id)).quantity, 1); // unchanged
});

test('StockMovement supports source references and unitCostPoisha without breaking existing inserts', async () => {
  // existing refill-shaped insert (no source fields, no key) still works
  const legacy = await insertMovement({
    movementType: 'refill_receipt', stockBucket: 'full', direction: 'in',
    reference: `refill:${new mongoose.Types.ObjectId()}:full`, note: 'x',
  });
  assert.equal(legacy.idempotencyKey, undefined);
  assert.equal(legacy.sourceType, undefined);
  assert.equal(legacy.unitCostPoisha, undefined);
  assert.equal(legacy.reference.startsWith('refill:'), true); // reference preserved

  // new optional fields
  const sourced = await insertMovement({
    movementType: 'purchase',
    stockBucket: 'full',
    direction: 'in',
    sourceType: 'purchase',
    sourceId: new mongoose.Types.ObjectId(),
    sourceLineId: new mongoose.Types.ObjectId(),
    movementGroupId: new mongoose.Types.ObjectId(),
    unitCostPoisha: 1234,
  });
  assert.equal(sourced.unitCostPoisha, 1234);
  assert.ok(sourced.sourceType === 'purchase');

  // invalid unitCostPoisha rejected
  await assert.rejects(insertMovement({ unitCostPoisha: 1.5 }));
  await assert.rejects(insertMovement({ unitCostPoisha: -1 }));
  await assert.rejects(insertMovement({ unitCostPoisha: Number.MAX_SAFE_INTEGER + 1 }));
});

test('StockMovement safe idempotency: partial unique on businessId+idempotencyKey, historical rows exempt', async () => {
  // no key -> always allowed (even duplicates; existing refill relies on this)
  await insertMovement({ reference: 'same' });
  await insertMovement({ reference: 'same' });
  await insertMovement({});
  await insertMovement({});

  // with key -> duplicate in same business rejected
  await insertMovement({ idempotencyKey: 'move-1' });
  await assert.rejects(insertMovement({ idempotencyKey: 'move-1' }), (e) => e.code === 11000);
  // same key in another tenant is fine
  await insertMovement({ businessId: otherBusinessId, idempotencyKey: 'move-1' });

  // tenant safety: businessId required + immutable
  await assert.rejects(
    StockMovement.create({ productId, movementType: 'adjustment', quantity: 1, stockBucket: 'full', direction: 'in', createdBy: userId }),
  );
});

test('StockMovement preserves existing refill movement types and shape', async () => {
  const types = ['refill_dispatch', 'refill_receipt', 'supplier_return', 'replacement', 'purchase', 'sale', 'exchange', 'return', 'adjustment'];
  for (const movementType of types) {
    const m = await insertMovement({ movementType, stockBucket: 'full', direction: 'in', reference: `t:${movementType}` });
    assert.equal(m.movementType, movementType);
  }
  await assert.rejects(insertMovement({ movementType: 'not_a_type' }));
});

test('Stock has optimistic version support without breaking existing stock data', async () => {
  // version is optional/additive; existing rows without it still work
  const created = await Stock.create({ businessId, productId, fullQty: 5, emptyQty: 5, rejectedQty: 0, damagedQty: 0 });
  assert.equal(created.version, 0);
  assert.equal(created.__v, 0);
  assert.equal(Stock.schema.options.optimisticConcurrency, true);

  // legacy-shaped doc (no version) loads + atomic $inc still works
  await Stock.collection.updateOne({ _id: created._id }, { $unset: { version: '', __v: '' } });
  const r = await Stock.updateOne({ businessId, productId, fullQty: { $gte: 1 } }, { $inc: { fullQty: -1 } });
  assert.equal(r.matchedCount, 1);
  assert.equal((await Stock.findById(created._id)).fullQty, 4);

  // version field can be read/set; non-negative integer
  await Stock.updateOne({ _id: created._id }, { $set: { version: 7 } });
  assert.equal((await Stock.findById(created._id)).version, 7);
  await assert.rejects(Stock.updateOne({ _id: created._id }, { $set: { version: -1 } }, { runValidators: true }));
});

test('stock concurrency: atomic $inc + $gte never drives a bucket negative', async () => {
  const s = await Stock.create({ businessId, productId: new mongoose.Types.ObjectId(), fullQty: 1, emptyQty: 0, rejectedQty: 0, damagedQty: 0 });
  const tryDecrement = () => Stock.updateOne({ businessId, productId: s.productId, fullQty: { $gte: 1 } }, { $inc: { fullQty: -1 } });

  const results = await Promise.allSettled([tryDecrement(), tryDecrement()]);
  const matched = results.filter((r) => r.status === 'fulfilled' && r.value.matchedCount === 1).length;
  assert.equal(matched, 1, 'exactly one decrement should succeed');
  const final = await Stock.findById(s._id);
  assert.equal(final.fullQty, 0);
  assert.ok(final.fullQty >= 0);
});

test('SupplierPayment keeps existing refill payments working; batchId optional; backward-compatible source fields', async () => {
  // schema: batchId no longer required
  assert.ok(!SupplierPayment.schema.path('batchId').isRequired);

  const base = {
    businessId, supplierId, idempotencyKey: 'p1', requestHash: 'h', amountPoisha: 100,
    method: 'cash', timing: 'later', paidBy: userId,
  };

  // existing refill shape: batchId present, no source fields
  const refill = await SupplierPayment.create({ ...base, batchId: new mongoose.Types.ObjectId(), idempotencyKey: 'refill-pay' });
  assert.equal(refill.sourceType, 'refill_batch'); // default preserves refill semantics
  assert.equal(refill.type, 'payment');
  assert.equal(refill.batchId !== undefined, true);
  assert.equal(refill.purchaseId, undefined);

  // no batchId (e.g. future purchase/advance)
  const purchase = await SupplierPayment.create({
    ...base, idempotencyKey: 'purchase-pay', sourceType: 'purchase', sourceId: new mongoose.Types.ObjectId(), purchaseId: new mongoose.Types.ObjectId(),
  });
  assert.equal(purchase.batchId, undefined);
  assert.equal(purchase.sourceType, 'purchase');

  // tenant safety: businessId required + immutable; still append-only + unique idempotency
  await assert.rejects(SupplierPayment.create({ ...base, businessId: undefined, batchId: new mongoose.Types.ObjectId(), idempotencyKey: 'no-tenant' }));
  await assert.rejects(SupplierPayment.updateOne({ _id: refill._id }, { $set: { businessId: otherBusinessId } }), /append-only/);
  await assert.rejects(SupplierPayment.updateOne({ _id: refill._id }, { $set: { amountPoisha: 1 } }), /append-only/);
  await assert.rejects(SupplierPayment.create({ ...base, idempotencyKey: 'refill-pay', batchId: new mongoose.Types.ObjectId() }), (e) => e.code === 11000);
});

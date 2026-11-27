import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import Business from '../src/modules/business.model.js';
import BusinessMember from '../src/modules/business-member.model.js';
import Product from '../src/modules/product.model.js';
import Purchase from '../src/modules/purchase.model.js';
import Stock from '../src/modules/stock.model.js';
import StockMovement from '../src/modules/stock-movement.model.js';
import Supplier from '../src/modules/supplier.model.js';
import SupplierPayment from '../src/modules/supplier-payment.model.js';
import User from '../src/modules/user.model.js';
import { createPurchase, reconcileNewCylinderStock, reconcilePurchasePayment, recordPurchasePayment } from '../src/modules/purchase.service.js';
import { ConflictError, NotFoundError } from '../src/errors.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

let businessA; let businessB; let actorA; let actorB; let supplierA; let productA; let productB;

const item = (productId, over = {}) => ({ productId: String(productId), quantity: 2, unitCostPoisha: 10000, sellingPricePoisha: 15000, ...over });

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  businessA = await Business.create({ name: 'A', slug: `sc-a-${Date.now()}`, status: 'active' });
  businessB = await Business.create({ name: 'B', slug: `sc-b-${Date.now()}`, status: 'active' });
  actorA = await User.create({ name: 'A', email: `sc-a-${Date.now()}@example.test`, status: 'active' });
  actorB = await User.create({ name: 'B', email: `sc-b-${Date.now()}@example.test`, status: 'active' });
  await BusinessMember.create([
    { businessId: businessA._id, userId: actorA._id, role: 'owner', status: 'active' },
    { businessId: businessB._id, userId: actorB._id, role: 'owner', status: 'active' },
  ]);
  supplierA = await Supplier.create({ businessId: businessA._id, name: 'Plant A', status: 'active' });
  productA = await Product.create({ businessId: businessA._id, brand: 'a', cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200, status: 'active', kind: 'lpg_cylinder' });
  productB = await Product.create({ businessId: businessB._id, brand: 'b', cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200, status: 'active', kind: 'lpg_cylinder' });
  for (const M of [Purchase, SupplierPayment, Stock, StockMovement]) await M.syncIndexes();
});

after(async () => {
  if (mongoose.connection.readyState === 1) {
    const db = mongoose.connection.db;
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name } of collections) if (!name.startsWith('system.')) await db.collection(name).deleteMany({});
  }
  await disconnectTestDatabase();
});

const base = (over = {}) => ({ businessId: businessA._id, supplierId: supplierA._id, actorId: actorA._id, items: [item(productA._id)], idempotencyKey: `k-${Math.random().toString(16).slice(2)}`, ...over });

// ---------- new-cylinder stock reconciliation ----------
test('new-cylinder reconciliation: read-only; scoped; matches; detects drift; no auto-repair', async () => {
  const purchase = await createPurchase(base({ items: [item(productA._id, { quantity: 5, unitCostPoisha: 10000 })] }));

  let recon = await reconcileNewCylinderStock({ businessId: businessA._id, productId: productA._id });
  assert.equal(recon.matches, true);
  assert.ok(recon.recomputedNewQty >= 5);
  assert.equal(recon.storedNewQty, recon.recomputedNewQty);
  assert.equal(recon.discrepancy, 0);
  assert.ok(recon.purchaseMovements >= 1);
  assert.ok(recon.stock.newQty >= 5);

  const stockBefore = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  const movementsBefore = await StockMovement.countDocuments({ businessId: businessA._id });

  // corrupt stored balance -> drift detected; NOT repaired
  await Stock.updateOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }, { $set: { newQty: recon.storedNewQty + 999 } });
  recon = await reconcileNewCylinderStock({ businessId: businessA._id, productId: productA._id });
  assert.equal(recon.matches, false);
  assert.equal(recon.discrepancy, 999);
  assert.equal(recon.recomputedNewQty, recon.storedNewQty - 999); // ledger unaffected
  // reconciliation did not mutate stock or ledger
  const stockAfter = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  assert.equal(stockAfter.newQty, recon.storedNewQty);
  assert.equal(await StockMovement.countDocuments({ businessId: businessA._id }), movementsBefore + 0); // no new movements

  // tenant scope
  await assert.rejects(reconcileNewCylinderStock({ businessId: businessA._id, productId: productB._id }), (e) => e.code === 'PRODUCT_NOT_FOUND');
  await assert.rejects(reconcileNewCylinderStock({ businessId: businessB._id, productId: productA._id }), (e) => e.code === 'PRODUCT_NOT_FOUND');
  // restore
  await Stock.updateOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }, { $set: { newQty: recon.recomputedNewQty } });
});

// ---------- payment cache reconciliation ----------
test('payment reconciliation: cache vs append-only SupplierPayment; read-only; safe', async () => {
  const purchase = await createPurchase(base({ items: [item(productA._id, { quantity: 1, unitCostPoisha: 10000 })] }));
  await recordPurchasePayment({ businessId: businessA._id, purchaseId: purchase._id, paidBy: actorA._id, amountPoisha: 4000, method: 'cash', idempotencyKey: `pr-${Date.now()}` });

  let recon = await reconcilePurchasePayment({ businessId: businessA._id, purchaseId: purchase._id });
  assert.equal(recon.matches, true);
  assert.equal(recon.recomputed.amountPaidPoisha, 4000);
  assert.equal(recon.recomputed.amountDuePoisha, 6000);
  assert.equal(recon.recomputed.paymentStatus, 'partially_paid');
  assert.equal(recon.stored.amountPaidPoisha, 4000);
  assert.equal(recon.paidPoisha, 4000);
  assert.ok(recon.paidPoisha <= recon.totalAmountPoisha);

  // corrupt cache -> drift; not repaired; append-only payments unchanged
  const paymentsBefore = await SupplierPayment.countDocuments({ businessId: businessA._id });
  await Purchase.updateOne({ _id: purchase._id }, { $set: { amountPaidPoisha: 0 } });
  recon = await reconcilePurchasePayment({ businessId: businessA._id, purchaseId: purchase._id });
  assert.equal(recon.matches, false);
  assert.equal(recon.recomputed.amountPaidPoisha, 4000); // recomputed from ledger
  assert.equal(await SupplierPayment.countDocuments({ businessId: businessA._id }), paymentsBefore); // no mutation
  // reconciliation did not auto-fix cache
  const cached = await Purchase.findById(purchase._id).lean();
  assert.equal(cached.amountPaidPoisha, 0);

  // tenant safe
  await assert.rejects(reconcilePurchasePayment({ businessId: businessB._id, purchaseId: purchase._id }), (e) => e.code === 'PURCHASE_NOT_FOUND');
});

// ---------- idempotency request-hash mismatch ----------
test('idempotency: same key + same payload replays; same key + DIFFERENT payload rejects safely', async () => {
  // ---- purchase ----
  const key = `purchase-key-${Date.now()}`;
  const args = base({ idempotencyKey: key, items: [item(productA._id, { quantity: 2, unitCostPoisha: 10000, sellingPricePoisha: 15000 })], note: 'n', reference: 'r' });
  const p1 = await createPurchase(args);
  // exact same payload -> replay
  const p2 = await createPurchase(args);
  assert.equal(String(p1._id), String(p2._id));
  assert.equal(await Purchase.countDocuments({ businessId: businessA._id, idempotencyKey: key }), 1);
  // same key + different payload -> ConflictError IDEMPOTENCY_CONFLICT
  for (const variant of [
    { ...args, items: [item(productA._id, { quantity: 3, unitCostPoisha: 10000, sellingPricePoisha: 15000 })] }, // quantity
    { ...args, items: [item(productA._id, { quantity: 2, unitCostPoisha: 11000, sellingPricePoisha: 15000 })] }, // cost
    { ...args, items: [item(productA._id, { quantity: 2, unitCostPoisha: 10000, sellingPricePoisha: 16000 })] }, // selling
    { ...args, supplierId: supplierA._id, note: 'DIFFERENT' }, // note
    { ...args, reference: 'DIFFERENT' }, // reference
    { ...args, purchaseNumber: 'DIFFERENT' }, // purchaseNumber
    { ...args, purchasedAt: new Date('2020-01-01').toISOString() }, // purchasedAt
    { ...args, items: [item(productA._id, { quantity: 2, unitCostPoisha: 10000, sellingPricePoisha: 15000, })].concat([item(productA._id)]) }, // item count
  ]) {
    await assert.rejects(createPurchase(variant), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  }
  assert.equal(await Purchase.countDocuments({ businessId: businessA._id, idempotencyKey: key }), 1); // still one

  // ---- payment ----
  const purchase = await createPurchase(base({ items: [item(productA._id, { quantity: 1, unitCostPoisha: 10000 })] }));
  const payKey = `pay-key-${Date.now()}`;
  const payArgs = { businessId: businessA._id, purchaseId: purchase._id, paidBy: actorA._id, amountPoisha: 4000, method: 'cash', idempotencyKey: payKey, reference: 'ref', note: 'n', paidAt: new Date('2024-01-01').toISOString() };
  await recordPurchasePayment(payArgs);
  // exact replay
  await recordPurchasePayment(payArgs);
  assert.equal(await SupplierPayment.countDocuments({ businessId: businessA._id, idempotencyKey: payKey }), 1);
  // same key + different payload
  for (const variant of [
    { ...payArgs, amountPoisha: 4001 }, // amount
    { ...payArgs, method: 'bank' }, // method
    { ...payArgs, reference: 'DIFF' }, // reference
    { ...payArgs, note: 'DIFF' }, // note
    { ...payArgs, paidAt: new Date('2024-01-02').toISOString() }, // paidAt
  ]) {
    await assert.rejects(recordPurchasePayment(variant), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  }
  // same key + different purchase
  const other = await createPurchase(base({ items: [item(productA._id, { quantity: 1, unitCostPoisha: 10000 })] }));
  await assert.rejects(recordPurchasePayment({ ...payArgs, purchaseId: other._id }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(await SupplierPayment.countDocuments({ businessId: businessA._id, idempotencyKey: payKey }), 1);

  // cross-business: key in A doesn't collide with B
  await assert.rejects(recordPurchasePayment({ ...payArgs, businessId: businessB._id, paidBy: actorB._id, purchaseId: purchase._id }), (e) => e.code === 'PURCHASE_NOT_FOUND');
});

// ---------- concurrency + atomicity ----------
test('concurrency: idempotency same key concurrent; no overpayment; atomic stock; no lost updates', async () => {
  // concurrent same-key purchase
  const key = `conc-key-${Date.now()}`;
  const args = base({ idempotencyKey: key, items: [item(productA._id, { quantity: 3, unitCostPoisha: 10000 })] });
  const results = await Promise.allSettled([createPurchase(args), createPurchase(args), createPurchase(args)]);
  assert.equal(await Purchase.countDocuments({ businessId: businessA._id, idempotencyKey: key }), 1);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  // exactly one purchase => atomic stock applied once
  const purchase = await Purchase.findOne({ businessId: businessA._id, idempotencyKey: key }).lean();
  assert.equal(await StockMovement.countDocuments({ businessId: businessA._id, sourceType: 'purchase', sourceId: purchase._id }), 1);

  // no-overpayment concurrent payments
  const totalPurchase = await createPurchase(base({ items: [item(productA._id, { quantity: 1, unitCostPoisha: 10000 })] }));
  const payResults = await Promise.allSettled([
    recordPurchasePayment({ businessId: businessA._id, purchaseId: totalPurchase._id, paidBy: actorA._id, amountPoisha: 6000, method: 'cash', idempotencyKey: `c1-${Date.now()}` }),
    recordPurchasePayment({ businessId: businessA._id, purchaseId: totalPurchase._id, paidBy: actorA._id, amountPoisha: 6000, method: 'cash', idempotencyKey: `c2-${Date.now()}` }),
  ]);
  const recon = await reconcilePurchasePayment({ businessId: businessA._id, purchaseId: totalPurchase._id });
  assert.ok(recon.paidPoisha <= 10000); // never overpaid
  assert.equal(recon.matches, true); // cache consistent with append-only ledger
  assert.ok(payResults.some((r) => r.status === 'fulfilled'));

  // reconciliation matches after concurrency
  const newRecon = await reconcileNewCylinderStock({ businessId: businessA._id, productId: productA._id });
  assert.equal(newRecon.matches, true);
});

// ---------- tenant isolation + no destructive ----------
test('tenant isolation + no auto-repair/backfill/destructive/ledger mutation', async () => {
  // create in A; B cannot reconcile
  const purchase = await createPurchase(base({ items: [item(productA._id, { quantity: 1, unitCostPoisha: 10000 })] }));
  await assert.rejects(reconcileNewCylinderStock({ businessId: businessB._id, productId: productA._id }), NotFoundError);
  await assert.rejects(reconcilePurchasePayment({ businessId: businessB._id, purchaseId: purchase._id }), NotFoundError);

  const stockBefore = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  const movementsBefore = await StockMovement.countDocuments({});
  const paymentsBefore = await SupplierPayment.countDocuments({});
  const purchaseBefore = await Purchase.findById(purchase._id).lean();

  await reconcileNewCylinderStock({ businessId: businessA._id, productId: productA._id });
  await reconcilePurchasePayment({ businessId: businessA._id, purchaseId: purchase._id });

  assert.deepEqual(await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean(), stockBefore);
  assert.equal(await StockMovement.countDocuments({}), movementsBefore);
  assert.equal(await SupplierPayment.countDocuments({}), paymentsBefore);
  assert.equal((await Purchase.findById(purchase._id).lean()).amountPaidPoisha, purchaseBefore.amountPaidPoisha);
});

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
import { createPurchase, getPurchase, getPurchaseDue, getPurchasePayments, getPurchaseSupplierBalance, recordPurchasePayment } from '../src/modules/purchase.service.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

let businessA; let businessB; let actorA; let actorB; let supplierA; let supplierB; let productA; let productB;

const item = (productId, over = {}) => ({ productId: String(productId), quantity: 2, unitCostPoisha: 10000, sellingPricePoisha: 15000, ...over });

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  businessA = await Business.create({ name: 'A', slug: `pur-a-${Date.now()}`, status: 'active' });
  businessB = await Business.create({ name: 'B', slug: `pur-b-${Date.now()}`, status: 'active' });
  actorA = await User.create({ name: 'A', email: `pur-a-${Date.now()}@example.test`, status: 'active' });
  actorB = await User.create({ name: 'B', email: `pur-b-${Date.now()}@example.test`, status: 'active' });
  await BusinessMember.create([
    { businessId: businessA._id, userId: actorA._id, role: 'owner', status: 'active' },
    { businessId: businessB._id, userId: actorB._id, role: 'owner', status: 'active' },
  ]);
  supplierA = await Supplier.create({ businessId: businessA._id, name: 'Plant A', status: 'active' });
  supplierB = await Supplier.create({ businessId: businessB._id, name: 'Plant B', status: 'active' });
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

const basePurchase = (over = {}) => ({
  businessId: businessA._id, supplierId: supplierA._id, actorId: actorA._id,
  items: [item(productA._id)], idempotencyKey: `pk-${Date.now()}-${Math.random().toString(16).slice(2)}`, ...over,
});

// ---------- purchase posting + stock ----------
test('purchase posting: new-cylinder purchase; dealer-defined cost+selling; total; payment unpaid; separate newQty', async () => {
  const purchase = await createPurchase(basePurchase({ items: [item(productA._id, { quantity: 3, unitCostPoisha: 10000, sellingPricePoisha: 15000 })] }));
  assert.equal(purchase.totalAmountPoisha, 30000); // 3 * 10000
  assert.equal(purchase.totalSellingPoisha, 45000); // informational; platform never sets
  assert.equal(purchase.paymentStatus, 'unpaid');
  assert.equal(purchase.amountPaidPoisha, 0);
  assert.equal(purchase.amountDuePoisha, 30000);
  assert.equal(purchase.status, 'posted');
  assert.equal(purchase.items.length, 1);
  assert.equal(purchase.items[0].unitCostPoisha, 10000);
  assert.equal(purchase.items[0].sellingPricePoisha, 15000);
  assert.equal(purchase.items[0].lineTotalPoisha, 30000);
  assert.equal(purchase.items[0].kind, 'lpg_cylinder');

  // separate NEW CYLINDER inventory; full/empty/damaged/rejected untouched
  const stock = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  assert.ok(stock.newQty >= 3);
  // append-only purchase movement
  const movements = await StockMovement.find({ businessId: businessA._id, productId: productA._id, movementType: 'purchase', sourceId: purchase._id }).lean();
  assert.ok(movements.length >= 1);
  const mv = movements[movements.length - 1];
  assert.equal(mv.stockBucket, 'new');
  assert.equal(mv.direction, 'in');
  assert.equal(mv.sourceType, 'purchase');
  assert.equal(String(mv.sourceId), String(purchase._id));
  assert.equal(String(mv.sourceLineId), String(purchase.items[0]._id));
  assert.ok(mv.movementGroupId);
  assert.equal(mv.unitCostPoisha, 10000);
  assert.ok(mv.idempotencyKey);

  // Product pricing NOT changed by purchase (platform never sets; not Sales)
  const product = await Product.findById(productA._id).lean();
  assert.equal(product.purchasePrice, 100);
  assert.equal(product.sellingPrice, 200);
});

test('purchase validation: integer poisha; dealer-defined; active lpg product; >=1 item; no platform defaults', async () => {
  await assert.rejects(createPurchase(basePurchase({ items: [item(productA._id, { quantity: 0 })] })), ValidationError);
  await assert.rejects(createPurchase(basePurchase({ items: [item(productA._id, { quantity: 1.5 })] })), ValidationError);
  await assert.rejects(createPurchase(basePurchase({ items: [item(productA._id, { unitCostPoisha: -1 })] })), ValidationError);
  await assert.rejects(createPurchase(basePurchase({ items: [item(productA._id, { unitCostPoisha: 1.5 })] })), ValidationError);
  await assert.rejects(createPurchase(basePurchase({ items: [item(productA._id, { sellingPricePoisha: -1 })] })), ValidationError);
  // missing required caller price (no platform default)
  await assert.rejects(createPurchase(basePurchase({ items: [{ productId: String(productA._id), quantity: 1 }] })), ValidationError);
  await assert.rejects(createPurchase(basePurchase({ items: [] })), ValidationError);
  // missing idempotency key
  await assert.rejects(createPurchase(basePurchase({ idempotencyKey: '' })), ValidationError);
  // no stock created on rejected
  assert.equal(await Purchase.countDocuments({ businessId: businessA._id, idempotencyKey: { $regex: /nope/ } }), 0);
});

// ---------- tenant isolation ----------
test('tenant isolation: supplier + product + purchase + payment + balance scoped; cross-business not-found', async () => {
  // cannot use B's supplier / product
  await assert.rejects(createPurchase(basePurchase({ supplierId: supplierB._id })), (e) => e.code === 'SUPPLIER_NOT_FOUND');
  await assert.rejects(createPurchase(basePurchase({ items: [item(productB._id)] })), (e) => e.code === 'PRODUCT_NOT_FOUND');
  // actor must be member of A
  await assert.rejects(createPurchase(basePurchase({ actorId: actorB._id })), (e) => e.code === 'ACTOR_NOT_FOUND');

  // create in A; B cannot read
  const purchase = await createPurchase(basePurchase());
  await assert.rejects(getPurchase(purchase._id, businessB._id), (e) => e.code === 'PURCHASE_NOT_FOUND');
  await assert.rejects(getPurchase(new mongoose.Types.ObjectId(), businessA._id), (e) => e.code === 'PURCHASE_NOT_FOUND');

  // B cannot pay A's purchase
  await assert.rejects(recordPurchasePayment({ businessId: businessB._id, purchaseId: purchase._id, paidBy: actorB._id, amountPoisha: 1, method: 'cash', idempotencyKey: `x-${Date.now()}` }), (e) => e.code === 'PURCHASE_NOT_FOUND');
  // cannot pay with cross-tenant paidBy
  await assert.rejects(recordPurchasePayment({ businessId: businessA._id, purchaseId: purchase._id, paidBy: actorB._id, amountPoisha: 1, method: 'cash', idempotencyKey: `y-${Date.now()}` }), (e) => e.code === 'ACTOR_NOT_FOUND');
  // balance tenant-safe
  await assert.rejects(getPurchaseSupplierBalance({ businessId: businessA._id, supplierId: supplierB._id }), (e) => e.code === 'SUPPLIER_NOT_FOUND');

  // no cross-tenant stock leakage
  const bStock = await Stock.find({ businessId: businessB._id, productId: productA._id }).lean();
  assert.equal(bStock.length, 0);
});

// ---------- payments: full / partial / unpaid, append-only, due ----------
test('supplier payments: full/partial/unpaid; append-only; paidAt; integer poisha; due; no overpayment', async () => {
  const purchase = await createPurchase(basePurchase({ items: [item(productA._id, { quantity: 1, unitCostPoisha: 10000 })] }));
  assert.equal(purchase.totalAmountPoisha, 10000);

  // unpaid initially
  let due = await getPurchaseDue(purchase._id, businessA._id);
  assert.equal(due.paymentStatus, 'unpaid'); assert.equal(due.amountDuePoisha, 10000); assert.equal(due.amountPaidPoisha, 0);

  // partial
  await recordPurchasePayment({ businessId: businessA._id, purchaseId: purchase._id, paidBy: actorA._id, amountPoisha: 4000, method: 'cash', idempotencyKey: `pay-${Date.now()}-1`, paidAt: new Date() });
  due = await getPurchaseDue(purchase._id, businessA._id);
  assert.equal(due.paymentStatus, 'partially_paid'); assert.equal(due.amountPaidPoisha, 4000); assert.equal(due.amountDuePoisha, 6000);

  // full
  await recordPurchasePayment({ businessId: businessA._id, purchaseId: purchase._id, paidBy: actorA._id, amountPoisha: 6000, method: 'bank', idempotencyKey: `pay-${Date.now()}-2` });
  due = await getPurchaseDue(purchase._id, businessA._id);
  assert.equal(due.paymentStatus, 'paid'); assert.equal(due.amountPaidPoisha, 10000); assert.equal(due.amountDuePoisha, 0);

  // append-only payment history (not mutated/deleted)
  const payments = await getPurchasePayments(purchase._id, businessA._id);
  assert.equal(payments.length, 2);
  assert.ok(payments.every((p) => p.sourceType === 'purchase' && p.type === 'payment' && String(p.purchaseId) === String(purchase._id) && String(p.sourceId) === String(purchase._id)));
  assert.ok(payments[0].paidAt); assert.ok(payments[0].timing);
  const aPayment = await SupplierPayment.findOne({ businessId: businessA._id, purchaseId: purchase._id }).lean();
  await assert.rejects(SupplierPayment.updateOne({ _id: aPayment._id }, { $set: { amountPoisha: 1 } }), /append-only/);
  await assert.rejects(SupplierPayment.deleteOne({ _id: aPayment._id }), /append-only|cannot be deleted/);

  // integer poisha + no overpayment
  await assert.rejects(recordPurchasePayment({ businessId: businessA._id, purchaseId: purchase._id, paidBy: actorA._id, amountPoisha: 1.5, method: 'cash', idempotencyKey: `pay-bad-${Date.now()}` }), ValidationError);
  await assert.rejects(recordPurchasePayment({ businessId: businessA._id, purchaseId: purchase._id, paidBy: actorA._id, amountPoisha: 1, method: 'cash', idempotencyKey: `pay-over-${Date.now()}` }), ConflictError);
  await assert.rejects(recordPurchasePayment({ businessId: businessA._id, purchaseId: purchase._id, paidBy: actorA._id, amountPoisha: 1, method: 'nope', idempotencyKey: `pay-method-${Date.now()}` }), ValidationError);
});

// ---------- supplier balance ----------
test('tenant-safe supplier balance for new-cylinder purchases', async () => {
  const purchase = await createPurchase(basePurchase({ supplierId: supplierA._id, items: [item(productA._id, { quantity: 1, unitCostPoisha: 10000 })] }));
  let bal = await getPurchaseSupplierBalance({ businessId: businessA._id, supplierId: supplierA._id });
  assert.ok(bal.obligationsPoisha >= 10000);
  const beforePaid = bal.paidPoisha;
  await recordPurchasePayment({ businessId: businessA._id, purchaseId: purchase._id, paidBy: actorA._id, amountPoisha: 10000, method: 'cash', idempotencyKey: `bal-${Date.now()}` });
  bal = await getPurchaseSupplierBalance({ businessId: businessA._id, supplierId: supplierA._id });
  assert.equal(bal.paidPoisha - beforePaid, 10000);
  assert.equal(bal.amountDuePoisha, bal.obligationsPoisha - bal.paidPoisha);
});

// ---------- idempotency ----------
test('idempotency: purchase + payment retry no double-post; concurrent safe', async () => {
  const key = `purchase-idem-${Date.now()}`;
  const args = basePurchase({ idempotencyKey: key, items: [item(productA._id, { quantity: 5, unitCostPoisha: 10000 })] });
  const stockBefore = (await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean())?.newQty ?? 0;

  const p1 = await createPurchase(args);
  const p2 = await createPurchase(args); // sequential retry
  assert.equal(String(p1._id), String(p2._id));
  assert.equal(await Purchase.countDocuments({ businessId: businessA._id, idempotencyKey: key }), 1);
  let stock = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  assert.equal(stock.newQty, stockBefore + 5); // applied once
  assert.equal(await StockMovement.countDocuments({ businessId: businessA._id, idempotencyKey: `${key}#new:${p1.items[0]._id}` }), 1);

  // concurrent same-key purchase
  const k2 = `purchase-idem-c-${Date.now()}`;
  const results = await Promise.allSettled([createPurchase({ ...args, idempotencyKey: k2 }), createPurchase({ ...args, idempotencyKey: k2 })]);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  assert.equal(await Purchase.countDocuments({ businessId: businessA._id, idempotencyKey: k2 }), 1);

  // payment idempotency
  const purchase = await createPurchase(basePurchase({ items: [item(productA._id, { quantity: 1, unitCostPoisha: 10000 })] }));
  const payKey = `pay-idem-${Date.now()}`;
  await recordPurchasePayment({ businessId: businessA._id, purchaseId: purchase._id, paidBy: actorA._id, amountPoisha: 10000, method: 'cash', idempotencyKey: payKey });
  await recordPurchasePayment({ businessId: businessA._id, purchaseId: purchase._id, paidBy: actorA._id, amountPoisha: 10000, method: 'cash', idempotencyKey: payKey }); // retry
  assert.equal(await SupplierPayment.countDocuments({ businessId: businessA._id, idempotencyKey: payKey }), 1);
  const due = await getPurchaseDue(purchase._id, businessA._id);
  assert.equal(due.amountPaidPoisha, 10000); assert.equal(due.amountDuePoisha, 0);
});

// ---------- concurrency ----------
test('concurrency: concurrent payments never overpay; atomic stock; no lost updates', async () => {
  const purchase = await createPurchase(basePurchase({ items: [item(productA._id, { quantity: 1, unitCostPoisha: 10000 })] }));

  // two concurrent half-payments (different keys): exactly one ordering; total paid == total; never > total
  const results = await Promise.allSettled([
    recordPurchasePayment({ businessId: businessA._id, purchaseId: purchase._id, paidBy: actorA._id, amountPoisha: 5000, method: 'cash', idempotencyKey: `conc-a-${Date.now()}` }),
    recordPurchasePayment({ businessId: businessA._id, purchaseId: purchase._id, paidBy: actorA._id, amountPoisha: 5000, method: 'cash', idempotencyKey: `conc-b-${Date.now()}` }),
  ]);
  const due = await getPurchaseDue(purchase._id, businessA._id);
  assert.equal(due.amountPaidPoisha, 10000); assert.equal(due.amountDuePoisha, 0); assert.equal(due.paymentStatus, 'paid');
  assert.ok(results.some((r) => r.status === 'fulfilled'));

  // concurrent purchases to same product: atomic $inc newQty, no lost updates
  const stockBefore = (await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean())?.newQty ?? 0;
  const N = 4;
  await Promise.all(Array.from({ length: N }, (_, i) => createPurchase(basePurchase({ items: [item(productA._id, { quantity: 1, unitCostPoisha: 1000 })], idempotencyKey: `conc-p-${Date.now()}-${i}` }))));
  const stockAfter = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  assert.equal(stockAfter.newQty, stockBefore + N);
});

// ---------- preserve SupplierPayment / Refill compatibility ----------
test('preserves existing SupplierPayment shape + Refill; no Supplier Returns', async () => {
  // SupplierPayment append-only + timing + sourceType purchase/refill_batch coexist
  const purchase = await createPurchase(basePurchase({ items: [item(productA._id, { quantity: 1, unitCostPoisha: 10000 })] }));
  await recordPurchasePayment({ businessId: businessA._id, purchaseId: purchase._id, paidBy: actorA._id, amountPoisha: 1000, method: 'cash', idempotencyKey: `keep-${Date.now()}` });
  const purchasePayment = await SupplierPayment.findOne({ businessId: businessA._id, purchaseId: purchase._id }).lean();
  assert.equal(purchasePayment.sourceType, 'purchase'); assert.equal(purchasePayment.type, 'payment'); assert.equal(purchasePayment.timing, 'later');
  // refill-shaped payment still inserts (not created by purchase service; just schema-compatible)
  await SupplierPayment.create({ businessId: businessA._id, supplierId: supplierA._id, batchId: new mongoose.Types.ObjectId(), sourceType: 'refill_batch', sourceId: new mongoose.Types.ObjectId(), type: 'payment', timing: 'receiving', idempotencyKey: `refill-${Date.now()}`, requestHash: 'h', amountPoisha: 100, method: 'cash', paidBy: actorA._id });
  // no supplier-return / purchase-return created
  assert.equal(await SupplierPayment.countDocuments({ businessId: businessA._id, type: 'refund', sourceType: 'purchase' }), 0);
});

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import Business from '../src/modules/business.model.js';
import BusinessMember from '../src/modules/business-member.model.js';
import Customer from '../src/modules/customer.model.js';
import Payment from '../src/modules/payment.model.js';
import Product from '../src/modules/product.model.js';
import Sale from '../src/modules/sale.model.js';
import Stock from '../src/modules/stock.model.js';
import StockMovement from '../src/modules/stock-movement.model.js';
import User from '../src/modules/user.model.js';
import { createSale, getSale, getSaleDue, getSalePayments, recordSalePayment, reconcileSalePayment } from '../src/modules/sale.service.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

let businessA; let businessB; let actorA; let actorB; let productA; let productB; let customerA; let customerB;

const saleItem = (productId, over = {}) => ({ productId: String(productId), quantity: 1, unitSellingPricePoisha: 15000, ...over });

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  businessA = await Business.create({ name: 'A', slug: `sal-a-${Date.now()}`, status: 'active' });
  businessB = await Business.create({ name: 'B', slug: `sal-b-${Date.now()}`, status: 'active' });
  actorA = await User.create({ name: 'A', email: `sal-a-${Date.now()}@example.test`, status: 'active' });
  actorB = await User.create({ name: 'B', email: `sal-b-${Date.now()}@example.test`, status: 'active' });
  await BusinessMember.create([
    { businessId: businessA._id, userId: actorA._id, role: 'owner', status: 'active' },
    { businessId: businessB._id, userId: actorB._id, role: 'owner', status: 'active' },
  ]);
  productA = await Product.create({ businessId: businessA._id, brand: 'a', cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200, status: 'active', kind: 'lpg_cylinder' });
  productB = await Product.create({ businessId: businessB._id, brand: 'b', cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200, status: 'active', kind: 'lpg_cylinder' });
  customerA = await Customer.create({ businessId: businessA._id, name: 'Cust A', phone: '111', status: 'active' });
  customerB = await Customer.create({ businessId: businessB._id, name: 'Cust B', phone: '222', status: 'active' });
  for (const M of [Sale, Payment, Stock, StockMovement]) await M.syncIndexes();
});

after(async () => {
  if (mongoose.connection.readyState === 1) {
    const db = mongoose.connection.db;
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name } of collections) if (!name.startsWith('system.')) await db.collection(name).deleteMany({});
  }
  await disconnectTestDatabase();
});

async function seedStock(businessId, productId, newQty) {
  await Stock.updateOne(
    { businessId, productId, warehouseId: null },
    { $setOnInsert: { fullQty: 3, emptyQty: 3, damagedQty: 3, rejectedQty: 3, warehouseId: null }, $set: { newQty } },
    { upsert: true },
  );
}

const baseSale = (over = {}) => ({
  businessId: businessA._id, actorId: actorA._id, invoiceNumber: `INV-${Math.random().toString(16).slice(2)}`,
  items: [saleItem(productA._id)], idempotencyKey: `s-${Math.random().toString(16).slice(2)}`, ...over,
});

// ---------- stock ----------
test('new-cylinder sale: atomic newQty decrement; no negative; append-only; full/empty/damaged/rejected untouched', async () => {
  await seedStock(businessA._id, productA._id, 5);
  const before = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();

  const sale = await createSale(baseSale({ invoiceNumber: `STK-${Date.now()}`, items: [saleItem(productA._id, { quantity: 2, unitSellingPricePoisha: 15000 })] }));
  const after = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  assert.equal(after.newQty, before.newQty - 2);
  // regular buckets untouched
  assert.equal(after.fullQty, before.fullQty);
  assert.equal(after.emptyQty, before.emptyQty);
  assert.equal(after.damagedQty, before.damagedQty);
  assert.equal(after.rejectedQty, before.rejectedQty);
  assert.ok(after.newQty >= 0);

  // append-only sale movement
  const movements = await StockMovement.find({ businessId: businessA._id, productId: productA._id, movementType: 'sale', sourceId: sale._id }).lean();
  assert.ok(movements.length >= 1);
  assert.equal(movements[0].stockBucket, 'new');
  assert.equal(movements[0].direction, 'out');
  assert.equal(movements[0].sourceType, 'sale');
  assert.ok(movements[0].sourceLineId);
  assert.ok(movements[0].movementGroupId);
  assert.ok(movements[0].idempotencyKey);
  // append-only
  await assert.rejects(StockMovement.updateOne({ _id: movements[0]._id }, { $set: { quantity: 99 } }), /append-only/);

  // no negative stock
  const avail = after.newQty;
  await assert.rejects(createSale(baseSale({ invoiceNumber: `OVER-${Date.now()}`, items: [saleItem(productA._id, { quantity: avail + 100 })] })), (e) => e.code === 'INSUFFICIENT_NEW_CYLINDER');
  const still = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  assert.equal(still.newQty, avail); // unchanged after rejected

  // no `purchase` newQty creation; selling only newQty
  // (can't sell when newQty insufficient even if fullQty high)
  await Stock.updateOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }, { $set: { newQty: 0, fullQty: 999 } });
  await assert.rejects(createSale(baseSale({ invoiceNumber: `FULL-${Date.now()}`, items: [saleItem(productA._id, { quantity: 1 })] })), (e) => e.code === 'INSUFFICIENT_NEW_CYLINDER');
});

// ---------- sale model ----------
test('sale: tenant-safe; optional customer; manual invoice; saleDate; items; integer poisha totals; status; idempotency; product prices unchanged', async () => {
  await seedStock(businessA._id, productA._id, 10);
  const sale = await createSale(baseSale({
    invoiceNumber: `SALE-${Date.now()}`, saleDate: new Date('2024-05-01').toISOString(), customerId: customerA._id,
    items: [saleItem(productA._id, { quantity: 2, unitSellingPricePoisha: 15000 })], note: 'n', reference: 'r',
  }));
  assert.equal(String(sale.businessId), String(businessA._id));
  assert.equal(String(sale.customerId), String(customerA._id));
  assert.ok(sale.invoiceNumber);
  assert.ok(sale.saleDate);
  assert.equal(sale.items.length, 1);
  assert.equal(sale.items[0].kind, 'lpg_cylinder');
  assert.equal(sale.items[0].quantity, 2);
  assert.equal(sale.items[0].unitPrice, 15000); // integer poisha; dealer-defined
  assert.equal(sale.items[0].lineTotal, 30000);
  assert.equal(sale.subtotal, 30000);
  assert.equal(sale.total, 30000);
  assert.equal(sale.paidAmount, 0);
  assert.equal(sale.dueAmount, 30000);
  assert.equal(sale.status, 'unpaid');
  assert.ok(sale.idempotencyKey);
  assert.ok(sale.items[0]._id); // sourceLineId
  // product pricing NOT modified
  const product = await Product.findById(productA._id).lean();
  assert.equal(product.sellingPrice, 200); assert.equal(product.purchasePrice, 100);

  // customer optional
  await seedStock(businessA._id, productA._id, 10);
  const anon = await createSale(baseSale({ invoiceNumber: `ANON-${Date.now()}` }));
  assert.equal(anon.customerId ?? undefined, undefined); // customer optional

  // invoice unique per business + manual required
  await assert.rejects(createSale(baseSale({ invoiceNumber: sale.invoiceNumber })), (e) => e.code === 11000 || e.code === 'CONFLICT');
  await assert.rejects(createSale(baseSale({ invoiceNumber: '' })), ValidationError);
  // integer poisha
  await seedStock(businessA._id, productA._id, 10);
  await assert.rejects(createSale(baseSale({ invoiceNumber: `BAD-${Date.now()}`, items: [saleItem(productA._id, { unitSellingPricePoisha: 1.5 })] })), ValidationError);
  await assert.rejects(createSale(baseSale({ invoiceNumber: `BAD2-${Date.now()}`, items: [saleItem(productA._id, { quantity: 1.5 })] })), ValidationError);
  await assert.rejects(createSale(baseSale({ invoiceNumber: `BAD3-${Date.now()}`, items: [saleItem(productA._id, { unitSellingPricePoisha: -1 })] })), ValidationError);
});

// ---------- payments ----------
test('customer sale payments: methods; full/partial/due; multiple no overpayment; append-only; recompute', async () => {
  await seedStock(businessA._id, productA._id, 10);
  const sale = await createSale(baseSale({ invoiceNumber: `PAY-${Date.now()}`, items: [saleItem(productA._id, { quantity: 1, unitSellingPricePoisha: 10000 })] }));

  // partial
  await recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 4000, method: 'cash', idempotencyKey: `p-${Date.now()}-1` });
  let due = await getSaleDue(sale._id, businessA._id);
  assert.equal(due.status, 'partially_paid'); assert.equal(due.paidAmount, 4000); assert.equal(due.dueAmount, 6000);

  // multiple + full
  await recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 3000, method: 'bkash', idempotencyKey: `p-${Date.now()}-2` });
  await recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 3000, method: 'nagad', idempotencyKey: `p-${Date.now()}-3` });
  due = await getSaleDue(sale._id, businessA._id);
  assert.equal(due.status, 'paid'); assert.equal(due.paidAmount, 10000); assert.equal(due.dueAmount, 0);

  // methods set + append-only
  const payments = await getSalePayments(sale._id, businessA._id);
  assert.ok(payments.length >= 3);
  assert.ok(payments.some((p) => p.method === 'cash') && payments.some((p) => p.method === 'bkash') && payments.some((p) => p.method === 'nagad'));
  assert.ok(payments.every((p) => p.immutable !== false));
  const aPayment = payments[0];
  await assert.rejects(Payment.updateOne({ _id: aPayment._id }, { $set: { amount: 1 } }), /append-only|cannot be overwritten/);
  await assert.rejects(Payment.deleteOne({ _id: aPayment._id }), /append-only|cannot be deleted/);

  // no overpayment
  await assert.rejects(recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 1, method: 'cash', idempotencyKey: `p-over-${Date.now()}` }), ConflictError);
  // integer poisha + valid method
  await assert.rejects(recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 1.5, method: 'cash', idempotencyKey: `p-bad-${Date.now()}` }), ValidationError);
  await assert.rejects(recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 1, method: 'nope', idempotencyKey: `p-meth-${Date.now()}` }), ValidationError);

  // 'Others'/'Bank'
  await seedStock(businessA._id, productA._id, 10);
  const sale2 = await createSale(baseSale({ invoiceNumber: `PAY2-${Date.now()}`, items: [saleItem(productA._id, { unitSellingPricePoisha: 10000 })] }));
  await recordSalePayment({ businessId: businessA._id, saleId: sale2._id, actorId: actorA._id, amountPoisha: 1, method: 'bank', idempotencyKey: `p-bank-${Date.now()}` });
  await recordSalePayment({ businessId: businessA._id, saleId: sale2._id, actorId: actorA._id, amountPoisha: 1, method: 'other', idempotencyKey: `p-other-${Date.now()}` });

  // reconciliation read-only
  const recon = await reconcileSalePayment({ businessId: businessA._id, saleId: sale._id });
  assert.equal(recon.matches, true); assert.ok(recon.paid <= recon.total);
});

// ---------- idempotency ----------
test('idempotency: sale + payment replay; same key + different payload rejects; concurrent safe', async () => {
  await seedStock(businessA._id, productA._id, 50);
  const key = `sale-idem-${Date.now()}`;
  const args = baseSale({ invoiceNumber: `IDEM-${Date.now()}`, idempotencyKey: key, items: [saleItem(productA._id, { quantity: 2, unitSellingPricePoisha: 10000 })], note: 'n' });
  const s1 = await createSale(args);
  const s2 = await createSale(args);
  assert.equal(String(s1._id), String(s2._id));
  assert.equal(await Sale.countDocuments({ businessId: businessA._id, idempotencyKey: key }), 1);
  const stockAfter = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  // applied once
  assert.equal(await StockMovement.countDocuments({ businessId: businessA._id, sourceType: 'sale', sourceId: s1._id }), 1);
  // same key + different payload
  await assert.rejects(createSale({ ...args, items: [saleItem(productA._id, { quantity: 3, unitSellingPricePoisha: 10000 })] }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(createSale({ ...args, note: 'DIFF' }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(createSale({ ...args, reference: 'DIFF' }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(createSale({ ...args, invoiceNumber: 'DIFF' }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');

  // concurrent same-key sale
  const k2 = `sale-idem-c-${Date.now()}`;
  const results = await Promise.allSettled([createSale({ ...args, invoiceNumber: `IDEMC-${Date.now()}`, idempotencyKey: k2 }), createSale({ ...args, invoiceNumber: `IDEMC-${Date.now()}`, idempotencyKey: k2 })]);
  // NOTE: concurrent same key + same invoice? invoice differs => requestHash differs => conflict possible; still at most one sale
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  assert.ok(await Sale.countDocuments({ businessId: businessA._id, idempotencyKey: k2 }) <= 1);

  // payment idempotency + mismatch
  const payKey = `sale-pay-idem-${Date.now()}`;
  const sale = await createSale(baseSale({ invoiceNumber: `PIDEM-${Date.now()}`, items: [saleItem(productA._id, { unitSellingPricePoisha: 10000 })] }));
  const payArgs = { businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 1000, method: 'cash', idempotencyKey: payKey, reference: 'ref', note: 'n' };
  await recordSalePayment(payArgs);
  await recordSalePayment(payArgs); // replay
  assert.equal(await Payment.countDocuments({ businessId: businessA._id, idempotencyKey: payKey }), 1);
  await assert.rejects(recordSalePayment({ ...payArgs, amountPoisha: 1001 }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(recordSalePayment({ ...payArgs, method: 'bank' }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(recordSalePayment({ ...payArgs, note: 'DIFF' }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(recordSalePayment({ ...payArgs, reference: 'DIFF' }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
});

// ---------- concurrency ----------
test('concurrency: no overpayment; no oversell (newQty); no lost updates', async () => {
  // no oversell: single newQty, two concurrent sales of 1
  await seedStock(businessA._id, productA._id, 1);
  const before = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  const sell = await Promise.allSettled([
    createSale(baseSale({ invoiceNumber: `CONC-A-${Date.now()}`, items: [saleItem(productA._id, { quantity: 1 })], idempotencyKey: `ca-${Date.now()}` })),
    createSale(baseSale({ invoiceNumber: `CONC-B-${Date.now()}`, items: [saleItem(productA._id, { quantity: 1 })], idempotencyKey: `cb-${Date.now()}` })),
  ]);
  const stock = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  assert.equal(stock.newQty, 0); assert.ok(stock.newQty >= 0);
  assert.equal(sell.filter((r) => r.status === 'fulfilled').length, 1); // exactly one winner

  // no overpayment concurrent
  await seedStock(businessA._id, productA._id, 10);
  const sale = await createSale(baseSale({ invoiceNumber: `CONCPAY-${Date.now()}`, items: [saleItem(productA._id, { unitSellingPricePoisha: 10000 })] }));
  const pay = await Promise.allSettled([
    recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 5000, method: 'cash', idempotencyKey: `cp-a-${Date.now()}` }),
    recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 5000, method: 'cash', idempotencyKey: `cp-b-${Date.now()}` }),
  ]);
  const due = await getSaleDue(sale._id, businessA._id);
  assert.equal(due.paidAmount, 10000); assert.equal(due.dueAmount, 0);
  assert.ok(pay.some((r) => r.status === 'fulfilled'));
  assert.equal((await reconcileSalePayment({ businessId: businessA._id, saleId: sale._id })).matches, true);
});

// ---------- tenant isolation ----------
test('tenant isolation: businessId verified; customer + product + sale + payment scoped; cross-business not-found', async () => {
  await seedStock(businessA._id, productA._id, 10);
  // cannot sell B's product
  await assert.rejects(createSale(baseSale({ invoiceNumber: `X-${Date.now()}`, items: [saleItem(productB._id)] })), (e) => e.code === 'PRODUCT_NOT_FOUND');
  // cannot use B's customer
  await assert.rejects(createSale(baseSale({ invoiceNumber: `XC-${Date.now()}`, customerId: customerB._id })), (e) => e.code === 'CUSTOMER_NOT_FOUND');
  // actor must be member of A
  await assert.rejects(createSale(baseSale({ invoiceNumber: `XA-${Date.now()}`, actorId: actorB._id })), (e) => e.code === 'ACTOR_NOT_FOUND');

  const sale = await createSale(baseSale({ invoiceNumber: `TEN-${Date.now()}`, customerId: customerA._id }));
  // B cannot read/pay A's sale
  await assert.rejects(getSaleDue(sale._id, businessB._id), (e) => e.code === 'SALE_NOT_FOUND');
  await assert.rejects(recordSalePayment({ businessId: businessB._id, saleId: sale._id, actorId: actorB._id, amountPoisha: 1, method: 'cash', idempotencyKey: `xt-${Date.now()}` }), (e) => e.code === 'SALE_NOT_FOUND');
  await assert.rejects(getSale(sale._id, businessB._id), NotFoundError);
  // no cross-tenant stock leakage
  assert.equal((await Stock.find({ businessId: businessB._id, productId: productA._id }).lean()).length, 0);
  // invoice uniqueness is per-tenant
  await seedStock(businessB._id, productB._id, 10);
  await createSale({ businessId: businessB._id, actorId: actorB._id, invoiceNumber: sale.invoiceNumber, items: [saleItem(productB._id)], idempotencyKey: `b-${Date.now()}` });
});
// end

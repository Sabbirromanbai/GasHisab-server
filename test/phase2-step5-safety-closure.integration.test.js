import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import Business from '../src/modules/business.model.js';
import BusinessMember from '../src/modules/business-member.model.js';
import Payment from '../src/modules/payment.model.js';
import Product from '../src/modules/product.model.js';
import Sale from '../src/modules/sale.model.js';
import Stock from '../src/modules/stock.model.js';
import StockMovement from '../src/modules/stock-movement.model.js';
import User from '../src/modules/user.model.js';
import { createSale, reconcileSalePayment, reconcileSaleStock, recordSalePayment } from '../src/modules/sale.service.js';
import { NotFoundError } from '../src/errors.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

let businessA; let businessB; let actorA; let actorB; let productA; let productB;

const item = (productId, over = {}) => ({ productId: String(productId), quantity: 1, unitSellingPricePoisha: 10000, ...over });

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  businessA = await Business.create({ name: 'A', slug: `scs-a-${Date.now()}`, status: 'active' });
  businessB = await Business.create({ name: 'B', slug: `scs-b-${Date.now()}`, status: 'active' });
  actorA = await User.create({ name: 'A', email: `scs-a-${Date.now()}@example.test`, status: 'active' });
  actorB = await User.create({ name: 'B', email: `scs-b-${Date.now()}@example.test`, status: 'active' });
  await BusinessMember.create([
    { businessId: businessA._id, userId: actorA._id, role: 'owner', status: 'active' },
    { businessId: businessB._id, userId: actorB._id, role: 'owner', status: 'active' },
  ]);
  productA = await Product.create({ businessId: businessA._id, brand: 'a', cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200, status: 'active', kind: 'lpg_cylinder' });
  productB = await Product.create({ businessId: businessB._id, brand: 'b', cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200, status: 'active', kind: 'lpg_cylinder' });
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
  await Stock.updateOne({ businessId, productId, warehouseId: null }, { $setOnInsert: { fullQty: 3, emptyQty: 3, damagedQty: 3, rejectedQty: 3, warehouseId: null }, $set: { newQty } }, { upsert: true });
}
const baseSale = (over = {}) => ({ businessId: businessA._id, actorId: actorA._id, invoiceNumber: `I-${Math.random().toString(16).slice(2)}`, items: [item(productA._id)], idempotencyKey: `k-${Math.random().toString(16).slice(2)}`, ...over });

// ---------- req 1: sale stock reconciliation ----------
test('reconcileSaleStock: read-only; sale newQty deductions vs append-only sale ledger; scoped; no repair', async () => {
  await seedStock(businessA._id, productA._id, 10);
  const sale = await createSale(baseSale({ invoiceNumber: `RS-${Date.now()}`, items: [item(productA._id, { quantity: 3 })] }));

  let recon = await reconcileSaleStock({ businessId: businessA._id, productId: productA._id });
  assert.equal(recon.matchesSaleLedger, true);
  assert.equal(recon.recomputedSaleDeduction, 3);
  assert.ok(recon.saleMovements >= 1);
  assert.equal(recon.unreconciledMovements, 0);
  assert.ok(recon.storedNewQty <= 10);
  assert.ok('stock' in recon);

  const stockBefore = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  const movementsBefore = await StockMovement.countDocuments({ businessId: businessA._id });
  await reconcileSaleStock({ businessId: businessA._id, productId: productA._id });
  // read-only: no mutation / no repair / no new movements
  assert.deepEqual(await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean(), stockBefore);
  assert.equal(await StockMovement.countDocuments({ businessId: businessA._id }), movementsBefore);

  // tenant scope
  await assert.rejects(reconcileSaleStock({ businessId: businessA._id, productId: productB._id }), (e) => e.code === 'PRODUCT_NOT_FOUND');
  await assert.rejects(reconcileSaleStock({ businessId: businessB._id, productId: productA._id }), (e) => e.code === 'PRODUCT_NOT_FOUND');
  void sale;
});

// ---------- req 2: payment cache reconciliation ----------
test('reconcileSalePayment: paid/due/status vs append-only Payment; read-only; no auto-fix', async () => {
  await seedStock(businessA._id, productA._id, 10);
  const sale = await createSale(baseSale({ invoiceNumber: `RP-${Date.now()}`, items: [item(productA._id, { unitSellingPricePoisha: 10000 })] }));
  await recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 4000, method: 'cash', idempotencyKey: `rp-${Date.now()}` });

  let recon = await reconcileSalePayment({ businessId: businessA._id, saleId: sale._id });
  assert.equal(recon.matches, true);
  assert.equal(recon.recomputed.paidAmount, 4000); assert.equal(recon.recomputed.dueAmount, 6000); assert.equal(recon.recomputed.status, 'partially_paid');
  assert.equal(recon.stored.paidAmount, 4000); assert.ok(recon.paid <= recon.total);

  const paymentsBefore = await Payment.countDocuments({ businessId: businessA._id });
  // corrupt cache -> drift; not repaired; append-only payments unchanged
  await Sale.updateOne({ _id: sale._id }, { $set: { paidAmount: 0 } });
  recon = await reconcileSalePayment({ businessId: businessA._id, saleId: sale._id });
  assert.equal(recon.matches, false); assert.equal(recon.recomputed.paidAmount, 4000); assert.equal(recon.paid, 4000);
  assert.equal(await Payment.countDocuments({ businessId: businessA._id }), paymentsBefore);
  assert.equal((await Sale.findById(sale._id).lean()).paidAmount, 0); // not auto-fixed
  // tenant
  await assert.rejects(reconcileSalePayment({ businessId: businessB._id, saleId: sale._id }), (e) => e.code === 'SALE_NOT_FOUND');
});

// ---------- req 3: idempotency mismatch ----------
test('idempotency: createSale + recordSalePayment same key + different payload rejects safely', async () => {
  await seedStock(businessA._id, productA._id, 50);
  const key = `sale-${Date.now()}`;
  const args = baseSale({ invoiceNumber: `ID-${Date.now()}`, idempotencyKey: key, items: [item(productA._id, { quantity: 2, unitSellingPricePoisha: 10000 })], note: 'n', reference: 'r' });
  const s1 = await createSale(args);
  const s2 = await createSale(args);
  assert.equal(String(s1._id), String(s2._id)); assert.equal(await Sale.countDocuments({ businessId: businessA._id, idempotencyKey: key }), 1);
  // atomic applied once
  assert.equal(await StockMovement.countDocuments({ businessId: businessA._id, sourceType: 'sale', sourceId: s1._id }), 1);
  for (const variant of [
    { ...args, items: [item(productA._id, { quantity: 3, unitSellingPricePoisha: 10000 })] },
    { ...args, items: [item(productA._id, { quantity: 2, unitSellingPricePoisha: 11000 })] },
    { ...args, note: 'DIFF' }, { ...args, reference: 'DIFF' }, { ...args, invoiceNumber: 'DIFF' },
    { ...args, saleDate: new Date('2020-01-01').toISOString() },
  ]) { await assert.rejects(createSale(variant), (e) => e.code === 'IDEMPOTENCY_CONFLICT'); }
  assert.equal(await Sale.countDocuments({ businessId: businessA._id, idempotencyKey: key }), 1);

  // payment
  const sale = await createSale(baseSale({ invoiceNumber: `PID-${Date.now()}`, items: [item(productA._id, { unitSellingPricePoisha: 10000 })] }));
  const pk = `pay-${Date.now()}`;
  const pa = { businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 1000, method: 'cash', idempotencyKey: pk, reference: 'ref', note: 'n', paidAt: new Date('2024-01-01').toISOString() };
  await recordSalePayment(pa); await recordSalePayment(pa);
  assert.equal(await Payment.countDocuments({ businessId: businessA._id, idempotencyKey: pk }), 1);
  for (const variant of [{ ...pa, amountPoisha: 1001 }, { ...pa, method: 'bank' }, { ...pa, reference: 'D' }, { ...pa, note: 'D' }, { ...pa, paidAt: new Date('2024-01-02').toISOString() }]) {
    await assert.rejects(recordSalePayment(variant), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  }
  // same key + different sale
  const other = await createSale(baseSale({ invoiceNumber: `PID2-${Date.now()}`, items: [item(productA._id, { unitSellingPricePoisha: 10000 })] }));
  await assert.rejects(recordSalePayment({ ...pa, saleId: other._id }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  // cross-business key independent
  await assert.rejects(recordSalePayment({ ...pa, businessId: businessB._id, actorId: actorB._id, saleId: sale._id }), (e) => e.code === 'SALE_NOT_FOUND');
  assert.equal(await Payment.countDocuments({ businessId: businessA._id, idempotencyKey: pk }), 1);
});

// ---------- req 4: atomic + concurrency ----------
test('concurrency: no oversell newQty; no overpayment; atomic; no lost updates', async () => {
  // no oversell: 1 newQty, two concurrent sales of 1
  await seedStock(businessA._id, productA._id, 1);
  const sell = await Promise.allSettled([
    createSale(baseSale({ invoiceNumber: `CA-${Date.now()}`, items: [item(productA._id, { quantity: 1 })], idempotencyKey: `ca-${Date.now()}` })),
    createSale(baseSale({ invoiceNumber: `CB-${Date.now()}`, items: [item(productA._id, { quantity: 1 })], idempotencyKey: `cb-${Date.now()}` })),
  ]);
  const stock = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  assert.equal(stock.newQty, 0); assert.ok(stock.newQty >= 0);
  assert.equal(sell.filter((r) => r.status === 'fulfilled').length, 1);
  // stock not created on rejected; reconciliation holds
  assert.equal((await reconcileSaleStock({ businessId: businessA._id, productId: productA._id })).matchesSaleLedger, true);

  // no overpayment concurrent
  await seedStock(businessA._id, productA._id, 10);
  const sale = await createSale(baseSale({ invoiceNumber: `CP-${Date.now()}`, items: [item(productA._id, { unitSellingPricePoisha: 10000 })] }));
  const pay = await Promise.allSettled([
    recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 5000, method: 'cash', idempotencyKey: `pa-${Date.now()}` }),
    recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 5000, method: 'cash', idempotencyKey: `pb-${Date.now()}` }),
  ]);
  const recon = await reconcileSalePayment({ businessId: businessA._id, saleId: sale._id });
  assert.ok(recon.paid <= recon.total); assert.equal(recon.paid, 10000); assert.equal(recon.matches, true);
  assert.ok(pay.some((r) => r.status === 'fulfilled'));

  // no-overpayment concurrent exceeding total -> at most total paid
  const sale2 = await createSale(baseSale({ invoiceNumber: `CP2-${Date.now()}`, items: [item(productA._id, { unitSellingPricePoisha: 10000 })] }));
  await Promise.allSettled([
    recordSalePayment({ businessId: businessA._id, saleId: sale2._id, actorId: actorA._id, amountPoisha: 8000, method: 'cash', idempotencyKey: `qa-${Date.now()}` }),
    recordSalePayment({ businessId: businessA._id, saleId: sale2._id, actorId: actorA._id, amountPoisha: 8000, method: 'cash', idempotencyKey: `qb-${Date.now()}` }),
  ]);
  const r2 = await reconcileSalePayment({ businessId: businessA._id, saleId: sale2._id });
  assert.ok(r2.paid <= 10000); assert.equal(r2.matches, true);
});

// ---------- req 5/6: tenant + append-only + no destructive ----------
test('tenant isolation + append-only + no auto-repair/backfill/destructive/ledger mutation', async () => {
  await seedStock(businessA._id, productA._id, 10);
  const sale = await createSale(baseSale({ invoiceNumber: `T-${Date.now()}` }));
  await recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: 1, method: 'cash', idempotencyKey: `t-${Date.now()}` });

  // B cannot reconcile A
  await assert.rejects(reconcileSaleStock({ businessId: businessB._id, productId: productA._id }), NotFoundError);
  await assert.rejects(reconcileSalePayment({ businessId: businessB._id, saleId: sale._id }), NotFoundError);

  const stockBefore = await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean();
  const movementsBefore = await StockMovement.countDocuments({});
  const paymentsBefore = await Payment.countDocuments({});
  const saleBefore = await Sale.findById(sale._id).lean();

  await reconcileSaleStock({ businessId: businessA._id, productId: productA._id });
  await reconcileSalePayment({ businessId: businessA._id, saleId: sale._id });

  assert.deepEqual(await Stock.findOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }).lean(), stockBefore);
  assert.equal(await StockMovement.countDocuments({}), movementsBefore);
  assert.equal(await Payment.countDocuments({}), paymentsBefore);
  assert.equal((await Sale.findById(sale._id).lean()).paidAmount, saleBefore.paidAmount);
  // append-only
  const mv = await StockMovement.findOne({ businessId: businessA._id, movementType: 'sale' }).lean();
  await assert.rejects(StockMovement.updateOne({ _id: mv._id }, { $set: { quantity: 999 } }), /append-only/);
  const p = await Payment.findOne({ businessId: businessA._id }).lean();
  await assert.rejects(Payment.updateOne({ _id: p._id }, { $set: { amount: 999 } }), /append-only|cannot be overwritten/);
});

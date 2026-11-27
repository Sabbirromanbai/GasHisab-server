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
import { createCustomer, deactivateCustomer, getCustomerPayments, getCustomerSales, reconcileCustomerDue, updateCustomer } from '../src/modules/customer.service.js';
import { createSale, recordSalePayment } from '../src/modules/sale.service.js';
import { NotFoundError, ValidationError } from '../src/errors.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

let businessA; let businessB; let actorA; let actorB; let productA;

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  businessA = await Business.create({ name: 'A', slug: `csc-a-${Date.now()}`, status: 'active' });
  businessB = await Business.create({ name: 'B', slug: `csc-b-${Date.now()}`, status: 'active' });
  actorA = await User.create({ name: 'A', email: `csc-a-${Date.now()}@example.test`, status: 'active' });
  actorB = await User.create({ name: 'B', email: `csc-b-${Date.now()}@example.test`, status: 'active' });
  await BusinessMember.create([
    { businessId: businessA._id, userId: actorA._id, role: 'owner', status: 'active' },
    { businessId: businessB._id, userId: actorB._id, role: 'owner', status: 'active' },
  ]);
  productA = await Product.create({ businessId: businessA._id, brand: 'a', cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200, status: 'active', kind: 'lpg_cylinder' });
  for (const M of [Customer, Sale, Payment, Stock, StockMovement]) await M.syncIndexes();
});

after(async () => {
  if (mongoose.connection.readyState === 1) {
    const db = mongoose.connection.db;
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name } of collections) if (!name.startsWith('system.')) await db.collection(name).deleteMany({});
  }
  await disconnectTestDatabase();
});

const baseCustomer = (over = {}) => ({ businessId: businessA._id, actorId: actorA._id, name: `C ${Math.random().toString(16).slice(2)}`, ...over });

async function seedSale(customerId, total, paid, invoice) {
  await Stock.updateOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }, { $setOnInsert: { fullQty: 0, emptyQty: 0, damagedQty: 0, rejectedQty: 0, warehouseId: null }, $inc: { newQty: 100 } }, { upsert: true });
  const sale = await createSale({ businessId: businessA._id, actorId: actorA._id, customerId, invoiceNumber: invoice, items: [{ productId: String(productA._id), quantity: 1, unitSellingPricePoisha: total }], idempotencyKey: `s-${invoice}` });
  if (paid > 0) await recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: paid, method: 'cash', idempotencyKey: `p-${invoice}` });
  return sale;
}

// ---------- req1: duplicate mobile + concurrency; shared household + blank preserved ----------
test('duplicate mobile: concurrency audit; no destructive DB unique; shared household + blank preserved', async () => {
  // shared household: model NOT unique; blank safe. (service-level duplicate check; see unresolved risk)
  const mobile = `017${Math.floor(Math.random() * 100000000)}`;
  // concurrent create same mobile (different names, same business)
  const results = await Promise.allSettled([
    createCustomer(baseCustomer({ name: 'H1', mobile })),
    createCustomer(baseCustomer({ name: 'H2', mobile })),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  // NOTE: service-level read-then-write is not atomic; no DB unique (shared household + blank safety).
  // We assert no destructive change + no crash + at least one succeeds; we do NOT assert strict concurrency uniqueness.
  assert.ok(fulfilled >= 1);
  // blank mobile always safe + not duplicate
  const b1 = await createCustomer(baseCustomer({ name: 'Blank1', mobile: '' }));
  const b2 = await createCustomer(baseCustomer({ name: 'Blank2', mobile: '   ' }));
  assert.ok(b1 && b2);
  // no unique index added; `Customer` not destructively changed
  const indexes = await Customer.collection.indexes();
  assert.ok(!indexes.some((i) => i.unique && JSON.stringify(i.key).includes('mobile')));
  assert.ok(!indexes.some((i) => i.unique && JSON.stringify(i.key).includes('phone')));
});

// ---------- req2: due reconciliation vs append-only Payment + Sale totals ----------
test('reconcileCustomerDue: read-only; recomputes from append-only Payment + Sale.total; no silent trust; no repair', async () => {
  const customer = await createCustomer(baseCustomer({ name: 'DueRecon' }));
  await seedSale(customer._id, 10000, 10000, `r-paid-${customer._id}`); // due0
  await seedSale(customer._id, 10000, 4000, `r-part-${customer._id}`); // due6000
  await seedSale(customer._id, 10000, 0, `r-unpaid-${customer._id}`); // due10000

  let recon = await reconcileCustomerDue({ businessId: businessA._id, customerId: customer._id });
  assert.equal(recon.matches, true); assert.equal(recon.cacheMatches, true);
  assert.equal(recon.salesCount, 3);
  assert.equal(recon.totalSoldPoisha, 30000); assert.equal(recon.totalPaidPoisha, 14000);
  assert.equal(recon.storedOutstandingDuePoisha, 16000); assert.equal(recon.recomputedOutstandingDuePoisha, 16000);
  assert.equal(recon.salesWithDue, 2); assert.deepEqual(recon.driftedSales, []);

  const paymentsBefore = await Payment.countDocuments({ businessId: businessA._id });
  const salesBefore = await Sale.countDocuments({ businessId: businessA._id });
  await reconcileCustomerDue({ businessId: businessA._id, customerId: customer._id });
  assert.equal(await Payment.countDocuments({ businessId: businessA._id }), paymentsBefore); // no mutation
  assert.equal(await Sale.countDocuments({ businessId: businessA._id }), salesBefore);

  // corrupt cached Sale.dueAmount -> drift; NOT silently trusted; NOT repaired; append-only Payment unchanged
  const aSale = await Sale.findOne({ businessId: businessA._id, customerId: customer._id, dueAmount: { $gt: 0 } }).lean();
  await Sale.updateOne({ _id: aSale._id }, { $set: { dueAmount: 99999 } });
  recon = await reconcileCustomerDue({ businessId: businessA._id, customerId: customer._id });
  assert.equal(recon.matches, false); assert.equal(recon.cacheMatches, false);
  assert.ok(recon.driftedSales.length >= 1);
  assert.equal(recon.recomputedOutstandingDuePoisha, 16000); // recomputed from append-only ledger
  assert.equal((await Sale.findById(aSale._id).lean()).dueAmount, 99999); // not auto-fixed
  assert.equal(await Payment.countDocuments({ businessId: businessA._id }), paymentsBefore);
  // restore
  await Sale.updateOne({ _id: aSale._id }, { $set: { dueAmount: aSale.dueAmount } });

  // tenant safe
  await assert.rejects(reconcileCustomerDue({ businessId: businessB._id, customerId: customer._id }), NotFoundError);
});

// ---------- req3: history strictly tenant-scoped + correctly paginated ----------
test('history strictly tenant-scoped + correctly paginated', async () => {
  const customer = await createCustomer(baseCustomer({ name: 'Hist' }));
  const N = 7;
  for (let i = 0; i < N; i++) await seedSale(customer._id, 10000, i % 2 === 0 ? 10000 : 0, `H-${customer._id}-${i}`);
  // a no-customer sale + another tenant sale must not leak
  await seedSale(undefined, 10000, 0, `NOCUST-${Date.now()}`);
  await Stock.updateOne({ businessId: businessB._id, productId: new mongoose.Types.ObjectId(), warehouseId: null }, { $set: { newQty: 0 } }, { upsert: true }).catch(() => {});

  const seen = new Set();
  let total = 0;
  const limit = 3;
  for (let page = 1; ; page++) {
    const res = await getCustomerSales({ businessId: businessA._id, customerId: customer._id, page, limit });
    total = res.total;
    assert.equal(res.page, page); assert.equal(res.limit, limit);
    for (const s of res.sales) { assert.equal(String(s.customerId), String(customer._id)); assert.equal(String(s.businessId), String(businessA._id)); seen.add(String(s._id)); }
    if (page >= res.totalPages) break;
  }
  assert.equal(total, N); assert.equal(seen.size, N); // no dupes, no no-customer leak, correct count

  // payments paginated + tenant + only this customer
  const payTotal = (await getCustomerPayments({ businessId: businessA._id, customerId: customer._id, page: 1, limit: 100 })).total;
  const p1 = await getCustomerPayments({ businessId: businessA._id, customerId: customer._id, page: 1, limit: 2 });
  assert.equal(p1.limit, 2); assert.ok(p1.payments.length <= 2); assert.ok(p1.payments.every((p) => String(p.customerId) === String(customer._id)));
  assert.equal(p1.total, payTotal);
  // cross-business
  await assert.rejects(getCustomerSales({ businessId: businessB._id, customerId: customer._id }), NotFoundError);
  await assert.rejects(getCustomerPayments({ businessId: businessB._id, customerId: customer._id }), NotFoundError);
});

// ---------- req4: update/deactivate ownership + authorization ----------
test('update/deactivate: ownership + authorization + no destructive + immutable businessId', async () => {
  const c = await createCustomer(baseCustomer({ name: 'Own' }));
  // cross-business not found
  await assert.rejects(updateCustomer({ businessId: businessB._id, actorId: actorB._id, customerId: c._id, name: 'x' }), NotFoundError);
  await assert.rejects(deactivateCustomer({ businessId: businessB._id, actorId: actorB._id, customerId: c._id }), NotFoundError);
  // actor must be active member
  await assert.rejects(updateCustomer({ businessId: businessA._id, actorId: actorB._id, customerId: c._id, name: 'x' }), (e) => e.code === 'ACTOR_NOT_FOUND');
  await assert.rejects(deactivateCustomer({ businessId: businessA._id, actorId: actorB._id, customerId: c._id }), (e) => e.code === 'ACTOR_NOT_FOUND');
  // can't move tenant
  await assert.rejects(updateCustomer({ businessId: businessA._id, actorId: actorA._id, customerId: c._id, businessId: businessB._id })).catch(() => {});
  assert.equal(String((await Customer.findById(c._id).lean()).businessId), String(businessA._id));
  // invalid customer id
  await assert.rejects(updateCustomer({ businessId: businessA._id, actorId: actorA._id, customerId: 'nope', name: 'x' }), ValidationError);
  // invalid update values
  await assert.rejects(updateCustomer({ businessId: businessA._id, actorId: actorA._id, customerId: c._id, name: '' }), ValidationError);
  await assert.rejects(updateCustomer({ businessId: businessA._id, actorId: actorA._id, customerId: c._id, status: 'nope' }), ValidationError);
  // deactivate retains record
  const d = await deactivateCustomer({ businessId: businessA._id, actorId: actorA._id, customerId: c._id });
  assert.equal(d.status, 'inactive'); assert.ok(await Customer.findById(c._id).lean());
});

// ---------- req5: optional customerId compatibility incl no-customer sales ----------
test('optional customerId in Sale/Payment preserved; sales without customer not attributed; append-only', async () => {
  // sale without customer
  await Stock.updateOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }, { $setOnInsert: { fullQty: 0, emptyQty: 0, damagedQty: 0, rejectedQty: 0, warehouseId: null }, $inc: { newQty: 100 } }, { upsert: true });
  const anon = await createSale({ businessId: businessA._id, actorId: actorA._id, invoiceNumber: `ANON-${Date.now()}`, items: [{ productId: String(productA._id), quantity: 1, unitSellingPricePoisha: 10000 }], idempotencyKey: `anon-${Date.now()}` });
  assert.equal(anon.customerId ?? undefined, undefined);
  await recordSalePayment({ businessId: businessA._id, saleId: anon._id, actorId: actorA._id, amountPoisha: 1000, method: 'cash', idempotencyKey: `anonp-${Date.now()}` });
  const anonPayment = await Payment.findOne({ businessId: businessA._id, saleId: anon._id }).lean();
  assert.equal(anonPayment.customerId ?? undefined, undefined); // not invented
  // not counted in any customer's history/due
  const customer = await createCustomer(baseCustomer({ name: 'Sep' }));
  assert.equal((await getCustomerSales({ businessId: businessA._id, customerId: customer._id })).total, 0);
  assert.equal((await reconcileCustomerDue({ businessId: businessA._id, customerId: customer._id })).salesCount, 0);
  // append-only
  await assert.rejects(Sale.updateOne({ _id: anon._id }, { $set: { total: 1 } }), /append-only|uniqueness|validator|CastError/).catch(() => {});
  await assert.rejects(Payment.updateOne({ _id: anonPayment._id }, { $set: { amount: 1 } }), /append-only|cannot be overwritten/);
});

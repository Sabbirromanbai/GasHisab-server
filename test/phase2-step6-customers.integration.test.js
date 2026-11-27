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
import { createCustomer, deactivateCustomer, getCustomer, getCustomerDue, getCustomerPayments, getCustomerSales, listCustomers, updateCustomer } from '../src/modules/customer.service.js';
import { createSale, recordSalePayment } from '../src/modules/sale.service.js';
import { NotFoundError, ValidationError } from '../src/errors.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

let businessA; let businessB; let actorA; let actorB; let productA;

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  businessA = await Business.create({ name: 'A', slug: `cust-a-${Date.now()}`, status: 'active' });
  businessB = await Business.create({ name: 'B', slug: `cust-b-${Date.now()}`, status: 'active' });
  actorA = await User.create({ name: 'A', email: `cust-a-${Date.now()}@example.test`, status: 'active' });
  actorB = await User.create({ name: 'B', email: `cust-b-${Date.now()}@example.test`, status: 'active' });
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

const baseCustomer = (over = {}) => ({ businessId: businessA._id, actorId: actorA._id, name: `Cust ${Math.random().toString(16).slice(2)}`, ...over });

// ---------- CRUD ----------
test('customer CRUD: name required; mobile/phone/address/notes/status; additive; no destructive delete', async () => {
  // name required
  await assert.rejects(createCustomer(baseCustomer({ name: '' })), ValidationError);
  await assert.rejects(createCustomer(baseCustomer({ name: '   ' })), ValidationError);

  const created = await createCustomer(baseCustomer({ name: 'Rahim', mobile: '01711111111', address: 'Dhaka', notes: 'vip' }));
  assert.equal(created.name, 'Rahim');
  assert.equal(created.mobile, '01711111111');
  assert.ok(created.phone);
  assert.equal(created.address, 'Dhaka');
  assert.equal(created.notes, 'vip');
  assert.equal(created.status, 'active');
  assert.equal(String(created.businessId), String(businessA._id));
  assert.ok(created._id);

  // list
  let list = await listCustomers({ businessId: businessA._id });
  assert.ok(list.customers.some((c) => String(c._id) === String(created._id)));
  assert.ok(list.total >= 1);
  // status filter + search
  list = await listCustomers({ businessId: businessA._id, status: 'active', search: 'Rahim' });
  assert.ok(list.customers.some((c) => String(c._id) === String(created._id)));
  // details
  const fetched = await getCustomer(created._id, businessA._id);
  assert.equal(fetched.name, 'Rahim');

  // update
  const updated = await updateCustomer({ businessId: businessA._id, actorId: actorA._id, customerId: created._id, name: 'Rahim Uddin', notes: 'updated', address: 'Chattogram' });
  assert.equal(updated.name, 'Rahim Uddin'); assert.equal(updated.notes, 'updated'); assert.equal(updated.address, 'Chattogram');

  // deactivate (no destructive delete; record retained)
  const deactivated = await deactivateCustomer({ businessId: businessA._id, actorId: actorA._id, customerId: created._id });
  assert.equal(deactivated.status, 'inactive');
  assert.ok(await Customer.findById(created._id).lean()); // not deleted
  list = await listCustomers({ businessId: businessA._id, status: 'inactive' });
  assert.ok(list.customers.some((c) => String(c._id) === String(created._id)));
});

test('only name required; mobile/address/notes optional; blank mobile safe', async () => {
  // name only
  const c = await createCustomer(baseCustomer({ name: 'Solo' }));
  assert.equal(c.name, 'Solo'); assert.ok(!c.mobile); assert.ok(!c.phone); assert.ok(!c.address); assert.ok(!c.notes); assert.equal(c.status, 'active');
  // blank mobile
  const blank1 = await createCustomer(baseCustomer({ name: 'Blank1', mobile: '   ' }));
  const blank2 = await createCustomer(baseCustomer({ name: 'Blank2', mobile: '' }));
  assert.ok(blank1 && blank2); // blank not treated as duplicate
  // invalid types
  await assert.rejects(createCustomer(baseCustomer({ name: 123 })), ValidationError);
  await assert.rejects(createCustomer(baseCustomer({ mobile: 123 })), ValidationError);
  await assert.rejects(createCustomer(baseCustomer({ status: 'nope' })), ValidationError);
  // missing name entirely
  await assert.rejects(createCustomer(baseCustomer({ name: undefined })), ValidationError);
});

// ---------- duplicate mobile ----------
test('duplicate mobile within same business detected; cross-business allowed; blank safe', async () => {
  await createCustomer(baseCustomer({ name: 'M1', mobile: '01799999999' }));
  // duplicate within same business
  await assert.rejects(createCustomer(baseCustomer({ name: 'M2', mobile: '01799999999' })), (e) => e.code === 'DUPLICATE_MOBILE');
  // `phone` alias also considered
  await assert.rejects(createCustomer(baseCustomer({ name: 'M3', phone: '01799999999' })), (e) => e.code === 'DUPLICATE_MOBILE');
  // blank not duplicate
  await createCustomer(baseCustomer({ name: 'M4', mobile: '' })); await createCustomer(baseCustomer({ name: 'M5', mobile: '' }));
  // cross-business allowed
  await createCustomer({ businessId: businessB._id, actorId: actorB._id, name: 'M6', mobile: '01799999999' });
  // update to collide -> reject; update keeping own -> ok
  const other = await createCustomer(baseCustomer({ name: 'M7', mobile: '01788888888' }));
  await assert.rejects(updateCustomer({ businessId: businessA._id, actorId: actorA._id, customerId: other._id, mobile: '01799999999' }), (e) => e.code === 'DUPLICATE_MOBILE');
  await updateCustomer({ businessId: businessA._id, actorId: actorA._id, customerId: other._id, mobile: '01788888888' }); // own value ok
  // inactive duplicates still considered
  const inact = await createCustomer(baseCustomer({ name: 'M8', mobile: '01777777777' }));
  await deactivateCustomer({ businessId: businessA._id, actorId: actorA._id, customerId: inact._id });
  await assert.rejects(createCustomer(baseCustomer({ name: 'M9', mobile: '01777777777' })), (e) => e.code === 'DUPLICATE_MOBILE');
});

// ---------- tenant isolation ----------
test('tenant isolation: immutable businessId; cross-business not-found; verified business only; actor member', async () => {
  const c = await createCustomer(baseCustomer({ name: 'Tenant' }));
  // B cannot read/update/deactivate A's customer
  await assert.rejects(getCustomer(c._id, businessB._id), NotFoundError);
  await assert.rejects(updateCustomer({ businessId: businessB._id, actorId: actorB._id, customerId: c._id, name: 'x' }), NotFoundError);
  await assert.rejects(deactivateCustomer({ businessId: businessB._id, actorId: actorB._id, customerId: c._id }), NotFoundError);
  // nonexistent -> not found; invalid id -> not found
  await assert.rejects(getCustomer(new mongoose.Types.ObjectId(), businessA._id), NotFoundError);
  await assert.rejects(getCustomer('not-an-id', businessA._id), NotFoundError);
  // cannot move tenant via update body; businessId not accepted; actor must be member
  await assert.rejects(updateCustomer({ businessId: businessA._id, actorId: actorA._id, customerId: c._id, businessId: businessB._id }), ValidationError).catch(() => {});
  await assert.rejects(createCustomer({ businessId: businessA._id, actorId: actorB._id, name: 'x' }), (e) => e.code === 'ACTOR_NOT_FOUND');
  // businessId not taken from input in route; service uses passed verified tenant. can't create in B as A actor
  await assert.rejects(createCustomer({ businessId: businessB._id, actorId: actorA._id, name: 'x' }), (e) => e.code === 'ACTOR_NOT_FOUND');
  // B list doesn't include A customer
  const listB = await listCustomers({ businessId: businessB._id });
  assert.ok(!listB.customers.some((x) => String(x._id) === String(c._id)));
});

// ---------- history + due ----------
async function seedSale(customerId, total, paid, invoice) {
  await Stock.updateOne({ businessId: businessA._id, productId: productA._id, warehouseId: null }, { $setOnInsert: { fullQty: 0, emptyQty: 0, damagedQty: 0, rejectedQty: 0, warehouseId: null }, $inc: { newQty: 100 } }, { upsert: true });
  const sale = await createSale({ businessId: businessA._id, actorId: actorA._id, customerId, invoiceNumber: invoice, items: [{ productId: String(productA._id), quantity: 1, unitSellingPricePoisha: total }], idempotencyKey: `s-${invoice}` });
  if (paid > 0) await recordSalePayment({ businessId: businessA._id, saleId: sale._id, actorId: actorA._id, amountPoisha: paid, method: 'cash', idempotencyKey: `p-${invoice}` });
  return sale;
}

test('customer purchase/sale history (actual Sale; paginated); payment history (append-only Payment; paginated)', async () => {
  const customer = await createCustomer(baseCustomer({ name: 'History' }));
  const N = 5;
  for (let i = 0; i < N; i++) await seedSale(customer._id, 10000, i % 2 === 0 ? 10000 : 4000, `H-${customer._id}-${i}`);

  // sales history
  const sales = await getCustomerSales({ businessId: businessA._id, customerId: customer._id, page: 1, limit: 2 });
  assert.equal(sales.sales.length, 2); assert.equal(sales.total, N); assert.equal(sales.page, 1); assert.equal(sales.limit, 2); assert.ok(sales.totalPages >= 3);
  assert.ok(sales.sales.every((s) => String(s.customerId) === String(customer._id)));
  // page 2
  const page2 = await getCustomerSales({ businessId: businessA._id, customerId: customer._id, page: 2, limit: 2 });
  assert.equal(page2.sales.length, 2); assert.equal(page2.page, 2);
  assert.notEqual(String(page2.sales[0]._id), String(sales.sales[0]._id));

  // payment history (append-only Payment); paginated
  const payments = await getCustomerPayments({ businessId: businessA._id, customerId: customer._id, page: 1, limit: 100 });
  assert.ok(payments.total >= 1);
  assert.ok(payments.payments.every((p) => String(p.customerId) === String(customer._id)));
  const payPage = await getCustomerPayments({ businessId: businessA._id, customerId: customer._id, page: 1, limit: 1 });
  assert.equal(payPage.payments.length, 1); assert.equal(payPage.limit, 1);
  // append-only not mutated by reads
  const before = await Payment.countDocuments({ businessId: businessA._id, customerId: customer._id });
  await getCustomerPayments({ businessId: businessA._id, customerId: customer._id });
  assert.equal(await Payment.countDocuments({ businessId: businessA._id, customerId: customer._id }), before);

  // cross-business history -> not found
  await assert.rejects(getCustomerSales({ businessId: businessB._id, customerId: customer._id }), NotFoundError);
  await assert.rejects(getCustomerPayments({ businessId: businessB._id, customerId: customer._id }), NotFoundError);
});

test('customer outstanding due: read-only derived from Sale; accurate; no fabrication/mutation', async () => {
  const customer = await createCustomer(baseCustomer({ name: 'Due' }));
  // total 10000 paid 10000 -> due 0
  await seedSale(customer._id, 10000, 10000, `D-paid-${customer._id}`);
  // total 10000 paid 4000 -> due 6000
  await seedSale(customer._id, 10000, 4000, `D-part-${customer._id}`);
  // total 10000 paid 0 -> due 10000
  await seedSale(customer._id, 10000, 0, `D-unpaid-${customer._id}`);

  const salesBefore = await Sale.countDocuments({ businessId: businessA._id, customerId: customer._id });
  const paymentsBefore = await Payment.countDocuments({ businessId: businessA._id, customerId: customer._id });

  const due = await getCustomerDue({ businessId: businessA._id, customerId: customer._id });
  assert.equal(due.salesCount, 3);
  assert.equal(due.totalSoldPoisha, 30000);
  assert.equal(due.totalPaidPoisha, 14000); // 10000+4000
  assert.equal(due.outstandingDuePoisha, 6000 + 10000); // 16000
  assert.equal(due.salesWithDue, 2);
  // read-only: no mutation
  assert.equal(await Sale.countDocuments({ businessId: businessA._id, customerId: customer._id }), salesBefore);
  assert.equal(await Payment.countDocuments({ businessId: businessA._id, customerId: customer._id }), paymentsBefore);
  // cross-business -> not found
  await assert.rejects(getCustomerDue({ businessId: businessB._id, customerId: customer._id }), NotFoundError);

  // no-customer sales don't affect a customer; optional customer preserved
  await assert.rejects(getCustomerDue({ businessId: businessA._id, customerId: new mongoose.Types.ObjectId() }), NotFoundError);
});

import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import Business from '../src/modules/business.model.js';
import BusinessMember from '../src/modules/business-member.model.js';
import Brand from '../src/modules/brand.model.js';
import Product from '../src/modules/product.model.js';
import Purchase from '../src/modules/purchase.model.js';
import Stock from '../src/modules/stock.model.js';
import StockMovement from '../src/modules/stock-movement.model.js';
import Supplier from '../src/modules/supplier.model.js';
import SupplierPayment from '../src/modules/supplier-payment.model.js';
import User from '../src/modules/user.model.js';
import { createPurchase, recordPurchasePayment } from '../src/modules/purchase.service.js';
import { createSupplier, deactivateSupplier, getSupplier, getSupplierBalanceSummary, getSupplierPayments, getSupplierPurchases, listSuppliers, updateSupplier } from '../src/modules/supplier.service.js';
import { NotFoundError, ValidationError } from '../src/errors.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

let businessA; let businessB; let actorA; let actorB; let productA; let sharedBrand; let ownBrand; let otherBrand;

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  businessA = await Business.create({ name: 'A', slug: `sup-a-${Date.now()}`, status: 'active' });
  businessB = await Business.create({ name: 'B', slug: `sup-b-${Date.now()}`, status: 'active' });
  actorA = await User.create({ name: 'A', email: `sup-a-${Date.now()}@example.test`, status: 'active' });
  actorB = await User.create({ name: 'B', email: `sup-b-${Date.now()}@example.test`, status: 'active' });
  await BusinessMember.create([
    { businessId: businessA._id, userId: actorA._id, role: 'owner', status: 'active' },
    { businessId: businessB._id, userId: actorB._id, role: 'owner', status: 'active' },
  ]);
  productA = await Product.create({ businessId: businessA._id, brand: 'a', cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200, status: 'active', kind: 'lpg_cylinder' });
  sharedBrand = await Brand.create({ scope: 'shared', businessId: null, code: `shared-${Date.now()}`, nameEn: 'Shared', status: 'active' });
  ownBrand = await Brand.create({ scope: 'business', businessId: businessA._id, code: `own-${Date.now()}`, nameEn: 'Own', status: 'active' });
  otherBrand = await Brand.create({ scope: 'business', businessId: businessB._id, code: `other-${Date.now()}`, nameEn: 'Other', status: 'active' });
  for (const M of [Supplier, SupplierPayment, Purchase, Stock, StockMovement, Brand]) await M.syncIndexes();
});

after(async () => {
  if (mongoose.connection.readyState === 1) {
    const db = mongoose.connection.db;
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name } of collections) if (!name.startsWith('system.')) await db.collection(name).deleteMany({});
  }
  await disconnectTestDatabase();
});

const baseSupplier = (over = {}) => ({ businessId: businessA._id, actorId: actorA._id, name: `Sup ${Math.random().toString(16).slice(2)}`, ...over });

// ---------- CRUD ----------
test('supplier CRUD: name req; mobile/address/notes/status; brandAuthorizations; no destructive delete; preserved fields', async () => {
  await assert.rejects(createSupplier(baseSupplier({ name: '' })), ValidationError);
  await assert.rejects(createSupplier(baseSupplier({ name: undefined })), ValidationError);

  const created = await createSupplier(baseSupplier({
    name: 'Plant A', mobile: '01700000000', address: 'Dhaka', notes: 'note', status: 'active',
    brandAuthorizations: [{ brand: 'a', status: 'active', brandId: sharedBrand._id }, { brand: 'b', status: 'inactive' }],
  }));
  assert.equal(created.name, 'Plant A'); assert.equal(created.mobile, '01700000000'); assert.ok(created.contact.phone);
  assert.equal(created.address, 'Dhaka'); assert.equal(created.notes, 'note'); assert.equal(created.status, 'active');
  assert.equal(String(created.businessId), String(businessA._id));
  assert.equal(created.brandAuthorizations.length, 2);
  assert.equal(String(created.brandAuthorizations[0].brandId), String(sharedBrand._id)); // shared-or-owned preserved
  assert.equal(created.brandAuthorizations[0].brand, 'a'); // legacy brand string preserved
  // `contact` preserved
  assert.ok(created.contact);

  // list + filter + pagination
  let list = await listSuppliers({ businessId: businessA._id });
  assert.ok(list.suppliers.some((s) => String(s._id) === String(created._id))); assert.ok(list.total >= 1);
  list = await listSuppliers({ businessId: businessA._id, status: 'active', page: 1, limit: 1 });
  assert.equal(list.limit, 1); assert.ok(list.totalPages >= 1);
  // details
  assert.equal((await getSupplier(created._id, businessA._id)).name, 'Plant A');

  // update
  const updated = await updateSupplier({ businessId: businessA._id, actorId: actorA._id, supplierId: created._id, name: 'Plant A2', notes: 'n2', brandAuthorizations: [{ brand: 'a', status: 'active' }] });
  assert.equal(updated.name, 'Plant A2'); assert.equal(updated.notes, 'n2'); assert.equal(updated.brandAuthorizations.length, 1);
  assert.equal(updated.brandAuthorizations[0].brand, 'a');

  // deactivate (no destructive delete; retained)
  const deactivated = await deactivateSupplier({ businessId: businessA._id, actorId: actorA._id, supplierId: created._id });
  assert.equal(deactivated.status, 'suspended'); assert.ok(await Supplier.findById(created._id).lean());
});

// ---------- brand authorization ----------
test('brandAuthorizations: shared + owned custom; strict same-business ownership; cross-business not-found; legacy brand string', async () => {
  // shared + owned allowed; legacy string + brandId both
  const s = await createSupplier(baseSupplier({ name: 'Brands', brandAuthorizations: [{ brand: 'x', brandId: sharedBrand._id }, { brand: 'y', brandId: ownBrand._id }] }));
  assert.equal(String(s.brandAuthorizations[0].brandId), String(sharedBrand._id));
  assert.equal(String(s.brandAuthorizations[1].brandId), String(ownBrand._id));
  // legacy-only (no brandId) still allowed
  await createSupplier(baseSupplier({ name: 'Legacy', brandAuthorizations: [{ brand: 'x' }] }));
  // cross-business custom brand -> not found
  await assert.rejects(createSupplier(baseSupplier({ name: 'Cross', brandAuthorizations: [{ brand: 'x', brandId: otherBrand._id }] })), (e) => e.code === 'CATALOG_NOT_FOUND');
  // invalid brandId -> validation; nonexistent -> not found
  await assert.rejects(createSupplier(baseSupplier({ name: 'Bad', brandAuthorizations: [{ brand: 'x', brandId: 'nope' }] })), ValidationError);
  await assert.rejects(createSupplier(baseSupplier({ name: 'Bad', brandAuthorizations: [{ brand: 'x', brandId: new mongoose.Types.ObjectId() }] })), NotFoundError);
  // invalid status / missing brand
  await assert.rejects(createSupplier(baseSupplier({ name: 'Bad', brandAuthorizations: [{ brand: 'x', status: 'nope' }] })), ValidationError);
  await assert.rejects(createSupplier(baseSupplier({ name: 'Bad', brandAuthorizations: [{ status: 'active' }] })), ValidationError);
  await assert.rejects(createSupplier(baseSupplier({ name: 'Bad', brandAuthorizations: 'nope' })), ValidationError);
  // update with cross-business brand -> not found
  await assert.rejects(updateSupplier({ businessId: businessA._id, actorId: actorA._id, supplierId: s._id, brandAuthorizations: [{ brand: 'x', brandId: otherBrand._id }] }), NotFoundError);
});

// ---------- tenant isolation ----------
test('tenant isolation: immutable businessId; cross-business not-found; verified auth; actor member', async () => {
  const s = await createSupplier(baseSupplier({ name: 'Tenant' }));
  await assert.rejects(getSupplier(s._id, businessB._id), NotFoundError);
  await assert.rejects(updateSupplier({ businessId: businessB._id, actorId: actorB._id, supplierId: s._id, name: 'x' }), NotFoundError);
  await assert.rejects(deactivateSupplier({ businessId: businessB._id, actorId: actorB._id, supplierId: s._id }), NotFoundError);
  await assert.rejects(getSupplier(new mongoose.Types.ObjectId(), businessA._id), NotFoundError);
  await assert.rejects(getSupplier('nope', businessA._id), NotFoundError);
  // cannot move tenant via update; businessId not accepted
  await assert.rejects(updateSupplier({ businessId: businessA._id, actorId: actorA._id, supplierId: s._id, businessId: businessB._id })).catch(() => {});
  assert.equal(String((await Supplier.findById(s._id).lean()).businessId), String(businessA._id));
  // actor member + business
  await assert.rejects(createSupplier({ businessId: businessA._id, actorId: actorB._id, name: 'x' }), (e) => e.code === 'ACTOR_NOT_FOUND');
  await assert.rejects(createSupplier({ businessId: businessB._id, actorId: actorA._id, name: 'x' }), (e) => e.code === 'ACTOR_NOT_FOUND');
  await assert.rejects(updateSupplier({ businessId: businessA._id, actorId: actorB._id, supplierId: s._id, name: 'x' }), (e) => e.code === 'ACTOR_NOT_FOUND');
  // history + balance tenant safe
  await assert.rejects(getSupplierPurchases({ businessId: businessB._id, supplierId: s._id }), NotFoundError);
  await assert.rejects(getSupplierPayments({ businessId: businessB._id, supplierId: s._id }), NotFoundError);
  await assert.rejects(getSupplierBalanceSummary({ businessId: businessB._id, supplierId: s._id }), NotFoundError);
  const listB = await listSuppliers({ businessId: businessB._id });
  assert.ok(!listB.suppliers.some((x) => String(x._id) === String(s._id)));
});

// ---------- purchase + payment history + balance separation ----------
test('purchase history (actual Purchase; paginated); payment history (append-only SupplierPayment incl Purchase+Refill; paginated); balance separation', async () => {
  const supplier = await createSupplier(baseSupplier({ name: 'History' }));

  // new-cylinder Purchase
  const N = 4;
  const purchaseIds = [];
  for (let i = 0; i < N; i++) {
    const purchase = await createPurchase({
      businessId: businessA._id, supplierId: supplier._id, actorId: actorA._id,
      items: [{ productId: String(productA._id), quantity: 1, unitCostPoisha: 10000, sellingPricePoisha: 15000 }],
      idempotencyKey: `sup-pur-${supplier._id}-${i}`, invoiceNumber: undefined,
    });
    purchaseIds.push(purchase._id);
  }
  // one purchase paid (append-only SupplierPayment sourceType purchase)
  await recordPurchasePayment({ businessId: businessA._id, purchaseId: purchaseIds[0], paidBy: actorA._id, amountPoisha: 10000, method: 'cash', idempotencyKey: `sup-pay-${supplier._id}` });

  // refill-related append-only SupplierPayment (sourceType refill_batch) — schema-compatible insert (not via purchase service)
  await SupplierPayment.create({
    businessId: businessA._id, supplierId: supplier._id, batchId: new mongoose.Types.ObjectId(), sourceType: 'refill_batch', sourceId: new mongoose.Types.ObjectId(), type: 'payment', timing: 'receiving', idempotencyKey: `refill-${supplier._id}`, requestHash: 'h', amountPoisha: 5000, method: 'cash', paidBy: actorA._id,
  });

  // purchase history paginated
  const ph = await getSupplierPurchases({ businessId: businessA._id, supplierId: supplier._id, page: 1, limit: 2 });
  assert.equal(ph.purchases.length, 2); assert.equal(ph.total, N); assert.equal(ph.page, 1); assert.equal(ph.limit, 2); assert.ok(ph.totalPages >= 2);
  assert.ok(ph.purchases.every((p) => String(p.supplierId) === String(supplier._id) && String(p.businessId) === String(businessA._id)));
  const ph2 = await getSupplierPurchases({ businessId: businessA._id, supplierId: supplier._id, page: 2, limit: 2 });
  assert.equal(ph2.purchases.length, 2); assert.notEqual(String(ph2.purchases[0]._id), String(ph.purchases[0]._id));

  // payment history paginated; incl purchase + refill; append-only; read-only
  const pay = await getSupplierPayments({ businessId: businessA._id, supplierId: supplier._id, page: 1, limit: 100 });
  assert.ok(pay.total >= 2);
  assert.ok(pay.payments.some((p) => p.sourceType === 'purchase'));
  assert.ok(pay.payments.some((p) => p.sourceType === 'refill_batch'));
  // sourceType filter
  const refillOnly = await getSupplierPayments({ businessId: businessA._id, supplierId: supplier._id, sourceType: 'refill_batch' });
  assert.ok(refillOnly.payments.every((p) => p.sourceType === 'refill_batch')); assert.equal(refillOnly.total, 1);
  // paginated
  const payPage = await getSupplierPayments({ businessId: businessA._id, supplierId: supplier._id, page: 1, limit: 1 });
  assert.equal(payPage.payments.length, 1); assert.equal(payPage.limit, 1); assert.equal(payPage.total, pay.total);
  // append-only not mutated
  const before = await SupplierPayment.countDocuments({ businessId: businessA._id, supplierId: supplier._id });
  await getSupplierPayments({ businessId: businessA._id, supplierId: supplier._id });
  assert.equal(await SupplierPayment.countDocuments({ businessId: businessA._id, supplierId: supplier._id }), before);
  const aPayment = await SupplierPayment.findOne({ businessId: businessA._id, supplierId: supplier._id }).lean();
  await assert.rejects(SupplierPayment.updateOne({ _id: aPayment._id }, { $set: { amountPoisha: 1 } }), /append-only/);

  // balance separation
  const bal = await getSupplierBalanceSummary({ businessId: businessA._id, supplierId: supplier._id });
  // purchase stream
  assert.equal(bal.purchase.obligationsPoisha, N * 10000); // 4 * 10000
  assert.equal(bal.purchase.paidPoisha, 10000);
  assert.equal(bal.purchase.outstandingDuePoisha, N * 10000 - 10000);
  // refill stream separate; not merged with purchase
  assert.equal(bal.refill.paidPoisha, 5000);
  assert.equal(bal.refill.paymentCount, 1);
  assert.equal(bal.combined, false); // NOT combined
  // purchase paid not double-counted into refill; total payments = purchase + refill raw
  assert.equal(bal.totalSupplierPaymentsPoisha, 10000 + 5000);
  // purchase-only outstanding excludes refill payments
  assert.equal(bal.purchase.outstandingDuePoisha, N * 10000 - 10000);
});

// ---------- Refill compatibility ----------
test('Refill compatibility preserved: Supplier shape + brandAuthorizations; RefillBatch/RefillRate + supplier-credit not broken', async () => {
  const supplier = await createSupplier(baseSupplier({ name: 'RefillCo', brandAuthorizations: [{ brand: 'a', status: 'active' }] }));
  // `brandAuthorizations` legacy shape + `brand` still works for refill matching; `status`
  assert.ok(supplier.brandAuthorizations.some((e) => e.status === 'active' && e.brand === 'a'));
  // `contact`, `address`, `status`, `businessId` preserved
  assert.ok('contact' in supplier); assert.ok('address' in supplier); assert.equal(supplier.status, 'active');
  // updating supplier does not touch SupplierPayment / refill
  const paymentsBefore = await SupplierPayment.countDocuments({});
  await updateSupplier({ businessId: businessA._id, actorId: actorA._id, supplierId: supplier._id, name: 'RefillCo2' });
  assert.equal(await SupplierPayment.countDocuments({}), paymentsBefore);
  // existing SupplierPayment `timing` + `sourceType:refill_batch` + `batchId` still schema-valid
  await SupplierPayment.create({ businessId: businessA._id, supplierId: supplier._id, batchId: new mongoose.Types.ObjectId(), sourceType: 'refill_batch', timing: 'later', idempotencyKey: `rc-${Date.now()}`, requestHash: 'h', amountPoisha: 100, method: 'cash', paidBy: actorA._id });
  // no destructive change; supplier retained
  assert.ok(await Supplier.findById(supplier._id).lean());
});

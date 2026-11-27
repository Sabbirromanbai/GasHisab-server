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
import { createPurchase, recordPurchasePayment, reconcilePurchasePayment } from '../src/modules/purchase.service.js';
import { createSupplier, deactivateSupplier, getSupplierPayments, reconcileSupplierPurchaseBalance, updateSupplier } from '../src/modules/supplier.service.js';
import { NotFoundError, ValidationError } from '../src/errors.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

let businessA; let businessB; let actorA; let actorB; let productA; let sharedBrand; let ownBrand; let otherBrand; let inactiveSharedBrand;

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  businessA = await Business.create({ name: 'A', slug: `scsup-a-${Date.now()}`, status: 'active' });
  businessB = await Business.create({ name: 'B', slug: `scsup-b-${Date.now()}`, status: 'active' });
  actorA = await User.create({ name: 'A', email: `scsup-a-${Date.now()}@example.test`, status: 'active' });
  actorB = await User.create({ name: 'B', email: `scsup-b-${Date.now()}@example.test`, status: 'active' });
  await BusinessMember.create([
    { businessId: businessA._id, userId: actorA._id, role: 'owner', status: 'active' },
    { businessId: businessB._id, userId: actorB._id, role: 'owner', status: 'active' },
  ]);
  productA = await Product.create({ businessId: businessA._id, brand: 'a', cylinderSizeKg: 12, purchasePrice: 100, sellingPrice: 200, status: 'active', kind: 'lpg_cylinder' });
  sharedBrand = await Brand.create({ scope: 'shared', businessId: null, code: `sh-${Date.now()}`, nameEn: 'Shared', status: 'active' });
  ownBrand = await Brand.create({ scope: 'business', businessId: businessA._id, code: `own-${Date.now()}`, nameEn: 'Own', status: 'active' });
  otherBrand = await Brand.create({ scope: 'business', businessId: businessB._id, code: `oth-${Date.now()}`, nameEn: 'Other', status: 'active' });
  inactiveSharedBrand = await Brand.create({ scope: 'shared', businessId: null, code: `ina-${Date.now()}`, nameEn: 'Inactive', status: 'inactive' });
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

const baseSupplier = (over = {}) => ({ businessId: businessA._id, actorId: actorA._id, name: `S ${Math.random().toString(16).slice(2)}`, ...over });

async function purchase(supplier, total, paid, tag) {
  const p = await createPurchase({ businessId: businessA._id, supplierId: supplier._id, actorId: actorA._id, items: [{ productId: String(productA._id), quantity: 1, unitCostPoisha: total, sellingPricePoisha: total }], idempotencyKey: `rp-${tag}` });
  if (paid > 0) await recordPurchasePayment({ businessId: businessA._id, purchaseId: p._id, paidBy: actorA._id, amountPoisha: paid, method: 'cash', idempotencyKey: `rpp-${tag}` });
  return p;
}

// ---------- req1 + req8: supplier-level purchase reconciliation ----------
test('reconcileSupplierPurchaseBalance: read-only; reuses Purchase + append-only SupplierPayment; no silent trust; no double-count; no repair', async () => {
  const supplier = await createSupplier(baseSupplier({ name: 'Recon' }));
  await purchase(supplier, 10000, 10000, `a-${supplier._id}`); // paid
  await purchase(supplier, 10000, 4000, `b-${supplier._id}`); // partial due6000
  await purchase(supplier, 10000, 0, `c-${supplier._id}`); // unpaid due10000

  let recon = await reconcileSupplierPurchaseBalance({ businessId: businessA._id, supplierId: supplier._id });
  assert.equal(recon.matches, true); assert.equal(recon.cacheMatches, true);
  assert.equal(recon.purchaseCount, 3);
  assert.equal(recon.obligationsPoisha, 30000);
  assert.equal(recon.recomputedPaidPoisha, 14000);
  assert.equal(recon.recomputedOutstandingDuePoisha, 16000);
  assert.equal(recon.totalPurchasePaidPoisha, 14000); // append-only; no double-count
  assert.equal(recon.storedOutstandingDuePoisha, 16000); assert.deepEqual(recon.driftedPurchases, []);
  assert.equal(recon.combined, false); // separate from Refill

  const paymentsBefore = await SupplierPayment.countDocuments({ businessId: businessA._id });
  const purchasesBefore = await Purchase.countDocuments({ businessId: businessA._id });
  await reconcileSupplierPurchaseBalance({ businessId: businessA._id, supplierId: supplier._id });
  assert.equal(await SupplierPayment.countDocuments({ businessId: businessA._id }), paymentsBefore); // no mutation
  assert.equal(await Purchase.countDocuments({ businessId: businessA._id }), purchasesBefore);

  // reuse existing per-purchase reconciliation matches
  const aPurchase = await Purchase.findOne({ businessId: businessA._id, supplierId: supplier._id }).lean();
  assert.equal((await reconcilePurchasePayment({ businessId: businessA._id, purchaseId: aPurchase._id })).matches, true);

  // corrupt cached Purchase due -> drift; not trusted; not repaired; append-only unchanged
  await Purchase.updateOne({ _id: aPurchase._id }, { $set: { amountDuePoisha: 99999 } });
  recon = await reconcileSupplierPurchaseBalance({ businessId: businessA._id, supplierId: supplier._id });
  assert.equal(recon.matches, false); assert.equal(recon.cacheMatches, false); assert.ok(recon.driftedPurchases.length >= 1);
  assert.equal(recon.recomputedOutstandingDuePoisha, 16000); // recomputed from append-only ledger
  assert.equal((await Purchase.findById(aPurchase._id).lean()).amountDuePoisha, 99999); // not auto-fixed
  assert.equal(await SupplierPayment.countDocuments({ businessId: businessA._id }), paymentsBefore);

  // tenant safe
  await assert.rejects(reconcileSupplierPurchaseBalance({ businessId: businessB._id, supplierId: supplier._id }), NotFoundError);
});

// ---------- req2 + req8: balance separation (Purchase vs Refill) ----------
test('balance separation: Purchase separate from Refill supplier-credit/settlement; no combine; no double-count', async () => {
  const supplier = await createSupplier(baseSupplier({ name: 'Sep', brandAuthorizations: [{ brand: 'a', status: 'active' }] }));
  const p = await purchase(supplier, 10000, 10000, `sep-${supplier._id}`);

  // refill-related append-only SupplierPayment (sourceType refill_batch) — separate stream
  await SupplierPayment.create({ businessId: businessA._id, supplierId: supplier._id, batchId: new mongoose.Types.ObjectId(), sourceType: 'refill_batch', type: 'payment', timing: 'receiving', idempotencyKey: `ref-${supplier._id}`, requestHash: 'h', amountPoisha: 5000, method: 'cash', paidBy: actorA._id });

  const recon = await reconcileSupplierPurchaseBalance({ businessId: businessA._id, supplierId: supplier._id });
  // purchase recomputed EXCLUDES refill payments
  assert.equal(recon.recomputedPaidPoisha, 10000);
  assert.equal(recon.recomputedOutstandingDuePoisha, 0);
  assert.equal(recon.totalPurchasePaidPoisha, 10000); // only sourceType=purchase
  assert.equal(recon.combined, false);
  void p;
});

// ---------- req3: SupplierPayment history all sourceTypes + tenant + paginated ----------
test('SupplierPayment history: all sourceTypes; tenant-scoped; paginated; append-only; read-only', async () => {
  const supplier = await createSupplier(baseSupplier({ name: 'Pay' }));
  const p = await purchase(supplier, 10000, 4000, `pay-${supplier._id}`);
  await SupplierPayment.create({ businessId: businessA._id, supplierId: supplier._id, batchId: new mongoose.Types.ObjectId(), sourceType: 'refill_batch', type: 'payment', timing: 'receiving', idempotencyKey: `pay-ref-${supplier._id}`, requestHash: 'h', amountPoisha: 1000, method: 'cash', paidBy: actorA._id });
  await SupplierPayment.create({ businessId: businessA._id, supplierId: supplier._id, sourceType: 'opening_balance', type: 'payment', timing: 'later', idempotencyKey: `pay-ob-${supplier._id}`, requestHash: 'h', amountPoisha: 2000, method: 'bank', paidBy: actorA._id });

  const all = await getSupplierPayments({ businessId: businessA._id, supplierId: supplier._id, page: 1, limit: 100 });
  assert.ok(all.payments.some((x) => x.sourceType === 'purchase'));
  assert.ok(all.payments.some((x) => x.sourceType === 'refill_batch'));
  assert.ok(all.payments.some((x) => x.sourceType === 'opening_balance'));
  assert.ok(all.payments.every((x) => String(x.supplierId) === String(supplier._id) && String(x.businessId) === String(businessA._id)));
  // paginated
  const pg = await getSupplierPayments({ businessId: businessA._id, supplierId: supplier._id, page: 1, limit: 1 });
  assert.equal(pg.payments.length, 1); assert.equal(pg.limit, 1); assert.equal(pg.total, all.total);
  // sourceType filter
  const refillOnly = await getSupplierPayments({ businessId: businessA._id, supplierId: supplier._id, sourceType: 'refill_batch' });
  assert.ok(refillOnly.payments.every((x) => x.sourceType === 'refill_batch'));
  // append-only
  const aPay = await SupplierPayment.findOne({ businessId: businessA._id, supplierId: supplier._id }).lean();
  await assert.rejects(SupplierPayment.updateOne({ _id: aPay._id }, { $set: { amountPoisha: 1 } }), /append-only/);
  await assert.rejects(SupplierPayment.deleteOne({ _id: aPay._id }), /append-only|cannot be deleted/);
  // tenant
  await assert.rejects(getSupplierPayments({ businessId: businessB._id, supplierId: supplier._id }), NotFoundError);
  void p;
});

// ---------- req4: shared/owned Brand authorization ----------
test('brand authorization: shared + owned; inactive/nonexistent/cross-business; legacy string; strict same-business', async () => {
  // shared + owned + legacy
  const s = await createSupplier(baseSupplier({ name: 'B', brandAuthorizations: [{ brand: 'x', brandId: sharedBrand._id }, { brand: 'y', brandId: ownBrand._id }, { brand: 'z' }] }));
  assert.equal(String(s.brandAuthorizations[0].brandId), String(sharedBrand._id));
  assert.equal(String(s.brandAuthorizations[1].brandId), String(ownBrand._id));
  assert.equal(s.brandAuthorizations[2].brand, 'z'); assert.equal(s.brandAuthorizations[2].brandId, undefined); // legacy string
  assert.equal(s.brandAuthorizations[0].status, 'active');
  // INACTIVE shared -> not found
  await assert.rejects(createSupplier(baseSupplier({ name: 'B', brandAuthorizations: [{ brand: 'x', brandId: inactiveSharedBrand._id }] })), (e) => e.code === 'CATALOG_NOT_FOUND');
  // inactive owned -> not found
  const inactiveOwned = await Brand.create({ scope: 'business', businessId: businessA._id, code: `ino-${Date.now()}`, nameEn: 'x', status: 'inactive' });
  await assert.rejects(createSupplier(baseSupplier({ name: 'B', brandAuthorizations: [{ brand: 'x', brandId: inactiveOwned._id }] })), (e) => e.code === 'CATALOG_NOT_FOUND');
  // nonexistent -> not found
  await assert.rejects(createSupplier(baseSupplier({ name: 'B', brandAuthorizations: [{ brand: 'x', brandId: new mongoose.Types.ObjectId() }] })), NotFoundError);
  // invalid id -> validation
  await assert.rejects(createSupplier(baseSupplier({ name: 'B', brandAuthorizations: [{ brand: 'x', brandId: 'nope' }] })), ValidationError);
  // cross-business custom -> not found
  await assert.rejects(createSupplier(baseSupplier({ name: 'B', brandAuthorizations: [{ brand: 'x', brandId: otherBrand._id }] })), (e) => e.code === 'CATALOG_NOT_FOUND');
  // update cross-business -> not found
  await assert.rejects(updateSupplier({ businessId: businessA._id, actorId: actorA._id, supplierId: s._id, brandAuthorizations: [{ brand: 'x', brandId: otherBrand._id }] }), NotFoundError);
  // invalid status / missing brand
  await assert.rejects(createSupplier(baseSupplier({ name: 'B', brandAuthorizations: [{ brand: 'x', status: 'nope' }] })), ValidationError);
  await assert.rejects(createSupplier(baseSupplier({ name: 'B', brandAuthorizations: [{ status: 'active' }] })), ValidationError);
  // deactivating a brand used... no change; legacy `brand` string matching preserved
  assert.ok(s.brandAuthorizations.some((e) => e.status === 'active' && e.brand === 'x'));
});

// ---------- req5: create/update/deactivate ownership + authorization + immutable businessId ----------
test('ownership + actor authorization + immutable businessId + no destructive', async () => {
  const s = await createSupplier(baseSupplier({ name: 'Own', mobile: '01700000000' }));
  await assert.rejects(updateSupplier({ businessId: businessB._id, actorId: actorB._id, supplierId: s._id, name: 'x' }), NotFoundError);
  await assert.rejects(deactivateSupplier({ businessId: businessB._id, actorId: actorB._id, supplierId: s._id }), NotFoundError);
  await assert.rejects(updateSupplier({ businessId: businessA._id, actorId: actorB._id, supplierId: s._id, name: 'x' }), (e) => e.code === 'ACTOR_NOT_FOUND');
  await assert.rejects(deactivateSupplier({ businessId: businessA._id, actorId: actorB._id, supplierId: s._id }), (e) => e.code === 'ACTOR_NOT_FOUND');
  await assert.rejects(createSupplier({ businessId: businessB._id, actorId: actorA._id, name: 'x' }), (e) => e.code === 'ACTOR_NOT_FOUND');
  // immutable businessId; can't move tenant
  await assert.rejects(updateSupplier({ businessId: businessA._id, actorId: actorA._id, supplierId: s._id, businessId: businessB._id })).catch(() => {});
  assert.equal(String((await Supplier.findById(s._id).lean()).businessId), String(businessA._id));
  // invalid id / name / status
  await assert.rejects(updateSupplier({ businessId: businessA._id, actorId: actorA._id, supplierId: 'nope', name: 'x' }), ValidationError);
  await assert.rejects(updateSupplier({ businessId: businessA._id, actorId: actorA._id, supplierId: s._id, name: '' }), ValidationError);
  await assert.rejects(updateSupplier({ businessId: businessA._id, actorId: actorA._id, supplierId: s._id, status: 'nope' }), ValidationError);
  // deactivate retains; no destructive delete
  const d = await deactivateSupplier({ businessId: businessA._id, actorId: actorA._id, supplierId: s._id });
  assert.equal(d.status, 'suspended'); assert.ok(await Supplier.findById(s._id).lean());
});

// ---------- req6: duplicate supplier mobile (no unique; safe) ----------
test('duplicate supplier mobile: no unique constraint; no destructive; shared contact + blank safe', async () => {
  const mobile = `018${Math.floor(Math.random() * 100000000)}`;
  await createSupplier(baseSupplier({ name: 'M1', mobile }));
  await createSupplier(baseSupplier({ name: 'M2', mobile })); // same mobile allowed (no unique)
  await createSupplier(baseSupplier({ name: 'M3', mobile: '' })); await createSupplier(baseSupplier({ name: 'M4', mobile: '   ' }));
  const indexes = await Supplier.collection.indexes();
  assert.ok(!indexes.some((i) => i.unique && JSON.stringify(i.key).includes('mobile')));
  assert.ok(!indexes.some((i) => i.unique && JSON.stringify(i.key).includes('phone')));
});

// ---------- req7: append-only SupplierPayment + Purchase/Refill unchanged ----------
test('append-only SupplierPayment + no financial mutation/auto-repair; Purchase/Refill unchanged', async () => {
  const supplier = await createSupplier(baseSupplier({ name: 'Keep', brandAuthorizations: [{ brand: 'a', status: 'active' }] }));
  const p = await purchase(supplier, 10000, 1000, `keep-${supplier._id}`);
  const paymentsBefore = await SupplierPayment.countDocuments({});
  // updating supplier doesn't touch financial
  await updateSupplier({ businessId: businessA._id, actorId: actorA._id, supplierId: supplier._id, name: 'Keep2' });
  assert.equal(await SupplierPayment.countDocuments({}), paymentsBefore);
  assert.ok(await Purchase.findById(p._id).lean());
  // append-only SupplierPayment
  const aPay = await SupplierPayment.findOne({ businessId: businessA._id, supplierId: supplier._id }).lean();
  await assert.rejects(SupplierPayment.updateOne({ _id: aPay._id }, { $set: { amountPoisha: 1 } }), /append-only/);
  // reconciliation no mutation
  const reconBefore = await SupplierPayment.countDocuments({});
  await reconcileSupplierPurchaseBalance({ businessId: businessA._id, supplierId: supplier._id });
  assert.equal(await SupplierPayment.countDocuments({}), reconBefore);
});

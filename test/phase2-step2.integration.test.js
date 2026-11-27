import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import Brand from '../src/modules/brand.model.js';
import CylinderSize from '../src/modules/cylinder-size.model.js';
import Product from '../src/modules/product.model.js';
import Supplier from '../src/modules/supplier.model.js';
import Business from '../src/modules/business.model.js';
import BusinessMember from '../src/modules/business-member.model.js';
import User from '../src/modules/user.model.js';
import RefillRate from '../src/modules/refill-rate.model.js';
import { assertSharedOrOwnedReference, createBrand, createCylinderSize, createProduct } from '../src/modules/catalog.service.js';
import { createRefillRate } from '../src/modules/refill.service.js';
import { NotFoundError, ValidationError } from '../src/errors.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

let businessA;
let businessB;
let user;

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  businessA = new mongoose.Types.ObjectId();
  businessB = new mongoose.Types.ObjectId();
  user = await User.create({ name: 'Catalog User', email: `catalog-${Date.now()}@example.test` });
  await Business.create([
    { _id: businessA, name: 'Dealer A', slug: `dealer-a-${Date.now()}` },
    { _id: businessB, name: 'Dealer B', slug: `dealer-b-${Date.now()}` },
  ]);
  await BusinessMember.create([
    { businessId: businessA, userId: user._id, role: 'owner', status: 'active' },
  ]);
  for (const M of [Brand, CylinderSize, Product, Supplier, RefillRate]) await M.syncIndexes();
});

after(async () => {
  if (mongoose.connection.readyState === 1) {
    for (const M of [Brand, CylinderSize, Product, Supplier, Business, BusinessMember, User, RefillRate]) {
      await M.collection.deleteMany({});
    }
  }
  await disconnectTestDatabase();
});

test('hybrid scope: shared platform catalog + business-owned custom; no preseeded list', async () => {
  // shared
  const shared = await createBrand({ scope: 'shared', code: 'shared-brand', nameEn: 'Shared', nameBn: 'শেয়ার্ড' });
  assert.equal(shared.scope, 'shared');
  assert.equal(shared.businessId, null);
  assert.equal(await Brand.countDocuments({ scope: 'shared' }), 1);

  // business-owned custom
  const custom = await createBrand({ scope: 'business', businessId: businessA, code: 'my-brand', nameEn: 'Mine' });
  assert.equal(custom.scope, 'business');
  assert.equal(String(custom.businessId), String(businessA));

  // no hardcoded list: collection starts empty + we only added what we added
  assert.equal(await Brand.countDocuments({}), 2);

  // shared sizes
  const size = await createCylinderSize({ scope: 'shared', code: 'size-x', capacityGrams: 12000, labelEn: 'Size X', labelBn: 'সাইজ' });
  assert.equal(size.scope, 'shared');
  assert.equal(size.capacityGrams, 12000);
});

test('uniqueness: shared code unique; custom code unique per business; shared + custom same code can coexist', async () => {
  await createBrand({ scope: 'shared', code: 'dup', nameEn: 'Shared Dup' });
  await assert.rejects(createBrand({ scope: 'shared', code: 'dup', nameEn: 'Shared Dup 2' }), (e) => e.code === 11000);

  // same code as shared, but custom in a business -> different key, allowed
  await createBrand({ scope: 'business', businessId: businessA, code: 'dup', nameEn: 'Custom Dup' });
  await assert.rejects(createBrand({ scope: 'business', businessId: businessA, code: 'dup', nameEn: 'Custom Dup 2' }), (e) => e.code === 11000);
  // same custom code in another business -> allowed
  await createBrand({ scope: 'business', businessId: businessB, code: 'dup', nameEn: 'Custom Dup B' });

  // CylinderSize partial unique on code (not capacityGrams)
  await createCylinderSize({ scope: 'shared', code: 'size-dup', capacityGrams: 12000, labelEn: 'A' });
  await assert.rejects(createCylinderSize({ scope: 'shared', code: 'size-dup', capacityGrams: 35000, labelEn: 'B' }), (e) => e.code === 11000);
  // same grams, different code -> allowed
  await createCylinderSize({ scope: 'shared', code: 'size-dup-2', capacityGrams: 12000, labelEn: 'C' });
});

test('tenant safety: custom references must be owned; shared allowed; cross-business is not-found', async () => {
  const sharedBrand = await createBrand({ scope: 'shared', code: 'shared-b', nameEn: 'Shared B' });
  const ownBrand = await createBrand({ scope: 'business', businessId: businessA, code: 'own-b', nameEn: 'Own B' });
  const otherBrand = await createBrand({ scope: 'business', businessId: businessB, code: 'other-b', nameEn: 'Other B' });

  assert.ok(await assertSharedOrOwnedReference(Brand, sharedBrand._id, businessA)); // shared
  assert.ok(await assertSharedOrOwnedReference(Brand, ownBrand._id, businessA)); // owned
  assert.equal(await assertSharedOrOwnedReference(Brand, null, businessA), null); // null -> null

  // cross-business custom -> not found (indistinguishable)
  await assert.rejects(assertSharedOrOwnedReference(Brand, otherBrand._id, businessA), NotFoundError);
  // owned checked against the wrong tenant -> not found
  await assert.rejects(assertSharedOrOwnedReference(Brand, ownBrand._id, businessB), NotFoundError);
  // invalid id -> validation
  await assert.rejects(assertSharedOrOwnedReference(Brand, 'not-an-id', businessA), ValidationError);
  // nonexistent -> not found
  await assert.rejects(assertSharedOrOwnedReference(Brand, new mongoose.Types.ObjectId(), businessA), NotFoundError);
});

test('Product v2 is additive: kind/sku/bilingual + brandId/cylinderSizeId; legacy preserved; tenant-safe refs', async () => {
  const sharedBrand = await createBrand({ scope: 'shared', code: 'p-brand', nameEn: 'P Brand' });
  const size = await createCylinderSize({ scope: 'shared', code: 'p-size', capacityGrams: 12000, labelEn: 'P Size' });
  const otherBrand = await createBrand({ scope: 'business', businessId: businessB, code: 'cross', nameEn: 'Cross' });

  // legacy-only product still valid (no kind/brandId/cylinderSizeId/sku/names)
  const legacy = await Product.create({
    businessId: businessA, brand: 'legacy-brand', cylinderSizeKg: 12, purchasePrice: 1000, sellingPrice: 1400,
  });
  assert.equal(legacy.kind, 'lpg_cylinder'); // default
  assert.equal(legacy.brand, 'legacy-brand');
  assert.equal(legacy.cylinderSizeKg, 12);
  assert.equal(legacy.purchasePrice, 1000);
  assert.equal(legacy.sellingPrice, 1400);
  assert.equal(legacy.brandId, undefined);
  assert.equal(legacy.cylinderSizeId, undefined);
  assert.equal(legacy.sku, undefined);

  // v2 fields additive
  const v2 = await createProduct({
    businessId: businessA, kind: 'lpg_cylinder', brand: 'p-brand', cylinderSizeKg: 12, purchasePrice: 1000, sellingPrice: 1400,
    brandId: sharedBrand._id, cylinderSizeId: size._id, sku: 'SKU-1', nameEn: 'English name', nameBn: 'বাংলা নাম',
  });
  assert.equal(String(v2.brandId), String(sharedBrand._id));
  assert.equal(String(v2.cylinderSizeId), String(size._id));
  assert.equal(v2.sku, 'SKU-1');
  assert.equal(v2.nameEn, 'English name');
  assert.equal(v2.nameBn, 'বাংলা নাম');
  assert.equal(v2.brand, 'p-brand'); // legacy still set
  assert.equal(v2.cylinderSizeKg, 12);

  // cross-business custom reference rejected
  await assert.rejects(createProduct({
    businessId: businessA, brand: 'cross', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1, brandId: otherBrand._id,
  }), NotFoundError);

  // integer poisha still enforced
  await assert.rejects(Product.create({ businessId: businessA, brand: 'x', cylinderSizeKg: 12, purchasePrice: 1.5, sellingPrice: 1 }));
});

test('Product uniqueness: one per business + brand + cylinder size (legacy + v2); per-business SKU', async () => {
  // legacy unique {businessId, brand, cylinderSizeKg}
  await Product.create({ businessId: businessA, brand: 'uniq', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });
  await assert.rejects(Product.create({ businessId: businessA, brand: 'uniq', cylinderSizeKg: 12, purchasePrice: 2, sellingPrice: 2 }), (e) => e.code === 11000);
  // case-normalized
  await assert.rejects(Product.create({ businessId: businessA, brand: 'UNIQ', cylinderSizeKg: 12, purchasePrice: 2, sellingPrice: 2 }), (e) => e.code === 11000);
  // different business -> allowed
  await Product.create({ businessId: businessB, brand: 'uniq', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });

  // v2 unique {businessId, brandId, cylinderSizeId, kind}
  const sharedBrand = await createBrand({ scope: 'shared', code: 'v2-uniq', nameEn: 'V2 Uniq' });
  const size = await createCylinderSize({ scope: 'shared', code: 'v2-size', capacityGrams: 12000, labelEn: 'V2' });
  const a1 = await Product.create({ businessId: businessA, brand: 'v2-uniq', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1, brandId: sharedBrand._id, cylinderSizeId: size._id, kind: 'lpg_cylinder' });
  await assert.rejects(
    Product.create({ businessId: businessA, brand: 'v2-uniq-alt', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1, brandId: sharedBrand._id, cylinderSizeId: size._id, kind: 'lpg_cylinder' }),
    (e) => e.code === 11000,
  );
  // different tenant -> allowed
  await Product.create({ businessId: businessB, brand: 'v2-uniq', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1, brandId: sharedBrand._id, cylinderSizeId: size._id, kind: 'lpg_cylinder' });

  // per-business SKU partial unique; same SKU in another business is allowed; missing SKU is not unique
  await Product.updateOne({ _id: a1._id }, { $set: { sku: 'S1' } });
  const other = await Product.create({ businessId: businessA, brand: 'sku-2', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });
  await assert.rejects(Product.updateOne({ _id: other._id }, { $set: { sku: 'S1' } }), (e) => e.code === 11000);
  const dup = await Product.create({ businessId: businessB, brand: 'sku-3', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1, sku: 'S1' });
  assert.ok(dup); // same sku in different business allowed
  await assert.rejects(Product.create({ businessId: businessA, brand: 'sku-4', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1, sku: 'S1' }), (e) => e.code === 11000);
});

test('Supplier brand authorization is backward compatible (brand string + optional brandId)', async () => {
  const sharedBrand = await createBrand({ scope: 'shared', code: 'sup-brand', nameEn: 'Sup Brand' });
  const supplier = await Supplier.create({
    businessId: businessA, name: 'Plant',
    brandAuthorizations: [{ brand: 'sup-brand', brandId: sharedBrand._id, status: 'active' }],
  });
  // legacy shape still accepted
  await Supplier.create({ businessId: businessA, name: 'Plant Legacy', brandAuthorizations: [{ brand: 'legacy', status: 'active' }] });

  assert.equal(supplier.brandAuthorizations[0].brand, 'sup-brand');
  assert.equal(String(supplier.brandAuthorizations[0].brandId), String(sharedBrand._id));
  assert.equal(supplier.businessId.toString(), businessA.toString());
});

test('refill reads remain backward compatible with Product v2 + hybrid catalog', async () => {
  const sharedBrand = await createBrand({ scope: 'shared', code: 'refill-brand', nameEn: 'Refill Brand' });
  const supplier = await Supplier.create({
    businessId: businessA, name: 'Refill Plant', status: 'active',
    brandAuthorizations: [{ brand: 'refill-brand', brandId: sharedBrand._id, status: 'active' }],
  });
  const product = await Product.create({
    businessId: businessA, brand: 'refill-brand', cylinderSizeKg: 12, purchasePrice: 1000, sellingPrice: 1400,
    brandId: sharedBrand._id, kind: 'lpg_cylinder',
  });

  // createRefillRate uses product.brand + product.cylinderSizeKg (legacy still present) and supplier authorization.
  const rate = await createRefillRate({
    businessId: businessA, supplierId: supplier._id, productId: product._id, unitRatePoisha: 1000, createdBy: user._id,
  });
  assert.equal(rate.brand, 'refill-brand'); // legacy product.brand
  assert.equal(rate.cylinderSizeKg, 12); // legacy product.cylinderSizeKg
  assert.equal(rate.unitRatePoisha, 1000);
  assert.equal(String(rate.productId), String(product._id));
  assert.equal(rate.businessId.toString(), businessA.toString());

  // supplier authorized by brand string; product has no brandId match needed
  const productNoBrandId = await Product.create({ businessId: businessA, brand: 'legacy-brand-refill', cylinderSizeKg: 12, purchasePrice: 1, sellingPrice: 1 });
  const supplierLegacy = await Supplier.create({ businessId: businessA, name: 'Legacy Plant', brandAuthorizations: [{ brand: 'legacy-brand-refill', status: 'active' }] });
  await createRefillRate({ businessId: businessA, supplierId: supplierLegacy._id, productId: productNoBrandId._id, unitRatePoisha: 500, createdBy: user._id });
});

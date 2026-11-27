import mongoose from 'mongoose';
import Brand from './brand.model.js';
import CylinderSize from './cylinder-size.model.js';
import Product from './product.model.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { inTransaction, requireObjectId } from '../kernel/index.js';

const SCOPE_VALUES = new Set(['shared', 'business']);

/**
 * Hybrid catalog.
 *
 * `scope='shared'` entries are platform reference data (`businessId: null`) and
 * are never tenant-owned. `scope='business'` entries are dealer-owned custom
 * entries whose `businessId` must equal the requesting tenant. Products always
 * belong to one business and reference a shared entry OR their own business's
 * custom entry. Custom entries from another business are rejected and read as
 * not-found; `ref` alone does not enforce same-tenant references.
 *
 * `businessId` passed here must come from verified `req.auth`, never request body.
 */

export const resolveScope = (scope, businessId) => {
  if (!SCOPE_VALUES.has(scope)) throw new ValidationError('Scope must be shared or business.', 'INVALID_SCOPE');
  if (scope === 'shared') {
    return { scope: 'shared', businessId: null };
  }
  return { scope: 'business', businessId: requireObjectId(businessId, 'business id') };
};

/**
 * Verify a referenced catalog entry is usable by `businessId`.
 * Accepts shared entries, or a `scope='business'` entry owned by this business.
 * Missing / inactive / cross-business-custom -> NotFoundError (indistinguishable).
 */
export const assertSharedOrOwnedReference = async (Model, referenceId, businessId, { session, requireActive = true } = {}) => {
  if (referenceId === undefined || referenceId === null || referenceId === '') return null;
  if (!mongoose.isValidObjectId(referenceId)) throw new ValidationError('A valid catalog reference id is required.', 'INVALID_OBJECT_ID');

  const query = { _id: referenceId };
  if (requireActive) query.status = 'active';
  const doc = await Model.findOne(query).session(session ?? null).lean();
  if (!doc) throw new NotFoundError('Catalog entry not found.', 'CATALOG_NOT_FOUND');

  if (doc.scope === 'shared') return doc;
  if (doc.scope === 'business' && String(doc.businessId) === String(businessId)) return doc;

  // Never reveal existence of another tenant's custom entry.
  throw new NotFoundError('Catalog entry not found.', 'CATALOG_NOT_FOUND');
};

/** Validate a Product's catalog references (brandId, cylinderSizeId) against `businessId`. */
export const assertProductCatalogReferences = async ({ brandId, cylinderSizeId, businessId, kind = 'lpg_cylinder', session } = {}) => {
  // MongoDB sessions cannot run concurrent operations; resolve sequentially.
  const brand = await assertSharedOrOwnedReference(Brand, brandId, businessId, { session });
  const size = await assertSharedOrOwnedReference(CylinderSize, cylinderSizeId, businessId, { session });
  return { brand, size };
};

// ---- Canonical duplicate prevention (legacy-only vs v2) ---------------------
//
// `Product.brand`(lowercase string)+`cylinderSizeKg`(number) legacy keys and
// `brandId`+`cylinderSizeId` v2 keys are SEPARATE database unique indexes. A
// legacy-only LPG product and a v2 LPG product could otherwise both exist for
// the same business + physical brand + physical size (different index keys).
// This read-only, non-mutating guard rejects that WITHOUT touching or
// backfilling any existing record. Matching is conservative (a match on any
// reliable signal counts) so no duplicate slips through. Only `kind==='lpg_cylinder'`
// is constrained; accessory/service products are not.

const normalizeBrandKey = (value) => String(value ?? '').trim().toLowerCase();
const normalizeKg = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);
const gramsFromKg = (kg) => (typeof kg === 'number' && Number.isFinite(kg) ? Math.round(kg * 1000) : null);

const brandIdsFor = (product, brandCodeToIds) => {
  const ids = new Set();
  if (product.brandId) ids.add(String(product.brandId));
  const norm = normalizeBrandKey(product.brand);
  if (norm) for (const id of brandCodeToIds.get(norm) ?? []) ids.add(id);
  return ids;
};

const brandMatch = (a, b, brandCodeToIds) => {
  // exact legacy string match (also covers both-legacy-only case)
  const an = normalizeBrandKey(a.brand);
  if (an && an === normalizeBrandKey(b.brand)) return true;
  // any shared canonical id in common (explicit brandId, or legacy string resolved to a Brand.code)
  const ai = brandIdsFor(a, brandCodeToIds);
  for (const id of brandIdsFor(b, brandCodeToIds)) if (ai.has(id)) return true;
  return false;
};

const effectiveGrams = (product, sizeGrams) => {
  if (product.cylinderSizeId) {
    const grams = sizeGrams.get(String(product.cylinderSizeId));
    if (grams != null) return grams;
  }
  return gramsFromKg(product.cylinderSizeKg);
};

const sizeMatch = (a, b, sizeGrams) => {
  const aId = a.cylinderSizeId ? String(a.cylinderSizeId) : null;
  const bId = b.cylinderSizeId ? String(b.cylinderSizeId) : null;
  // Both reference an explicit size: same reference = same size; distinct references = distinct sizes.
  if (aId && bId) return aId === bId;
  // At least one side is legacy-only: compare physical grams, then raw kg.
  const ag = effectiveGrams(a, sizeGrams);
  const bg = effectiveGrams(b, sizeGrams);
  if (ag != null && bg != null && ag === bg) return true;
  const ak = normalizeKg(a.cylinderSizeKg);
  const bk = normalizeKg(b.cylinderSizeKg);
  if (ak != null && bk != null && ak === bk) return true;
  return false;
};

/**
 * Reject a duplicate LPG product for one business + brand + cylinder size,
 * matching across legacy-only and v2 representations. Read-only; no backfill.
 */
export const assertNoDuplicateLpgProduct = async ({
  businessId, kind = 'lpg_cylinder', brand, brandId, cylinderSizeKg, cylinderSizeId, excludeId, session,
} = {}) => {
  if (kind !== 'lpg_cylinder') return; // only LPG cylinders are constrained
  const tenantId = requireObjectId(businessId, 'business id');

  // Prefetch shared + owned brands (any status) to canonicalize legacy strings; nothing is mutated.
  const brands = await Brand.find({ $or: [{ scope: 'shared' }, { scope: 'business', businessId: tenantId }] })
    .session(session ?? null).lean();
  const brandCodeToIds = new Map();
  for (const entry of brands) {
    if (!brandCodeToIds.has(entry.code)) brandCodeToIds.set(entry.code, new Set());
    brandCodeToIds.get(entry.code).add(String(entry._id));
  }

  const query = { businessId: tenantId, kind: 'lpg_cylinder' };
  if (excludeId) query._id = { $ne: requireObjectId(excludeId, 'product id') };
  const candidates = await Product.find(query).session(session ?? null).lean();

  // Prefetch CylinderSize grams for incoming + existing references; nothing is mutated.
  const sizeIds = new Set();
  if (cylinderSizeId) sizeIds.add(String(cylinderSizeId));
  for (const candidate of candidates) if (candidate.cylinderSizeId) sizeIds.add(String(candidate.cylinderSizeId));
  const sizeGrams = new Map();
  if (sizeIds.size > 0) {
    const sizes = await CylinderSize.find({ _id: { $in: [...sizeIds] } }).session(session ?? null).lean();
    for (const size of sizes) sizeGrams.set(String(size._id), size.capacityGrams);
  }

  const incoming = { brand, brandId, cylinderSizeKg, cylinderSizeId };
  for (const existing of candidates) {
    if (brandMatch(incoming, existing, brandCodeToIds) && sizeMatch(incoming, existing, sizeGrams)) {
      throw new ConflictError(
        'A duplicate LPG product already exists for this business, brand and cylinder size.',
        'DUPLICATE_PRODUCT',
      );
    }
  }
};

export const createBrand = async ({ scope = 'business', businessId, code, nameEn, nameBn, logoUrl, status, createdBy } = {}) => {
  if (typeof code !== 'string' || code.trim() === '') throw new ValidationError('A brand code is required.', 'INVALID_CODE');
  if (typeof nameEn !== 'string' || nameEn.trim() === '') throw new ValidationError('nameEn is required.', 'INVALID_NAME');
  const resolved = resolveScope(scope, businessId);
  const [doc] = await Brand.create([{
    scope: resolved.scope,
    businessId: resolved.businessId,
    code: code.trim().toLowerCase(),
    nameEn: nameEn.trim(),
    nameBn: nameBn?.trim(),
    logoUrl,
    status: status ?? 'active',
    createdBy: createdBy ? requireObjectId(createdBy, 'user id') : undefined,
  }]);
  return doc;
};

export const createCylinderSize = async ({ scope = 'business', businessId, code, capacityGrams, labelEn, labelBn, tareWeightGrams, segment, sortOrder, status, createdBy } = {}) => {
  if (typeof code !== 'string' || code.trim() === '') throw new ValidationError('A cylinder size code is required.', 'INVALID_CODE');
  if (!Number.isSafeInteger(capacityGrams) || capacityGrams < 0) throw new ValidationError('capacityGrams must be a whole number of grams.', 'INVALID_CAPACITY');
  if (typeof labelEn !== 'string' || labelEn.trim() === '') throw new ValidationError('labelEn is required.', 'INVALID_LABEL');
  const resolved = resolveScope(scope, businessId);
  const [doc] = await CylinderSize.create([{
    scope: resolved.scope,
    businessId: resolved.businessId,
    code: code.trim().toLowerCase(),
    capacityGrams,
    tareWeightGrams,
    labelEn: labelEn.trim(),
    labelBn: labelBn?.trim(),
    segment,
    sortOrder,
    status: status ?? 'active',
    createdBy: createdBy ? requireObjectId(createdBy, 'user id') : undefined,
  }]);
  return doc;
};

/**
 * Create a Product additively. `businessId` is required (verified tenant).
 * `brand` + `cylinderSizeKg` (legacy) remain required; `brandId`/`cylinderSizeId`
 * are optional shared-or-owned references; `kind`, `sku`, bilingual names additive.
 */
export const createProduct = async ({
  businessId, kind = 'lpg_cylinder', brand, cylinderSizeKg, purchasePrice, sellingPrice,
  brandId, cylinderSizeId, sku, nameEn, nameBn, status = 'active',
} = {}) => {
  const tenantId = requireObjectId(businessId, 'business id');

  return inTransaction(async (session) => {
    await assertProductCatalogReferences({ brandId, cylinderSizeId, businessId: tenantId, kind, session });
    // Block duplicate LPG products across legacy-only and v2 references (non-mutating; DB indexes still apply).
    await assertNoDuplicateLpgProduct({ businessId: tenantId, kind, brand, brandId, cylinderSizeKg, cylinderSizeId, session });

    const [product] = await Product.create([{
      businessId: tenantId,
      kind,
      brand,                 // legacy preserved (required by schema)
      cylinderSizeKg,        // legacy preserved (required by schema)
      purchasePrice,
      sellingPrice,
      brandId,
      cylinderSizeId,
      sku: sku?.trim() || undefined,
      nameEn: nameEn?.trim() || undefined,
      nameBn: nameBn?.trim() || undefined,
      status,
    }], { session, ordered: true });
    return product;
  });
};

/**
 * Update a tenant-owned Product. Additive; `businessId` is immutable and taken
 * from verified tenant context, never request body. Catalog references are
 * re-validated and the duplicate-LPG guard re-runs (excluding this product).
 */
export const updateProduct = async ({ businessId, productId, patch = {} } = {}) => {
  const tenantId = requireObjectId(businessId, 'business id');
  const id = requireObjectId(productId, 'product id');

  return inTransaction(async (session) => {
    const existing = await Product.findOne({ _id: id, businessId: tenantId }).session(session);
    if (!existing) throw new NotFoundError('Product not found.', 'PRODUCT_NOT_FOUND');

    const kind = patch.kind ?? existing.kind;
    const brand = patch.brand ?? existing.brand;
    const cylinderSizeKg = patch.cylinderSizeKg ?? existing.cylinderSizeKg;
    const brandId = patch.brandId !== undefined ? patch.brandId : existing.brandId;
    const cylinderSizeId = patch.cylinderSizeId !== undefined ? patch.cylinderSizeId : existing.cylinderSizeId;

    await assertProductCatalogReferences({ brandId, cylinderSizeId, businessId: tenantId, kind, session });
    await assertNoDuplicateLpgProduct({
      businessId: tenantId, kind, brand, brandId, cylinderSizeKg, cylinderSizeId, excludeId: id, session,
    });

    // Apply only safe additive fields; never move tenant.
    if (patch.kind !== undefined) existing.kind = kind;
    if (patch.brand !== undefined) existing.brand = brand;
    if (patch.cylinderSizeKg !== undefined) existing.cylinderSizeKg = cylinderSizeKg;
    if (patch.brandId !== undefined) existing.brandId = brandId ?? undefined;
    if (patch.cylinderSizeId !== undefined) existing.cylinderSizeId = cylinderSizeId ?? undefined;
    if (patch.purchasePrice !== undefined) existing.purchasePrice = patch.purchasePrice;
    if (patch.sellingPrice !== undefined) existing.sellingPrice = patch.sellingPrice;
    if (patch.status !== undefined) existing.status = patch.status;
    if (patch.sku !== undefined) existing.sku = typeof patch.sku === 'string' && patch.sku.trim() ? patch.sku.trim() : undefined;
    if (patch.nameEn !== undefined) existing.nameEn = patch.nameEn?.trim() || undefined;
    if (patch.nameBn !== undefined) existing.nameBn = patch.nameBn?.trim() || undefined;

    await existing.save({ session });
    return existing;
  });
};

// ---- Reads (tenant-safe) ----------------------------------------------------

const visibleScopeFilter = (businessId) => ({ $or: [{ scope: 'shared' }, { scope: 'business', businessId }] });

/** List shared + owned entries. `scope`/`status` optional filters. */
export const listCatalogEntries = async (Model, { businessId, scope, status, session } = {}) => {
  const tenantId = requireObjectId(businessId, 'business id');
  let filter;
  if (scope === 'shared') filter = { scope: 'shared' };
  else if (scope === 'business') filter = { scope: 'business', businessId: tenantId };
  else filter = visibleScopeFilter(tenantId);
  if (status) filter.status = status;
  return Model.find(filter).sort({ nameEn: 1, createdAt: 1 }).session(session ?? null).lean();
};

export const listBrands = (opts) => listCatalogEntries(Brand, opts);
export const listCylinderSizes = (opts) => listCatalogEntries(CylinderSize, opts);

/** Get a shared or owned entry; cross-business custom reads as not-found. */
export const getCatalogEntry = async (Model, referenceId, businessId, { session } = {}) => {
  if (!mongoose.isValidObjectId(referenceId)) throw new NotFoundError('Catalog entry not found.', 'CATALOG_NOT_FOUND');
  const tenantId = requireObjectId(businessId, 'business id');
  const doc = await Model.findOne({ _id: referenceId }).session(session ?? null).lean();
  if (!doc) throw new NotFoundError('Catalog entry not found.', 'CATALOG_NOT_FOUND');
  if (doc.scope === 'shared') return doc;
  if (doc.scope === 'business' && String(doc.businessId) === String(tenantId)) return doc;
  // Never reveal existence of another tenant's custom entry.
  throw new NotFoundError('Catalog entry not found.', 'CATALOG_NOT_FOUND');
};

export const getBrand = (referenceId, businessId, opts) => getCatalogEntry(Brand, referenceId, businessId, opts);
export const getCylinderSize = (referenceId, businessId, opts) => getCatalogEntry(CylinderSize, referenceId, businessId, opts);

/** List tenant-owned products. */
export const listProducts = async ({ businessId, status, kind, session } = {}) => {
  const tenantId = requireObjectId(businessId, 'business id');
  const filter = { businessId: tenantId };
  if (status) filter.status = status;
  if (kind) filter.kind = kind;
  return Product.find(filter).sort({ createdAt: -1 }).session(session ?? null).lean();
};

/** Get a tenant-owned product; other businesses' products read as not-found. */
export const getProduct = async (productId, businessId, { session } = {}) => {
  if (!mongoose.isValidObjectId(productId)) throw new NotFoundError('Product not found.', 'PRODUCT_NOT_FOUND');
  const tenantId = requireObjectId(businessId, 'business id');
  const product = await Product.findOne({ _id: productId, businessId: tenantId }).session(session ?? null).lean();
  if (!product) throw new NotFoundError('Product not found.', 'PRODUCT_NOT_FOUND');
  return product;
};

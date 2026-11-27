/**
 * Supplier Management Foundation (Phase 2 Step 7).
 *
 * Core tenant-safe Supplier CRUD + read-only history + read-only balance
 * summaries. NOT a financial/payment abstraction; reuses append-only
 * `SupplierPayment`, `Purchase`, `RefillBatch`, `RefillRate`. NOT Supplier
 * Returns. NOT multi-warehouse. `businessId` immutable + verified auth; tenant
 * safe; cross not-found. NO destructive delete; `deactivate` `status:'suspended'`.
 * NO financial mutation/invention; NO auto-repair; NO double-counting.
 * Preserve existing `Supplier` fields + Refill `brandAuthorizations` + refill
 * settlement. `brandAuthorizations` brand strings + `brandId` shared-or-owned.
 */
import mongoose from 'mongoose';
import Business from './business.model.js';
import BusinessMember from './business-member.model.js';
import Brand from './brand.model.js';
import Purchase from './purchase.model.js';
import Supplier from './supplier.model.js';
import SupplierPayment from './supplier-payment.model.js';
import User from './user.model.js';
import { assertSharedOrOwnedReference } from './catalog.service.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { requireObjectId } from '../kernel/index.js';

const MAX = 1000;
const requireTenant = (businessId) => requireObjectId(businessId, 'business id');

const requireActor = async (actorId, businessId) => {
  const id = requireObjectId(actorId, 'actor id');
  const actor = await User.exists({ _id: id, status: 'active' });
  const membership = await BusinessMember.exists({ businessId, userId: id, status: 'active' });
  if (!actor || !membership) throw new NotFoundError('An active business member was not found.', 'ACTOR_NOT_FOUND');
  return id;
};
const requireActiveBusiness = async (businessId) => {
  const business = await Business.exists({ _id: businessId, status: 'active' });
  if (!business) throw new NotFoundError('Active business was not found.', 'BUSINESS_NOT_FOUND');
};

const optionalString = (value, field, max) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string.`, 'INVALID_STRING');
  const t = value.trim();
  if (t.length > max) throw new ValidationError(`${field} must be at most ${max} characters.`, 'STRING_TOO_LONG');
  return t === '' ? undefined : t;
};
const requireName = (name) => {
  if (typeof name !== 'string' || name.trim() === '') throw new ValidationError('name is required.', 'INVALID_NAME');
  if (name.trim().length > 160) throw new ValidationError('name must be at most 160 characters.', 'STRING_TOO_LONG');
  return name.trim();
};
const normMobile = (value) => { if (value === undefined || value === null) return undefined; if (typeof value !== 'string') throw new ValidationError('mobile must be a string.', 'INVALID_STRING'); const t = value.trim(); if (t.length > 32) throw new ValidationError('mobile must be at most 32 characters.', 'STRING_TOO_LONG'); return t === '' ? undefined : t; };
const pageParams = (page, limit) => { const p = Number.isSafeInteger(page) ? Math.max(1, page) : 1; const l = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50; return { page: p, limit: l }; };

/** Validate `brandAuthorizations`. `brand` string preserved; `brandId` shared-or-owned. status active/inactive. */
const validateBrandAuthorizations = async (businessId, brandAuthorizations) => {
  if (brandAuthorizations === undefined) return undefined;
  if (!Array.isArray(brandAuthorizations)) throw new ValidationError('brandAuthorizations must be an array.', 'INVALID_BRAND_AUTHORIZATIONS');
  const out = [];
  for (const entry of brandAuthorizations) {
    if (!entry || typeof entry !== 'object') throw new ValidationError('Invalid brand authorization.', 'INVALID_BRAND_AUTHORIZATIONS');
    if (typeof entry.brand !== 'string' || entry.brand.trim() === '') throw new ValidationError('brandAuthorizations[].brand is required.', 'INVALID_BRAND');
    if (entry.brand.trim().length > 80) throw new ValidationError('brand must be at most 80 characters.', 'STRING_TOO_LONG');
    const status = entry.status === undefined ? 'active' : entry.status;
    if (status !== 'active' && status !== 'inactive') throw new ValidationError('brandAuthorizations[].status must be active or inactive.', 'INVALID_STATUS');
    const item = { brand: entry.brand.trim().toLowerCase(), status };
    if (entry.brandId !== undefined && entry.brandId !== null && entry.brandId !== '') {
      // strict shared-or-owned; cross-business custom => not-found (indistinguishable); invalid => validation
      await assertSharedOrOwnedReference(Brand, entry.brandId, businessId);
      item.brandId = requireObjectId(entry.brandId, 'brand id');
    }
    out.push(item);
  }
  return out;
};

// ---------- CRUD ----------

export const createSupplier = async ({ businessId, actorId, name, mobile, phone, email, address, notes, status = 'active', brandAuthorizations } = {}) => {
  const tenantId = requireTenant(businessId);
  await requireActiveBusiness(tenantId);
  await requireActor(actorId, tenantId);
  if (status !== 'active' && status !== 'suspended') throw new ValidationError('status must be active or suspended.', 'INVALID_STATUS');
  const brands = await validateBrandAuthorizations(tenantId, brandAuthorizations ?? []);

  const [supplier] = await Supplier.create([{
    businessId: tenantId, name: requireName(name),
    mobile: normMobile(mobile ?? phone),
    contact: { phone: normMobile(phone ?? mobile), email: optionalString(email, 'email', 254) },
    address: optionalString(address, 'address', 500), notes: optionalString(notes, 'notes', MAX), status,
    brandAuthorizations: brands ?? [],
  }]);
  return supplier;
};

export const listSuppliers = async ({ businessId, status, search, page = 1, limit = 50, session } = {}) => {
  const tenantId = requireTenant(businessId);
  const filter = { businessId: tenantId };
  if (status === 'active' || status === 'suspended') filter.status = status;
  if (typeof search === 'string' && search.trim()) { const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); filter.$or = [{ name: re }, { mobile: re }, { 'contact.phone': re }]; }
  const { page: p, limit: l } = pageParams(page, limit);
  const items = await Supplier.find(filter).sort({ name: 1 }).skip((p - 1) * l).limit(l).session(session ?? null).lean();
  const total = await Supplier.countDocuments(filter).session(session ?? null);
  return { suppliers: items, page: p, limit: l, total, totalPages: Math.max(1, Math.ceil(total / l)) };
};

export const getSupplier = async (supplierId, businessId, { session } = {}) => {
  if (!mongoose.isValidObjectId(supplierId)) throw new NotFoundError('Supplier not found.', 'SUPPLIER_NOT_FOUND');
  const tenantId = requireTenant(businessId);
  const supplier = await Supplier.findOne({ _id: supplierId, businessId: tenantId }).session(session ?? null).lean();
  if (!supplier) throw new NotFoundError('Supplier not found.', 'SUPPLIER_NOT_FOUND'); // cross-business => not-found
  return supplier;
};

export const updateSupplier = async ({ businessId, actorId, supplierId, name, mobile, phone, email, address, notes, status, brandAuthorizations } = {}) => {
  const tenantId = requireTenant(businessId);
  await requireActiveBusiness(tenantId);
  await requireActor(actorId, tenantId);
  const id = requireObjectId(supplierId, 'supplier id');
  const existing = await Supplier.findOne({ _id: id, businessId: tenantId });
  if (!existing) throw new NotFoundError('Supplier not found.', 'SUPPLIER_NOT_FOUND');

  if (name !== undefined) existing.name = requireName(name);
  if (mobile !== undefined) existing.mobile = normMobile(mobile);
  if (phone !== undefined) existing.contact = { ...(existing.contact?.toObject?.() ?? existing.contact ?? {}), phone: normMobile(phone) };
  if (email !== undefined) existing.contact = { ...(existing.contact?.toObject?.() ?? existing.contact ?? {}), email: optionalString(email, 'email', 254) };
  if (address !== undefined) existing.address = optionalString(address, 'address', 500);
  if (notes !== undefined) existing.notes = optionalString(notes, 'notes', MAX);
  if (status !== undefined) { if (status !== 'active' && status !== 'suspended') throw new ValidationError('status must be active or suspended.', 'INVALID_STATUS'); existing.status = status; }
  if (brandAuthorizations !== undefined) existing.brandAuthorizations = await validateBrandAuthorizations(tenantId, brandAuthorizations);
  await existing.save();
  return existing;
};

/** Deactivate (no destructive delete). */
export const deactivateSupplier = async ({ businessId, actorId, supplierId } = {}) =>
  updateSupplier({ businessId, actorId, supplierId, status: 'suspended' });

// ---------- read-only history + balances ----------

/** Supplier purchase history (actual `Purchase`; scoped; paginated). NOT Refill. */
export const getSupplierPurchases = async ({ businessId, supplierId, page = 1, limit = 50, session } = {}) => {
  const supplier = await getSupplier(supplierId, businessId, { session });
  const { page: p, limit: l } = pageParams(page, limit);
  const filter = { businessId: requireTenant(businessId), supplierId: supplier._id };
  const items = await Purchase.find(filter).sort({ purchasedAt: -1 }).skip((p - 1) * l).limit(l).session(session ?? null).lean();
  const total = await Purchase.countDocuments(filter).session(session ?? null);
  return { purchases: items, page: p, limit: l, total, totalPages: Math.max(1, Math.ceil(total / l)) };
};

/** Supplier payment history (append-only `SupplierPayment`; ALL sourceTypes incl Purchase + Refill; scoped; paginated; read-only). */
export const getSupplierPayments = async ({ businessId, supplierId, page = 1, limit = 50, sourceType, session } = {}) => {
  const supplier = await getSupplier(supplierId, businessId, { session });
  const { page: p, limit: l } = pageParams(page, limit);
  const filter = { businessId: requireTenant(businessId), supplierId: supplier._id };
  if (typeof sourceType === 'string' && sourceType.trim()) filter.sourceType = sourceType.trim();
  const items = await SupplierPayment.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).session(session ?? null).lean();
  const total = await SupplierPayment.countDocuments(filter).session(session ?? null);
  return { payments: items, page: p, limit: l, total, totalPages: Math.max(1, Math.ceil(total / l)) };
};

/**
 * Read-only outstanding balance summary. SEPARATE streams; NOT combined; no
 * double-count; nothing invented/mutated. `purchase` uses `Purchase` totals vs
 * `SupplierPayment(sourceType='purchase')`; `refill` uses append-only
 * `SupplierPayment(sourceType='refill_batch')` counted only (existing Refill
 * supplier-credit/settlement accounting lives in refill.service; NOT merged
 * here; refill obligations not derivable from `SupplierPayment` alone).
 */
export const getSupplierBalanceSummary = async ({ businessId, supplierId, session } = {}) => {
  const supplier = await getSupplier(supplierId, businessId, { session });
  const tenantId = requireTenant(businessId);
  const sid = supplier._id;

  // ---- Purchase stream (new-cylinder purchases) ----
  const purchases = await Purchase.find({ businessId: tenantId, supplierId: sid, status: 'posted' }).select('totalAmountPoisha').session(session ?? null).lean();
  const purchaseObligationsPoisha = purchases.reduce((sum, p) => sum + p.totalAmountPoisha, 0);
  const purchasePayments = await SupplierPayment.find({ businessId: tenantId, supplierId: sid, sourceType: 'purchase', type: 'payment' }).select('amountPoisha').session(session ?? null).lean();
  const purchasePaidPoisha = purchasePayments.reduce((sum, p) => sum + p.amountPoisha, 0);

  // ---- Refill stream (existing supplier-credit/settlement; append-only SupplierPayment only; NOT merged with Purchase) ----
  const refillPayments = await SupplierPayment.find({ businessId: tenantId, supplierId: sid, sourceType: 'refill_batch', type: 'payment' }).select('amountPoisha').session(session ?? null).lean();
  const refillPaidPoisha = refillPayments.reduce((sum, p) => sum + p.amountPoisha, 0);
  const refillPaymentCount = refillPayments.length;

  // raw append-only payment totals across streams (informational only; NOT an outstanding balance; no double-count of obligations)
  const allPayments = await SupplierPayment.find({ businessId: tenantId, supplierId: sid, type: 'payment' }).select('amountPoisha sourceType').session(session ?? null).lean();
  const totalSupplierPaymentsPoisha = allPayments.reduce((sum, p) => sum + p.amountPoisha, 0);

  return {
    supplierId: sid,
    // Purchase (separate, derived; read-only)
    purchase: { obligationsPoisha: purchaseObligationsPoisha, paidPoisha: purchasePaidPoisha, outstandingDuePoisha: purchaseObligationsPoisha - purchasePaidPoisha },
    // Refill (existing supplier-credit/settlement NOT merged; only append-only payments counted here)
    refill: { paidPoisha: refillPaidPoisha, paymentCount: refillPaymentCount, settlement: 'see refill.service / append-only SupplierPayment; not merged with Purchase' },
    // raw append-only payment totals (informational; NOT outstanding; NOT combined obligations)
    totalSupplierPaymentsPoisha,
    // NOTE: no combined balance; Purchase and Refill remain separate; no auto-repair.
    combined: false,
  };
};

/**
 * Read-only supplier-level Purchase reconciliation. Reuses existing Purchase
 * reconciliation (`getPurchaseSupplierBalance` + `reconcilePurchasePayment`)
 * across this supplier's `Purchase` records in this business. Recomputes paid
 * from append-only `SupplierPayment(sourceType='purchase',type='payment')`.
 * Compares to cached `Purchase.amountPaidPoisha/dueAmount/paymentStatus`.
 * SEPARATE from Refill; NOT combined; NO auto-repair/financial mutation.
 */
export const reconcileSupplierPurchaseBalance = async ({ businessId, supplierId, session } = {}) => {
  const supplier = await getSupplier(supplierId, businessId, { session });
  const tenantId = requireTenant(businessId);
  const sid = supplier._id;

  const purchases = await Purchase.find({ businessId: tenantId, supplierId: sid, status: 'posted' }).session(session ?? null).lean();
  const purchasePayments = await SupplierPayment.find({ businessId: tenantId, supplierId: sid, sourceType: 'purchase', type: 'payment' }).select('amountPoisha purchaseId').session(session ?? null).lean();

  const paidByPurchase = new Map();
  let totalPurchasePaidPoisha = 0;
  for (const payment of purchasePayments) {
    totalPurchasePaidPoisha += payment.amountPoisha;
    if (payment.purchaseId) paidByPurchase.set(String(payment.purchaseId), (paidByPurchase.get(String(payment.purchaseId)) ?? 0) + payment.amountPoisha);
  }

  let obligationsPoisha = 0;
  let recomputedPaidPoisha = 0;
  let storedPaidPoisha = 0;
  let recomputedOutstandingDuePoisha = 0;
  let storedOutstandingDuePoisha = 0;
  let cacheMatches = true;
  const driftedPurchases = [];

  for (const purchase of purchases) {
    const total = purchase.totalAmountPoisha;
    const recomputedPaid = paidByPurchase.get(String(purchase._id)) ?? 0;
    obligationsPoisha += total;
    recomputedPaidPoisha += recomputedPaid;
    storedPaidPoisha += purchase.amountPaidPoisha;
    recomputedOutstandingDuePoisha += total - recomputedPaid;
    storedOutstandingDuePoisha += purchase.amountDuePoisha;
    if (purchase.amountPaidPoisha !== recomputedPaid || purchase.amountDuePoisha !== total - recomputedPaid || purchase.paymentStatus !== (recomputedPaid >= total ? 'paid' : recomputedPaid > 0 ? 'partially_paid' : 'unpaid')) {
      cacheMatches = false;
      driftedPurchases.push({ purchaseId: purchase._id, storedPaid: purchase.amountPaidPoisha, recomputedPaid, storedDue: purchase.amountDuePoisha, recomputedDue: total - recomputedPaid });
    }
  }

  return {
    supplierId: sid,
    purchaseCount: purchases.length,
    obligationsPoisha,
    // recomputed from append-only `SupplierPayment` (source of truth)
    recomputedPaidPoisha, recomputedOutstandingDuePoisha,
    // `totalPurchasePaidPoisha` from append-only payments (not double-counting obligations)
    totalPurchasePaidPoisha,
    // cached `Purchase` fields (NOT silently trusted; `cacheMatches` reflects drift)
    storedPaidPoisha, storedOutstandingDuePoisha, cacheMatches,
    matches: cacheMatches && storedPaidPoisha === recomputedPaidPoisha && storedOutstandingDuePoisha === recomputedOutstandingDuePoisha,
    driftedPurchases,
    // SEPARATE from Refill; not combined; no auto-repair
    combined: false,
  };
};

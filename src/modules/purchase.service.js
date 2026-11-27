/**
 * Purchase foundation (Phase 2 Step 4) — NEW-CYLINDER supplier purchase only.
 *
 * NOT Supplier Returns, NOT Sales, NOT Customer Sale Returns. NOT Purchase
 * Returns. Supplier purchase of NEW filled cylinder packages. Dealer-defined
 * `unitCostPoisha` + `sellingPricePoisha`; platform never sets prices. Integer
 * poisha. NOT warehouse management; single default warehouse (`warehouseId:null`).
 *
 * Safety: tenant-scoped; supplier + product ownership re-validated inside the
 * transaction; atomic stock posting to SEPARATE `newQty` (not full/empty/
 * damaged/rejected); append-only StockMovement audit; append-only SupplierPayment
 * history; transaction-safe; idempotent posting + payment; full/partial/unpaid;
 * tenant-safe supplier balances. Preserves existing SupplierPayment + Refill.
 */
import mongoose from 'mongoose';
import Business from './business.model.js';
import BusinessMember from './business-member.model.js';
import Product from './product.model.js';
import Purchase from './purchase.model.js';
import Stock from './stock.model.js';
import StockMovement from './stock-movement.model.js';
import Supplier from './supplier.model.js';
import SupplierPayment from './supplier-payment.model.js';
import User from './user.model.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { generateRequestHash, inTransaction, normalizeIdempotencyKey, requireObjectId, runIdempotently } from '../kernel/index.js';

const isPoisha = (value) => Number.isSafeInteger(value) && value >= 0;
const isPositiveInt = (value) => Number.isSafeInteger(value) && value >= 1;
const PAYMENT_METHODS = new Set(['cash', 'bkash', 'nagad', 'bank', 'other']);
const MAX = 1000;

const requireTenant = (businessId) => requireObjectId(businessId, 'business id');
const requireActor = async (actorId, businessId, session) => {
  const id = requireObjectId(actorId, 'actor id');
  const actor = await User.exists({ _id: id, status: 'active' }).session(session);
  const membership = await BusinessMember.exists({ businessId, userId: id, status: 'active' }).session(session);
  if (!actor || !membership) throw new NotFoundError('An active business member was not found.', 'ACTOR_NOT_FOUND');
  return id;
};
const requireActiveBusiness = async (businessId, session) => {
  const business = await Business.exists({ _id: businessId, status: 'active' }).session(session);
  if (!business) throw new NotFoundError('Active business was not found.', 'BUSINESS_NOT_FOUND');
};
const requireOwnedSupplier = async (businessId, supplierId, session) => {
  const id = requireObjectId(supplierId, 'supplier id');
  const supplier = await Supplier.findOne({ _id: id, businessId, status: 'active' }).select('_id businessId').session(session).lean();
  if (!supplier) throw new NotFoundError('Supplier not found.', 'SUPPLIER_NOT_FOUND'); // cross-business => not-found
  return id;
};
const requireOwnedProduct = async (businessId, productId, session) => {
  const id = requireObjectId(productId, 'product id');
  const product = await Product.findOne({ _id: id, businessId }).select('_id kind status businessId').session(session).lean();
  if (!product) throw new NotFoundError('Product not found.', 'PRODUCT_NOT_FOUND'); // cross-business => not-found
  if (product.kind !== 'lpg_cylinder') throw new ValidationError('Only new LPG cylinder packages can be purchased in this step.', 'INVALID_PRODUCT_KIND');
  if (product.status !== 'active') throw new ValidationError('Product is not active.', 'PRODUCT_INACTIVE');
  return id;
};

const optionalString = (value, field, max = 120) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string.`, 'INVALID_STRING');
  const t = value.trim();
  if (t.length > max) throw new ValidationError(`${field} must be at most ${max} characters.`, 'STRING_TOO_LONG');
  return t === '' ? undefined : t;
};

/** Validate + normalize embedded purchase items. No platform-set prices; all caller-defined. */
const validateItems = (items, businessId, session) => {
  if (!Array.isArray(items) || items.length < 1) throw new ValidationError('A purchase needs at least one item.', 'INVALID_ITEMS');
  return items.map((item) => {
    if (!item || typeof item !== 'object') throw new ValidationError('Invalid purchase item.', 'INVALID_ITEMS');
    const quantity = item.quantity;
    const unitCostPoisha = item.unitCostPoisha;
    const sellingPricePoisha = item.sellingPricePoisha;
    if (!isPositiveInt(quantity)) throw new ValidationError('item.quantity must be a positive whole number.', 'INVALID_QUANTITY');
    if (!isPoisha(unitCostPoisha)) throw new ValidationError('item.unitCostPoisha must be a non-negative whole number of poisha.', 'INVALID_UNIT_COST');
    if (!isPoisha(sellingPricePoisha)) throw new ValidationError('item.sellingPricePoisha must be a non-negative whole number of poisha.', 'INVALID_SELLING_PRICE');
    // platform never sets prices; both are required caller inputs
    return { productIdRaw: item.productId, quantity, unitCostPoisha, sellingPricePoisha };
  });
};

/**
 * Create + post a new-cylinder Purchase. Atomic; transaction-safe; idempotent.
 * Posts `newQty` (separate new-cylinder inventory) + append-only `purchase` movements.
 */
export const createPurchase = async ({
  businessId, supplierId, actorId, items, purchasedAt, purchaseNumber, note, reference, idempotencyKey, session: providedSession,
} = {}) => {
  const tenantId = requireTenant(businessId);
  const supplier = requireObjectId(supplierId, 'supplier id');
  const actor = requireObjectId(actorId, 'actor id');
  const key = normalizeIdempotencyKey(idempotencyKey);
  const rawItems = validateItems(items, tenantId, providedSession);

  // canonical request hashing over the FULL payload; `requestHash` immutable; append-once.
  const requestHash = generateRequestHash({
    businessId: tenantId, supplierId: supplier, actorId: actor, purchaseNumber: purchaseNumber ?? null,
    purchasedAt: purchasedAt ? new Date(purchasedAt).toISOString() : null,
    items: rawItems.map((i) => ({ productId: i.productIdRaw, quantity: i.quantity, unitCostPoisha: i.unitCostPoisha, sellingPricePoisha: i.sellingPricePoisha })),
    note: note ?? null, reference: reference ?? null,
  });

  return runIdempotently({
    model: Purchase,
    filter: { businessId: tenantId, idempotencyKey: key },
    requestHash,
    authorize: async () => { await requireActiveBusiness(tenantId, providedSession ?? null); await requireActor(actor, tenantId, providedSession ?? null); },
    work: async (session) => {
      await requireOwnedSupplier(tenantId, supplier, session);

      // validate each product owned + active + lpg_cylinder; compute totals (integer poisha; no floats)
      const items = [];
      let totalAmountPoisha = 0;
      let totalSellingPoisha = 0;
      for (const raw of rawItems) {
        const productId = await requireOwnedProduct(tenantId, raw.productIdRaw, session);
        const lineTotalPoisha = raw.quantity * raw.unitCostPoisha;
        totalAmountPoisha += lineTotalPoisha;
        totalSellingPoisha += raw.quantity * raw.sellingPricePoisha;
        // explicit _id => `sourceLineId` + per-line idempotency; Mongoose would otherwise assign
        items.push({ _id: new mongoose.Types.ObjectId(), productId, kind: 'lpg_cylinder', quantity: raw.quantity, unitCostPoisha: raw.unitCostPoisha, sellingPricePoisha: raw.sellingPricePoisha, lineTotalPoisha });
      }
      if (!Number.isSafeInteger(totalAmountPoisha) || !Number.isSafeInteger(totalSellingPoisha)) throw new ValidationError('Purchase totals exceed safe integer poisha.', 'AMOUNT_TOO_LARGE');

      const [purchase] = await Purchase.create([{
        businessId: tenantId, supplierId: supplier, purchaseNumber: optionalString(purchaseNumber, 'purchaseNumber', 64),
        purchasedAt: purchasedAt ? new Date(purchasedAt) : undefined, items, totalAmountPoisha, totalSellingPoisha,
        paymentStatus: 'unpaid', amountPaidPoisha: 0, amountDuePoisha: totalAmountPoisha, status: 'posted',
        note: optionalString(note, 'note', MAX), reference: optionalString(reference, 'reference', 120),
        createdBy: actor, idempotencyKey: key, requestHash,
      }], { session, ordered: true });

      // ---- atomic stock posting to SEPARATE new-cylinder inventory ----
      const movementGroupId = new mongoose.Types.ObjectId();
      const movements = [];
      for (const item of items) {
        await Stock.updateOne(
          { businessId: tenantId, productId: item.productId, warehouseId: null },
          { $setOnInsert: { fullQty: 0, emptyQty: 0, damagedQty: 0, rejectedQty: 0, warehouseId: null }, $inc: { newQty: item.quantity, version: 1 } },
          { upsert: true, session, runValidators: true, setDefaultsOnInsert: false },
        );
        movements.push({
          businessId: tenantId, productId: item.productId, warehouseId: null,
          movementType: 'purchase', quantity: item.quantity, stockBucket: 'new', direction: 'in',
          sourceType: 'purchase', sourceId: purchase._id, sourceLineId: item._id, movementGroupId,
          unitCostPoisha: item.unitCostPoisha, reference: optionalString(reference, 'reference', 120),
          note: 'New-cylinder purchase.', createdBy: actor, idempotencyKey: `${key}#new:${item._id}`,
        });
      }
      if (movements.length > 0) await StockMovement.create(movements, { session, ordered: true });
      return purchase;
    },
    session: providedSession,
  });
};

const sumPurchasePaid = async (businessId, purchaseId, session) => {
  const rows = await SupplierPayment.find({ businessId, purchaseId, sourceType: 'purchase', type: 'payment' }).select('amountPoisha').session(session ?? null).lean();
  return rows.reduce((sum, row) => sum + row.amountPoisha, 0);
};

/**
 * Record a supplier payment against a Purchase. Append-only SupplierPayment
 * (sourceType='purchase'). Full / partial / unpaid supported. Idempotent.
 * `amountPoisha` integer poisha >=1; cannot exceed amount due. Recomputes
 * Purchase paymentStatus/amountPaidPoisha/amountDuePoisha from append-only history.
 */
export const recordPurchasePayment = async ({
  businessId, purchaseId, paidBy, amountPoisha, method, paidAt, reference, note, idempotencyKey, session: providedSession,
} = {}) => {
  const tenantId = requireTenant(businessId);
  const purchase = requireObjectId(purchaseId, 'purchase id');
  const actor = requireObjectId(paidBy, 'paidBy');
  const key = normalizeIdempotencyKey(idempotencyKey);
  if (!isPositiveInt(amountPoisha)) throw new ValidationError('amountPoisha must be a positive whole number of poisha.', 'INVALID_AMOUNT');
  if (!PAYMENT_METHODS.has(method)) throw new ValidationError('method must be one of: cash, bkash, nagad, bank, other.', 'INVALID_METHOD');

  // full canonical payload hash; `requestHash` immutable; append-only.
  const requestHash = generateRequestHash({ businessId: tenantId, purchaseId: purchase, paidBy: actor, amountPoisha, method, paidAt: paidAt ? new Date(paidAt).toISOString() : null, reference: reference ?? null, note: note ?? null });

  return runIdempotently({
    model: SupplierPayment,
    filter: { businessId: tenantId, idempotencyKey: key },
    requestHash,
    authorize: async () => { await requireActiveBusiness(tenantId, providedSession ?? null); await requireActor(actor, tenantId, providedSession ?? null); },
    work: async (session) => {
      const purchaseDoc = await Purchase.findOne({ _id: purchase, businessId: tenantId }).session(session);
      if (!purchaseDoc) throw new NotFoundError('Purchase not found.', 'PURCHASE_NOT_FOUND'); // cross-business => not-found
      // tenant-safe supplier: payment supplier must match purchase supplier
      const supplierId = purchaseDoc.supplierId;

      const paidSoFar = await sumPurchasePaid(tenantId, purchase, session);
      const total = purchaseDoc.totalAmountPoisha;
      if (paidSoFar + amountPoisha > total) throw new ConflictError('Payment exceeds amount due.', 'PAID_EXCEEDS_TOTAL');

      const [payment] = await SupplierPayment.create([{
        businessId: tenantId, supplierId, batchId: undefined, receiptId: undefined,
        sourceType: 'purchase', sourceId: purchase, purchaseId: purchase, type: 'payment',
        timing: 'later', // `timing` required by schema; refill-specific value, unchanged
        paidAt: paidAt ? new Date(paidAt) : new Date(), amountPoisha, method,
        reference: optionalString(reference, 'reference', 120), note: optionalString(note, 'note', MAX), paidBy: actor,
        idempotencyKey: key, requestHash,
      }], { session, ordered: true });

      const totalPaid = paidSoFar + amountPoisha;
      purchaseDoc.amountPaidPoisha = totalPaid;
      purchaseDoc.amountDuePoisha = total - totalPaid;
      purchaseDoc.paymentStatus = totalPaid >= total ? 'paid' : (totalPaid > 0 ? 'partially_paid' : 'unpaid');
      await purchaseDoc.save({ session });
      return payment;
    },
    session: providedSession,
  });
};

// ---------- read-only reconciliation (NO auto-repair / backfill / ledger mutation) ----------

/**
 * Read-only reconciliation of separate NEW-CYLINDER inventory (`Stock.newQty`)
 * against the append-only `purchase`/`stockBucket:'new'` StockMovement ledger,
 * scoped by business + product (+ warehouse, default null). Mutates nothing.
 */
export const reconcileNewCylinderStock = async ({ businessId, productId, warehouseId = null, session } = {}) => {
  const tenantId = requireTenant(businessId);
  const product = requireObjectId(productId, 'product id');
  const warehouse = warehouseId ? requireObjectId(warehouseId, 'warehouse id') : null;

  // product must be owned (tenant-safe); NOT found cross-business
  const owned = await Product.exists({ _id: product, businessId: tenantId }).session(session ?? null);
  if (!owned) throw new NotFoundError('Product not found.', 'PRODUCT_NOT_FOUND');

  const stock = await Stock.findOne({ businessId: tenantId, productId: product, warehouseId: warehouse ?? null }).session(session ?? null).lean();
  const storedNewQty = stock?.newQty ?? 0;

  const movements = await StockMovement.find({
    businessId: tenantId, productId: product, warehouseId: warehouse ?? null, stockBucket: 'new',
  }).session(session ?? null).lean();

  let recomputedNewQty = 0;
  let unreconciled = 0;
  for (const movement of movements) {
    if (!movement.direction) { unreconciled += 1; continue; }
    recomputedNewQty += movement.direction === 'in' ? movement.quantity : -movement.quantity;
  }

  const discrepancy = storedNewQty - recomputedNewQty;
  return {
    businessId: tenantId, productId: product, warehouseId: warehouse ?? null,
    storedNewQty, recomputedNewQty, discrepancy,
    matches: discrepancy === 0 && recomputedNewQty >= 0,
    unreconciledMovements: unreconciled,
    purchaseMovements: movements.filter((m) => m.movementType === 'purchase').length,
    stock: stock ?? null,
  };
};

/**
 * Read-only audit of Purchase payment cache vs append-only SupplierPayment.
 * `amountPaidPoisha`/`amountDuePoisha`/`paymentStatus` recomputed from
 * SupplierPayment(sourceType='purchase',type='payment'). Mutates nothing.
 */
export const reconcilePurchasePayment = async ({ businessId, purchaseId, session } = {}) => {
  const tenantId = requireTenant(businessId);
  const purchaseDoc = await Purchase.findOne({ _id: requireObjectId(purchaseId, 'purchase id'), businessId: tenantId }).session(session ?? null).lean();
  if (!purchaseDoc) throw new NotFoundError('Purchase not found.', 'PURCHASE_NOT_FOUND');

  const paidPoisha = await sumPurchasePaid(tenantId, purchaseDoc._id, session);
  const total = purchaseDoc.totalAmountPoisha;
  const amountDuePoisha = total - paidPoisha;
  const paymentStatus = paidPoisha >= total ? 'paid' : (paidPoisha > 0 ? 'partially_paid' : 'unpaid');

  const stored = {
    amountPaidPoisha: purchaseDoc.amountPaidPoisha, amountDuePoisha: purchaseDoc.amountDuePoisha, paymentStatus: purchaseDoc.paymentStatus,
  };
  const recomputed = { amountPaidPoisha: paidPoisha, amountDuePoisha, paymentStatus };
  const matches =
    stored.amountPaidPoisha === recomputed.amountPaidPoisha &&
    stored.amountDuePoisha === recomputed.amountDuePoisha &&
    stored.paymentStatus === recomputed.paymentStatus &&
    paidPoisha <= total;

  return { purchaseId: purchaseDoc._id, totalAmountPoisha: total, stored, recomputed, matches, paidPoisha };
};

// ---------- reads (tenant-safe) ----------
export const getPurchase = async (purchaseId, businessId, { session } = {}) => {
  if (!mongoose.isValidObjectId(purchaseId)) throw new NotFoundError('Purchase not found.', 'PURCHASE_NOT_FOUND');
  const tenantId = requireTenant(businessId);
  const purchase = await Purchase.findOne({ _id: purchaseId, businessId: tenantId }).session(session ?? null).lean();
  if (!purchase) throw new NotFoundError('Purchase not found.', 'PURCHASE_NOT_FOUND');
  return purchase;
};

export const listPurchases = async ({ businessId, supplierId, paymentStatus, session } = {}) => {
  const tenantId = requireTenant(businessId);
  const filter = { businessId: tenantId };
  if (supplierId) filter.supplierId = requireObjectId(supplierId, 'supplier id');
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  return Purchase.find(filter).sort({ purchasedAt: -1 }).session(session ?? null).lean();
};

/** Append-only supplier payment history for a purchase (tenant-scoped). */
export const getPurchasePayments = async (purchaseId, businessId, { session } = {}) => {
  const purchase = await getPurchase(purchaseId, businessId, { session });
  return SupplierPayment.find({ businessId, purchaseId: purchase._id, sourceType: 'purchase' }).sort({ createdAt: 1 }).session(session ?? null).lean();
};

/** Amount due for a purchase. */
export const getPurchaseDue = async (purchaseId, businessId, { session } = {}) => {
  const purchase = await getPurchase(purchaseId, businessId, { session });
  return { purchaseId: purchase._id, totalAmountPoisha: purchase.totalAmountPoisha, amountPaidPoisha: purchase.amountPaidPoisha, amountDuePoisha: purchase.amountDuePoisha, paymentStatus: purchase.paymentStatus };
};

/** Tenant-safe supplier balance for NEW-CYLINDER purchases. */
export const getPurchaseSupplierBalance = async ({ businessId, supplierId, session } = {}) => {
  const tenantId = requireTenant(businessId);
  const supplier = requireObjectId(supplierId, 'supplier id');
  // verify supplier belongs to tenant
  const exists = await Supplier.exists({ _id: supplier, businessId: tenantId }).session(session ?? null);
  if (!exists) throw new NotFoundError('Supplier not found.', 'SUPPLIER_NOT_FOUND');

  const purchases = await Purchase.find({ businessId: tenantId, supplierId: supplier, status: 'posted' }).select('totalAmountPoisha').session(session ?? null).lean();
  const obligationsPoisha = purchases.reduce((sum, p) => sum + p.totalAmountPoisha, 0);
  const payments = await SupplierPayment.find({ businessId: tenantId, supplierId: supplier, sourceType: 'purchase', type: 'payment' }).select('amountPoisha').session(session ?? null).lean();
  const paidPoisha = payments.reduce((sum, p) => sum + p.amountPoisha, 0);
  return { businessId: tenantId, supplierId: supplier, obligationsPoisha, paidPoisha, amountDuePoisha: obligationsPoisha - paidPoisha };
};

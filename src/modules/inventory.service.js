/**
 * Inventory foundation (Phase 2 Step 3).
 *
 * Safe, tenant-scoped, transaction-safe stock operations over the append-only
 * StockMovement ledger and the atomic `Stock` balance. NOT Purchase, NOT Sales,
 * NOT transfers, NOT warehouse management.
 *
 * Invariants:
 *  - Four buckets: full | empty | damaged | rejected.
 *  - `businessId` is verified tenant context, NEVER request body; product +
 *    warehouse ownership are re-validated inside the transaction.
 *  - Atomic `$inc` + `$gte` no-negative guard + unique index + MongoDB
 *    transaction => concurrency-safe; `version` optimistic token is bumped.
 *  - Negative stock is prevented. `allowNegative:true` is rejected; `$gte` +
 *    `Stock` schema `min:0` hard backstop. Overdraft disabled for MVP.
 *  - StockMovement is append-only; corrections are new movements.
 *  - Manual adjustments require a `reason`; opening stock is dealer-entered and
 *    quantities are NEVER assumed.
 *  - Idempotency: `idempotencyKey` (unique per business, partial) + `sourceType`/
 *    `sourceId`/`sourceLineId`/`movementGroupId` prevent duplicate posting.
 *  - `warehouseId` optional; `null` = implicit default single warehouse (no
 *    setup); a supplied warehouse is ownership-validated. Multi-warehouse ready.
 *  - Refill is NOT touched; existing refill Stock/StockMovement inserts remain
 *    valid in single-warehouse mode.
 */
import mongoose from 'mongoose';
import Business from './business.model.js';
import BusinessMember from './business-member.model.js';
import Product from './product.model.js';
import Stock from './stock.model.js';
import StockMovement from './stock-movement.model.js';
import User from './user.model.js';
import Warehouse from './warehouse.model.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { inTransaction, requireObjectId, normalizeIdempotencyKey } from '../kernel/index.js';

export const BUCKETS = Object.freeze(['full', 'empty', 'damaged', 'rejected']);
const BUCKET_FIELD = Object.freeze({ full: 'fullQty', empty: 'emptyQty', damaged: 'damagedQty', rejected: 'rejectedQty' });
const ADJUSTMENT_TYPE = 'adjustment';
const isInteger = (value) => Number.isSafeInteger(value);

const requireBucket = (bucket) => {
  if (!BUCKETS.includes(bucket)) throw new ValidationError(`Stock bucket must be one of: ${BUCKETS.join(', ')}.`, 'INVALID_BUCKET');
  return bucket;
};

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

/** Product must exist and belong to this tenant. */
const requireOwnedProduct = async (businessId, productId, session) => {
  const id = requireObjectId(productId, 'product id');
  const product = await Product.findOne({ _id: id, businessId }).select('_id businessId').session(session).lean();
  if (!product) throw new NotFoundError('Product not found.', 'PRODUCT_NOT_FOUND');
  return id;
};

/**
 * Resolve + validate warehouse. `null`/omitted => implicit default warehouse (no doc, no setup).
 * A supplied `warehouseId` must reference an ACTIVE warehouse OWNED by `businessId`.
 * Cross-business / nonexistent => not-found (indistinguishable).
 */
export const resolveWarehouse = async (businessId, warehouseId, session) => {
  const business = await Business.findOne({ _id: businessId, status: 'active' }).select('multiWarehouse').session(session ?? null).lean();
  if (!business) throw new NotFoundError('Active business was not found.', 'BUSINESS_NOT_FOUND');

  // Default single-warehouse mode: `null`/omitted => implicit default warehouse. No doc/setup; always safe.
  if (warehouseId === undefined || warehouseId === null || warehouseId === '') return null;

  // Multi-warehouse is DISABLED by default and cannot be safely enabled while Refill is not warehouse-compatible.
  if (business.multiWarehouse !== true) {
    throw new ForbiddenError(
      'Multi-warehouse is disabled for this business; warehouse-specific stock requires multi-warehouse mode, which cannot be enabled until Refill is warehouse-compatible.',
      'MULTI_WAREHOUSE_DISABLED',
    );
  }

  const id = requireObjectId(warehouseId, 'warehouse id');
  // Warehouse must be ACTIVE, OWNED by this business, and business must be active (checked above). Cross-business/nonexistent => not-found.
  const warehouse = await Warehouse.findOne({ _id: id, businessId, status: 'active' }).select('_id').session(session ?? null).lean();
  if (!warehouse) throw new NotFoundError('Warehouse not found.', 'WAREHOUSE_NOT_FOUND');
  return id;
};

/**
 * Reject unsafe enablement of multi-warehouse. Currently ALWAYS rejects `enabled===true`
 * because Refill is not warehouse-compatible; `enabled===false` is a safe no-op.
 */
export const setMultiWarehouse = async ({ businessId, enabled } = {}) => {
  requireObjectId(businessId, 'business id');
  if (enabled !== true && enabled !== false) throw new ValidationError('multiWarehouse must be an explicit boolean.', 'INVALID_MULTI_WAREHOUSE');
  if (enabled === true) {
    throw new ForbiddenError(
      'Cannot enable multi-warehouse: Refill operations are not warehouse-compatible. Multi-warehouse remains disabled until Refill is warehouse-compatible.',
      'MULTI_WAREHOUSE_UNSAFE',
    );
  }
  return { businessId: String(businessId), multiWarehouse: false };
};

const stockFilter = (businessId, productId, warehouseId) => ({ businessId, productId, warehouseId: warehouseId ?? null });

/** Validate a full four-bucket quantities object; NO bucket is assumed. */
const validateQuantities = (quantities) => {
  if (!quantities || typeof quantities !== 'object' || Array.isArray(quantities)) {
    throw new ValidationError('Opening stock quantities are required for all four buckets.', 'INVALID_QUANTITIES');
  }
  const out = {};
  for (const bucket of BUCKETS) {
    const value = quantities[bucket];
    if (value === undefined || value === null || !isInteger(value) || value < 0) {
      throw new ValidationError(`Opening stock '${bucket}' must be an explicit non-negative whole number.`, 'INVALID_QUANTITIES');
    }
    out[bucket] = value;
  }
  return out;
};

/** Read current balance. */
export const getStock = async ({ businessId, productId, warehouseId = null, session } = {}) => {
  const tenantId = requireTenant(businessId);
  const product = await requireOwnedProduct(tenantId, productId, session ?? null);
  const wh = await resolveWarehouse(tenantId, warehouseId, session ?? null);
  const stock = await Stock.findOne(stockFilter(tenantId, product, wh)).session(session ?? null).lean();
  return stock ?? { businessId: tenantId, productId: product, warehouseId: wh, fullQty: 0, emptyQty: 0, damagedQty: 0, rejectedQty: 0, version: 0 };
};

/**
 * Atomic no-negative bucket update + version bump. `$gte` prevents overdraft
 * atomically; `Stock` schema `min:0` + `runValidators` is a hard DB backstop.
 * Overdraft is DISABLED for MVP; there is no `allowNegative` bypass.
 */
const atomicBucketDelta = async ({ filter, field, delta, session }) => {
  const query = { ...filter };
  if (delta < 0) query[field] = { $gte: -delta };
  const updated = await Stock.findOneAndUpdate(
    query,
    { $inc: { [field]: delta, version: 1 } },
    { returnDocument: 'after', session, runValidators: true },
  );
  if (!updated) {
    throw new ConflictError('Insufficient stock for this operation; stock would go negative.', 'INSUFFICIENT_STOCK');
  }
  return updated;
};

/**
 * Opening stock. Dealer-entered; ALL four buckets must be explicit integers >=0;
 * quantities are NEVER assumed. Only allowed when no existing non-zero balance.
 * Append-only opening movements are recorded for reconciliation. Transaction-safe
 * + idempotent. `warehouseId` optional/validated. Creates NO automatic quantities.
 */
export const recordOpeningStock = async ({
  businessId, productId, warehouseId = null, actorId, quantities,
  idempotencyKey, sourceType = 'opening_stock', sourceId, reference, note, session: providedSession,
} = {}) => {
  const tenantId = requireTenant(businessId);
  const key = normalizeIdempotencyKey(idempotencyKey);
  const quantitiesValidated = validateQuantities(quantities); // no assumptions
  const actor = requireObjectId(actorId, 'actor id');
  const groupId = new mongoose.Types.ObjectId();
  const sourceTypeValidated = typeof sourceType === 'string' && sourceType.trim() ? sourceType.trim() : 'opening_stock';
  const sourceIdValidated = sourceId ? requireObjectId(sourceId, 'source id') : undefined;

  return inTransaction(async (session) => {
    await requireActiveBusiness(tenantId, session);
    await requireActor(actor, tenantId, session);
    const product = await requireOwnedProduct(tenantId, productId, session);
    const wh = await resolveWarehouse(tenantId, warehouseId, session);
    const filter = stockFilter(tenantId, product, wh);
    const keyVariants = [key, ...BUCKETS.map((bucket) => `${key}#${bucket}`)];

    // Idempotent retry: already posted -> return current state, do NOT re-apply.
    const existing = await StockMovement.findOne({ businessId: tenantId, idempotencyKey: { $in: keyVariants } }).session(session).lean();
    if (existing) {
      const stock = await Stock.findOne(filter).session(session).lean();
      return { stock, movements: [], idempotentReplay: true, movementGroupId: existing.movementGroupId ?? groupId };
    }

    const current = await Stock.findOne(filter).session(session);
    const currentTotal = current ? current.fullQty + current.emptyQty + current.damagedQty + current.rejectedQty : 0;
    if (currentTotal > 0) {
      throw new ConflictError('Opening stock can only be recorded for a product/warehouse with no existing balance.', 'OPENING_STOCK_NOT_EMPTY');
    }

    const stockDoc = {
      fullQty: quantitiesValidated.full,
      emptyQty: quantitiesValidated.empty,
      damagedQty: quantitiesValidated.damaged,
      rejectedQty: quantitiesValidated.rejected,
    };

    let stock;
    if (current) {
      stock = await Stock.findOneAndUpdate(filter, { $set: stockDoc, $inc: { version: 1 } }, { returnDocument: 'after', session, runValidators: true });
    } else {
      [stock] = await Stock.create([{ ...filter, ...stockDoc, version: 1 }], { session });
    }

    const movements = BUCKETS
      .filter((bucket) => quantitiesValidated[bucket] > 0)
      .map((bucket) => ({
        businessId: tenantId,
        productId: product,
        warehouseId: wh,
        movementType: ADJUSTMENT_TYPE,
        quantity: quantitiesValidated[bucket],
        stockBucket: bucket,
        direction: 'in',
        sourceType: sourceTypeValidated,
        sourceId: sourceIdValidated,
        movementGroupId: groupId,
        reference,
        note,
        reason: 'opening stock',
        createdBy: actor,
        // unique per business; per-bucket suffix so a multi-bucket op doesn't self-collide
        idempotencyKey: `${key}#${bucket}`,
      }));

    const created = movements.length > 0 ? await StockMovement.create(movements, { session, ordered: true }) : [];
    return { stock, movements: created, idempotentReplay: false, movementGroupId: groupId };
  }, { session: providedSession });
};

/**
 * Manual adjustment. Requires `reason`. Adjusts one bucket by a signed integer
 * `delta`. Prevents negative stock atomically (`$gte` + `min:0`); overdraft is
 * DISABLED for MVP and `allowNegative:true` is rejected. Append-only audit
 * movement. Transaction-safe + idempotent.
 */
export const applyManualAdjustment = async ({
  businessId, productId, warehouseId = null, actorId, bucket, delta, reason,
  idempotencyKey, sourceType = 'manual_adjustment', sourceId, sourceLineId, reference, note,
  allowNegative = false, expectedVersion, session: providedSession,
} = {}) => {
  const tenantId = requireTenant(businessId);
  requireBucket(bucket);
  if (!isInteger(delta) || delta === 0) throw new ValidationError('delta must be a non-zero whole number.', 'INVALID_DELTA');
  if (typeof reason !== 'string' || reason.trim() === '') throw new ValidationError('A reason is required for a manual adjustment.', 'REASON_REQUIRED');
  // Overdraft disabled for MVP. Investigate note: `allowNegative` previously only skipped `$gte`
  // while `Stock` schema `min:0` still rejected negative => inconsistent no-op; it is now rejected.
  if (allowNegative === true) throw new ForbiddenError('Overdraft is disabled; negative stock is not permitted.', 'OVERDRAFT_DISABLED');
  const key = normalizeIdempotencyKey(idempotencyKey);
  const actor = requireObjectId(actorId, 'actor id');
  const sourceTypeValidated = typeof sourceType === 'string' && sourceType.trim() ? sourceType.trim() : 'manual_adjustment';
  const sourceIdValidated = sourceId ? requireObjectId(sourceId, 'source id') : undefined;
  const sourceLineIdValidated = sourceLineId ? requireObjectId(sourceLineId, 'source line id') : undefined;
  const field = BUCKET_FIELD[bucket];
  const groupId = new mongoose.Types.ObjectId();

  return inTransaction(async (session) => {
    await requireActiveBusiness(tenantId, session);
    await requireActor(actor, tenantId, session);
    const product = await requireOwnedProduct(tenantId, productId, session);
    const wh = await resolveWarehouse(tenantId, warehouseId, session);
    const filter = stockFilter(tenantId, product, wh);

    // Idempotent retry.
    const existing = await StockMovement.findOne({ businessId: tenantId, idempotencyKey: key }).session(session).lean();
    if (existing) {
      const stock = await Stock.findOne(filter).session(session).lean();
      return { stock, movement: existing, idempotentReplay: true };
    }

    // Ensure a balance row exists WITHOUT assuming quantities (explicit zero row; not opening stock).
    await Stock.updateOne(filter, { $setOnInsert: { fullQty: 0, emptyQty: 0, damagedQty: 0, rejectedQty: 0, version: 0 } }, { upsert: true, session, setDefaultsOnInsert: false });

    const deltaFilter = { ...filter };
    if (expectedVersion !== undefined) deltaFilter.version = requireInteger(expectedVersion, 'expected version'); // optimistic concurrency

    const stock = await atomicBucketDelta({ filter: deltaFilter, field, delta, session });

    const [movement] = await StockMovement.create([{
      businessId: tenantId,
      productId: product,
      warehouseId: wh,
      movementType: ADJUSTMENT_TYPE,
      quantity: Math.abs(delta),
      stockBucket: bucket,
      direction: delta > 0 ? 'in' : 'out',
      sourceType: sourceTypeValidated,
      sourceId: sourceIdValidated,
      sourceLineId: sourceLineIdValidated,
      movementGroupId: groupId,
      reference,
      note,
      reason: reason.trim(),
      createdBy: actor,
      idempotencyKey: key,
    }], { session, ordered: true });

    return { stock, movement, idempotentReplay: false };
  }, { session: providedSession });
};

const requireInteger = (value, field) => {
  if (!isInteger(value)) throw new ValidationError(`${field} must be a whole number.`, 'INVALID_INTEGER');
  return value;
};

/**
 * Stock reconciliation. Recomputes expected bucket totals from the append-only
 * StockMovement ledger (applying stockBucket + direction for `warehouseId`) and
 * compares to the materialized Stock balance. Movements without bucket/direction
 * are reported as `unreconciled` and skipped. Returns stored, recomputed,
 * matches and per-bucket discrepancies. Read-only.
 */
export const reconcileStock = async ({ businessId, productId, warehouseId = null, session } = {}) => {
  const tenantId = requireTenant(businessId);
  const product = await requireOwnedProduct(tenantId, productId, session ?? null);
  const wh = await resolveWarehouse(tenantId, warehouseId, session ?? null);
  const filter = stockFilter(tenantId, product, wh);

  // Sequential: a single MongoDB session cannot run concurrent operations.
  const stock = await Stock.findOne(filter).session(session ?? null).lean();
  const movements = await StockMovement.find({ businessId: tenantId, productId: product, warehouseId: filter.warehouseId }).session(session ?? null).lean();

  const stored = {
    full: stock?.fullQty ?? 0,
    empty: stock?.emptyQty ?? 0,
    damaged: stock?.damagedQty ?? 0,
    rejected: stock?.rejectedQty ?? 0,
  };
  const recomputed = { full: 0, empty: 0, damaged: 0, rejected: 0 };
  let unreconciled = 0;

  for (const movement of movements) {
    if (!movement.stockBucket || !movement.direction || !BUCKETS.includes(movement.stockBucket)) { unreconciled += 1; continue; }
    recomputed[movement.stockBucket] += movement.direction === 'in' ? movement.quantity : -movement.quantity;
  }

  const discrepancies = {};
  let matches = true;
  for (const bucket of BUCKETS) {
    const diff = stored[bucket] - recomputed[bucket];
    discrepancies[bucket] = diff;
    if (diff !== 0) matches = false;
    if (recomputed[bucket] < 0) matches = false;
  }

  return {
    businessId: tenantId,
    productId: product,
    warehouseId: wh,
    stored,
    recomputed,
    discrepancies,
    matches,
    unreconciledMovements: unreconciled,
    stock: stock ?? null,
  };
};

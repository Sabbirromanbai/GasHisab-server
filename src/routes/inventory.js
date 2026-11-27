import express from 'express';
import mongoose from 'mongoose';
import { withTenant } from '../auth/middleware.js';
import { ForbiddenError, ValidationError } from '../errors.js';
import { normalizeIdempotencyKey, requireObjectId } from '../kernel/index.js';
import { applyManualAdjustment, getStock, reconcileStock, recordOpeningStock } from '../modules/inventory.service.js';

/**
 * Tenant-secure Inventory API (/api/inventory). Inventory foundation only.
 *
 *  - `withTenant`: verified session + active membership + `businessId` from a
 *    validated X-Business-Id header + DB check; `businessId`/`actorId` NEVER
 *    from request body/query; `req.auth` frozen. `businessId` passed to services
 *    is `req.auth.businessId`; `actorId` is `req.auth.userId`.
 *  - Owner/admin for opening stock + manual adjustments; any active member reads.
 *  - `warehouseId` optional; `null`/omitted = default single warehouse; non-null
 *    ownership/status validated server-side; multi-warehouse disabled.
 *  - HTTP boundary validation: types, safe integers, valid ObjectIds, required
 *    `reason`, required `idempotencyKey`, allowed enums; unknown extra fields
 *    not forwarded. Overdraft disabled; `allowNegative` rejected.
 *  - NOT Purchase / NOT Sales / NOT transfers.
 */

const BUCKETS = new Set(['full', 'empty', 'damaged', 'rejected']);
const MAX_NOTE = 1000;
const MAX_REASON = 500;
const MAX_SOURCE_TYPE = 64;

const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

const optionalString = (value, field, max) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string.`, 'INVALID_STRING');
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${field} must be at most ${max} characters.`, 'STRING_TOO_LONG');
  return trimmed === '' ? undefined : trimmed;
};

const optionalObjectId = (value, field) => {
  if (value === undefined || value === null || value === '') return undefined;
  return requireObjectId(value, field);
};

const warehouseIdFrom = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!mongoose.isValidObjectId(raw)) throw new ValidationError('A valid warehouse id is required.', 'INVALID_OBJECT_ID');
  return raw; // ownership/status re-validated server-side in inventory.service
};

const requireProductId = (raw) => requireObjectId(raw, 'product id');

export const createInventoryRouter = (auth) => {
  const router = express.Router();
  const tenant = withTenant(auth); // reads: any active member
  const tenantWrite = withTenant(auth, ['owner', 'admin']); // writes: owner/admin

  // GET /api/inventory/stock?productId&warehouseId
  router.get('/stock', ...tenant, async (req, res, next) => {
    try {
      const stock = await getStock({
        businessId: req.auth.businessId,
        productId: requireProductId(req.query.productId),
        warehouseId: warehouseIdFrom(req.query.warehouseId),
      });
      return res.json({ stock });
    } catch (error) { return next(error); }
  });

  // GET /api/inventory/reconciliation?productId&warehouseId
  router.get('/reconciliation', ...tenant, async (req, res, next) => {
    try {
      const reconciliation = await reconcileStock({
        businessId: req.auth.businessId,
        productId: requireProductId(req.query.productId),
        warehouseId: warehouseIdFrom(req.query.warehouseId),
      });
      return res.json({ reconciliation });
    } catch (error) { return next(error); }
  });

  // POST /api/inventory/opening-stock — owner/admin; idempotent
  router.post('/opening-stock', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey); // required; 400 if missing
      // reject unsafe flags
      if (body.multiWarehouse === true) throw new ForbiddenError('Multi-warehouse cannot be enabled.', 'MULTI_WAREHOUSE_UNSAFE');

      // explicit four-bucket quantities; NO assumptions; integers >=0 validated again in service
      const q = body.quantities;
      if (!q || typeof q !== 'object' || Array.isArray(q)) throw new ValidationError('quantities with all four buckets is required.', 'INVALID_QUANTITIES');
      const quantities = {};
      for (const bucket of ['full', 'empty', 'damaged', 'rejected']) {
        const value = q[bucket];
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          throw new ValidationError(`quantities.${bucket} must be an explicit non-negative whole number.`, 'INVALID_QUANTITIES');
        }
        quantities[bucket] = value;
      }

      const result = await recordOpeningStock({
        businessId: req.auth.businessId,
        productId: requireProductId(body.productId),
        warehouseId: warehouseIdFrom(body.warehouseId),
        actorId: req.auth.userId,
        quantities,
        idempotencyKey,
        sourceType: optionalString(body.sourceType, 'sourceType', MAX_SOURCE_TYPE),
        sourceId: optionalObjectId(body.sourceId, 'source id'),
        reference: optionalString(body.reference, 'reference', 120),
        note: optionalString(body.note, 'note', MAX_NOTE),
      });
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (error) { return next(error); }
  });

  // POST /api/inventory/adjustments — owner/admin; idempotent; reason required; overdraft disabled
  router.post('/adjustments', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey); // required

      if (!BUCKETS.has(body.bucket)) throw new ValidationError('bucket must be one of: full, empty, damaged, rejected.', 'INVALID_BUCKET');
      if (typeof body.delta !== 'number' || !Number.isSafeInteger(body.delta) || body.delta === 0) {
        throw new ValidationError('delta must be a non-zero whole number.', 'INVALID_DELTA');
      }
      if (typeof body.reason !== 'string' || body.reason.trim() === '') throw new ValidationError('A reason is required for a manual adjustment.', 'REASON_REQUIRED');
      if (body.reason.trim().length > MAX_REASON) throw new ValidationError(`reason must be at most ${MAX_REASON} characters.`, 'STRING_TOO_LONG');
      // overdraft disabled for MVP
      if (body.allowNegative === true) throw new ForbiddenError('Overdraft is disabled; negative stock is not permitted.', 'OVERDRAFT_DISABLED');
      if (body.multiWarehouse === true) throw new ForbiddenError('Multi-warehouse cannot be enabled.', 'MULTI_WAREHOUSE_UNSAFE');

      let expectedVersion;
      if (body.expectedVersion !== undefined && body.expectedVersion !== null) {
        if (typeof body.expectedVersion !== 'number' || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
          throw new ValidationError('expectedVersion must be a non-negative whole number.', 'INVALID_VERSION');
        }
        expectedVersion = body.expectedVersion;
      }

      const result = await applyManualAdjustment({
        businessId: req.auth.businessId,
        productId: requireProductId(body.productId),
        warehouseId: warehouseIdFrom(body.warehouseId),
        actorId: req.auth.userId,
        bucket: body.bucket,
        delta: body.delta,
        reason: body.reason.trim(),
        idempotencyKey,
        sourceType: optionalString(body.sourceType, 'sourceType', MAX_SOURCE_TYPE),
        sourceId: optionalObjectId(body.sourceId, 'source id'),
        sourceLineId: optionalObjectId(body.sourceLineId, 'source line id'),
        reference: optionalString(body.reference, 'reference', 120),
        note: optionalString(body.note, 'note', MAX_NOTE),
        expectedVersion,
        // NOTE: `allowNegative` intentionally not forwarded; overdraft disabled.
      });
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (error) { return next(error); }
  });

  return router;
};

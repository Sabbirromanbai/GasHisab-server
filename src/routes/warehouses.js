import express from 'express';
import mongoose from 'mongoose';
import { withTenant } from '../auth/middleware.js';
import Warehouse from '../modules/warehouse.model.js';
import { NotFoundError } from '../errors.js';
import { setMultiWarehouse } from '../modules/inventory.service.js';

/**
 * Safe Warehouse API/configuration. NOT warehouse-management UI, NOT transfers,
 * NOT enabling multi-warehouse.
 *
 *  - Tenant-scoped via `withTenant`; `businessId` from verified context.
 *  - Reads: any active member. No shared/global warehouses.
 *  - Cross-business custom reads as not-found.
 *  - DEFAULT single warehouse requires NO Warehouse doc/setup; `GET /default`
 *    returns the implicit `null` warehouse + `multiWarehouse:false`.
 *  - Multi-warehouse DISABLED by default; `multiWarehouse=true` is REJECTED
 *    clearly until Refill is warehouse-compatible (see inventory.setMultiWarehouse).
 *  - No route creates/edits warehouses in this MVP; ownership/status are still
 *    validated server-side on use (`inventory.resolveWarehouse`).
 */
export const createWarehouseRouter = (auth) => {
  const router = express.Router();
  const tenant = withTenant(auth);

  // implicit default single warehouse; no setup
  router.get('/default', ...tenant, async (req, res, next) => {
    try {
      return res.json({
        warehouse: null,
        warehouseId: null,
        mode: 'single',
        multiWarehouse: false, // effective: always disabled in MVP
      });
    } catch (error) { return next(error); }
  });

  router.get('/', ...tenant, async (req, res, next) => {
    try {
      const filter = { businessId: req.auth.businessId };
      if (req.query.status === 'active' || req.query.status === 'inactive') filter.status = req.query.status;
      const warehouses = await Warehouse.find(filter).sort({ createdAt: 1 }).lean();
      return res.json({ warehouses });
    } catch (error) { return next(error); }
  });

  router.get('/:id', ...tenant, async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) throw new NotFoundError('Warehouse not found.', 'WAREHOUSE_NOT_FOUND');
      const warehouse = await Warehouse.findOne({ _id: req.params.id, businessId: req.auth.businessId }).lean();
      if (!warehouse) throw new NotFoundError('Warehouse not found.', 'WAREHOUSE_NOT_FOUND'); // cross-business => not-found
      return res.json({ warehouse });
    } catch (error) { return next(error); }
  });

  // Multi-warehouse enablement endpoint: rejects unsafe `true`. `false` is a safe no-op.
  router.patch('/config/multi-warehouse', ...withTenant(auth, ['owner', 'admin']), async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const result = await setMultiWarehouse({ businessId: req.auth.businessId, enabled: body.multiWarehouse ?? body.enabled });
      return res.json(result);
    } catch (error) { return next(error); }
  });

  return router;
};

import express from 'express';
import { withTenant } from '../auth/middleware.js';
import { requireObjectId } from '../kernel/index.js';
import { createSupplier, deactivateSupplier, getSupplier, getSupplierBalanceSummary, getSupplierPayments, getSupplierPurchases, listSuppliers, reconcileSupplierPurchaseBalance, updateSupplier } from '../modules/supplier.service.js';

/**
 * Tenant-secure Supplier Management Foundation API (/api/suppliers).
 * `businessId` from verified tenant; `actor`=req.auth.userId; never body.
 * Owner/admin writes; member reads. NOT destructive; NOT Supplier Returns.
 */
const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
const pageNum = (v, d) => { const n = Number(v); return Number.isSafeInteger(n) && n >= 1 ? n : d; };

export const createSupplierRouter = (auth) => {
  const router = express.Router();
  const tenant = withTenant(auth);
  const tenantWrite = withTenant(auth, ['owner', 'admin']);

  router.get('/', ...tenant, async (req, res, next) => {
    try {
      const result = await listSuppliers({ businessId: req.auth.businessId, status: typeof req.query.status === 'string' ? req.query.status : undefined, search: typeof req.query.search === 'string' ? req.query.search : undefined, page: pageNum(req.query.page, 1), limit: pageNum(req.query.limit, 50) });
      return res.json(result);
    } catch (error) { return next(error); }
  });

  router.get('/:id', ...tenant, async (req, res, next) => {
    try { return res.json({ supplier: await getSupplier(requireObjectId(req.params.id, 'supplier id'), req.auth.businessId) }); } catch (error) { return next(error); }
  });

  router.get('/:id/purchases', ...tenant, async (req, res, next) => {
    try { return res.json(await getSupplierPurchases({ businessId: req.auth.businessId, supplierId: req.params.id, page: pageNum(req.query.page, 1), limit: pageNum(req.query.limit, 50) })); } catch (error) { return next(error); }
  });

  router.get('/:id/payments', ...tenant, async (req, res, next) => {
    try { return res.json(await getSupplierPayments({ businessId: req.auth.businessId, supplierId: req.params.id, page: pageNum(req.query.page, 1), limit: pageNum(req.query.limit, 50), sourceType: typeof req.query.sourceType === 'string' ? req.query.sourceType : undefined })); } catch (error) { return next(error); }
  });

  router.get('/:id/balance', ...tenant, async (req, res, next) => {
    try { return res.json({ balance: await getSupplierBalanceSummary({ businessId: req.auth.businessId, supplierId: req.params.id }) }); } catch (error) { return next(error); }
  });

  router.get('/:id/balance/reconciliation', ...tenant, async (req, res, next) => {
    try { return res.json({ reconciliation: await reconcileSupplierPurchaseBalance({ businessId: req.auth.businessId, supplierId: req.params.id }) }); } catch (error) { return next(error); }
  });

  router.post('/', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const supplier = await createSupplier({ businessId: req.auth.businessId, actorId: req.auth.userId, name: body.name, mobile: body.mobile, phone: body.phone, email: body.email, address: body.address, notes: body.notes, status: body.status, brandAuthorizations: body.brandAuthorizations });
      return res.status(201).json({ supplier });
    } catch (error) { return next(error); }
  });

  router.patch('/:id', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const supplier = await updateSupplier({ businessId: req.auth.businessId, actorId: req.auth.userId, supplierId: req.params.id, name: body.name, mobile: body.mobile, phone: body.phone, email: body.email, address: body.address, notes: body.notes, status: body.status, brandAuthorizations: body.brandAuthorizations });
      return res.json({ supplier });
    } catch (error) { return next(error); }
  });

  router.post('/:id/deactivate', ...tenantWrite, async (req, res, next) => {
    try { return res.json({ supplier: await deactivateSupplier({ businessId: req.auth.businessId, actorId: req.auth.userId, supplierId: req.params.id }) }); } catch (error) { return next(error); }
  });

  return router;
};

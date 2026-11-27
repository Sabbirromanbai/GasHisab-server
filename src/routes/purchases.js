import express from 'express';
import { withTenant } from '../auth/middleware.js';
import { normalizeIdempotencyKey, requireObjectId } from '../kernel/index.js';
import { createPurchase, getPurchase, getPurchaseDue, getPurchasePayments, getPurchaseSupplierBalance, listPurchases, recordPurchasePayment, reconcileNewCylinderStock, reconcilePurchasePayment } from '../modules/purchase.service.js';

/**
 * Tenant-secure Purchase foundation API (/api/purchases). NEW-CYLINDER purchase
 * only. NOT Sales, NOT Customer Sale Returns, NOT Supplier Returns, NOT
 * Purchase Returns. `businessId` from verified tenant; `actorId`/`paidBy`
 * = req.auth.userId; never body. Owner/admin writes; member reads.
 */
const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

export const createPurchaseRouter = (auth) => {
  const router = express.Router();
  const tenant = withTenant(auth);
  const tenantWrite = withTenant(auth, ['owner', 'admin']);

  router.get('/', ...tenant, async (req, res, next) => {
    try {
      const purchases = await listPurchases({
        businessId: req.auth.businessId,
        supplierId: typeof req.query.supplierId === 'string' ? req.query.supplierId : undefined,
        paymentStatus: typeof req.query.paymentStatus === 'string' ? req.query.paymentStatus : undefined,
      });
      return res.json({ purchases });
    } catch (error) { return next(error); }
  });

  // read-only new-cylinder stock reconciliation, scoped by business + product
  router.get('/reconciliation/new-cylinder', ...tenant, async (req, res, next) => {
    try {
      const reconciliation = await reconcileNewCylinderStock({
        businessId: req.auth.businessId,
        productId: req.query.productId,
        warehouseId: typeof req.query.warehouseId === 'string' ? req.query.warehouseId : null,
      });
      return res.json({ reconciliation });
    } catch (error) { return next(error); }
  });

  // supplier balance (tenant-safe)
  router.get('/suppliers/:supplierId/balance', ...tenant, async (req, res, next) => {
    try {
      const balance = await getPurchaseSupplierBalance({ businessId: req.auth.businessId, supplierId: req.params.supplierId });
      return res.json({ balance });
    } catch (error) { return next(error); }
  });

  router.get('/:id', ...tenant, async (req, res, next) => {
    try { return res.json({ purchase: await getPurchase(req.params.id, req.auth.businessId) }); } catch (error) { return next(error); }
  });

  router.get('/:id/due', ...tenant, async (req, res, next) => {
    try { return res.json(await getPurchaseDue(req.params.id, req.auth.businessId)); } catch (error) { return next(error); }
  });

  router.get('/:id/payments', ...tenant, async (req, res, next) => {
    try { return res.json({ payments: await getPurchasePayments(req.params.id, req.auth.businessId) }); } catch (error) { return next(error); }
  });

  // read-only reconciliation; no auto-repair
  router.get('/:id/reconciliation', ...tenant, async (req, res, next) => {
    try { return res.json({ reconciliation: await reconcilePurchasePayment({ businessId: req.auth.businessId, purchaseId: req.params.id }) }); } catch (error) { return next(error); }
  });

  // create + post new-cylinder purchase; owner/admin; idempotent; dealer-defined prices
  router.post('/', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const purchase = await createPurchase({
        businessId: req.auth.businessId, // verified tenant
        supplierId: body.supplierId,
        actorId: req.auth.userId, // verified actor
        items: body.items,
        purchasedAt: body.purchasedAt,
        purchaseNumber: body.purchaseNumber,
        note: body.note,
        reference: body.reference,
        idempotencyKey: normalizeIdempotencyKey(body.idempotencyKey), // required
      });
      return res.status(201).json({ purchase });
    } catch (error) { return next(error); }
  });

  // record supplier payment against a purchase; owner/admin; append-only; idempotent; full/partial/unpaid
  router.post('/:id/payments', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const payment = await recordPurchasePayment({
        businessId: req.auth.businessId,
        purchaseId: requireObjectId(req.params.id, 'purchase id'),
        paidBy: req.auth.userId,
        amountPoisha: body.amountPoisha,
        method: body.method,
        paidAt: body.paidAt,
        reference: body.reference,
        note: body.note,
        idempotencyKey: normalizeIdempotencyKey(body.idempotencyKey),
      });
      return res.status(201).json({ payment });
    } catch (error) { return next(error); }
  });

  return router;
};

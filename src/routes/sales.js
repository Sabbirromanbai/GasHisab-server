import express from 'express';
import { withTenant } from '../auth/middleware.js';
import { normalizeIdempotencyKey, requireObjectId } from '../kernel/index.js';
import { createSale, getSale, getSaleDue, getSalePayments, listSales, recordSalePayment, reconcileSalePayment, reconcileSaleStock } from '../modules/sale.service.js';

/**
 * Tenant-secure New Cylinder Sales Foundation API (/api/sales).
 * NOT Sales Returns/refunds/advance/multi-warehouse. `businessId` from verified
 * tenant; `actorId`=req.auth.userId; never body. Owner/admin writes; member reads.
 */
const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

export const createSaleRouter = (auth) => {
  const router = express.Router();
  const tenant = withTenant(auth);
  const tenantWrite = withTenant(auth, ['owner', 'admin']);

  // read-only sale stock reconciliation (`newQty` vs append-only sale ledger); scoped business+product
  router.get('/reconciliation/stock', ...tenant, async (req, res, next) => {
    try {
      const reconciliation = await reconcileSaleStock({ businessId: req.auth.businessId, productId: req.query.productId });
      return res.json({ reconciliation });
    } catch (error) { return next(error); }
  });

  router.get('/', ...tenant, async (req, res, next) => {
    try {
      const sales = await listSales({
        businessId: req.auth.businessId,
        customerId: typeof req.query.customerId === 'string' ? req.query.customerId : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
      });
      return res.json({ sales });
    } catch (error) { return next(error); }
  });

  router.get('/:id', ...tenant, async (req, res, next) => {
    try { return res.json({ sale: await getSale(req.params.id, req.auth.businessId) }); } catch (error) { return next(error); }
  });

  router.get('/:id/due', ...tenant, async (req, res, next) => {
    try { return res.json(await getSaleDue(req.params.id, req.auth.businessId)); } catch (error) { return next(error); }
  });

  router.get('/:id/payments', ...tenant, async (req, res, next) => {
    try { return res.json({ payments: await getSalePayments(req.params.id, req.auth.businessId) }); } catch (error) { return next(error); }
  });

  router.get('/:id/reconciliation', ...tenant, async (req, res, next) => {
    try { return res.json({ reconciliation: await reconcileSalePayment({ businessId: req.auth.businessId, saleId: req.params.id }) }); } catch (error) { return next(error); }
  });

  // create + post new-cylinder sale; owner/admin; idempotent; dealer-defined selling prices
  router.post('/', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const sale = await createSale({
        businessId: req.auth.businessId,
        customerId: body.customerId,
        actorId: req.auth.userId,
        invoiceNumber: body.invoiceNumber,
        saleDate: body.saleDate,
        items: body.items,
        note: body.note,
        reference: body.reference,
        idempotencyKey: normalizeIdempotencyKey(body.idempotencyKey),
      });
      return res.status(201).json({ sale });
    } catch (error) { return next(error); }
  });

  // append-only customer sale payment; owner/admin; idempotent; no overpayment
  router.post('/:id/payments', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const payment = await recordSalePayment({
        businessId: req.auth.businessId,
        saleId: requireObjectId(req.params.id, 'sale id'),
        actorId: req.auth.userId,
        amountPoisha: body.amountPoisha ?? body.amount,
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

import express from 'express';
import { withTenant } from '../auth/middleware.js';
import { requireObjectId } from '../kernel/index.js';
import { createCustomer, deactivateCustomer, getCustomer, getCustomerDue, getCustomerPayments, getCustomerSales, listCustomers, reconcileCustomerDue, updateCustomer } from '../modules/customer.service.js';

/**
 * Tenant-secure Customer Management Foundation API (/api/customers).
 * `businessId` from verified tenant; `actor`=req.auth.userId; never body.
 * Owner/admin writes; member reads. NOT destructive delete; NOT financial.
 */
const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
const pageNum = (v, d) => { const n = Number(v); return Number.isSafeInteger(n) && n >= 1 ? n : d; };

export const createCustomerRouter = (auth) => {
  const router = express.Router();
  const tenant = withTenant(auth);
  const tenantWrite = withTenant(auth, ['owner', 'admin']);

  router.get('/', ...tenant, async (req, res, next) => {
    try {
      const result = await listCustomers({
        businessId: req.auth.businessId,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        page: pageNum(req.query.page, 1), limit: pageNum(req.query.limit, 50),
      });
      return res.json(result);
    } catch (error) { return next(error); }
  });

  router.get('/:id', ...tenant, async (req, res, next) => {
    try { return res.json({ customer: await getCustomer(requireObjectId(req.params.id, 'customer id'), req.auth.businessId) }); } catch (error) { return next(error); }
  });

  router.get('/:id/sales', ...tenant, async (req, res, next) => {
    try {
      const result = await getCustomerSales({ businessId: req.auth.businessId, customerId: req.params.id, page: pageNum(req.query.page, 1), limit: pageNum(req.query.limit, 50) });
      return res.json(result);
    } catch (error) { return next(error); }
  });

  router.get('/:id/payments', ...tenant, async (req, res, next) => {
    try {
      const result = await getCustomerPayments({ businessId: req.auth.businessId, customerId: req.params.id, page: pageNum(req.query.page, 1), limit: pageNum(req.query.limit, 50) });
      return res.json(result);
    } catch (error) { return next(error); }
  });

  router.get('/:id/due', ...tenant, async (req, res, next) => {
    try { return res.json(await getCustomerDue({ businessId: req.auth.businessId, customerId: req.params.id })); } catch (error) { return next(error); }
  });

  router.get('/:id/due/reconciliation', ...tenant, async (req, res, next) => {
    try { return res.json({ reconciliation: await reconcileCustomerDue({ businessId: req.auth.businessId, customerId: req.params.id }) }); } catch (error) { return next(error); }
  });

  router.post('/', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const customer = await createCustomer({
        businessId: req.auth.businessId, actorId: req.auth.userId,
        name: body.name, mobile: body.mobile, phone: body.phone, address: body.address, notes: body.notes, status: body.status,
      });
      return res.status(201).json({ customer });
    } catch (error) { return next(error); }
  });

  router.patch('/:id', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const customer = await updateCustomer({
        businessId: req.auth.businessId, actorId: req.auth.userId, customerId: req.params.id,
        name: body.name, mobile: body.mobile, phone: body.phone, address: body.address, notes: body.notes, status: body.status,
      });
      return res.json({ customer });
    } catch (error) { return next(error); }
  });

  // deactivate (no destructive delete)
  router.post('/:id/deactivate', ...tenantWrite, async (req, res, next) => {
    try {
      const customer = await deactivateCustomer({ businessId: req.auth.businessId, actorId: req.auth.userId, customerId: req.params.id });
      return res.json({ customer });
    } catch (error) { return next(error); }
  });

  return router;
};

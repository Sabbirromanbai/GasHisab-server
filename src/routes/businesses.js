import express from 'express';
import { requireAuthentication, withTenant } from '../auth/middleware.js';
import {
  createBusiness,
  listBusinessesForUser,
  removeBusinessMember,
  updateBusinessMember,
} from '../modules/business.service.js';

/**
 * Express router for /api/businesses.
 *
 * Collection routes only require a verified Better Auth session because they
 * operate on the caller's own membership list. Tenant-scoped routes use
 * `withTenant`, which sets `req.auth.businessId` from a verified header +
 * database membership lookup; body/query values are never trusted.
 */
export const createBusinessRouter = (auth) => {
  const router = express.Router();

  // GET /api/businesses — list active businesses for the authenticated user.
  router.get('/', requireAuthentication(auth), async (req, res, next) => {
    try {
      const businesses = await listBusinessesForUser(req.auth.userId);
      return res.json({ businesses });
    } catch (error) {
      return next(error);
    }
  });

  // POST /api/businesses — create a business and owner membership.
  router.post('/', requireAuthentication(auth), async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const business = await createBusiness({
        name: body.name,
        slug: body.slug,
        contact: body.contact,
        address: body.address,
        createdBy: req.auth.userId,
      });
      return res.status(201).json({ business });
    } catch (error) {
      // Status/code mapping lives in the central HTTP mapper, never here.
      return next(error);
    }
  });

  // PATCH /api/businesses/members/:userId — owner-only role/status change.
  router.patch('/members/:userId', ...withTenant(auth, ['owner']), async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const member = await updateBusinessMember({
        businessId: req.auth.businessId,
        userId: req.params.userId,
        role: body.role,
        status: body.status,
        actorId: req.auth.userId,
      });
      return res.json({ member });
    } catch (error) {
      return next(error);
    }
  });

  // DELETE /api/businesses/members/:userId — owner-only membership removal.
  router.delete('/members/:userId', ...withTenant(auth, ['owner']), async (req, res, next) => {
    try {
      const result = await removeBusinessMember({
        businessId: req.auth.businessId,
        userId: req.params.userId,
        actorId: req.auth.userId,
      });
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  return router;
};

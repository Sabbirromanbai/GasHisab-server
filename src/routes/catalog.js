import express from 'express';
import { requirePlatformAdmin, withTenant } from '../auth/middleware.js';
import {
  createBrand,
  createCylinderSize,
  createProduct,
  getBrand,
  getCylinderSize,
  getProduct,
  listBrands,
  listCylinderSizes,
  listProducts,
  updateProduct,
} from '../modules/catalog.service.js';

/**
 * Express router for /api/catalog. Consistent with src/routes/businesses.js.
 *
 * Tenant safety:
 *  - Tenant-scoped routes use `withTenant`, which derives `businessId` from a
 *    verified session + active BusinessMember row + X-Business-Id header; body
 *    and query `businessId` are NEVER trusted. Writes require owner/admin.
 *  - `scope='shared'` (platform reference data) WRITES require `requirePlatformAdmin`
 *    (Better Auth session re-checked + DB platformRole==='super_admin'). Tenants
 *    can never create/own shared entries; `businessId` is forced null.
 *  - Shared catalog reads are available to any authenticated tenant; custom
 *    `scope='business'` entries are only visible to their owning tenant.
 *  - Cross-business custom references and nonexistent ids are indistinguishable
 *    (404 CATALOG_NOT_FOUND / *_NOT_FOUND).
 *  - `POST` on tenant routes FORCES `scope='business'`; it cannot mint shared data.
 */

const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
const tenantRoles = (auth) => withTenant(auth, ['owner', 'admin']);

export const createCatalogRouter = (auth) => {
  const router = express.Router();
  const tenant = withTenant(auth); // reads: any active member
  const tenantWrite = tenantRoles(auth); // writes: owner/admin
  const platformAdmin = requirePlatformAdmin(auth);

  // ---------------- Brand ----------------
  router.get('/brands', ...tenant, async (req, res, next) => {
    try {
      const brands = await listBrands({
        businessId: req.auth.businessId,
        scope: req.query.scope === 'shared' || req.query.scope === 'business' ? req.query.scope : undefined,
        status: req.query.status === 'active' || req.query.status === 'inactive' ? req.query.status : undefined,
      });
      return res.json({ brands });
    } catch (error) { return next(error); }
  });

  router.get('/brands/:id', ...tenant, async (req, res, next) => {
    try {
      const brand = await getBrand(req.params.id, req.auth.businessId);
      return res.json({ brand });
    } catch (error) { return next(error); }
  });

  // Business-owned custom brand. scope forced to 'business'; businessId from verified tenant.
  router.post('/brands', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      if (body.scope !== undefined && body.scope !== 'business') {
        return res.status(403).json({ error: 'Shared catalog writes require platform administration.', code: 'PLATFORM_ADMIN_REQUIRED' });
      }
      const brand = await createBrand({
        scope: 'business',
        businessId: req.auth.businessId, // verified tenant, never body
        code: body.code,
        nameEn: body.nameEn,
        nameBn: body.nameBn,
        logoUrl: body.logoUrl,
        status: body.status,
        createdBy: req.auth.userId,
      });
      return res.status(201).json({ brand });
    } catch (error) { return next(error); }
  });

  // Shared platform brand. Requires platform admin. Not tenant-scoped; businessId forced null.
  router.post('/brands/shared', platformAdmin, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const brand = await createBrand({
        scope: 'shared',
        businessId: null,
        code: body.code,
        nameEn: body.nameEn,
        nameBn: body.nameBn,
        logoUrl: body.logoUrl,
        status: body.status,
        createdBy: req.auth.userId,
      });
      return res.status(201).json({ brand });
    } catch (error) { return next(error); }
  });

  // ---------------- CylinderSize ----------------
  router.get('/cylinder-sizes', ...tenant, async (req, res, next) => {
    try {
      const cylinderSizes = await listCylinderSizes({
        businessId: req.auth.businessId,
        scope: req.query.scope === 'shared' || req.query.scope === 'business' ? req.query.scope : undefined,
        status: req.query.status === 'active' || req.query.status === 'inactive' ? req.query.status : undefined,
      });
      return res.json({ cylinderSizes });
    } catch (error) { return next(error); }
  });

  router.get('/cylinder-sizes/:id', ...tenant, async (req, res, next) => {
    try {
      const cylinderSize = await getCylinderSize(req.params.id, req.auth.businessId);
      return res.json({ cylinderSize });
    } catch (error) { return next(error); }
  });

  router.post('/cylinder-sizes', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      if (body.scope !== undefined && body.scope !== 'business') {
        return res.status(403).json({ error: 'Shared catalog writes require platform administration.', code: 'PLATFORM_ADMIN_REQUIRED' });
      }
      const cylinderSize = await createCylinderSize({
        scope: 'business',
        businessId: req.auth.businessId,
        code: body.code,
        capacityGrams: body.capacityGrams,
        tareWeightGrams: body.tareWeightGrams,
        segment: body.segment,
        labelEn: body.labelEn,
        labelBn: body.labelBn,
        sortOrder: body.sortOrder,
        status: body.status,
        createdBy: req.auth.userId,
      });
      return res.status(201).json({ cylinderSize });
    } catch (error) { return next(error); }
  });

  router.post('/cylinder-sizes/shared', platformAdmin, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const cylinderSize = await createCylinderSize({
        scope: 'shared',
        businessId: null,
        code: body.code,
        capacityGrams: body.capacityGrams,
        tareWeightGrams: body.tareWeightGrams,
        segment: body.segment,
        labelEn: body.labelEn,
        labelBn: body.labelBn,
        sortOrder: body.sortOrder,
        status: body.status,
        createdBy: req.auth.userId,
      });
      return res.status(201).json({ cylinderSize });
    } catch (error) { return next(error); }
  });

  // ---------------- Product ----------------
  router.get('/products', ...tenant, async (req, res, next) => {
    try {
      const products = await listProducts({
        businessId: req.auth.businessId,
        status: req.query.status === 'active' || req.query.status === 'inactive' ? req.query.status : undefined,
        kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
      });
      return res.json({ products });
    } catch (error) { return next(error); }
  });

  router.get('/products/:id', ...tenant, async (req, res, next) => {
    try {
      const product = await getProduct(req.params.id, req.auth.businessId);
      return res.json({ product });
    } catch (error) { return next(error); }
  });

  router.post('/products', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const product = await createProduct({
        businessId: req.auth.businessId, // verified tenant, never body
        kind: body.kind,
        brand: body.brand,
        cylinderSizeKg: body.cylinderSizeKg,
        purchasePrice: body.purchasePrice,
        sellingPrice: body.sellingPrice,
        brandId: body.brandId,
        cylinderSizeId: body.cylinderSizeId,
        sku: body.sku,
        nameEn: body.nameEn,
        nameBn: body.nameBn,
        status: body.status,
      });
      return res.status(201).json({ product });
    } catch (error) { return next(error); }
  });

  router.patch('/products/:id', ...tenantWrite, async (req, res, next) => {
    try {
      const body = bodyOf(req);
      const product = await updateProduct({
        businessId: req.auth.businessId,
        productId: req.params.id,
        patch: {
          kind: body.kind,
          brand: body.brand,
          cylinderSizeKg: body.cylinderSizeKg,
          brandId: body.brandId,
          cylinderSizeId: body.cylinderSizeId,
          purchasePrice: body.purchasePrice,
          sellingPrice: body.sellingPrice,
          status: body.status,
          sku: body.sku,
          nameEn: body.nameEn,
          nameBn: body.nameBn,
        },
      });
      return res.json({ product });
    } catch (error) { return next(error); }
  });

  return router;
};

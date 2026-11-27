/**
 * Tenant-scoped repository helpers.
 *
 * Every tenant document carries an immutable `businessId`. These helpers guarantee
 * that `businessId` is derived exclusively from the verified `req.auth` context
 * (set by `requireTenant`/`withTenant`) and never from request body or query.
 *
 * Cross-tenant records are indistinguishable from not-found: any ownership mismatch
 * throws NotFoundError, so an attacker cannot enumerate another tenant's records.
 */
import { AuthenticationError, ForbiddenError, NotFoundError } from '../errors.js';

/**
 * Extract the verified tenant business ID from the request context.
 *
 * @param {object} req - Express request with `req.auth` set by requireTenant/withTenant.
 * @returns {string} The verified businessId.
 * @throws {AuthenticationError} When the user is not authenticated.
 * @throws {ForbiddenError} When tenant context is missing.
 */
export const getTenantBusinessId = (req) => {
  if (!req.auth?.userId) {
    throw new AuthenticationError('Authentication required.', 'AUTHENTICATION_REQUIRED');
  }
  const businessId = req.auth.businessId;
  if (!businessId) {
    throw new ForbiddenError('Tenant context required.', 'TENANT_CONTEXT_REQUIRED');
  }
  return String(businessId);
};

/**
 * Build a Mongoose query filter scoped to the current tenant.
 * Every domain query must start with `businessId`.
 *
 * @param {object} req
 * @returns {object} `{ businessId: string }`
 */
export const tenantFilter = (req) => ({
  businessId: getTenantBusinessId(req),
});

/**
 * Assert that a document belongs to the current tenant.
 * A mismatch (or missing businessId) throws NotFoundError — never ForbiddenError —
 * so cross-tenant records are indistinguishable from not-found.
 *
 * @param {object} req
 * @param {object} document - Mongoose document or plain object with a `businessId`.
 * @returns {object} The document (unchanged).
 * @throws {NotFoundError} When the document does not belong to the tenant.
 */
export const assertTenantOwnership = (req, document) => {
  const businessId = getTenantBusinessId(req);
  const docBusinessId = document?.businessId;
  if (docBusinessId === undefined || String(docBusinessId) !== businessId) {
    throw new NotFoundError('Not found.', 'NOT_FOUND');
  }
  return document;
};

/**
 * Remove any client-supplied `businessId` from input data.
 * Tenant ownership is always derived from `req.auth`, never the request body/query.
 *
 * @param {object} data
 * @returns {object} Data without `businessId`.
 */
export const stripUntrustedBusinessId = (data) => {
  if (!data || typeof data !== 'object') return {};
  const { businessId, ...rest } = data;
  return rest;
};

/**
 * Inject the verified tenant `businessId` into create/update data.
 * Any `businessId` present in `data` is discarded and replaced with the verified one.
 *
 * @param {object} data
 * @param {object} req
 * @returns {object} Data with `businessId` set from `req.auth.businessId`.
 */
export const injectBusinessId = (data, req) => ({
  ...stripUntrustedBusinessId(data),
  businessId: getTenantBusinessId(req),
});

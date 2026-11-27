import mongoose from 'mongoose';
import Business from '../modules/business.model.js';
import BusinessMember from '../modules/business-member.model.js';
import User from '../modules/user.model.js';
import { fromNodeHeaders } from 'better-auth/node';

export const requireAuthentication = (auth) => async (req, res, next) => {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user?.id || !mongoose.isValidObjectId(session.user.id)) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTHENTICATION_REQUIRED' });
    }
    const user = await User.findOne({ _id: session.user.id, status: 'active' }).select('_id').lean();
    if (!user) return res.status(401).json({ error: 'Authentication required.', code: 'AUTHENTICATION_REQUIRED' });
    req.auth = { userId: String(user._id) };
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireTenant = async (req, res, next) => {
  const requestedBusinessId = req.get('x-business-id');
  if (!req.auth?.userId) {
    return res.status(401).json({ error: 'Authentication required.', code: 'AUTHENTICATION_REQUIRED' });
  }
  if (typeof requestedBusinessId !== 'string' || !/^[a-f\d]{24}$/i.test(requestedBusinessId)
      || !mongoose.isValidObjectId(requestedBusinessId)) {
    return res.status(400).json({ error: 'A valid X-Business-Id is required.', code: 'INVALID_BUSINESS_ID' });
  }
  try {
    const businessId = new mongoose.Types.ObjectId(requestedBusinessId);
    const [business, membership] = await Promise.all([
      Business.findOne({ _id: businessId, status: 'active' }).select('_id').lean(),
      BusinessMember.findOne({ businessId, userId: req.auth.userId, status: 'active' }).select('role').lean(),
    ]);
    if (!business || !membership) {
      return res.status(403).json({ error: 'Active business membership required.', code: 'TENANT_ACCESS_DENIED' });
    }
    req.auth.businessId = String(business._id);
    req.auth.role = membership.role;
    return next();
  } catch (error) {
    return next(error);
  }
};

const ROLES = new Set(['owner', 'admin', 'staff']);
export const requireRole = (...allowedRoles) => {
  if (allowedRoles.length === 0 || allowedRoles.some((role) => !ROLES.has(role))) {
    throw new Error('requireRole needs one or more known business roles.');
  }
  const allowed = new Set(allowedRoles);
  return (req, res, next) => {
    if (!req.auth?.businessId || !req.auth.role) {
      return res.status(403).json({ error: 'Tenant authorization required.', code: 'TENANT_AUTHORIZATION_REQUIRED' });
    }
    if (!allowed.has(req.auth.role)) {
      return res.status(403).json({ error: 'Insufficient business role.', code: 'INSUFFICIENT_ROLE' });
    }
    return next();
  };
};

/**
 * Reusable tenant guard chain for mutating and tenant-scoped routes.
 *
 * Order: authenticated session -> verified active membership -> role policy.
 * `requireTenant` derives `businessId` from the validated X-Business-Id header
 * plus a database check of an active Business and active BusinessMember row.
 * Callers must read `req.auth.businessId`; request body/query values are never
 * consulted here.
 *
 * The resolved context is frozen so a handler cannot be tricked into
 * overwriting `businessId` with untrusted input.
 */
export const withTenant = (auth, roles = []) => {
  if (!Array.isArray(roles)) throw new Error('withTenant roles must be an array.');
  const guards = [requireAuthentication(auth), requireTenant];
  if (roles.length > 0) guards.push(requireRole(...roles));
  guards.push((req, _res, next) => {
    Object.freeze(req.auth);
    next();
  });
  return guards;
};

// Platform-level admin guard. Verifies the Better Auth session AND checks the
// database user's platformRole. This is separate from business roles (owner/
// admin/staff) which are scoped to a tenant. Only users with platformRole
// 'super_admin' (set exclusively via the one-time bootstrap script) pass.
//
// Platform admin is NOT a tenant role: it never grants implicit access to a
// business's data. Tenant routes still require an active BusinessMember row.
export const requirePlatformAdmin = (auth) => async (req, res, next) => {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user?.id || !mongoose.isValidObjectId(session.user.id)) {
      return res.status(401).json({ error: 'Authentication required.', code: 'AUTHENTICATION_REQUIRED' });
    }
    // Re-check active status AND platform role against the database on every
    // request. Session data alone is not trusted for privilege decisions.
    const user = await User.findOne({
      _id: session.user.id,
      status: 'active',
      platformRole: 'super_admin',
    }).select('_id').lean();
    if (!user) return res.status(403).json({ error: 'Platform admin access required.', code: 'PLATFORM_ADMIN_REQUIRED' });
    req.auth = { userId: String(user._id), platformRole: 'super_admin' };
    return next();
  } catch (error) {
    return next(error);
  }
};

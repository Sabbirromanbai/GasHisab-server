import mongoose from 'mongoose';
import Business from '../modules/business.model.js';
import BusinessMember from '../modules/business-member.model.js';
import User from '../modules/user.model.js';
import { fromNodeHeaders } from 'better-auth/node';

export const requireAuthentication = (auth) => async (req, res, next) => {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user?.id || !mongoose.isValidObjectId(session.user.id)) return res.status(401).json({ error: 'Authentication required.' });
    const user = await User.findOne({ _id: session.user.id, status: 'active' }).select('_id').lean();
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    req.auth = { userId: String(user._id) };
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireTenant = async (req, res, next) => {
  const requestedBusinessId = req.get('x-business-id');
  if (!req.auth?.userId) return res.status(401).json({ error: 'Authentication required.' });
  if (typeof requestedBusinessId !== 'string' || !/^[a-f\d]{24}$/i.test(requestedBusinessId)
      || !mongoose.isValidObjectId(requestedBusinessId)) {
    return res.status(400).json({ error: 'A valid X-Business-Id is required.' });
  }
  try {
    const businessId = new mongoose.Types.ObjectId(requestedBusinessId);
    const [business, membership] = await Promise.all([
      Business.findOne({ _id: businessId, status: 'active' }).select('_id').lean(),
      BusinessMember.findOne({ businessId, userId: req.auth.userId, status: 'active' }).select('role').lean(),
    ]);
    if (!business || !membership) return res.status(403).json({ error: 'Active business membership required.' });
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
    if (!req.auth?.businessId || !req.auth.role) return res.status(403).json({ error: 'Tenant authorization required.' });
    if (!allowed.has(req.auth.role)) return res.status(403).json({ error: 'Insufficient business role.' });
    return next();
  };
};

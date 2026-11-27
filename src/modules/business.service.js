import Business from './business.model.js';
import BusinessMember from './business-member.model.js';
import User from './user.model.js';
import {
  AuthenticationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../errors.js';
import { inTransaction, requireObjectId, ROLES } from '../kernel/index.js';

/**
 * List all active businesses the user has active membership in.
 * Uses the existing { userId, status } index on BusinessMember.
 */
export const listBusinessesForUser = async (userId) => {
  const userIdObj = requireObjectId(userId, 'user id');

  const memberships = await BusinessMember.find({
    userId: userIdObj,
    status: 'active',
  })
    .select('businessId role')
    .lean();

  if (memberships.length === 0) return [];

  const businessIds = memberships.map((m) => m.businessId);
  const businesses = await Business.find({
    _id: { $in: businessIds },
    status: 'active',
  })
    .select('_id name slug contact address status createdAt updatedAt')
    .lean();

  const businessMap = new Map(businesses.map((b) => [String(b._id), b]));

  // Only include businesses that are still active (filter out suspended).
  return memberships
    .filter((m) => businessMap.has(String(m.businessId)))
    .map((m) => ({
      ...businessMap.get(String(m.businessId)),
      role: m.role,
    }));
};

/**
 * Generate a URL-safe slug from a business name.
 */
const slugify = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Create a business and an owner membership for the creator atomically.
 * Prevents mass assignment by accepting only whitelisted fields.
 */
export const createBusiness = async ({ name, slug, contact, address, createdBy }) => {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || trimmedName.length > 120) {
    throw new ValidationError('Business name is required and must be at most 120 characters.');
  }

  const resolvedSlug = (typeof slug === 'string' && slug.trim())
    ? slug.trim().toLowerCase()
    : slugify(trimmedName);

  if (!resolvedSlug || resolvedSlug.length > 120 || !SLUG_PATTERN.test(resolvedSlug)) {
    throw new ValidationError('Business slug must contain only lowercase letters, numbers, and hyphens.');
  }

  // Sanitize contact — only allow known fields.
  const sanitizedContact = {};
  if (contact && typeof contact === 'object') {
    if (typeof contact.email === 'string') sanitizedContact.email = contact.email.trim().toLowerCase();
    if (typeof contact.phone === 'string') sanitizedContact.phone = contact.phone.trim();
  }

  // Sanitize address — only allow known fields.
  const sanitizedAddress = {};
  if (address && typeof address === 'object') {
    for (const field of ['addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country']) {
      if (typeof address[field] === 'string') sanitizedAddress[field] = address[field].trim();
    }
  }

  const creatorId = requireObjectId(createdBy, 'user id');

  return inTransaction(async (session) => {
    // Verify creator is an active user.
    const user = await User.findOne({ _id: creatorId, status: 'active' })
      .select('_id')
      .session(session)
      .lean();
    if (!user) throw new AuthenticationError();

    // Create business.
    const [business] = await Business.create(
      [
        {
          name: trimmedName,
          slug: resolvedSlug,
          contact: sanitizedContact,
          address: sanitizedAddress,
          status: 'active',
        },
      ],
      { session, ordered: true },
    );

    // Create owner membership atomically.
    await BusinessMember.create(
      [
        {
          businessId: business._id,
          userId: creatorId,
          role: 'owner',
          status: 'active',
        },
      ],
      { session, ordered: true },
    );

    return business;
  });
};

const MEMBER_STATUSES = new Set(['active', 'suspended']);

// Re-check the actor inside the transaction; middleware checks happen before
// untrusted work and must not be the only authorization layer.
const assertActiveOwner = async (session, businessId, actorId) => {
  const owner = await BusinessMember.findOne({
    businessId,
    userId: actorId,
    role: 'owner',
    status: 'active',
  })
    .select('_id')
    .session(session)
    .lean();
  if (!owner) throw new ForbiddenError('Only an active business owner can manage members.', 'OWNER_REQUIRED');
};

const loadActiveBusiness = async (session, businessId) => {
  const business = await Business.findOne({ _id: businessId, status: 'active' })
    .select('_id')
    .session(session)
    .lean();
  if (!business) throw new NotFoundError('Business not found.', 'BUSINESS_NOT_FOUND');
  return business;
};

const countActiveOwners = (session, businessId) =>
  BusinessMember.countDocuments({ businessId, role: 'owner', status: 'active' }).session(session);

/**
 * Serialize concurrent membership mutations on the parent Business document.
 * Two owners suspending each other in parallel both read "2 active owners";
 * without this shared write both could commit (write skew) and leave none.
 * MongoDB then reports a transient write conflict and withTransaction retries
 * the callback, which re-reads the now-reduced owner count.
 */
const touchMembershipRevision = (session, businessId) =>
  Business.updateOne({ _id: businessId }, { $inc: { membershipRevision: 1 } }, { session });

/**
 * Change a member's role or status. Owner-only.
 * The final active owner cannot be demoted or suspended.
 */
export const updateBusinessMember = async ({ businessId, userId, role, status, actorId }) => {
  const tenantId = requireObjectId(businessId, 'business id');
  const memberUserId = requireObjectId(userId, 'user id');
  const actorUserId = requireObjectId(actorId, 'user id');

  if (role === undefined && status === undefined) throw new ValidationError('A role or status is required.');
  if (role !== undefined && !ROLES.includes(role)) throw new ValidationError('Role must be owner, admin, or staff.');
  if (status !== undefined && !MEMBER_STATUSES.has(status)) throw new ValidationError('Status must be active or suspended.');

  return inTransaction(async (session) => {
    await assertActiveOwner(session, tenantId, actorUserId);
    await loadActiveBusiness(session, tenantId);

    const membership = await BusinessMember.findOne({ businessId: tenantId, userId: memberUserId }).session(session);
    if (!membership) throw new NotFoundError('Business member not found.', 'MEMBER_NOT_FOUND');

    const nextRole = role ?? membership.role;
    const nextStatus = status ?? membership.status;
    const losesActiveOwner = membership.status === 'active'
      && membership.role === 'owner'
      && (nextStatus !== 'active' || nextRole !== 'owner');

    if (losesActiveOwner) {
      const activeOwners = await countActiveOwners(session, tenantId);
      if (activeOwners <= 1) {
        throw new ConflictError('A business must keep at least one active owner.', 'LAST_OWNER');
      }
    }

    await touchMembershipRevision(session, tenantId);
    membership.role = nextRole;
    membership.status = nextStatus;
    await membership.save({ session });
    return membership.toObject();
  });
};

/**
 * Remove a membership. Owner-only.
 * The final active owner cannot be removed.
 */
export const removeBusinessMember = async ({ businessId, userId, actorId }) => {
  const tenantId = requireObjectId(businessId, 'business id');
  const memberUserId = requireObjectId(userId, 'user id');
  const actorUserId = requireObjectId(actorId, 'user id');

  return inTransaction(async (session) => {
    await assertActiveOwner(session, tenantId, actorUserId);
    await loadActiveBusiness(session, tenantId);

    const membership = await BusinessMember.findOne({ businessId: tenantId, userId: memberUserId }).session(session);
    if (!membership) throw new NotFoundError('Business member not found.', 'MEMBER_NOT_FOUND');

    if (membership.status === 'active' && membership.role === 'owner') {
      const activeOwners = await countActiveOwners(session, tenantId);
      if (activeOwners <= 1) {
        throw new ConflictError('A business must keep at least one active owner.', 'LAST_OWNER');
      }
    }

    await touchMembershipRevision(session, tenantId);
    await membership.deleteOne({ session });
    return { removed: true };
  });
};

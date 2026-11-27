/**
 * Customer Management Foundation (Phase 2 Step 6).
 *
 * Core customer CRUD + read-only history + read-only outstanding due. NOT a
 * financial/payment abstraction; `Sale`/`Payment` unchanged; nothing financial
 * is fabricated or mutated. `businessId` from verified auth; immutable; tenant
 * safe; cross-business not-found. Owner/admin writes (route); member reads.
 * NO destructive delete; `deactivateCustomer` sets `status:'inactive'`. NOT
 * Customer advance/returns/refunds; NOT multi-warehouse. No auto-repair.
 */
import mongoose from 'mongoose';
import Business from './business.model.js';
import BusinessMember from './business-member.model.js';
import Customer from './customer.model.js';
import Payment from './payment.model.js';
import Sale from './sale.model.js';
import User from './user.model.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { requireObjectId } from '../kernel/index.js';

const MAX = 1000;
const requireTenant = (businessId) => requireObjectId(businessId, 'business id');

const requireActor = async (actorId, businessId) => {
  const id = requireObjectId(actorId, 'actor id');
  const actor = await User.exists({ _id: id, status: 'active' });
  const membership = await BusinessMember.exists({ businessId, userId: id, status: 'active' });
  if (!actor || !membership) throw new NotFoundError('An active business member was not found.', 'ACTOR_NOT_FOUND');
  return id;
};
const requireActiveBusiness = async (businessId) => {
  const business = await Business.exists({ _id: businessId, status: 'active' });
  if (!business) throw new NotFoundError('Active business was not found.', 'BUSINESS_NOT_FOUND');
};

const optionalString = (value, field, max) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string.`, 'INVALID_STRING');
  const t = value.trim();
  if (t.length > max) throw new ValidationError(`${field} must be at most ${max} characters.`, 'STRING_TOO_LONG');
  return t === '' ? undefined : t;
};
const requireName = (name) => {
  if (typeof name !== 'string' || name.trim() === '') throw new ValidationError('name is required.', 'INVALID_NAME');
  if (name.trim().length > 120) throw new ValidationError('name must be at most 120 characters.', 'STRING_TOO_LONG');
  return name.trim();
};

// Mobile/phone normalization for duplicate detection. Blank/undefined -> null (NO duplicate assumption). Not stored destructively.
const normalizeMobile = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('mobile must be a string.', 'INVALID_STRING');
  const trimmed = value.trim();
  if (trimmed === '') return null; // blank mobile is NOT treated as a duplicate
  if (trimmed.length > 32) throw new ValidationError('mobile must be at most 32 characters.', 'STRING_TOO_LONG');
  return trimmed;
};

// effective mobile for duplicate checks: `mobile` alias OR `phone`. 
const effectiveMobile = (customer) => normalizeMobile(customer.mobile ?? customer.phone ?? null);

/** Duplicate mobile within same business (active+inactive). Blank -> never duplicate. */
const assertNoDuplicateMobile = async (businessId, mobile, { excludeId } = {}) => {
  const normalized = normalizeMobile(mobile);
  if (!normalized) return; // no unsafe assumption for blank
  const query = { businessId, $or: [{ mobile: normalized }, { phone: normalized }] };
  if (excludeId) query._id = { $ne: requireObjectId(excludeId, 'customer id') };
  const existing = await Customer.findOne(query).select('_id').lean();
  if (existing) throw new ValidationError('A customer with this mobile already exists in this business.', 'DUPLICATE_MOBILE');
};

// ---------- CRUD ----------

export const createCustomer = async ({ businessId, actorId, name, mobile, phone, address, notes, status = 'active' } = {}) => {
  const tenantId = requireTenant(businessId);
  await requireActiveBusiness(tenantId);
  await requireActor(actorId, tenantId);
  const cleanName = requireName(name);
  const mobileValue = mobile !== undefined ? normalizeMobile(mobile) : normalizeMobile(phone ?? null);
  const phoneValue = phone !== undefined ? normalizeMobile(phone) : (mobile !== undefined ? mobileValue : undefined);
  if (status !== 'active' && status !== 'inactive') throw new ValidationError('status must be active or inactive.', 'INVALID_STATUS');
  await assertNoDuplicateMobile(tenantId, mobileValue ?? phoneValue);

  const [customer] = await Customer.create([{
    businessId: tenantId, name: cleanName,
    mobile: mobileValue ?? undefined, phone: phoneValue ?? mobileValue ?? undefined,
    address: optionalString(address, 'address', 500), notes: optionalString(notes, 'notes', MAX), status,
  }]);
  return customer;
};

export const listCustomers = async ({ businessId, status, search, page = 1, limit = 50, session } = {}) => {
  const tenantId = requireTenant(businessId);
  const filter = { businessId: tenantId };
  if (status === 'active' || status === 'inactive') filter.status = status;
  if (typeof search === 'string' && search.trim()) {
    const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: re }, { phone: re }, { mobile: re }];
  }
  const { page: p, limit: l } = pageParams(page, limit);
  const [items, total] = await Promise.all([
    Customer.find(filter).sort({ name: 1 }).skip((p - 1) * l).limit(l).session(session ?? null).lean(),
    Customer.countDocuments(filter).session(session ?? null),
  ]);
  return { customers: items, page: p, limit: l, total, totalPages: Math.max(1, Math.ceil(total / l)) };
};

export const getCustomer = async (customerId, businessId, { session } = {}) => {
  if (!mongoose.isValidObjectId(customerId)) throw new NotFoundError('Customer not found.', 'CUSTOMER_NOT_FOUND');
  const tenantId = requireTenant(businessId);
  const customer = await Customer.findOne({ _id: customerId, businessId: tenantId }).session(session ?? null).lean();
  if (!customer) throw new NotFoundError('Customer not found.', 'CUSTOMER_NOT_FOUND'); // cross-business => not-found
  return customer;
};

export const updateCustomer = async ({ businessId, actorId, customerId, name, mobile, phone, address, notes, status } = {}) => {
  const tenantId = requireTenant(businessId);
  await requireActiveBusiness(tenantId);
  await requireActor(actorId, tenantId);
  const id = requireObjectId(customerId, 'customer id');
  const existing = await Customer.findOne({ _id: id, businessId: tenantId });
  if (!existing) throw new NotFoundError('Customer not found.', 'CUSTOMER_NOT_FOUND');

  const nextMobile = mobile !== undefined ? normalizeMobile(mobile)
    : (phone !== undefined ? normalizeMobile(phone) : effectiveMobile(existing));
  await assertNoDuplicateMobile(tenantId, nextMobile, { excludeId: id });

  if (name !== undefined) existing.name = requireName(name);
  if (mobile !== undefined) existing.mobile = normalizeMobile(mobile) ?? undefined;
  if (phone !== undefined) existing.phone = normalizeMobile(phone) ?? undefined;
  if (address !== undefined) existing.address = optionalString(address, 'address', 500);
  if (notes !== undefined) existing.notes = optionalString(notes, 'notes', MAX);
  if (status !== undefined) { if (status !== 'active' && status !== 'inactive') throw new ValidationError('status must be active or inactive.', 'INVALID_STATUS'); existing.status = status; }
  await existing.save();
  return existing;
};

/** Deactivate (no destructive delete). */
export const deactivateCustomer = async ({ businessId, actorId, customerId } = {}) =>
  updateCustomer({ businessId, actorId, customerId, status: 'inactive' });

// ---------- read-only history + due ----------

const pageParams = (page, limit) => {
  const p = Number.isSafeInteger(page) ? Math.max(1, page) : 1;
  const l = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
  return { page: p, limit: l };
};

/** Customer sale/purchase history (actual `Sale` records; scoped; paginated). */
export const getCustomerSales = async ({ businessId, customerId, page = 1, limit = 50, session } = {}) => {
  const customer = await getCustomer(customerId, businessId, { session });
  const { page: p, limit: l } = pageParams(page, limit);
  const filter = { businessId: requireTenant(businessId), customerId: customer._id };
  const [items, total] = await Promise.all([
    Sale.find(filter).sort({ saleDate: -1 }).skip((p - 1) * l).limit(l).session(session ?? null).lean(),
    Sale.countDocuments(filter).session(session ?? null),
  ]);
  return { sales: items, page: p, limit: l, total, totalPages: Math.max(1, Math.ceil(total / l)) };
};

/** Customer payment history (append-only `Payment`; scoped; paginated; read-only). */
export const getCustomerPayments = async ({ businessId, customerId, page = 1, limit = 50, session } = {}) => {
  const customer = await getCustomer(customerId, businessId, { session });
  const { page: p, limit: l } = pageParams(page, limit);
  const filter = { businessId: requireTenant(businessId), customerId: customer._id };
  const [items, total] = await Promise.all([
    Payment.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).session(session ?? null).lean(),
    Payment.countDocuments(filter).session(session ?? null),
  ]);
  return { payments: items, page: p, limit: l, total, totalPages: Math.max(1, Math.ceil(total / l)) };
};

/** Read-only customer outstanding due derived from `Sale.dueAmount`. Never fabricates or mutates. */
export const getCustomerDue = async ({ businessId, customerId, session } = {}) => {
  const customer = await getCustomer(customerId, businessId, { session });
  const filter = { businessId: requireTenant(businessId), customerId: customer._id };
  const sales = await Sale.find(filter).select('total paidAmount dueAmount status').session(session ?? null).lean();
  let totalSoldPoisha = 0; let totalPaidPoisha = 0; let outstandingDuePoisha = 0; let salesWithDue = 0;
  for (const sale of sales) {
    totalSoldPoisha += sale.total;
    totalPaidPoisha += sale.paidAmount;
    outstandingDuePoisha += sale.dueAmount;
    if (sale.dueAmount > 0) salesWithDue += 1;
  }
  return {
    customerId: customer._id, salesCount: sales.length, salesWithDue,
    totalSoldPoisha, totalPaidPoisha, outstandingDuePoisha,
  };
};

/**
 * Read-only customer due reconciliation. Recomputes each Sale's paid/due from
 * append-only `Payment` records + `Sale.total` and compares to cached
 * `Sale.paidAmount/dueAmount`, plus aggregate outstanding due. Does NOT trust
 * inconsistent cached due silently; `matches=false` on drift. NO auto-repair,
 * backfill, or financial mutation. Tenant-safe.
 */
export const reconcileCustomerDue = async ({ businessId, customerId, session } = {}) => {
  const customer = await getCustomer(customerId, businessId, { session });
  const tenantId = requireTenant(businessId);
  const filter = { businessId: tenantId, customerId: customer._id };
  const sales = await Sale.find(filter).session(session ?? null).lean();

  // append-only Payment per sale (tenant-scoped); read-only
  const saleIds = sales.map((s) => s._id);
  const payments = saleIds.length
    ? await Payment.find({ businessId: tenantId, saleId: { $in: saleIds } }).select('saleId amount').session(session ?? null).lean()
    : [];
  const paidBySale = new Map();
  for (const payment of payments) {
    const key = String(payment.saleId);
    paidBySale.set(key, (paidBySale.get(key) ?? 0) + payment.amount);
  }

  let totalSoldPoisha = 0; let totalPaidPoisha = 0;
  let storedOutstandingDuePoisha = 0; let recomputedOutstandingDuePoisha = 0;
  let storedPaidPoisha = 0; let salesWithDue = 0; let cacheMatches = true;
  const driftedSales = [];

  for (const sale of sales) {
    const recomputedPaid = paidBySale.get(String(sale._id)) ?? 0;
    const recomputedDue = sale.total - recomputedPaid;
    totalSoldPoisha += sale.total;
    totalPaidPoisha += recomputedPaid;
    recomputedOutstandingDuePoisha += recomputedDue;
    storedOutstandingDuePoisha += sale.dueAmount;
    storedPaidPoisha += sale.paidAmount;
    if (recomputedDue > 0) salesWithDue += 1;
    if (sale.paidAmount !== recomputedPaid || sale.dueAmount !== recomputedDue) {
      cacheMatches = false;
      driftedSales.push({ saleId: sale._id, storedPaid: sale.paidAmount, recomputedPaid, storedDue: sale.dueAmount, recomputedDue });
    }
  }

  return {
    customerId: customer._id, salesCount: sales.length, salesWithDue,
    totalSoldPoisha, totalPaidPoisha,
    // read-only reconciliation; NOT silently trusting cached due
    storedOutstandingDuePoisha, recomputedOutstandingDuePoisha, storedPaidPoisha,
    cacheMatches, matches: cacheMatches && storedOutstandingDuePoisha === recomputedOutstandingDuePoisha, driftedSales,
  };
};

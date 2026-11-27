/**
 * New Cylinder Sales Foundation (Phase 2 Step 5).
 *
 * NOT Sales Returns, NOT refunds, NOT Customer Sale Returns, NOT customer
 * advance allocation, NOT multi-warehouse sales, NOT Supplier Returns/Purchase.
 * Sell ONLY NEW-CYLINDER stock (`Stock.newQty`, `kind==='lpg_cylinder'`),
 * NOT full/empty/damaged/rejected. Atomic stock decrement no-negative +
 * append-only StockMovement + append-only customer Payment. Tenant-safe.
 * Reuses existing `Sale` + `Payment`; NO duplicate financial/payment abstraction.
 * `businessId` from verified auth; integer poisha; `inTransaction`; `runIdempotently`.
 * Dealer controls all selling prices; `Product` prices NEVER auto-modified.
 */
import mongoose from 'mongoose';
import Business from './business.model.js';
import BusinessMember from './business-member.model.js';
import Customer from './customer.model.js';
import Payment from './payment.model.js';
import Product from './product.model.js';
import Sale from './sale.model.js';
import Stock from './stock.model.js';
import StockMovement from './stock-movement.model.js';
import User from './user.model.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { generateRequestHash, inTransaction, normalizeIdempotencyKey, requireObjectId, runIdempotently } from '../kernel/index.js';

const isPoisha = (value) => Number.isSafeInteger(value) && value >= 0;
const isPositiveInt = (value) => Number.isSafeInteger(value) && value >= 1;
const PAYMENT_METHODS = new Set(['cash', 'bkash', 'nagad', 'bank', 'other']); // Cash, bKash, Nagad, Bank, Others
const MAX = 1000;
const NEW_BUCKET = 'new';

const requireTenant = (businessId) => requireObjectId(businessId, 'business id');
const requireActor = async (actorId, businessId, session) => {
  const id = requireObjectId(actorId, 'actor id');
  const actor = await User.exists({ _id: id, status: 'active' }).session(session);
  const membership = await BusinessMember.exists({ businessId, userId: id, status: 'active' }).session(session);
  if (!actor || !membership) throw new NotFoundError('An active business member was not found.', 'ACTOR_NOT_FOUND');
  return id;
};
const requireActiveBusiness = async (businessId, session) => {
  const business = await Business.exists({ _id: businessId, status: 'active' }).session(session);
  if (!business) throw new NotFoundError('Active business was not found.', 'BUSINESS_NOT_FOUND');
};
const requireOwnedProduct = async (businessId, productId, session) => {
  const id = requireObjectId(productId, 'product id');
  const product = await Product.findOne({ _id: id, businessId }).select('_id kind status brand cylinderSizeKg businessId').session(session).lean();
  if (!product) throw new NotFoundError('Product not found.', 'PRODUCT_NOT_FOUND'); // cross-business => not-found
  if (product.kind !== 'lpg_cylinder') throw new ValidationError('Only new LPG cylinder packages can be sold in this step.', 'INVALID_PRODUCT_KIND');
  if (product.status !== 'active') throw new ValidationError('Product is not active.', 'PRODUCT_INACTIVE');
  return product;
};
const requireOwnedCustomer = async (businessId, customerId, session) => {
  if (customerId === undefined || customerId === null || customerId === '') return null; // customer optional
  const id = requireObjectId(customerId, 'customer id');
  const customer = await Customer.findOne({ _id: id, businessId, status: 'active' }).select('_id').session(session).lean();
  if (!customer) throw new NotFoundError('Customer not found.', 'CUSTOMER_NOT_FOUND'); // cross-business => not-found
  return id;
};

const optionalString = (value, field, max = 120) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string.`, 'INVALID_STRING');
  const t = value.trim();
  if (t.length > max) throw new ValidationError(`${field} must be at most ${max} characters.`, 'STRING_TOO_LONG');
  return t === '' ? undefined : t;
};

const validateItems = (items) => {
  if (!Array.isArray(items) || items.length < 1) throw new ValidationError('A sale needs at least one item.', 'INVALID_ITEMS');
  return items.map((item) => {
    if (!item || typeof item !== 'object') throw new ValidationError('Invalid sale item.', 'INVALID_ITEMS');
    if (!isPositiveInt(item.quantity)) throw new ValidationError('item.quantity must be a positive whole number.', 'INVALID_QUANTITY');
    const unitSellingPricePoisha = item.unitSellingPricePoisha ?? item.unitPrice; // `unitPrice` alias preserved
    if (!isPoisha(unitSellingPricePoisha)) throw new ValidationError('item.unitSellingPricePoisha must be a non-negative whole number of poisha.', 'INVALID_UNIT_PRICE');
    return { productIdRaw: item.productId, quantity: item.quantity, unitPrice: unitSellingPricePoisha };
  });
};

/**
 * Create + post a new-cylinder Sale. Atomic; transaction-safe; idempotent.
 * Decrement `Stock.newQty` atomically `$gte`, no negative; append-only `sale`
 * `stockBucket:'new'` `direction:'out'` movements. `Product` prices NOT changed.
 */
export const createSale = async ({
  businessId, customerId, actorId, invoiceNumber, saleDate, items,
  note, reference, idempotencyKey, session: providedSession,
} = {}) => {
  const tenantId = requireTenant(businessId);
  const actor = requireObjectId(actorId, 'actor id');
  const key = normalizeIdempotencyKey(idempotencyKey);
  if (typeof invoiceNumber !== 'string' || invoiceNumber.trim() === '') throw new ValidationError('A manual invoice number is required.', 'INVALID_INVOICE_NUMBER');
  const invoice = invoiceNumber.trim();
  if (invoice.length > 64) throw new ValidationError('invoiceNumber must be at most 64 characters.', 'STRING_TOO_LONG');
  const rawItems = validateItems(items);

  // `requestHash` FULL canonical payload; `note`/`reference` included.
  const requestHash = generateRequestHash({
    businessId: tenantId, customerId: customerId ?? null, actorId: actor, invoiceNumber: invoice,
    saleDate: saleDate ? new Date(saleDate).toISOString() : null,
    items: rawItems.map((i) => ({ productId: i.productIdRaw, quantity: i.quantity, unitSellingPricePoisha: i.unitPrice })),
    note: note ?? null, reference: reference ?? null,
  });

  return runIdempotently({
    model: Sale,
    filter: { businessId: tenantId, idempotencyKey: key },
    requestHash,
    authorize: async () => { await requireActiveBusiness(tenantId, providedSession ?? null); await requireActor(actor, tenantId, providedSession ?? null); },
    work: async (session) => {
      const customer = await requireOwnedCustomer(tenantId, customerId, session);

      // validate products + capture snapshots (integer poisha; totals recomputed; no platform price)
      const items = [];
      let subtotal = 0;
      for (const raw of rawItems) {
        const product = await requireOwnedProduct(tenantId, raw.productIdRaw, session);
        const lineTotal = raw.quantity * raw.unitPrice;
        subtotal += lineTotal;
        items.push({
          productId: product._id, kind: 'lpg_cylinder', brand: product.brand, cylinderSizeKg: product.cylinderSizeKg,
          quantity: raw.quantity, unitPrice: raw.unitPrice, lineTotal,
        });
      }
      if (!Number.isSafeInteger(subtotal)) throw new ValidationError('Sale total exceeds safe integer poisha.', 'AMOUNT_TOO_LARGE');
      const total = subtotal; // no discount in this step

      const [sale] = await Sale.create([{
        businessId: tenantId, customerId: customer, invoiceNumber: invoice, saleDate: saleDate ? new Date(saleDate) : undefined,
        items, subtotal, discount: 0, total, paidAmount: 0, dueAmount: total, status: 'unpaid',
        note: optionalString(note, 'note', MAX), reference: optionalString(reference, 'reference', 120),
        createdBy: actor, idempotencyKey: key, requestHash,
      }], { session, ordered: true });

      // ---- atomic NEW-CYLINDER stock decrement (no-negative) ----
      const movementGroupId = new mongoose.Types.ObjectId();
      const movements = [];
      for (const item of sale.items) {
        const stockUpdate = await Stock.updateOne(
          { businessId: tenantId, productId: item.productId, warehouseId: null, newQty: { $gte: item.quantity } },
          { $inc: { newQty: -item.quantity, version: 1 } },
          { session, runValidators: true },
        );
        if (stockUpdate.matchedCount !== 1) {
          throw new ConflictError('Insufficient new-cylinder stock; sale would create negative stock.', 'INSUFFICIENT_NEW_CYLINDER');
        }
        movements.push({
          businessId: tenantId, productId: item.productId, warehouseId: null,
          movementType: 'sale', quantity: item.quantity, stockBucket: NEW_BUCKET, direction: 'out',
          sourceType: 'sale', sourceId: sale._id, sourceLineId: item._id, movementGroupId,
          reference: optionalString(reference, 'reference', 120), note: 'New-cylinder sale.', createdBy: actor, idempotencyKey: `${key}#sale:${item._id}`,
        });
      }
      if (movements.length > 0) await StockMovement.create(movements, { session, ordered: true });
      return sale;
    },
    session: providedSession,
  });
};

const sumSalePaid = async (businessId, saleId, session) => {
  const rows = await Payment.find({ businessId, saleId }).select('amount').session(session ?? null).lean();
  return rows.reduce((sum, row) => sum + row.amount, 0);
};

/**
 * Record a customer sale payment. Append-only `Payment`. Full/partial/multiple.
 * No overpayment. Idempotent. Recompute `Sale.paidAmount/dueAmount/status`.
 */
export const recordSalePayment = async ({
  businessId, saleId, actorId, amountPoisha, method, paidAt, reference, note, idempotencyKey, session: providedSession,
} = {}) => {
  const tenantId = requireTenant(businessId);
  const sale = requireObjectId(saleId, 'sale id');
  const actor = requireObjectId(actorId, 'actor id');
  const key = normalizeIdempotencyKey(idempotencyKey);
  if (!isPositiveInt(amountPoisha)) throw new ValidationError('amountPoisha must be a positive whole number of poisha.', 'INVALID_AMOUNT');
  if (!PAYMENT_METHODS.has(method)) throw new ValidationError('method must be one of: cash, bkash, nagad, bank, other.', 'INVALID_METHOD');

  const requestHash = generateRequestHash({ businessId: tenantId, saleId: sale, paidBy: actor, amountPoisha, method, paidAt: paidAt ? new Date(paidAt).toISOString() : null, reference: reference ?? null, note: note ?? null });

  return runIdempotently({
    model: Payment,
    filter: { businessId: tenantId, idempotencyKey: key },
    requestHash,
    authorize: async () => { await requireActiveBusiness(tenantId, providedSession ?? null); await requireActor(actor, tenantId, providedSession ?? null); },
    work: async (session) => {
      const saleDoc = await Sale.findOne({ _id: sale, businessId: tenantId }).session(session);
      if (!saleDoc) throw new NotFoundError('Sale not found.', 'SALE_NOT_FOUND'); // cross-business => not-found

      const paidSoFar = await sumSalePaid(tenantId, sale, session);
      const total = saleDoc.total;
      if (paidSoFar + amountPoisha > total) throw new ConflictError('Payment exceeds amount due.', 'PAID_EXCEEDS_TOTAL');

      const [payment] = await Payment.create([{
        businessId: tenantId, saleId: sale, customerId: saleDoc.customerId ?? undefined, amount: amountPoisha, method,
        reference: optionalString(reference, 'reference', 120), note: optionalString(note, 'note', MAX), receivedBy: actor, paidAt: paidAt ? new Date(paidAt) : new Date(),
        idempotencyKey: key, requestHash,
      }], { session, ordered: true });

      const totalPaid = paidSoFar + amountPoisha;
      const dueAmount = total - totalPaid;
      const status = totalPaid >= total ? 'paid' : (totalPaid > 0 ? 'partially_paid' : 'unpaid');
      // atomic cache update (not `save`/`__v`); append-only `Payment` is source of truth; no auto-repair; concurrent `WriteConflict` retried by `withTransaction`.
      await Sale.updateOne({ _id: sale, businessId: tenantId }, { $set: { paidAmount: totalPaid, dueAmount, status } }, { session });
      return payment;
    },
    session: providedSession,
  });
};

// ---------- reads (tenant-safe) ----------
export const getSale = async (saleId, businessId, { session } = {}) => {
  if (!mongoose.isValidObjectId(saleId)) throw new NotFoundError('Sale not found.', 'SALE_NOT_FOUND');
  const tenantId = requireTenant(businessId);
  const sale = await Sale.findOne({ _id: saleId, businessId: tenantId }).session(session ?? null).lean();
  if (!sale) throw new NotFoundError('Sale not found.', 'SALE_NOT_FOUND');
  return sale;
};

export const listSales = async ({ businessId, customerId, status, session } = {}) => {
  const tenantId = requireTenant(businessId);
  const filter = { businessId: tenantId };
  if (customerId) filter.customerId = requireObjectId(customerId, 'customer id');
  if (status) filter.status = status;
  return Sale.find(filter).sort({ saleDate: -1 }).session(session ?? null).lean();
};

export const getSalePayments = async (saleId, businessId, { session } = {}) => {
  const sale = await getSale(saleId, businessId, { session });
  return Payment.find({ businessId, saleId: sale._id }).sort({ createdAt: 1 }).session(session ?? null).lean();
};

export const getSaleDue = async (saleId, businessId, { session } = {}) => {
  const sale = await getSale(saleId, businessId, { session });
  return { saleId: sale._id, total: sale.total, paidAmount: sale.paidAmount, dueAmount: sale.dueAmount, status: sale.status };
};

/** Read-only reconciliation of `Sale` payment cache vs append-only `Payment`. No auto-repair. */
export const reconcileSalePayment = async ({ businessId, saleId, session } = {}) => {
  const tenantId = requireTenant(businessId);
  const saleDoc = await Sale.findOne({ _id: requireObjectId(saleId, 'sale id'), businessId: tenantId }).session(session ?? null).lean();
  if (!saleDoc) throw new NotFoundError('Sale not found.', 'SALE_NOT_FOUND');
  const paid = await sumSalePaid(tenantId, saleDoc._id, session);
  const total = saleDoc.total;
  const recomputed = { paidAmount: paid, dueAmount: total - paid, status: paid >= total ? 'paid' : (paid > 0 ? 'partially_paid' : 'unpaid') };
  const stored = { paidAmount: saleDoc.paidAmount, dueAmount: saleDoc.dueAmount, status: saleDoc.status };
  const matches = stored.paidAmount === recomputed.paidAmount && stored.dueAmount === recomputed.dueAmount && stored.status === recomputed.status && paid <= total;
  return { saleId: saleDoc._id, total, stored, recomputed, matches, paid };
};

/**
 * Read-only reconciliation of SALE stock deductions. `Sale` new-cylinder sales
 * decrement `Stock.newQty`; verify against append-only `StockMovement`
 * `movementType='sale'`, `stockBucket='new'`, `direction='out'`, `sourceType='sale'`,
 * scoped by business + product. NOT full/empty/damaged/rejected. No auto-repair,
 * backfill, or ledger mutation.
 */
export const reconcileSaleStock = async ({ businessId, productId, session } = {}) => {
  const tenantId = requireTenant(businessId);
  const product = requireObjectId(productId, 'product id');
  const owned = await Product.exists({ _id: product, businessId: tenantId }).session(session ?? null);
  if (!owned) throw new NotFoundError('Product not found.', 'PRODUCT_NOT_FOUND'); // cross-business => not-found

  const stock = await Stock.findOne({ businessId: tenantId, productId: product, warehouseId: null }).session(session ?? null).lean();
  const storedNewQty = stock?.newQty ?? 0;

  const saleMovements = await StockMovement.find({
    businessId: tenantId, productId: product, movementType: 'sale', stockBucket: 'new', sourceType: 'sale', warehouseId: null,
  }).session(session ?? null).lean();

  let recomputedSaleDeduction = 0; // total new-cylinders sold out via append-only sale ledger
  let unreconciled = 0;
  for (const movement of saleMovements) {
    if (movement.direction !== 'out') { unreconciled += 1; continue; }
    recomputedSaleDeduction += movement.quantity;
  }

  // sale-only view; `matches` requires no unreconciled sale movements and non-negative recomputed
  const saleView = { recomputedSaleDeduction, saleMovements: saleMovements.length, unreconciledMovements: unreconciled };
  return {
    businessId: tenantId, productId: product,
    storedNewQty, ...saleView, stock: stock ?? null,
    // `newQty` itself depends on purchases/opening too; see reconcileNewCylinderStock for full balance match.
    matchesSaleLedger: unreconciled === 0,
  };
};
